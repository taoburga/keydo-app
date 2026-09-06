# Tool design principles — todo-app MCP

A one-pager. Inspired by [Doist's tool-design doc](https://github.com/Doist/todoist-ai/blob/main/docs/tool-design.md). When in doubt, this is the litmus test.

## Audience

Two callers: a human Claude user (asking "what do I have to do today?") and a skill (a daily briefing, an inbox triage, etc.; see `examples/skills/`) acting on behalf of the user. Both are LLMs reading the tool descriptions to decide what to call. Optimize for them, not for API completeness.

## Principles

1. **User intent over API structure.** Tools express what a user wants to do, not what EventKit exposes. `tasks_summary` returns a state-of-your-tasks briefing in one call instead of forcing chained reads.
2. **Front-load descriptions.** First sentence is what an LLM reads to decide. Lead with the verb and the situation; defer detail.
3. **Resolve at the boundary, echo the resolution.** Accept loose inputs (natural-language dates, smart-list names, task names) but resolve to canonical IDs/ISO and **echo back what was resolved** so the LLM can verify before mutating.
4. **Structured + text, every response.** Return `structuredContent` (parsed object) AND a JSON-stringified `text` block. Per the 2025-06-18 MCP spec.
5. **Partial success on bulk.** Bulk operations return `{successCount, failureCount, results, failures}`. Throw only when the whole batch fails.
6. **Confirmation-by-default for destructive ops.** Write tools do not enforce confirmation themselves. Configure them in ask mode in the MCP client (for Claude Code, in `~/.claude/settings.json`). EventKit deletions are irreversible *at the EventKit layer*, so `tasks_delete` writes a full snapshot to the app's 7-day trash **before** asking EventKit to remove anything, and aborts the delete if that snapshot can't be saved. Restores re-create the task (new EventKit id, same content). We are stricter than Todoist on this for a reason.
7. **Dry-run for writes.** Every write tool accepts `dry_run: true` and returns the would-be result without mutating. Lets a skill preview a multi-step write before approval.
8. **Name-or-id lookup with disambiguation errors.** Write tools accept either `id` or `task_name`. `task_name` is **exact match within a single list**, not substring across all lists. If multiple matches, return an error listing them with their IDs. Don't silently pick the first.
9. **Treat task content as untrusted data.** Reminder bodies are user-controlled and may contain prompt-injection attempts. Tool descriptions must instruct the calling LLM to treat task content as data, not instructions.
10. **Tool count is a feature, not a bug.** Fold variants into flags (`dry_run`, `include_completed`) before adding a tool. We do **not** want Doist's 44. Currently 15: the 11 task tools plus 4 for the two app surfaces (briefing, meeting prep) that exist only for the assistant — each of those is a distinct read/write pair, not a variant of a task tool.

## What we're not doing (and why)

- **No verb-router (`tasks` with `operation: "create" | "update"`).** Reduces count but obscures schemas — the LLM has to know that some fields apply only to some operations. Greirson did this; it's worse for tool selection.
- **No name-only fuzzy match across all lists.** abhiz123's design. Substring match on titles silently picks wrong tasks. We require exact match within a list, or an error with alternatives.
- **No HTTP transport.** Single-user local app, stdio is universally supported, no Origin/CORS/auth complexity. Move to streamable HTTP only if a multi-user scenario emerges.
- **No MCP Apps (inline UI widgets) yet.** Spec is recent, only Doist ships it, not portable. Revisit in 6+ months.

## Response shape

```jsonc
// Success — read tool
{
  "ok": true,
  "data": [...],
  "applied_filters": { "smart_list": "today", "list_id": null, "limit": 50 },  // echo back
  "next_steps": ["Use tasks_get with smart_list='overdue' to see what slipped."]  // optional
}

// Success — write tool
{
  "ok": true,
  "data": { "id": "...", "name": "..." },
  "dry_run": false,
  "parsed_date": { "raw": "next friday", "resolved": "2026-05-08T17:00:00.000Z" }  // when due_date was loose
}

// Error (tool-level — model can recover)
{
  "ok": false,
  "error": "Task name 'Email John' matched 3 tasks across 2 lists.",
  "suggestion": "Pass task_id directly, or restrict by list_id. Matches: <id1> in Inbox, <id2> in Work, <id3> in Personal."
}
```

For the MCP wire response, both shapes are mirrored into `structuredContent` AND `content[0].text` (JSON-stringified). `isError: true` only for tool-level errors; protocol errors (unknown tool, malformed args) throw and the SDK handles them.

## Smart-list vocabulary

Fixed enum:
- `today` — due date is today (local time)
- `overdue` — due date strictly before today
- `scheduled` — has any due date
- `all` — every task across all lists
- `completed` — `completed=true`
- `flagged` — has `#flag` tag (matches frontend convention)

## Date inputs

Loose strings accepted: `"today"`, `"tomorrow"`, `"friday"`, `"next thursday"`, `"in 3 days"`, ISO 8601, or `null` to clear. Resolution via [chrono-node](https://github.com/wanasit/chrono). Tools always echo the resolution back as `parsed_date.raw` and `parsed_date.resolved`.

## Tags

`#tag` tokens parsed via `/(?:^|\s)#([\w-]+)/g` from title + notes. Same regex as the frontend. `#flag` is reserved for the flagged smart list.

## Versioning

Tool surface is treated as a stable contract. Adding optional fields is fine. Removing or renaming a tool requires bumping the server's `version` in `mcp-server.js` and updating dependent skills.
