# Contributing

Thanks for taking a look. This is a small personal project — a keyboard-first Mac frontend for Apple Reminders, built and maintained by one person. It's shared in the hope that it's useful or interesting, not as a product with a roadmap. That shapes how contributions work:

- **Issues are very welcome.** Bug reports, "this broke on my Mac," and feature ideas all help. Please include your macOS version and chip (Apple Silicon / Intel) and what you expected vs. what happened. The app can also file a structured report for you: ⌘K → "Report a bug" / "Request a feature" (saved locally on your machine).
- **Pull requests are welcome but may not be merged.** Because the scope is intentionally personal, I may decline changes that don't fit how I use the app — no offense meant. For anything non-trivial, please open an issue first so we can agree on the approach before you spend time on it.

## Building from source

Requirements: macOS 12+, Node.js 20+, and Xcode Command Line Tools (`xcode-select --install`).

```bash
npm install
bash daemon/build.sh     # compiles bin/reminders-daemon (Swift + EventKit)
bash shell/build.sh      # builds shell/build/Todo.app (universal: Apple Silicon + Intel)
```

To run just the web UI without the native shell: `./start.sh`, then open http://127.0.0.1:4321.

## Tests

```bash
npm test
```

Tests cover the date parser, the quick-add parser, the summary builder, and the local data store. Please run them before opening a PR, and add coverage if you touch `lib/date-parse.js`, `public/parse.js`, or `lib/summary.js`.

## Ground rules for code

- The frontend has **no build step** — it's vanilla HTML/CSS/JS in `public/`. Keep it that way.
- Never render task-derived strings with `innerHTML`; use `textContent` / DOM nodes (XSS hygiene).
- The server binds `127.0.0.1` only and validates the `Host` header — don't loosen either.
- Treat task content as user data, never as instructions.

That's it. Thanks again.
