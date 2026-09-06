# reports/ — issue reports

User-filed bug reports and feature requests land here as markdown files. Created
from the app via **⌘K → "Report a bug"** or **"Request a feature"** (handler:
`openReportModal` in `public/app.js` → `POST /api/report` → `saveReport` in
`server.js`).

Everything in this folder **except this README is gitignored** — reports are
local logs, not source, and they are never committed.

## File format

Filename: `report-YYYY-MM-DD-HHMMSS-xxxx.md` (local date/time + 4 random hex).

````markdown
---
id: 2026-06-25-143022-3f9a
type: bug              # bug | feature
status: open           # open | fixed | wontfix
created: 2026-06-25T18:30:22.123Z
fixed:                 # date set when resolved
app_version: a7ad818   # git short sha the app was running
source: local          # 'local' = this machine; a beta build would carry a tester id
---

# Bug: <first line of the report>

## Report
<what the user typed>

## Diagnostics (captured automatically — content-free)
```json
{ ...counts, settings, viewport, redacted recent errors/breadcrumbs... }
```

## Resolution
_open — not yet addressed_
````

### Privacy

The diagnostics block is **content-free by construction**: counts, enums,
settings, localStorage key *sizes*, and *redacted* error/breadcrumb strings —
**never task names, notes, or URLs**. This invariant is what would let a future
"send to the maintainer" transport reuse the same envelope without leaking
testers' task data. If you extend `_buildDiagnostics` in `app.js`, keep it that way.

The envelope carries (all content-free):
- `app` / `view` / `counts` / `settings` / `storage` — viewport, current view,
  task/list counts, toggles, localStorage key sizes.
- `sync` — live-sync health: SSE `readyState`, seconds since last refresh,
  in-flight saves, pending refresh. Catches "edit didn't stick / sync froze".
- `breadcrumbs` — the last ~25 **actions** (content-free verbs like
  `complete task`, `priority → high`, `reorder task (drag)`, `undo → patch`),
  not just navigation. This is usually what makes a vague report reproducible.
- `recentErrors` + `lastError` — fixed error categories **and trimmed stacks**
  (message text is discarded; file paths are stripped to basenames). `lastError` survives ring-buffer eviction
  so a single real crash isn't pushed out by a burst of benign errors.
- `serverEnv` — added **server-side** in `saveReport` (`server.js`), so it's
  authoritative and unspoofable: Node version, arch, real macOS version (the
  WKWebView userAgent lies — reports `10_15_7`), Darwin kernel ver, daemon
  binary build date (catches stale builds), server uptime. Keep it content-free.

## Sharing a tester's reports

The report modal stays local and fast: each submission writes one ignored file
here. When a tester is ready to send feedback, ⌘K → **Export bug reports &
feature requests — copy for email** collects every report whose frontmatter is
still `status: open`, sorts them by filename, and copies one structured Markdown
packet. They can paste that packet into an email or directly into Claude.

Export never sends anything over the network and never marks or deletes a local
report. Re-running it is safe. Fixed/wontfix reports are excluded.

## Triaging reports

Reports are local-only — they stay on the machine that filed them and are never pushed.
The maintainer reads the files with `status: open`, fixes or queues each one, then updates
the report's frontmatter so it isn't re-investigated later:

- set `status: fixed` (or `wontfix`),
- set `fixed:` to the date,
- replace the `## Resolution` placeholder with what changed (and the commit sha, if any).
