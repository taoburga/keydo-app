// chrono-node wrapper. Accepts loose strings ("tomorrow", "next friday",
// "in 3 days") OR ISO 8601 OR null. Always echoes the resolution back so
// the calling LLM can verify what we did. See docs/tool-design.md.
import * as chrono from 'chrono-node';

// Returns { ok: true, iso: '...' | null, raw: '...' } on success
//      or { ok: false, raw, error: '...' } on unparseable.
// `null` and empty string both resolve to `{ ok: true, iso: null, raw }` —
// caller treats that as "clear the date".
//
// Bare "YYYY-MM-DD" input additionally sets `dateOnly: 'YYYY-MM-DD'`. Write
// paths should send that to the daemon verbatim (it stores date-only
// components = an all-day reminder); `iso` stays populated (local 17:00) so
// filter/comparison callers keep working unchanged.
export function parseLooseDate(input, { reference = new Date() } = {}) {
  if (input === null || input === undefined || input === '') {
    return { ok: true, iso: null, raw: input ?? null };
  }
  if (typeof input !== 'string') {
    return { ok: false, raw: String(input), error: 'date must be a string or null' };
  }
  const raw = input.trim();
  if (!raw) return { ok: true, iso: null, raw };

  // ISO short-circuit — chrono parses ISO too, but we want full date-times to
  // round-trip exactly without re-interpretation.
  //
  // Date-only strings need special care: `new Date('2026-05-15')` is UTC
  // midnight per the ECMAScript spec, which in any US timezone is the
  // *previous evening* local — the task would land a day early. Build those
  // as a local date instead, defaulting to 17:00 like the chrono no-time path.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, mo, da] = dateOnly.map(Number);
    const d = new Date(y, mo - 1, da, 17, 0, 0, 0);
    if (Number.isNaN(d.getTime()) || d.getDate() !== da || d.getMonth() !== mo - 1) {
      return { ok: false, raw, error: `not a valid ISO date: ${raw}` };
    }
    return { ok: true, iso: d.toISOString(), dateOnly: raw, raw };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, raw, error: `not a valid ISO date: ${raw}` };
    }
    return { ok: true, iso: d.toISOString(), raw };
  }

  const parsed = chrono.parse(raw, reference, { forwardDate: true });
  if (!parsed.length) {
    return { ok: false, raw, error: `couldn't parse "${raw}" as a date` };
  }
  const date = parsed[0].start.date();
  // If the user didn't specify a time, default to 17:00 local — same as
  // EOD-ish convention for tasks. chrono leaves it as midnight otherwise,
  // which causes "due today" to render as already-overdue immediately.
  const hasTime = parsed[0].start.isCertain('hour') || parsed[0].start.isCertain('minute');
  if (!hasTime) {
    date.setHours(17, 0, 0, 0);
  }
  return { ok: true, iso: date.toISOString(), raw };
}
