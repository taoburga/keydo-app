# Security

This is a single-user macOS app that runs entirely on your own machine.

- The local server binds to `127.0.0.1` only and validates the `Host` header (a defense against DNS-rebinding). Nothing listens on your network.
- Your tasks live in Apple Reminders (via EventKit) and sync through your own iCloud account. This app stores no task data of its own on any server.
- The app makes exactly one kind of outbound request: fetching the `<title>` of a link you save to a task. That request is blocked from reaching private/loopback addresses (an SSRF guard) and is size- and time-capped. There is **no analytics or telemetry** of any kind.
- The optional MCP server (`mcp-server.js`) lets a local AI assistant (e.g. Claude Code) read and write your Reminders. Its write tools are designed to run in "ask" mode so you approve each change, and every write tool supports a `dry_run` preview. See the README's MCP section before enabling it.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private vulnerability reporting on this repository: the **Security** tab → **Report a vulnerability**. I'll respond as soon as I reasonably can. This is a personal project, so please calibrate expectations accordingly — but I take loopback / EventKit / SSRF issues seriously.
