# Installing the todo-app MCP server from keydo-app

This doc covers wiring `mcp-server.js` into Claude Code (and other MCP clients) so a local AI assistant can read and write your tasks.

## Prerequisites

- Node 20+ (`node` is resolved from PATH)
- The Swift daemon built once (`./start.sh` or `bash daemon/build.sh` does it). Reminders access is granted per host app, so expect a fresh macOS prompt the first time each MCP client calls a tool; see "Permissions" below.
- This repo cloned somewhere on your machine (the paths below use `/path/to/keydo-app/`; substitute your actual clone location)

## Claude Code (recommended)

Register the server with the `claude mcp add` command (Claude Code does **not**
read MCP servers from `settings.json`). From anywhere:

```bash
claude mcp add --scope user todo-app -- node /absolute/path/to/keydo-app/mcp-server.js
```

`--scope user` registers it globally, so the tools work in every Claude Code
project. Drop `--scope user` to register it only for the current project. To
remove it later: `claude mcp remove --scope user todo-app`.

Then, to make the write tools prompt before each call (reads auto-allow),
add the ask-list to `~/.claude/settings.json`:

```jsonc
{
  "permissions": {
    "ask": [
      "mcp__todo-app__tasks_add",
      "mcp__todo-app__tasks_add_bulk",
      "mcp__todo-app__tasks_update",
      "mcp__todo-app__tasks_complete",
      "mcp__todo-app__tasks_delete",
      "mcp__todo-app__briefing_set",
      "mcp__todo-app__meeting_prep_set"
    ]
  }
}
```

(`briefing_set` and `meeting_prep_set` only write display data for the app's
briefing pop-up and calendar prep cards; they never touch tasks. If you
schedule an autonomous morning briefing, move those two to the allow list.)

Restart Claude Code. Run `/mcp` to verify `todo-app` shows up. Read tools
(`tasks_list_lists`, `tasks_get`, etc.) auto-allow; write tools prompt before each call.

## Claude Desktop

Same shape, but in `~/Library/Application Support/Claude/claude_desktop_config.json`. Claude Desktop doesn't honor the `permissions.ask` list — confirmation behavior is controlled by the user accepting/denying each tool call.

## Verifying the install

From a fresh Claude Code session:

```
> What tools does the todo-app MCP expose?
> Use tasks_list_lists to show my reminder lists.
> Run tasks_summary and tell me what's most pressing.
```

If you see "Reminders access denied", the host app that launched the MCP server has not been granted Reminders access yet. See "Permissions" below.

## Permissions (Reminders and Calendars)

macOS grants Reminders and Calendars access **per host application**, not per binary. The daemon inherits the permission of whichever app launched it, so each of these needs its own grant:

- **Todo.app** (the native shell) — prompted on first launch.
- **Terminal** (or iTerm, etc.) — prompted the first time you run `./start.sh` or the MCP server from a terminal session.
- **Claude Code** — prompted the first time a tool call reaches the daemon from a Claude Code session. If Claude Code itself runs inside a terminal, the grant belongs to that terminal app.
- **Claude Desktop** (or any other MCP client) — prompted separately on its first tool call.

Granting access in one host does nothing for the others. If a prompt was dismissed or denied, re-enable it in System Settings → Privacy & Security → **Reminders** (and **Calendars**, if you use the calendar pane or `meeting_prep_*` tools) for that host app, then restart the client. The Calendars prompt is lazy: it appears the first time the calendar pane or a calendar-reading tool is used, never at startup.

## Tool surface (15 tools)

Read (8):
- `tasks_list_lists` — discover lists
- `tasks_get` — filter by list / smart-list / tag / priority / date range
- `tasks_search` — full-text substring across all tasks
- `tasks_get_tags` — `#tag` index with counts
- `tasks_summary` — one-call state-of-your-tasks briefing for daily check-ins
- `tasks_history` — log of task lifecycle events (added / completed / deleted) from every surface, for scoreboards and already-done detection
- `briefing_get` — the currently published in-app briefing, plus the user's reactions to it (done-marks, comments)
- `meeting_prep_get` — published preps plus the user's done/dismiss reactions from the prep card

Write (5 task tools, all gated):
- `tasks_add` — single task
- `tasks_add_bulk` — up to 25 tasks, partial-success response
- `tasks_update` — id-or-name lookup, `dry_run` previews
- `tasks_complete` — toggle complete (or uncomplete)
- `tasks_delete` — saves a full snapshot to the 7-day recoverable trash, then deletes; aborts rather than deleting if that snapshot can't be saved. Previews with `dry_run`

Publish (2, display-only: they write app UI data, never tasks):
- `briefing_set` — publish the morning briefing the app pops up once a day
- `meeting_prep_set` — publish a prep brief shown on a calendar-pane event

All write tools accept `dry_run: true` to preview without mutating. Lookup tools accept either `task_id` (from a previous read) or `task_name` (exact match within an optional `list_id`).

## Daily briefing and meeting prep

The app has two assistant-facing surfaces beyond tasks: a once-a-day briefing
pop-up (`briefing_set` / `briefing_get`) and prep cards on calendar events
(`meeting_prep_set` / `meeting_prep_get`). Ready-to-copy starter skills that
drive them (a daily check-in and a meeting-prep flow, including how to run
the briefing automatically every morning) live in
[examples/skills/](../examples/skills/README.md).

## Example assistant integrations

Some ways an assistant can use these tools in a daily workflow:

- A morning-briefing command can call `tasks_summary` once, build a day plan, and publish it with `briefing_set` (see [examples/skills/](../examples/skills/README.md)).
- An inbox-triage flow can call `tasks_add_bulk` to turn follow-up emails into tasks in one approval.
- A drafting flow can call `tasks_add` when you commit to something ("I'll do X by Friday") so it lands somewhere.

## Security notes

- The routing convention in the server instructions sends assistant-generated tasks to a Reminders list named `Claude` by default. Set `TODO_APP_ASSISTANT_LIST` in the server's environment (`claude mcp add -e TODO_APP_ASSISTANT_LIST=Assistant ...`) to use another name. Person tags (`#firstname`) are opt-in: the assistant only follows the pattern if you already tag tasks that way.
- Task names and notes are user-controlled. Tool descriptions instruct calling LLMs to treat them as data, not instructions. Don't loosen this in tool descriptions.
- The daemon talks to EventKit directly. Deletes are recoverable: `tasks_delete` snapshots the task into a 7-day trash bin (restorable from the app). Even so, prefer `tasks_complete` for tasks you've actually finished.
- ask-mode on writes is a hard requirement until `dry_run` previews are battle-tested in real flows.
