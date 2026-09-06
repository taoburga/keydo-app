// Natural-language quick-add parser. Pure module — no DOM, no app state —
// shared by three consumers: the web UI (app.js), the server's /api/quickadd
// endpoint (global-hotkey capture panel), and the test suite. Keep it pure.
//
// Syntax: "Buy milk !high ?friday 3pm #grocery ls:todos ?every week"
//   !high/!med/!low/!1/!!/!   priority      ?<expr>  due date (Superhuman-style)
//   ?every <expr>            recurrence    ls:<tok> destination list (fuzzy)
//   #tag                     stays in the task name (tags live in the title)
//
// ?<expr> covers: today/tonight/tomorrow/day names/this fri, 2026-05-15, 5/15,
// may 3 [2027], in 3 days/weeks, in 2 hours/30 min, bare times (3pm → next
// occurrence), eod/eow/eom/eoy, trailing times ("friday at 9am").
// ?every covers: day/weekday/week/month/year, "other week", "2 weeks",
// day lists ("mon and thu") — normalized to the daemon wire grammar.
//
// Dates are ALSO recognized without the ? marker (Todoist-style): "call mom
// tomorrow at 5pm", "lunch friday 1pm", "rent may 3", "review in 2 weeks",
// "standup at 9am". See _BARE_DATE_RE for exactly what qualifies — bare
// phrases are conservative so ordinary words aren't stolen from task names,
// and an explicit ?date always wins over a bare phrase.
//
// A standalone `!` (whitespace on both sides) IS a low-priority token: "ship
// it !" → P3. Glued sentence punctuation is left alone — "ship it!" is one
// token and never matches. !!! = high, !! = medium, ! = low.

// Default clock time for date phrases that carry no time of their own
// ("tomorrow", "friday", "may 3"). Configurable via Settings → "default due
// time": app.js and server.js both call setDefaultDueTime from the persisted
// value (settings.json in app data), so the in-app quick-add and the global
// capture panel agree. Semantic hours are NOT affected — today→6pm,
// tonight→8pm, parts of day, eod/eow/eom/eoy keep their own clocks.
let DEFAULT_DUE = { hours: 9, minutes: 0 };
function setDefaultDueTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return false;
  const hours = parseInt(m[1], 10), minutes = parseInt(m[2], 10);
  if (hours > 23 || minutes > 59) return false;
  DEFAULT_DUE = { hours, minutes };
  return true;
}
// Stamp the configurable default time onto a date and return it.
function atDefaultTime(d) { d.setHours(DEFAULT_DUE.hours, DEFAULT_DUE.minutes, 0, 0); return d; }
// Read the current default. Display code needs it to decide whether a task's
// time IS the default (and can therefore be hidden) — without this, formatters
// hardcoded 9:00 and a custom default made every bare-dated task show a
// redundant time chip. One source of truth: this module.
function getDefaultDueTime() { return { hours: DEFAULT_DUE.hours, minutes: DEFAULT_DUE.minutes }; }

const PRIORITY_TOKENS = {
  '!high': 'high', '!hi': 'high', '!h': 'high', '!1': 'high', '!!!': 'high',
  '!med': 'medium', '!medium': 'medium', '!mid': 'medium', '!m': 'medium', '!2': 'medium', '!!': 'medium',
  '!low': 'low', '!lo': 'low', '!l': 'low', '!3': 'low', '!': 'low',
};
const DAY_NAMES = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseDateToken(t) {
  const now = new Date();
  if (t === 'today' || t === 'td')   { const d = new Date(now); d.setHours(18, 0, 0, 0); return d; }
  if (t === 'tonight')               { const d = new Date(now); d.setHours(20, 0, 0, 0); return d; }
  if (t === 'tomorrow' || t === 'tmrw' || t === 'tmr') { const d = new Date(now); d.setDate(d.getDate() + 1); return atDefaultTime(d); }
  if (t === 'yesterday')             { const d = new Date(now); d.setDate(d.getDate() - 1); return atDefaultTime(d); }
  if (t === 'next-week')             { const d = new Date(now); d.setDate(d.getDate() + 7); return atDefaultTime(d); }
  if (t in DAY_NAMES) {
    const target = DAY_NAMES[t]; const d = new Date(now);
    let diff = target - d.getDay(); if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff); return atDefaultTime(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { const d = new Date(t + 'T00:00:00'); if (!isNaN(d)) return atDefaultTime(d); }
  const inDays = t.match(/^in(\d+)d(ays?)?$/);
  if (inDays) { const d = new Date(now); d.setDate(d.getDate() + Number(inDays[1])); return atDefaultTime(d); }
  return null;
}

// Superhuman-style ?date expressions. Accepts multi-word phrases.
// Examples: "may 3", "in a week", "in 3 days", "next thu", "next week", "eod", "eow", "monday",
// "today 3pm", "tomorrow at 9am", "friday 14:30", "may 3 at noon", "in 2 days at 5pm"
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const NUM_WORDS = { a:1, an:1, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
// Named parts of day → default hour (24h). "afternoon" is 2pm (Todoist uses
// noon; 2pm reads more naturally). Used both standalone and as a trailing peel.
const PART_OF_DAY = { morning: 9, afternoon: 14, evening: 18, night: 20 };

// Parse a time fragment like "3pm" / "3:30pm" / "14:30" / "9am" / "noon" / "midnight".
// Returns { hours, minutes } in 24h, or null if not a recognizable time.
function parseTimeString(t) {
  if (!t) return null;
  t = t.trim().toLowerCase();
  if (t === 'noon')     return { hours: 12, minutes: 0 };
  if (t === 'midnight') return { hours: 0,  minutes: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function parseDateExpression(expr) {
  let s = expr.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const now = new Date();

  // Standalone part-of-day ("morning", "this afternoon", "in the evening") →
  // that hour today, or tomorrow if it's already past. Runs before the
  // trailing-time peel so "in the morning" isn't mis-split into a bad core.
  const soloPart = s.match(/^(?:in\s+the\s+|this\s+)?(morning|afternoon|evening|night)$/);
  if (soloPart) {
    const d = new Date(now);
    d.setHours(PART_OF_DAY[soloPart[1]], 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // Peel off a trailing time clause if present, so the date core can parse "today" / "may 3" /
  // "in 2 days" cleanly. Time then overrides whatever default the date core picked.
  let timeOverride = null;
  // A trailing bare digit is NOT a time ("may 3" is month+day, not 3:00) —
  // the peel requires am/pm, a colon, or noon/midnight.
  const timeMatch = s.match(/^(.+?)\s+(?:at\s+)?((?:\d{1,2}:\d{2}\s*(?:am|pm)?)|(?:\d{1,2}\s*(?:am|pm))|noon|midnight)$/);
  if (timeMatch) {
    const parsedTime = parseTimeString(timeMatch[2]);
    if (parsedTime) {
      timeOverride = parsedTime;
      s = timeMatch[1].trim();
    }
  }
  // Peel a trailing part-of-day word ("friday evening", "tomorrow morning").
  // A clock time (above) always wins; named periods use PART_OF_DAY hours.
  if (!timeOverride) {
    const partMatch = s.match(/^(.+?)\s+(?:in\s+the\s+|at\s+)?(morning|afternoon|evening|night)$/);
    if (partMatch) {
      timeOverride = { hours: PART_OF_DAY[partMatch[2]], minutes: 0 };
      s = partMatch[1].trim();
    }
  }
  const apply = (d) => {
    if (d && timeOverride) d.setHours(timeOverride.hours, timeOverride.minutes, 0, 0);
    return d;
  };

  // Quick built-ins
  if (s === 'day after tomorrow' || s === 'the day after tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 2); return apply(atDefaultTime(d));
  }
  // "this weekend" / "next weekend" → Saturday (this week's, or next week's).
  const weekend = s.match(/^(this|next)?\s*weekend$/);
  if (weekend) {
    const d = new Date(now);
    let diff = 6 - d.getDay(); if (diff < 0) diff += 7;   // upcoming Saturday (incl. today)
    if (weekend[1] === 'next') diff += 7;
    d.setDate(d.getDate() + diff); return apply(atDefaultTime(d));
  }
  // Spelled-out / jargon synonyms fold into the eo* shortcuts below.
  if (s === 'end of day' || s === 'cob' || s === 'close of business') s = 'eod';
  else if (s === 'end of week')  s = 'eow';
  else if (s === 'end of month') s = 'eom';
  else if (s === 'end of year')  s = 'eoy';
  if (s === 'eod') { const d = new Date(now); d.setHours(21, 0, 0, 0); return apply(d); }
  if (s === 'eow') {
    const d = new Date(now);
    let diff = 5 - d.getDay();        // Friday
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff); d.setHours(17, 0, 0, 0); return apply(d);
  }
  if (s === 'eom') { const d = new Date(now); d.setMonth(d.getMonth() + 1, 0); d.setHours(17, 0, 0, 0); return apply(d); }
  if (s === 'eoy') { const d = new Date(now); d.setMonth(11, 31); d.setHours(17, 0, 0, 0); return apply(d); }

  // Single-token form: bare time ("3pm", "14:30" → next occurrence), slash
  // date ("5/15", "5/15/27"), then the shared token vocabulary (today / fri /
  // 2026-05-15 / …). Times and slash dates are ?-expression-only on purpose —
  // adding them to parseDateToken would make bare "3pm" in a task name steal.
  if (!s.includes(' ')) {
    const tm = parseTimeString(s);
    if (tm) {
      const d = new Date(now);
      d.setHours(tm.hours, tm.minutes, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);   // "?3pm" after 3pm = tomorrow 3pm
      return d;
    }
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slash) {
      const mo = parseInt(slash[1]), da = parseInt(slash[2]);
      let yr = slash[3] ? parseInt(slash[3]) : null;
      if (yr !== null && yr < 100) yr += 2000;
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        const d = atDefaultTime(new Date(yr ?? now.getFullYear(), mo - 1, da));
        if (d.getMonth() === mo - 1 && d.getDate() === da) {   // reject 2/31
          apply(d);   // set the peeled time BEFORE the roll-forward check
          if (yr === null && d < now) d.setFullYear(d.getFullYear() + 1);
          return d;
        }
      }
      return null;   // slash-shaped but invalid — don't fall through
    }
    // Ordinal day-of-month ("27th", "3rd") → this month, or next if it passed.
    // The suffix is required so a bare "27" stays a time, not the 27th.
    const ord = s.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
    if (ord) {
      const day = parseInt(ord[1]);
      if (day >= 1 && day <= 31) {
        let y = now.getFullYear(), mo = now.getMonth();
        if (day < now.getDate()) { mo++; if (mo > 11) { mo = 0; y++; } }
        let d = new Date(y, mo, day);
        while (d.getDate() !== day) { mo++; if (mo > 11) { mo = 0; y++; } d = new Date(y, mo, day); }
        return apply(atDefaultTime(d));
      }
    }
    return apply(parseDateToken(s));
  }

  // "in <N|word> hour(s)/minute(s)" — sub-day: anchor to now, keep the clock
  // time (no 9:00 normalization).
  const inTime = s.match(/^in\s+(\d+|[a-z]+)\s+(hours?|hrs?|minutes?|mins?)$/);
  if (inTime) {
    const n = /^\d+$/.test(inTime[1]) ? parseInt(inTime[1]) : (NUM_WORDS[inTime[1]] || NaN);
    if (!isNaN(n)) {
      const d = new Date(now);
      if (inTime[2].startsWith('h')) d.setHours(d.getHours() + n);
      else d.setMinutes(d.getMinutes() + n);
      return d;
    }
  }

  // "this <day>" — the upcoming one, INCLUDING today (plain "fri" always
  // rolls forward to next week when said on a Friday; "this fri" means today).
  const thisMatch = s.match(/^this\s+([a-z]+)$/);
  if (thisMatch && thisMatch[1] in DAY_NAMES) {
    const target = DAY_NAMES[thisMatch[1]];
    const d = new Date(now);
    let diff = target - d.getDay();
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() + diff);
    if (diff === 0) d.setHours(18, 0, 0, 0); else atDefaultTime(d);
    return apply(d);
  }

  // "in <N|word> day(s)/week(s)/month(s)/year(s)"
  const inMatch = s.match(/^in\s+(\d+|[a-z]+)\s+(day|days|week|weeks|month|months|year|years)$/);
  if (inMatch) {
    const n = /^\d+$/.test(inMatch[1]) ? parseInt(inMatch[1]) : (NUM_WORDS[inMatch[1]] || NaN);
    if (!isNaN(n)) {
      const d = new Date(now);
      const unit = inMatch[2];
      if (unit.startsWith('day'))   d.setDate(d.getDate() + n);
      if (unit.startsWith('week'))  d.setDate(d.getDate() + n * 7);
      if (unit.startsWith('month')) d.setMonth(d.getMonth() + n);
      if (unit.startsWith('year'))  d.setFullYear(d.getFullYear() + n);
      return apply(atDefaultTime(d));
    }
  }

  // "<N|word> day(s)/week(s)/month(s)/year(s) ago"
  const agoMatch = s.match(/^(\d+|[a-z]+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
  if (agoMatch) {
    const n = /^\d+$/.test(agoMatch[1]) ? parseInt(agoMatch[1]) : (NUM_WORDS[agoMatch[1]] || NaN);
    if (!isNaN(n)) {
      const d = new Date(now);
      const unit = agoMatch[2];
      if (unit.startsWith('day'))   d.setDate(d.getDate() - n);
      if (unit.startsWith('week'))  d.setDate(d.getDate() - n * 7);
      if (unit.startsWith('month')) d.setMonth(d.getMonth() - n);
      if (unit.startsWith('year'))  d.setFullYear(d.getFullYear() - n);
      return apply(atDefaultTime(d));
    }
  }
  if (s === 'last week')  { const d = new Date(now); d.setDate(d.getDate() - 7);  return apply(atDefaultTime(d)); }
  if (s === 'last month') { const d = new Date(now); d.setMonth(d.getMonth() - 1); return apply(atDefaultTime(d)); }

  // "next <day|week|month|year>"
  const nextMatch = s.match(/^next\s+([a-z]+)$/);
  if (nextMatch) {
    const tok = nextMatch[1];
    if (tok === 'week')  { const d = new Date(now); d.setDate(d.getDate() + 7);   return apply(atDefaultTime(d)); }
    if (tok === 'month') { const d = new Date(now); d.setMonth(d.getMonth() + 1); return apply(atDefaultTime(d)); }
    if (tok === 'year')  { const d = new Date(now); d.setFullYear(d.getFullYear() + 1); return apply(atDefaultTime(d)); }
    return apply(parseDateToken(tok));
  }

  // "<month> <day>[ <year>]" — e.g. "may 3", "june 15", "may 3 2027"
  const monthDay = s.match(/^([a-z]{3,9})\s+(\d{1,2})(?:[a-z]{2})?(?:,?\s+(\d{4}))?$/);  // "3rd" + ", 2027" tolerated
  if (monthDay) {
    const m3 = monthDay[1].slice(0, 3);
    const monthIdx = MONTHS.findIndex(m => m.startsWith(m3));
    const day = parseInt(monthDay[2]);
    const year = monthDay[3] ? parseInt(monthDay[3]) : null;
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      const d = new Date(now);
      if (year) d.setFullYear(year);
      d.setMonth(monthIdx, day);
      atDefaultTime(d);
      apply(d);   // set the peeled time BEFORE the roll-forward check
      if (!year && d < now) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // "<day> <month>[ <year>]" — day-first, e.g. "27 jan", "3 may", "3 may 2027".
  // ?-marked only: bare quick-add never grabs this ("3 may" would steal the
  // modal verb "may" out of a title).
  const dayMonth = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:,?\s+(\d{4}))?$/);
  if (dayMonth) {
    const monthIdx = MONTHS.findIndex(m => m.startsWith(dayMonth[2].slice(0, 3)));
    const day = parseInt(dayMonth[1]);
    const year = dayMonth[3] ? parseInt(dayMonth[3]) : null;
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      const d = new Date(now);
      if (year) d.setFullYear(year);
      d.setMonth(monthIdx, day);
      atDefaultTime(d);
      apply(d);
      if (!year && d < now) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // Day-of-month "the 15th" / "on the 27th" / "15th" → this month, or next
  // month if that day already passed. ?-marked only: bare declines these (it
  // would grab "the 3rd floor" out of a title). A bare "15" is a time, so the
  // number form requires an ordinal suffix or a leading "the".
  const domMatch = s.match(/^(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)$/)
                || s.match(/^(?:on\s+)?the\s+(\d{1,2})$/);
  if (domMatch) {
    const day = parseInt(domMatch[1]);
    if (day >= 1 && day <= 31) {
      let y = now.getFullYear(), mo = now.getMonth();
      if (day < now.getDate()) { mo++; if (mo > 11) { mo = 0; y++; } }
      let d = new Date(y, mo, day);
      while (d.getDate() !== day) { mo++; if (mo > 11) { mo = 0; y++; } d = new Date(y, mo, day); }
      return apply(atDefaultTime(d));
    }
  }

  // "mid january" → the 15th of that month (?-marked only).
  const midMonth = s.match(/^mid[-\s]?([a-z]{3,9})$/);
  if (midMonth) {
    const monthIdx = MONTHS.findIndex(m => m.startsWith(midMonth[1].slice(0, 3)));
    if (monthIdx >= 0) {
      const d = new Date(now);
      d.setMonth(monthIdx, 15); atDefaultTime(d);
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      return apply(d);
    }
  }

  // Fallback: try the single-token parser on a hyphenated form
  return apply(parseDateToken(s.replace(/\s+/g, '-')));
}
// Does `expr` look like an attempt at a date? Used to decide whether a `?expr`
// that fails to parse is a typo worth flagging (strip + warn) or just a literal
// question mark in the task name ("(sai and nancy?)") that should be left alone.
function _looksLikeDate(expr) {
  const s = (expr || '').trim().toLowerCase();
  if (!s) return false;
  if (/^\d/.test(s)) return true;                       // 3pm, 5/15, 2026-05-15, 3 days
  const first = s.split(/\s+/)[0];
  const KEYWORDS = new Set([
    'today', 'td', 'tonight', 'tomorrow', 'tmrw', 'tmr', 'yesterday',
    'next', 'this', 'in', 'last', 'every', 'eod', 'eow', 'eom', 'eoy',
    'noon', 'midnight', 'weekend', 'end', 'mid', 'cob',
    'morning', 'afternoon', 'evening', 'night',
    ...Object.keys(DAY_NAMES),
  ]);
  if (KEYWORDS.has(first)) return true;
  if (first.length >= 3 && MONTHS.some(m => m.startsWith(first.slice(0, 3)))) return true;
  return false;
}

// -------------------------------------------------------------------------
// Bare (marker-less) date phrases, Todoist-style: "call mom tomorrow at 5pm",
// "lunch with dan friday 1pm", "rent due may 3", "review in 2 weeks".
// Conservative on purpose — a phrase only counts when it's a strong date
// signal, so ordinary words aren't stolen from task names:
//   - full day names always count; "sun/sat/mon/wed" are common English words
//     and only count with a marker (this/next/on) or an attached time
//   - month-day needs the day number ("may 3", not bare "may")
//   - times need am/pm, a colon, or noon/midnight (never a bare digit)
//   - a date anchor may carry a trailing part-of-day ("tomorrow morning",
//     "friday evening"); standalone "morning" stays ?-only (too common a word)
// The LAST match in the string wins (dates trail the task text), and the
// explicit `?date` marker always takes precedence over any bare phrase.
const _RELDAY_RE = '(?:today|tonight|tomorrow|tmrw|tmr)';
const _DAYS_ANY_RE = '(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)';
const _DAYS_SAFE_RE = '(?:sunday|monday|tuesday|tues|tue|wednesday|thursday|thurs|thu|friday|fri|saturday)';
const _TIME_RE = '(?:\\d{1,2}:\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm)|noon|midnight)';
const _MONTHS_RE = '(?:january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)';
const _NUMW_RE = '(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)';
const _PARTDAY_RE = '(?:morning|afternoon|evening|night)';
const _AT_TIME_RE = `(?:\\s+(?:at\\s+)?${_TIME_RE})`;
// A trailing "when" clause: a clock time OR a named part of day
// ("at 3pm", "in the morning", "evening").
const _WHEN_RE = `(?:\\s+(?:at\\s+|in\\s+the\\s+)?(?:${_TIME_RE}|${_PARTDAY_RE}))`;
const _BARE_DATE_RE = new RegExp(
  '(?:^|\\s)(' + [
    `(?:the\\s+)?day\\s+after\\s+tomorrow${_WHEN_RE}?`,             // day after tomorrow [evening]
    `(?:this|next)\\s+weekend`,                                    // this / next weekend
    `end\\s+of\\s+(?:day|week|month|year)`,                        // end of month
    `this\\s+${_PARTDAY_RE}`,                                      // this afternoon
    `(?:on\\s+)?(?:this|next)\\s+${_DAYS_ANY_RE}${_WHEN_RE}?`,     // this/next fri [morning]
    'next\\s+(?:week|month|year)',
    `(?:on\\s+)?${_RELDAY_RE}${_WHEN_RE}?`,                        // tomorrow [morning]
    `in\\s+${_NUMW_RE}\\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)`,
    `(?:on\\s+)?${_MONTHS_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?${_WHEN_RE}?`,  // may 3 [2027] [morning]
    `(?:on\\s+)?${_DAYS_SAFE_RE}${_WHEN_RE}?`,                     // friday [evening] — unambiguous names only
    `(?:on\\s+)?${_DAYS_ANY_RE}${_AT_TIME_RE}`,                    // sat 3pm — abbreviation is fine WITH a clock time
    `at\\s+${_TIME_RE}`,                                             // at 5pm → next occurrence
    _TIME_RE,                                                        // 5pm / 14:30 → next occurrence
  ].join('|') + ')(?=[\\s.,;:)!?]|$)',
  'gi'
);
function _scanBareDatePhrase(text) {
  _BARE_DATE_RE.lastIndex = 0;
  let m, last = null;
  while ((m = _BARE_DATE_RE.exec(text)) !== null) {
    last = { index: m.index, full: m[0], phrase: m[1] };
  }
  if (!last) return null;
  const expr = last.phrase.replace(/^(?:on|at)\s+/i, '');
  const date = parseDateExpression(expr);
  if (!date) return null;
  return { date, start: last.index, end: last.index + last.full.length };
}

// Fuzzy-match a `ls:<token>` to a list id. Token is the user's shorthand
// (case-insensitive, spaces stripped). Returns null if no plausible match.
function _matchListByToken(token, lists) {
  if (!token) return null;
  const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const t = norm(token);
  if (!t) return null;
  // Exact normalized match wins
  let hit = lists.find(l => norm(l.name) === t);
  if (hit) return hit.id;
  // Prefix match
  hit = lists.find(l => norm(l.name).startsWith(t));
  if (hit) return hit.id;
  // Substring match
  hit = lists.find(l => norm(l.name).includes(t));
  if (hit) return hit.id;
  return null;
}

function parseQuickAdd(input, lists = [], opts = {}) {
  // opts.dateOff: skip ALL date extraction — the date words stay in the task
  // name and no due date is set. Used by the quick-add preview's tap-to-revert
  // chip ("the parser grabbed a phrase I meant as title text"). Recurrence
  // (`every …`) still parses: it is explicit syntax, never an accidental grab.
  const dateOff = !!opts.dateOff;
  const out = { name: '', priority: undefined, dueDate: undefined, recurrence: undefined, listId: undefined, listToken: undefined, url: undefined, unparsedDate: null };

  // Zeroth pass: pull a pasted URL out of the text into the `url` field so it
  // lands in the task's link slot, not the title. MUST run before the date /
  // tag / ls: passes — a URL's own `?query`, `#fragment`, and `:` would
  // otherwise be misread as date / tag / list tokens. Only http(s) (and bare
  // `www.` → https) — never script-ish schemes (the daemon rejects those).
  input = input.replace(/(?:^|\s)((?:https?:\/\/|www\.)[^\s]+)/i, (full, raw) => {
    if (out.url) return full;                       // first URL wins; leave any others in the name
    const url = raw.replace(/[.,;:!?'")\]}>]+$/, '');   // drop trailing sentence punctuation
    out.url = /^www\./i.test(url) ? 'https://' + url : url;
    return ' ';
  });

  // First pass: extract `ls:<token>` to override the destination list. Token is
  // a single word (no spaces); `ls:to dos` would only consume `to`. Falls back
  // to the active list if the token doesn't match anything.
  input = input.replace(/(?:^|\s)ls:([^\s]+)/i, (full, token) => {
    out.listToken = token;
    const id = _matchListByToken(token, lists);
    if (id) out.listId = id;
    return ' ';
  });

  // Second pass: extract `?every <expr>` (recurrence) before generic `?<date>`.
  // Date/recurrence expressions stop at the next token marker — including `#`,
  // so a trailing tag ("?friday 3pm #grocery") doesn't get swallowed into the
  // date expression and break the parse. Dates never legitimately contain #.
  let working = input.trim().replace(/(?:^|\s)\??every\s+([^!?#\n]+?)(?=\s*[!?#]|\s*$)/gi, (full, expr) => {
    const e = expr.trim().toLowerCase().replace(/\s+/g, ' ');
    if (e === 'day' || e === 'daily')                              { out.recurrence = 'daily'; return ''; }
    if (e === 'weekday' || e === 'weekdays')                       { out.recurrence = 'weekdays'; return ''; }
    if (e === 'week' || e === 'weekly')                            { out.recurrence = 'weekly'; return ''; }
    if (e === 'month' || e === 'monthly')                          { out.recurrence = 'monthly'; return ''; }
    if (e === 'year' || e === 'yearly' || e === 'annual')          { out.recurrence = 'yearly'; return ''; }
    // "every other week" / "every 2 weeks" / "every three months" — interval
    // forms, normalized to the daemon's wire grammar "every N <unit>s".
    const interval = e.match(/^(other|\d+|[a-z]+)\s+(day|days|week|weeks|month|months|year|years)$/);
    if (interval) {
      const n = interval[1] === 'other' ? 2
              : /^\d+$/.test(interval[1]) ? parseInt(interval[1])
              : (NUM_WORDS[interval[1]] || NaN);
      const unit = interval[2].replace(/s$/, '');
      if (!isNaN(n) && n >= 1) {
        out.recurrence = n === 1
          ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit]
          : `every ${n} ${unit}s`;
        return '';
      }
    }
    // "every monday" / "every mon and thu" / "every wednesday 3pm" — weekly
    // pinned to those weekdays (wire grammar "every mon and thu"). A trailing
    // time ("3pm") sets the clock on the seeded due date. Seeds a due date on
    // the nearest listed day when none was given.
    let dayPart = e, recTime = null;
    const dlTime = e.match(/^(.+?)\s+(?:at\s+)?((?:\d{1,2}:\d{2}\s*(?:am|pm)?)|(?:\d{1,2}\s*(?:am|pm))|noon|midnight)$/);
    if (dlTime) {
      const pt = parseTimeString(dlTime[2]);
      if (pt) { recTime = pt; dayPart = dlTime[1].trim(); }
    }
    const dayTokens = dayPart.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
    if (dayTokens.length && dayTokens.every(d => d in DAY_NAMES)) {
      const nums = [...new Set(dayTokens.map(d => DAY_NAMES[d]))].sort((a, b) => a - b);
      out.recurrence = 'every ' + nums.map(n => DAY_SHORT[n]).join(' and ');
      if (!out.dueDate) {
        const today = new Date();
        let best = null;
        for (const n of nums) {
          let diff = n - today.getDay(); if (diff <= 0) diff += 7;
          if (best === null || diff < best) best = diff;
        }
        const d = new Date(today);
        d.setDate(d.getDate() + best);
        // No explicit time on the rule → the configurable default, not a
        // hardcoded 9:00 (which ignored Settings → default due time).
        if (recTime) d.setHours(recTime.hours, recTime.minutes, 0, 0);
        else atDefaultTime(d);
        out.dueDate = d.toISOString();
      } else if (recTime) {
        const d = new Date(out.dueDate);
        d.setHours(recTime.hours, recTime.minutes, 0, 0);
        out.dueDate = d.toISOString();
      }
      return '';
    }
    return full;
  });

  // Second pass: extract `?<date expression>` from anywhere in the input.
  let unparsedDate = null;
  working = working.replace(/\?([^!?#\n]+?)(?=\s*[!?#]|\s*$)/g, (full, expr) => {
    if (dateOff || out.dueDate) return full;
    const date = parseDateExpression(expr);
    if (date) { out.dueDate = date.toISOString(); return ''; }
    // Unparseable. Only strip + flag it when it actually looks like a date
    // attempt; otherwise it's a literal `?` in the task name (e.g.
    // "(sai and nancy?)") and must be left untouched.
    if (_looksLikeDate(expr)) { unparsedDate = expr.trim(); return ''; }
    return full;
  });
  if (unparsedDate && !out.dueDate) {
    // Pure module: report instead of touching the UI — callers surface it.
    out.unparsedDate = unparsedDate;
  }

  // Third pass: bare date phrases with no marker ("tomorrow at 5pm",
  // "friday 1pm", "may 3"). Runs only when no explicit ?date matched.
  if (!dateOff && !out.dueDate) {
    const scan = _scanBareDatePhrase(working);
    if (scan) {
      out.dueDate = scan.date.toISOString();
      working = (working.slice(0, scan.start) + ' ' + working.slice(scan.end)).trim();
    }
  }

  const tokens = working.split(/\s+/).filter(Boolean);
  const joined = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() === 'next' && tokens[i + 1] && tokens[i + 1].toLowerCase() === 'week') {
      joined.push('next-week'); i++;
    } else if (tokens[i].toLowerCase() === 'in' && /^\d+$/.test(tokens[i + 1] || '') && /^d(ays?)?$/i.test(tokens[i + 2] || '')) {
      joined.push(`in${tokens[i + 1]}d`); i += 2;
    } else {
      joined.push(tokens[i]);
    }
  }
  // Bare day ABBREVIATIONS that are also common English words must not be
  // eaten out of task names ("we sat down", "morning sun"). They still parse
  // with any marker (?sat, "next sat", "on sat") or an attached time.
  const AMBIGUOUS_BARE_DAYS = new Set(['sun', 'sat', 'mon', 'wed']);
  const remaining = [];
  for (const tok of joined) {
    const lower = tok.toLowerCase();
    if (PRIORITY_TOKENS[lower]) { out.priority = PRIORITY_TOKENS[lower]; continue; }
    if (!dateOff && !AMBIGUOUS_BARE_DAYS.has(lower)) {
      const date = parseDateToken(lower);
      if (date && !out.dueDate) { out.dueDate = date.toISOString(); continue; }
    }
    remaining.push(tok);
  }
  out.name = remaining.join(' ').trim();
  return out;
}

// Peel a standalone priority token (!!!, !1, !high, …) off free text without
// running the full quick-add parse. For surfaces that treat input as a link
// dump (reading list) but should still honor priority markers. Same rules as
// the tokenizer: whitespace-delimited only (glued "done!!!" stays text), last
// token wins.
function peelPriority(text) {
  let priority = null;
  const kept = [];
  for (const tok of String(text).split(/\s+/)) {
    const p = PRIORITY_TOKENS[tok.toLowerCase()];
    if (p) { priority = p; continue; }
    if (tok) kept.push(tok);
  }
  return { text: kept.join(' '), priority };
}

export { parseQuickAdd, parseDateExpression, parseDateToken, parseTimeString, setDefaultDueTime, getDefaultDueTime, peelPriority };
