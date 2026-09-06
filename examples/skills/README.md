# Example Claude skills for the todo-app

Two starter skills that turn the app's briefing pop-up and calendar prep cards
into a daily assistant routine. They are templates: copy them, then edit the
placeholder sections (marked `<!-- CUSTOMIZE -->`) to match your own tools and
priorities.

Prerequisite: the todo-app MCP server registered with your assistant. See
[docs/mcp-install.md](../../docs/mcp-install.md).

## Install (Claude Code)

```bash
mkdir -p ~/.claude/skills
cp -R examples/skills/daily-briefing ~/.claude/skills/
cp -R examples/skills/meeting-prep   ~/.claude/skills/
```

Restart Claude Code, then try:

```
/daily-briefing
/meeting-prep tomorrow
```

## What each one does

- **daily-briefing**: triages your tasks, builds a day plan, and publishes it
  via `briefing_set`. The app pops the briefing up once, the first time you
  open it that day. Reactions you leave in the pop-up (done-marks, comments)
  flow back to the next run through `briefing_get`.
- **meeting-prep**: writes a short prep brief for a calendar event and
  publishes it via `meeting_prep_set`. The app marks the event in its calendar
  pane; clicking it opens the brief, with done/dismiss buttons on each open
  loop that flow back through `meeting_prep_get`.

Both skills work with the todo-app MCP alone. If your assistant also has
calendar, email, or chat access (for example via other MCP servers), the
skills say where to fold that in, but every such source is optional.

## Running the briefing automatically each morning

The pop-up is most useful when the briefing is already there when you open the
app. Options, simplest first:

1. **Claude Code scheduled tasks**: ask Claude to "schedule a task that runs
   /daily-briefing every weekday at 7am".
2. **cron / launchd**: run headless Claude on a schedule:

   ```bash
   claude -p "Run the daily-briefing skill autonomously. Do not ask questions." \
     --allowedTools "mcp__todo-app__*"
   ```

Autonomous runs should stick to the skill's "safe writes" list (see the skill
file): publishing the briefing is always fine; deleting or completing tasks is
not.
