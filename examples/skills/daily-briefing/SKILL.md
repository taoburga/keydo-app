---
name: daily-briefing
description: Daily check-in for the todo-app. Triages tasks, builds an opinionated day plan, and publishes it as the in-app morning briefing pop-up via the todo-app MCP. Use when the user says "daily briefing", "morning brief", "check in", "what's on my plate", or "start my day".
---

# /daily-briefing: daily check-in and in-app briefing

Goal: a lean, opinionated brief. What matters most today, when to do it, and
what is slipping. Publish it into the todo app with `briefing_set` so the app
shows it as a once-a-day pop-up.

## Step 1: Read feedback first

Call `briefing_get` (todo-app MCP). It returns the currently published
briefing plus `feedback`, the user's reactions from the app's pop-up:

- `done` marks on plan items: those are handled; do not resurface them.
- `needs_done` marks: that email/message thread is handled; drop it.
- `comment` notes: direct instructions for THIS run. Honor them.

If a briefing for today already exists, refresh it only if you have materially
new information; otherwise stop.

## Step 2: Gather

In one batch: `tasks_list_lists`, `tasks_summary`, `tasks_get smart_list=overdue`,
and `tasks_history` (what actually got completed / added / deleted since the
last run; use it for the scoreboard and for already-done detection. A task
the user deleted was a deliberate drop, never resurface it).

<!-- CUSTOMIZE: if your assistant has calendar/email/chat MCPs, add them here.
For example: list today's calendar events so the plan can wrap around
meetings, or scan the inbox for messages awaiting a reply. Each source is
optional; the skill works from tasks alone. -->

## Step 3: Build the plan

- Pick 3-5 tasks for today: big rocks first, sized to the free time actually
  available. Name what is deliberately NOT being done.
- Never bump every overdue task to today; propose realistic new dates instead.
- If you use the `#claude` tag convention (see the MCP server instructions),
  tag the picks in place so the plan is backed by real tasks.

## Step 4: Publish

Call `briefing_set` with:

- `date`: today, YYYY-MM-DD (local). The pop-up only fires on this date.
- `headline`: one line for the day.
- `plan`: chronological day map, max 12 rows. Tasks carry `task_id` (from
  `tasks_get`) plus a `slot` ("9:00-10:00") and a one-clause `why`. Calendar
  events go in as `kind: "fixed"` rows so the day reads top to bottom.
- `needs_answer`: messages awaiting the user (only if you have a source for
  them), each with `who`, `what`, `source`, and a `level` (`critical` is rare).
- `keep_in_mind`: max 5 lines, only things that change behavior in ~48h.
- `scoreboard`: one line on how yesterday's plan went (from `tasks_history`).

Preview with `dry_run: true` if unsure. Then give the user the same briefing
in chat, under ~30 lines.

## Safe-writes rule (for scheduled/autonomous runs)

Allowed without asking: `briefing_set`, `meeting_prep_set`, adding tags or due
dates per the MCP server's routing rules, and `tasks_add` into the assistant's
own list. Never in an autonomous run: `tasks_delete`, `tasks_complete`, or
re-dating the user's own tasks. Turn those into proposals inside the briefing
instead.

<!-- CUSTOMIZE: add your own rules. Working hours, weekly rhythms, projects
to always watch, people whose requests jump the queue. -->
