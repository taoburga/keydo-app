# Todoist MCP Server — Research & Design Insights

**Purpose:** Reference doc for the Apple Reminders MCP build. Surveys the Todoist MCP ecosystem and extracts patterns worth borrowing or avoiding.
**Companion:** [`mcp-plan.md`](./mcp-plan.md) — our plan.
**Date:** 2026-05-01.

---

## TL;DR

- The **official server is `Doist/todoist-ai`** (the older `Doist/todoist-mcp` repo is now deprecated and points there). It exposes ~44 tools organized around **user workflows, not API endpoints** — and the team has published an explicit [tool-design.md](https://github.com/Doist/todoist-ai/blob/main/docs/tool-design.md) philosophy doc that aligns closely with our plan.
- The most popular community server is **`abhiz123/todoist-mcp-server`** — only 5 tools, name-based fuzzy matching, very thin. A useful negative example.
- **`greirson/mcp-todoist`** (19 grouped "verb-router" tools, dry-run mode, in-memory cache) and **`Hint-Services/mcp-todoist`** (15 tools, Zod schemas, name-or-id lookup) sit in between.
- Top 3 things to borrow for our Apple Reminders MCP: **(1) batch-by-default array inputs (cap at ~25)**, **(2) "user intent over API structure" tool surface**, **(3) return both structured + human-readable text with next-step suggestions**.
- Top 3 things to avoid: **(1) name-only lookup with no id fallback**, **(2) one-tool-per-endpoint sprawl**, **(3) skipping confirmation/dry-run for destructive ops**.

---

## Implementations surveyed

| Repo | Status | Tool count | Transport | Notable |
|---|---|---|---|---|
| **Doist/todoist-ai** | Official, actively maintained | ~44 | Streamable HTTP (`https://ai.todoist.net/mcp`) + stdio (`npx @doist/todoist-ai`) | OAuth flow; published tool-design philosophy; "MCP Apps" inline UI widgets; OpenAI-compatible `search`/`fetch` |
| **Doist/todoist-mcp** | **Deprecated** — points at `todoist-ai` | — | — | Don't use |
| **greirson/mcp-todoist** | Community, mature | 19 (grouped, action-routing) | stdio | Bulk ops, in-memory cache, **`DRYRUN=true` mode**, modular handlers |
| **Hint-Services/mcp-todoist** | Community | 15 | HTTP streaming + stdio | Zod schemas, **id-or-name lookup**, batch on most write tools |
| **abhiz123/todoist-mcp-server** | Community, popular tutorial fodder | **5** | stdio | Name-only lookup; thin; useful as a "what not to do" example |
| ganievs, ecfaria, mikemc, IAMSamuelRodda, Hint-Services, stanislavlysenko0912 | Various community forks/rewrites | varies | mostly stdio | Comparable feature sets to the above |

I focused depth on **Doist/todoist-ai** (because it's the official one with a published philosophy) and **abhiz123** + **greirson** + **Hint-Services** (to triangulate community patterns).

---

## Doist/todoist-ai — leading implementation

### Tool surface (~44 tools, organized by user workflow)

Sourced from `src/tools/` directory listing.

**Tasks (8):**
`add-tasks`, `update-tasks`, `complete-tasks`, `uncomplete-tasks`, `find-tasks`, `find-tasks-by-date`, `find-completed-tasks`, `reschedule-tasks`

**Projects & sections (8):**
`add-projects`, `update-projects`, `find-projects`, `project-management`, `project-move`, `add-sections`, `update-sections`, `find-sections`

**Metadata — labels, filters, reminders (9):**
`add-labels`, `update-labels`, `find-labels`, `add-filters`, `update-filters`, `find-filters`, `add-reminders`, `update-reminders`, `find-reminders`

**Comments & collaboration (5):**
`add-comments`, `update-comments`, `find-comments`, `find-project-collaborators`, `manage-assignments`

**Analytics (5):**
`get-overview`, `get-workspace-insights`, `get-productivity-stats`, `analyze-project-health`, `get-project-health`, `get-project-activity-stats`

**Utility (8):**
`fetch`, `fetch-object`, `delete-object` (universal across entity types — one tool, not five), `search`, `reorder-objects`, `find-activity`, `view-attachment`, `list-workspaces`, `user-info`

### Tool-by-tool examples (deep look at 2 tools)

**`add-tasks`** — illustrates the batch-by-default pattern:

| Field | Type | Required | Notes |
|---|---|---|---|
| `tasks` | Array (1–25) | yes | Up-front cap — a real, hard limit |
| `tasks[].content` | string (≥1 char) | yes | Description: "concise and actionable" |
| `tasks[].description` | string | no | Markdown supported |
| `tasks[].priority` | enum | no | |
| `tasks[].dueString` | string | no | **Natural language passed straight to Todoist's NLP** |
| `tasks[].deadlineDate` | string (ISO 8601 YYYY-MM-DD) | no | Strict, separate from `dueString` |
| `tasks[].duration` | string | no | "2h", "90m", "2h30m", max 24h |
| `tasks[].labels` | string[] | no | |
| `tasks[].projectId` | string | no | Accepts the literal `"inbox"` |
| `tasks[].sectionId` / `parentId` / `order` | string / string / number | no | |
| `tasks[].responsibleUser` | string | no | "me", id, name, or email — multi-format input |
| `tasks[].isUncompletable` | boolean | no | For org headers |

Response shape: `{ tasks, totalCount, failures, totalRequested, successCount, failureCount }`. Partial success is first-class — only throws if **all** tasks fail.

**`find-tasks`** — illustrates filter-or-fail validation:

- Required: at least one of `searchText` / `projectId` / `sectionId` / `parentId` / `responsibleUser` / `labels` / `filter` / `filterIdOrName`.
- Conflicting combinations validated up front (e.g., `filter` + container filters rejected with explicit error).
- `limit` 1–450 with cursor pagination.
- Response: `{ tasks, nextCursor, totalCount, hasMore, appliedFilters }` — echoes back which filters applied so the LLM can re-read its own request.

### Auth

- Local: `TODOIST_API_KEY` env var via `.env` file (note: `_API_KEY`, while community servers use `_API_TOKEN` — annoying inconsistency).
- Hosted: **OAuth flow** through the user's browser. For Claude Code: `claude mcp add --transport http todoist https://ai.todoist.net/mcp`, then `/mcp` → select Todoist → wizard.

### Transport

Streamable HTTP is primary; stdio is secondary. Inverse of our setup — **we will be stdio-primary** because we're local-only.

### Error handling

- Per-item partial success on batch tools (`failures` array).
- Throws only when the whole batch fails.
- Validation errors are explicit and structured (e.g., `find-tasks` rejecting conflicting filter combos with named errors).

### Natural language

- **Pushed entirely to Todoist's server-side NLP** via `dueString` — the MCP server itself does no date parsing.
- Strict ISO format reserved for `deadlineDate` (separate field, no ambiguity).

### Rate limiting / batching

- Hard cap of **25 tasks per `add-tasks` call** — the only documented limit.
- No client-side throttling found.
- Defers to Todoist API quotas.

### MCP Apps

Inline UI widgets for tool output (e.g., a rendered task list instead of plain JSON). Spec is recent (2025+); not portable yet but worth tracking.

### Philosophy doc — verbatim highlights

From [docs/tool-design.md](https://github.com/Doist/todoist-ai/blob/main/docs/tool-design.md):

- **"Specialized workflow tools instead of 30+ API-endpoint tools."**
- **"User Intent Over API Structure."**
- **"Always return both structured data AND human-readable text with next steps."**
- **"Context-Aware Responses with follow-up suggestions to maintain workflow momentum."**
- **"Batch Operations — support multiple items when logical (e.g., `add-tasks` accepts arrays)."**
- Universal `delete-object` tool spans entity types — "to reduce cognitive load."
- Anti-patterns called out: one-to-one API mapping, raw API responses without context, forcing multiple tool calls for related operations.

---

## Community implementations — quick survey

### `abhiz123/todoist-mcp-server` (5 tools, popular)

Tools: `todoist_create_task`, `todoist_get_tasks`, `todoist_update_task`, `todoist_complete_task`, `todoist_delete_task`.

- Auth: `TODOIST_API_TOKEN` env var, exits if missing.
- Schema example (`todoist_create_task`): required `content`, optional `description`, `due_string`, `priority` (enum [1,2,3,4]).
- **Lookup pattern:** update/complete/delete take `task_name` and do **case-insensitive substring matching across all tasks**. No id fallback. **This is the antipattern.** A task called "Email John" matches "email" — and in a list of 200 tasks the first match wins.
- Error handling: try/catch wrap, returns `{ content: [{type: "text", text: "Error: ..."}], isError: true }`. Standard MCP shape.
- Natural language: passes `due_string` straight through ("tomorrow", "next Friday") — same as official.
- No batch ops. No id-based access.

### `greirson/mcp-todoist` (19 grouped tools)

- Tools route by **operation string**: `todoist_task` accepts `operation: "create" | "get" | "update" | "delete" | "complete" | "reopen" | "quick_add"`. Reduces tool count but trades it for less discoverable schemas (each operation has different required fields).
- Has dedicated `todoist_task_bulk` for `bulk_create` / `bulk_update` / `bulk_delete` / `bulk_complete`.
- **`DRYRUN=true` env var** simulates mutations against real data without executing — the only one of the four that ships this.
- In-memory cache layer (`src/cache.ts`).
- Quick Add tool exposes Todoist's syntax: `p1`–`p4`, `@label`, `#Project`, `+name`, `// description`. Lets the LLM construct one string.

### `Hint-Services/mcp-todoist` (15 tools)

- TypeScript + **Zod schemas** for validation.
- **`task_id OR task_name`** lookup on most write tools — addresses the abhiz problem.
- HTTP streaming primary, stdio legacy.
- Most write tools support batch (`task_ids` arrays).
- Separate `todoist_move_task` instead of overloading update — explicit intent.

---

## Comparison to our plan

Our plan ([mcp-plan.md](./mcp-plan.md)): 9 tools (5 read + 4 write), stdio, ask-mode for writes, `tasks_summary` smart aggregator, named smart lists, JS-side date normalization via chrono-node.

### What we're already doing right (validated by Todoist patterns)

| Our plan | Validated by |
|---|---|
| Front-loaded descriptions (LLM reads first sentence to decide) | Doist tool docs: "concise and actionable" descriptions; Doist anti-pattern list calls out raw API responses without context |
| `tasks_summary` as a workflow-batched tool | Doist `get-overview`, `get-workspace-insights` — explicit "specialized workflow tools" principle |
| ask-mode on all writes | None of the four community servers ship a confirmation pattern; greirson's DRYRUN is the closest. **We're ahead of them on safety**, which is correct because we're hitting EventKit (no undo) not a service with a trash. |
| Smart-list semantics (today/overdue/scheduled/all) | Doist has `find-tasks-by-date` as a separate tool — same instinct |
| Both `text` (JSON-stringified) and `structuredContent` in responses | Doist: "Always return both structured data AND human-readable text" |

### Things to borrow (concrete, do this)

1. **Add a `tasks_add_bulk` (or accept arrays in `tasks_add`).** Doist caps at 25 per call. Right now our `tasks_add` is single-item. Adding a bulk path means an inbox-triage skill can convert 5 P1 emails into 5 follow-up tasks in one approval, not five. **Recommended shape:** keep `tasks_add` single-item for ergonomics, add `tasks_add_bulk` with a `tasks: [...]` array, max 25, partial-success response (`{tasks, failures, successCount, failureCount}` like Doist).

2. **Accept name OR id on `tasks_update` / `tasks_complete` / `tasks_delete`.** Hint-Services does `task_id OR task_name`. Right now our plan's write tools take `id`. That's safer for collisions but worse for LLM-driven flows where the model just saw a task title and wants to act on it. **Recommended:** add an optional `task_name` parameter that does **exact (not substring)** match within a single list, and **errors with alternatives if ambiguous** ("Found 3 tasks named 'Email John' in lists Inbox, Work, Personal — pass `id` or `list_id`"). Don't repeat abhiz's substring-match-anywhere bug.

3. **Add a dry-run flag on writes.** greirson's `DRYRUN=true` is the right idea but at the wrong level (env var = global). Better: add `dry_run: true` as an optional param on `tasks_add` / `tasks_update` / `tasks_delete`. Returns the would-be result without calling EventKit. Lets an inbox-triage skill preview the full write before approval. This was uniquely valuable for us because **EventKit deletions are unrecoverable at the EventKit layer** (the shipped app later added its own 7-day trash in front of them).

4. **Echo back the applied filters in `tasks_get` responses.** Doist's `find-tasks` returns `appliedFilters` in the response so the LLM can re-read its own request and avoid re-asking. Trivial to add (`appliedFilters: {smart_list, list_id, due_before, ...}` in our response object), big payoff for chained calls.

5. **Steal the philosophy doc.** Write a one-pager `keydo-app/docs/tool-design.md` with our principles before we build (workflow > endpoints, structured + text, partial success, smart-list verbs, name-or-id lookup, ask-mode for destructive). Useful as a litmus test when we add tool #10.

### Things to avoid / reconsider

1. **Don't ship name-only lookup like abhiz123.** Substring match on titles across all lists is a footgun — bad list, wrong task, silent failure. Open question 5 in our plan ("loose date strings") has the same shape: be permissive at the input boundary, but **resolve to ids and echo back the resolution** so the LLM can verify before mutating.

2. **Don't grow the tool surface to 44.** Doist can do this because they have a hosted product, dedicated MCP team, and discovery via OpenAI's `search`/`fetch`. We're 9 tools and should stay there. If we add bulk + dry-run as flags/variants rather than new tools, we don't bloat the surface. greirson's verb-router pattern (`todoist_task` with `operation` arg) is one way to keep count low but **degrades schema clarity** — don't do it.

3. **Reconsider open question 5 (date parsing in JS via chrono-node).** Doist passes `dueString` straight to Todoist's server-side NLP. We don't have a server-side NLP. Two options:
   - **(a)** Parse with chrono-node in `mcp-tools.js` *and* echo `parsed_date` back so the LLM sees what we did.
   - **(b)** Punt to the calling Claude — accept only ISO/null and let the LLM normalize before calling.
   Doist's design suggests (a): "be lenient at the boundary, be strict internally, echo the resolution." Recommend going with (a) **and** echoing `dueString_raw` + `dueDate_resolved` in the response.

4. **Decide on partial-success now, not later.** Once we add bulk, decide whether partial failure throws or returns a `failures` array. Doist returns `failures`. That's right for an LLM consumer — let the model see what worked and decide. Bake this into the response schema for v2 even before bulk lands so we don't break consumers later.

5. **Skip "MCP Apps" / inline UI widgets for now.** Cool feature, not portable yet, only Doist ships it. Revisit in 6+ months.

---

## Recommended changes to our plan (concrete)

| # | Change | Where | Phase |
|---|---|---|---|
| 1 | Add `tasks_add_bulk` (array, max 25, partial success) | `mcp-tools.js` | v2.5 |
| 2 | Add optional `task_name` to write tools, with exact-match-or-error behavior | `mcp-tools.js` | v2 |
| 3 | Add `dry_run: true` flag to `tasks_add`/`tasks_update`/`tasks_delete` | `mcp-tools.js` | v2 |
| 4 | Echo `appliedFilters` in `tasks_get` and `tasks_search` responses | `mcp-tools.js` | v1 |
| 5 | Add `parsed_date` echo on any tool accepting loose date strings | `mcp-tools.js` | v2 |
| 6 | Write `keydo-app/docs/tool-design.md` (1 page, our principles) | docs | v1 (before coding) |

---

## Sources

- [Doist/todoist-ai (official)](https://github.com/Doist/todoist-ai)
- [Doist/todoist-ai tool-design.md](https://github.com/Doist/todoist-ai/blob/main/docs/tool-design.md)
- [Doist/todoist-ai add-tasks.ts](https://github.com/Doist/todoist-ai/blob/main/src/tools/add-tasks.ts)
- [Doist/todoist-ai find-tasks.ts](https://github.com/Doist/todoist-ai/blob/main/src/tools/find-tasks.ts)
- [Doist/todoist-mcp (deprecated)](https://github.com/Doist/todoist-mcp)
- [abhiz123/todoist-mcp-server](https://github.com/abhiz123/todoist-mcp-server)
- [greirson/mcp-todoist](https://github.com/greirson/mcp-todoist)
- [Hint-Services/mcp-todoist](https://github.com/Hint-Services/mcp-todoist)
- [PulseMCP — Official Todoist MCP Server](https://www.pulsemcp.com/servers/todoist)
- [Todoist help — Use ChatGPT with Todoist](https://www.todoist.com/help/articles/use-chatgpt-with-todoist-WEeLx9d8h)
