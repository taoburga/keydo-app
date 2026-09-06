# MCP Server Plan — BUILT (2026-05-01)

> **Historical design document.** Kept for the reasoning behind the tool surface. Where it disagrees with the code, the code wins: the shipped server has **15 tools** (not 9), `tasks_delete` moves tasks to the app's 7-day trash (not a permanent delete), and installation uses `claude mcp add` as described in [`docs/mcp-install.md`](./mcp-install.md), not a `settings.json` block. The "open questions" and phase estimates at the bottom were resolved before shipping.

**Status:** ✅ **Shipped.** v1 + v2 + v3 all in `main`. See `mcp-server.js`, `lib/mcp-tools.js`, `lib/date-parse.js`, `lib/summary.js`. Install instructions: [`docs/mcp-install.md`](./mcp-install.md). Principles: [`docs/tool-design.md`](./tool-design.md). Research that informed it: [`docs/todoist-mcp-research.md`](./todoist-mcp-research.md).

**Original goal:** let other assistant sessions (a daily-briefing skill, an inbox-triage skill, ad-hoc Claude Code conversations) read/write the user's task data via Model Context Protocol.

---

## TL;DR

Build **9 tools** behind a **Node MCP server using stdio** in `keydo-app/mcp-server.js`, sharing the existing Swift daemon via the existing `lib/reminders.js` client. Phase: **v1 read-only (4–6h) → v2 writes with ask-mode (3–4h) → v3 `tasks_summary` + skill integrations (2–3h)**. Total: ~10h over 2-3 sessions. Eval the descriptions with 15-20 behavioral prompts before each promotion.

The architecture decision is **Option A** (standalone Node MCP server). Alternatives (HTTP endpoints on the existing server, Swift-based MCP) considered and rejected — stdio is the universally supported MCP transport, our Swift daemon is already designed around exactly the pattern we'd want.

The killer feature is `tasks_summary` — it lets a daily-briefing skill get a full briefing in one call.

---

## Tool surface (9 total)

### Read-only (5)
| Tool | Description (front-loaded, what Claude reads to decide) |
|---|---|
| `tasks_list_lists` | Return all reminder lists with incomplete-task counts. Call this first to discover available lists before adding or filtering tasks. |
| `tasks_get` | Get tasks from a list, smart list (today/scheduled/overdue/all/completed/flagged), or tag. Filters: `include_completed`, `due_before`, `due_after`, `priority`, `limit`. |
| `tasks_search` | Full-text search task titles and notes across all lists. Case-insensitive substring match. Returns up to 50 best matches sorted by recency. |
| `tasks_summary` | High-level state-of-your-tasks briefing: counts and top items for overdue / today / upcoming this week / by priority. Use this for daily check-ins instead of multiple `tasks_get` calls. |
| `tasks_get_tags` | Return all `#tag` tokens parsed from titles+notes with counts. |

### Write (4) — all require user confirmation in calling Claude
| Tool | Description |
|---|---|
| `tasks_add` | Create a task. Required: `list_id`, `name`. Optional: notes, url, due_date, priority, recurrence, alarms, tags. |
| `tasks_update` | Update an existing task by id. Pass only the fields to change. Pass `null` to clear due_date / notes / url. |
| `tasks_complete` | Mark a task complete (or uncomplete). |
| `tasks_delete` | Delete a task (as shipped: moved to the app's 7-day trash first, see banner above). Prefer `tasks_complete` if unsure. |

---

## Architecture: Option A — Node MCP server, shared Swift daemon

```
Claude Code  ←(stdio JSON-RPC)→  mcp-server.js
                                       │
                                       │ imports lib/reminders.js
                                       ▼
                                 Swift daemon (auto-spawned)
                                       │
                                       ▼
                                  EventKit → Reminders DB
```

**Why A:**
- stdio is MCP's universally supported transport (every client supports it; no Origin/CORS/auth concerns).
- We share `lib/reminders.js` directly — zero duplication.
- Each Claude session gets its own daemon process (~30MB extra RAM each, EventKit is multi-process safe).

**Why not B (HTTP /mcp endpoints on existing server):** Streamable HTTP transport adds Origin validation, CORS, session management for zero benefit on a local single-user setup.

**Why not C (Swift MCP):** Reimplementing MCP SDK in Swift is a week of yak-shaving for no user-facing benefit.

---

## File layout

```
keydo-app/
  mcp-server.js          NEW — MCP entry point, ~150 lines
  lib/
    reminders.js         (unchanged)
    mcp-tools.js         NEW — tool definitions + handlers, ~250 lines
    summary.js           NEW — pure functions for tasks_summary, ~100 lines
  bin/reminders-daemon   (unchanged)
  package.json           add @modelcontextprotocol/sdk; add bin entry
```

Sketch of `mcp-server.js`:
```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, handlers } from './lib/mcp-tools.js';

const server = new Server(
  { name: 'todo-app', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({ tools }));
server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: args } = req.params;
  const handler = handlers[name];
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    const result = await handler(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `${name} failed: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
```

---

## Installation (after building)

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "todo-app": {
      "command": "node",
      "args": ["/absolute/path/to/keydo-app/mcp-server.js"]
    }
  },
  "permissions": {
    "ask": [
      "mcp__todo-app__tasks_add",
      "mcp__todo-app__tasks_update",
      "mcp__todo-app__tasks_complete",
      "mcp__todo-app__tasks_delete"
    ]
  }
}
```

---

## Phased rollout

**v1 — read-only MVP (4–6h):**
- mcp-server.js skeleton + stdio transport
- `tasks_list_lists`, `tasks_get`, `tasks_search`, `tasks_get_tags`
- Smart-list semantics (today/overdue/scheduled/all/completed/flagged)
- Behavioral eval suite v1 (10 prompts)
- Register, smoke-test from a fresh Claude session

**v2 — writes with confirmation (3–4h):**
- `tasks_add`, `tasks_update`, `tasks_complete`, `tasks_delete`
- ask-mode in permissions
- Eval suite v2 (5 write prompts; check that calling Claude asks before invoking)
- Wire `tasks_add` into an email-drafting skill (when an email yields a follow-up)

**v3 — smart summaries + skill integrations (2–3h):**
- `tasks_summary`
- Update the daily-briefing skill to call it
- Update the inbox-triage skill to call `tasks_add` on P1 follow-ups
- `tags` filter on `tasks_get`
- Eval suite v3

---

## Open questions to resolve before building

1. **Tag parsing in JS or Swift?** Recommend JS (`lib/mcp-tools.js`) — keeps Swift simple.
2. **`flagged` smart list** — fake via `#flag` tag (matches the frontend convention).
3. **Subtasks?** Skip in v1 (local-only currently). v3+ if migrated to `parentIdentifier` KVC.
4. **Multiple Reminders sources** (iCloud, On My Mac) — `tasks_summary` aggregates across all; consider per-source filter if it gets noisy.
5. **Date input from calling Claudes** — accept loose strings (`"tomorrow"`, `"Friday"`), normalize via [chrono-node](https://github.com/wanasit/chrono) before forwarding to daemon.
6. **TCC re-prompt risk.** Reminders access is authorized in the context of the host application. The native app, Claude Desktop, Codex, Terminal, and other launchers may each need approval, and rebuilding or moving the executable can prompt again. Add a 5-second timeout on initial `ping` with a clear error message.
7. **Prompt-injection surface.** Reminder bodies are user-controlled. Mitigation: configure write tools to require confirmation in the MCP client. v3 hardening: sanitization pass.

---

## Key best-practices from research (cited)

- Tool surface size: 5–8 ideal, 8–12 reasonable, >15 hurts tool selection.
- Naming: `snake_case`, verb-noun, ≤64 chars, prefixed by domain (`tasks_*`).
- Descriptions: front-load. First sentence is what an LLM reads to decide.
- Schemas: required fields explicit, sensible defaults, `enum` for fixed sets, provide `outputSchema`.
- Response shape: include both `text` (JSON-stringified) AND `structuredContent` (parsed object) per the 2025-06-18 spec.
- Errors: protocol-level for unknown tool/bad params; tool-level (`isError: true`) for "not found" / "permission denied" so the model can recover.
- Hint at alternatives in error messages: "list 'work' not found. Available: Inbox, Personal, Work (with capital W)."
- Smart batched tools (`tasks_summary`) beat one-shot CRUD chains.

---

## Subtasks: nesting via tag-encoding

`#par-<id>` tag. **Implemented 2026-06-27.** Lets the MCP (or any external client) create nested
subtasks even though the parent/child hierarchy lives only in browser
localStorage, which the daemon/server/MCP can't touch.

### The problem
`state.parentMap` (`{ childId: parentId }`) is local-only. EventKit exposes no
subtask field, so a task added through the MCP could only ever land flat. We
needed a parent link that rides along inside an EventKit field (the title) and
survives iCloud sync.

### The mechanism
1. **Encode.** `tasks_add` accepts `parent_id` (an existing task's EventKit id).
   `_applyParentTag` (lib/mcp-tools.js) appends a hidden ` #par-<parentId>` to
   the title. Idempotent; no-op when `parent_id` is absent.
2. **Hide.** `INTERNAL_TAG_RE` already strips `#flag`/`#sec-<slug>`/`#par-<id>`
   from rendered titles. `_isInternalTag` (app.js) / `INTERNAL_TAG_PREFIX`
   (mcp-tools.js) keep them out of the sidebar tag list, tag chips, and the MCP
   `tags` output, so the plumbing never shows as a browsable tag.
3. **Ingest once.** On every load/refresh, `_ingestParentTags` (app.js) reads
   each `#par-<id>` into `state.parentMap` — but only the *first* time it sees a
   given task id. Seeded ids are recorded in `state.ingestedParents`
   (`ING_KEY = todo-app:ingestedParents:v1`). Hooked into both load paths
   (`refreshAllTasks` for all-tasks views, the list-view branch of `loadTasks`)
   so nesting appears live via the existing SSE refresh, no restart needed.

### Why seed-once
The tag and `parentMap` are two sources of truth. If we re-applied the tag on
every load, a manual move (drag / indent / outdent) would get snapped back to
the tagged parent on the next sync — the feature would fight the user. Seeding
exactly once makes the tag an *import seed*: after first sight, local state is
authoritative and moves stick. The tag stays in EventKit (so the hierarchy is
iCloud-portable and survives a localStorage wipe — a wipe re-seeds the original
layout) but is otherwise inert.

### Bookkeeping
`ingestedParents` is a task-id-keyed set, so it joins the other local maps in
the daily GC (`_gcLocalMaps` drops ids no longer live) and in
`_purgeTaskLocalRefs` (forgets an id on delete, so a future task reusing it can
re-seed). Capture is case-preserving (`PAR_TAG_RE`, no `/i` lowercasing of the
group) because EventKit ids are case-sensitive — unlike `tagsInTask`, which
lowercases for display tags.

### Limitations / future work
- **Re-parenting** by writing a *new* `#par-` tag won't take — the id is already
  in `ingestedParents`. Move the task in the UI instead. (A future
  re-parent-via-tag would need a tag→link reconciler that overrides local state,
  which reintroduces the snap-back tension; deferred until there's a real need.)
- **Bulk ordering:** a child can't reference a parent created in the *same*
  `tasks_add_bulk` call (the parent id isn't known until it exists). Create
  parents first, then pass their returned ids.
- **Sections (`#sec-<slug>`)** are reserved and display-hidden but not yet
  ingested — the same pattern would apply when sections need to be MCP-writable.
- **MCP server reload:** the `parent_id` param only goes live after the stdio
  MCP server restarts (it loads `lib/mcp-tools.js` at startup). Until then,
  encode `#par-<id>` directly in the `name` field — same on-disk result.

---

## Sources

- [MCP Tools spec](https://modelcontextprotocol.io/docs/concepts/tools)
- [MCP Transports spec](https://modelcontextprotocol.io/docs/concepts/transports)
- [AWS Labs MCP Design Guidelines](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md)
- [Merge.dev — MCP Tool Descriptions](https://www.merge.dev/blog/mcp-tool-description)
- [awesome-mcp-best-practices](https://github.com/lirantal/awesome-mcp-best-practices)
- [FradSer/mcp-server-apple-reminders](https://github.com/FradSer/mcp-server-apple-reminders)
- [Krishna-Desiraju/apple-reminders-swift-mcp-server](https://github.com/Krishna-Desiraju/apple-reminders-swift-mcp-server)
- [snarris/apple-eventkit-mcp](https://github.com/snarris/apple-eventkit-mcp)
