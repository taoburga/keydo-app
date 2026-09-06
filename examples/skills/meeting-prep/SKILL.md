---
name: meeting-prep
description: Meeting prep notes published into the todo-app calendar pane. Researches the person/meeting from whatever sources are available and publishes a short brief via the todo-app MCP. Use when the user says "prep me for", "meeting prep", "who am I meeting", or names an upcoming call.
---

# /meeting-prep: prep briefs on calendar events

Goal: a short brief the user glances at right before a call. Who they are
meeting, why it matters, and what to raise. Published with `meeting_prep_set`,
it appears as a click-open card on the matching event in the app's calendar
pane.

## Step 1: Check what exists

Call `meeting_prep_get` (todo-app MCP) first:

- Skip meetings that already have a prep (unless asked to refresh).
- Honor `feedback`: `done` marks mean an open loop is handled; `dismiss` means
  "not a real item, never resurface it"; `comment` notes are instructions.

## Step 2: Identify the meeting

Get the event's exact title, date, and start time. The app matches preps to
events by normalized title (or start time), so `title` should match the
calendar event as closely as possible.

<!-- CUSTOMIZE: if your assistant has a calendar MCP, pull today's/tomorrow's
events and prep the ones worth prepping (typically external meetings and
first-time calls, not recurring internal ones). Without a calendar source, ask
the user which meeting to prep and copy the title they give you. -->

## Step 3: Research

Build the brief from whatever is available, best sources first:

- Prior interactions: search tasks (`tasks_search`) for the person's name;
  check open loops from earlier preps (`meeting_prep_get`).
- <!-- CUSTOMIZE: add your sources. Email search, chat history, meeting
  transcripts, CRM, LinkedIn/web search. The skill works with none of them;
  the brief is just thinner. -->

## Step 4: Publish

Call `meeting_prep_set` with:

- `date` (YYYY-MM-DD), `title` (matching the calendar event), `start`
  (ISO 8601, helps matching when titles differ).
- `person`: who it is with, e.g. "Jordan Lee (Acme Corp)".
- `brief`: the prep text, plain text, tight. A good shape:
  1. Context: who they are, how you know them, what happened last time.
  2. Their likely agenda.
  3. Questions or asks worth raising.
- `items`: discrete open loops / follow-ups (max 12 short lines). Each gets
  done/dismiss buttons in the app, so make each one independently actionable.

Preview with `dry_run: true` if unsure. Re-publishing the same date+title
replaces the old brief.

## After the meeting (optional)

If asked "what did I commit to", read the brief's open loops back via
`meeting_prep_get` and turn real commitments into tasks (`tasks_add`, into
the assistant's own list per the MCP routing rules).
