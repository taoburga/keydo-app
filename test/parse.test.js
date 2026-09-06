// Tests for public/parse.js — the quick-add syntax parser shared by the web
// UI, the /api/quickadd endpoint (global-hotkey capture), and Shortcuts.
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd, parseDateExpression, parseTimeString, setDefaultDueTime, peelPriority } from '../public/parse.js';

const LISTS = [
  { id: 'L1', name: 'Reminders' },
  { id: 'L2', name: 'To Dos' },
  { id: 'L3', name: 'On Hold' },
];

test('the canonical placeholder example parses fully', () => {
  // This exact string is the app's own placeholder text. A tag after the
  // date expression used to swallow the date (regression anchor).
  const r = parseQuickAdd('Buy milk !mid ?friday 3pm #grocery ls:todos', LISTS);
  assert.equal(r.name, 'Buy milk #grocery');
  assert.equal(r.priority, 'medium');
  assert.equal(r.listId, 'L2');
  assert.equal(r.unparsedDate, null);
  const d = new Date(r.dueDate);
  assert.equal(d.getDay(), 5);        // Friday
  assert.equal(d.getHours(), 15);     // 3pm
});

test('a pasted URL is pulled into the url field, not the task name', () => {
  const r = parseQuickAdd('read this https://example.com/article !high', LISTS);
  assert.equal(r.url, 'https://example.com/article');
  assert.equal(r.name, 'read this');          // URL stripped from the name
  assert.equal(r.priority, 'high');           // tokens after the URL still parse
});

test('URL query/fragment do not get misparsed as date/tag, www gets https', () => {
  // The URL's own ?q= and #frag must survive — not be eaten by the date / tag passes.
  const r = parseQuickAdd('check https://site.com/p?q=1&x=2#sec', LISTS);
  assert.equal(r.url, 'https://site.com/p?q=1&x=2#sec');
  assert.equal(r.dueDate, undefined);
  assert.equal(r.name, 'check');
  // bare www. is promoted to https://
  assert.equal(parseQuickAdd('site www.example.com', LISTS).url, 'https://www.example.com');
  // trailing sentence punctuation is trimmed off the URL
  assert.equal(parseQuickAdd('see https://example.com.', LISTS).url, 'https://example.com');
  // no URL → field stays undefined
  assert.equal(parseQuickAdd('just a task', LISTS).url, undefined);
});

test('priority tokens', () => {
  assert.equal(parseQuickAdd('x !high', LISTS).priority, 'high');
  assert.equal(parseQuickAdd('x !1', LISTS).priority, 'high');
  assert.equal(parseQuickAdd('x !!', LISTS).priority, 'medium');
  assert.equal(parseQuickAdd('x !low', LISTS).priority, 'low');
  assert.equal(parseQuickAdd('x', LISTS).priority, undefined);
});

test('standalone ! is low priority; glued ! stays punctuation', () => {
  // Spaced-out ! (whitespace both sides) → low priority, dropped from the name.
  const r = parseQuickAdd('ship it !', LISTS);
  assert.equal(r.priority, 'low');
  assert.equal(r.name, 'ship it');
  // Glued sentence punctuation is one token — left alone, no priority set.
  const g = parseQuickAdd('ship it!', LISTS);
  assert.equal(g.priority, undefined);
  assert.equal(g.name, 'ship it!');
  // The multi-char forms still work.
  assert.equal(parseQuickAdd('x !3', LISTS).priority, 'low');
  assert.equal(parseQuickAdd('x !!', LISTS).priority, 'medium');
  assert.equal(parseQuickAdd('x !!!', LISTS).priority, 'high');
});

test('ls: fuzzy list matching — exact, prefix, substring, miss', () => {
  assert.equal(parseQuickAdd('x ls:todos', LISTS).listId, 'L2');     // normalized exact
  assert.equal(parseQuickAdd('x ls:rem', LISTS).listId, 'L1');       // prefix
  assert.equal(parseQuickAdd('x ls:hold', LISTS).listId, 'L3');      // substring
  const miss = parseQuickAdd('x ls:nope', LISTS);
  assert.equal(miss.listId, undefined);
  assert.equal(miss.listToken, 'nope');                              // caller can warn
});

test('?every recurrence, including weekday shorthand that also sets a due date', () => {
  assert.equal(parseQuickAdd('rent ?every month', LISTS).recurrence, 'monthly');
  assert.equal(parseQuickAdd('standup ?every weekday', LISTS).recurrence, 'weekdays');
  const mon = parseQuickAdd('water plants ?every monday #home', LISTS);
  assert.equal(mon.recurrence, 'every mon');   // weekly pinned to Monday
  assert.ok(mon.dueDate, 'weekday recurrence seeds a due date');
  assert.equal(new Date(mon.dueDate).getDay(), 1);
  assert.equal(mon.name, 'water plants #home');
});

test('?every interval forms normalize to the wire grammar', () => {
  assert.equal(parseQuickAdd('laundry ?every other day', LISTS).recurrence, 'every 2 days');
  assert.equal(parseQuickAdd('review ?every 2 weeks', LISTS).recurrence, 'every 2 weeks');
  assert.equal(parseQuickAdd('budget ?every three months', LISTS).recurrence, 'every 3 months');
  assert.equal(parseQuickAdd('x ?every 1 week', LISTS).recurrence, 'weekly');   // interval 1 = plain preset
});

test('?every day lists become weekly-on-days with a seeded due date', () => {
  const r = parseQuickAdd('gym ?every mon and thu', LISTS);
  assert.equal(r.recurrence, 'every mon and thu');
  assert.ok(r.dueDate, 'seeds the nearest listed day');
  assert.ok([1, 4].includes(new Date(r.dueDate).getDay()));
  assert.equal(r.name, 'gym');
  assert.equal(parseQuickAdd('x ?every tue, sat', LISTS).recurrence, 'every tue and sat');
});

test('new date expressions: bare time, tonight, this <day>, eom, in N hours, slash, year', () => {
  const now = new Date();

  const t3 = parseDateExpression('3pm');
  assert.equal(t3.getHours(), 15);
  assert.ok(t3 > now, 'bare time rolls to the next occurrence');

  const tonight = parseDateExpression('tonight');
  assert.equal(tonight.getHours(), 20);
  assert.equal(tonight.getDate(), now.getDate());

  const thisFri = parseDateExpression('this fri');
  assert.equal(thisFri.getDay(), 5);
  const daysAway = Math.round((new Date(thisFri).setHours(0,0,0,0) - new Date(now).setHours(0,0,0,0)) / 86400000);
  assert.ok(daysAway >= 0 && daysAway <= 6, '"this fri" includes today, never next week');

  const eom = parseDateExpression('eom');
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  assert.equal(eom.getDate(), lastDay);
  assert.equal(eom.getMonth(), now.getMonth());
  assert.equal(eom.getHours(), 17);

  const in2h = parseDateExpression('in 2 hours');
  assert.ok(Math.abs(in2h - now - 2 * 3600e3) < 60e3, 'in 2 hours anchors to now');
  const in30m = parseDateExpression('in 30 min');
  assert.ok(Math.abs(in30m - now - 30 * 60e3) < 60e3);

  const slash = parseDateExpression('5/15');
  assert.equal(slash.getMonth(), 4);
  assert.equal(slash.getDate(), 15);
  assert.ok(slash >= now, 'past slash dates roll to next year');
  assert.equal(parseDateExpression('13/40'), null);

  // Regression: the trailing-time peel used to eat a bare day number as
  // "3:00", so "may 3" (and "?may 3") parsed to nothing.
  const monthDay = parseDateExpression('may 3');
  assert.equal(monthDay.getMonth(), 4);
  assert.equal(monthDay.getDate(), 3);
  assert.equal(monthDay.getHours(), 9);

  const withYear = parseDateExpression('may 3 2027');
  assert.equal(withYear.getFullYear(), 2027);
  assert.equal(withYear.getMonth(), 4);
  assert.equal(withYear.getDate(), 3);

  // Regression: a month+day WITH a typed time later today must not roll a full
  // year forward. The roll-forward check used to compare the 9am default (often
  // already past) instead of the peeled time, so "jul 1 11pm" said at 7pm on
  // Jul 1 jumped to next year. Build an expression ~2h in the future and assert
  // it stays in the (soon) year. (Holds across the year boundary: near midnight
  // Dec 31, `soon` is next year and so is the correctly-rolled result.)
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const soon = new Date(); soon.setHours(soon.getHours() + 2);
  let h = soon.getHours(); const ampm = h >= 12 ? 'pm' : 'am'; let h12 = h % 12; if (h12 === 0) h12 = 12;
  const expr = `${MONTHS[soon.getMonth()]} ${soon.getDate()} ${h12}:${String(soon.getMinutes()).padStart(2, '0')}${ampm}`;
  const soonParsed = parseDateExpression(expr);
  assert.equal(soonParsed.getFullYear(), soon.getFullYear(), `"${expr}" should not roll a year forward`);
  assert.equal(soonParsed.getMonth(), soon.getMonth());
  assert.equal(soonParsed.getDate(), soon.getDate());
});

test('a literal ? that is not a date stays in the task name', () => {
  // "(sai and nancy?)" regression: a trailing ? whose text is not date-shaped
  // must neither warn ("? not a date") nor eat the surrounding character.
  const r = parseQuickAdd('(sai and nancy?)', LISTS);
  assert.equal(r.dueDate, undefined);
  assert.equal(r.unparsedDate, null);
  assert.equal(r.name, '(sai and nancy?)');
});

test('a date-shaped but unparseable ?date is still reported', () => {
  // A genuine date attempt (starts date-shaped) that fails to parse should still
  // surface the "? not a date" hint, so real typos are not swallowed silently.
  const r = parseQuickAdd('thing ?32nd', LISTS);
  assert.equal(r.dueDate, undefined);
  assert.equal(r.unparsedDate, '32nd');
  assert.equal(r.name, 'thing');
});

test('"every wednesday 3pm" sets weekly recurrence + a 3pm due date (no ? needed)', () => {
  const r = parseQuickAdd('standup every wednesday 3pm', LISTS);
  assert.equal(r.recurrence, 'every wed');
  assert.equal(r.name, 'standup');
  const d = new Date(r.dueDate);
  assert.equal(d.getDay(), 3);        // Wednesday
  assert.equal(d.getHours(), 15);     // 3pm
});

test('?every with multiple weekdays and a time', () => {
  const r = parseQuickAdd('gym ?every mon and thu 7am', LISTS);
  assert.equal(r.recurrence, 'every mon and thu');
  assert.equal(r.name, 'gym');
  const d = new Date(r.dueDate);
  assert.equal(d.getHours(), 7);
  assert.ok(d.getDay() === 1 || d.getDay() === 4);   // seeded on the nearer of mon/thu
});

test('bare date tokens still work without the ? prefix', () => {
  const r = parseQuickAdd('call mom tomorrow', LISTS);
  assert.ok(r.dueDate);
  assert.equal(r.name, 'call mom');
});

test('bare date PHRASES parse without a ? marker (Todoist-style)', () => {
  // relative day + time — the old parser left "at 5pm" stranded in the name
  const r1 = parseQuickAdd('call mom tomorrow at 5pm', LISTS);
  assert.equal(r1.name, 'call mom');
  const d1 = new Date(r1.dueDate);
  assert.equal(d1.getHours(), 17);
  // day name + time
  const r2 = parseQuickAdd('lunch with dan friday 1pm', LISTS);
  assert.equal(r2.name, 'lunch with dan');
  const d2 = new Date(r2.dueDate);
  assert.equal(d2.getDay(), 5);
  assert.equal(d2.getHours(), 13);
  // month + day
  const r3 = parseQuickAdd('rent due may 3', LISTS);
  assert.equal(r3.name, 'rent due');
  const d3 = new Date(r3.dueDate);
  assert.equal(d3.getMonth(), 4);
  assert.equal(d3.getDate(), 3);
  // "in N units"
  const r4 = parseQuickAdd('review budget in 2 weeks', LISTS);
  assert.equal(r4.name, 'review budget');
  assert.ok(r4.dueDate);
  // "at <time>" alone → next occurrence
  const r5 = parseQuickAdd('standup at 9am', LISTS);
  assert.equal(r5.name, 'standup');
  assert.equal(new Date(r5.dueDate).getHours(), 9);
  // "next <day>" with abbreviation (marker makes the abbrev safe)
  const r6 = parseQuickAdd('dentist next sat', LISTS);
  assert.equal(r6.name, 'dentist');
  assert.equal(new Date(r6.dueDate).getDay(), 6);
  // phrase in the middle of the name is stripped cleanly
  const r7 = parseQuickAdd('meet sam at 3pm for coffee', LISTS);
  assert.equal(r7.name, 'meet sam for coffee');
  assert.equal(new Date(r7.dueDate).getHours(), 15);
});

test('Tier 1 bare phrases: weekend, day-after-tomorrow, parts of day, end of month', () => {
  // this / next weekend → Saturday
  const w1 = parseQuickAdd('groceries this weekend', LISTS);
  assert.equal(w1.name, 'groceries');
  assert.equal(new Date(w1.dueDate).getDay(), 6);
  const w2 = parseQuickAdd('trip next weekend', LISTS);
  assert.equal(new Date(w2.dueDate).getDay(), 6);
  assert.ok(new Date(w2.dueDate) - new Date(w1.dueDate) >= 6 * 864e5);  // a week later
  // day after tomorrow → +2 days, whole phrase stripped (was leaving "day after")
  const dat = parseQuickAdd('vet day after tomorrow', LISTS);
  assert.equal(dat.name, 'vet');
  const exp = new Date(); exp.setDate(exp.getDate() + 2);
  assert.equal(new Date(dat.dueDate).getDate(), exp.getDate());
  // parts of day attach to a date anchor and set the hour (were being stranded)
  const pm = parseQuickAdd('buy milk tomorrow morning', LISTS);
  assert.equal(pm.name, 'buy milk');
  assert.equal(new Date(pm.dueDate).getHours(), 9);
  const ev = parseQuickAdd('call sam friday evening', LISTS);
  assert.equal(ev.name, 'call sam');
  assert.equal(new Date(ev.dueDate).getHours(), 18);
  // "this afternoon" bare
  const aft = parseQuickAdd('standup this afternoon', LISTS);
  assert.equal(aft.name, 'standup');
  assert.equal(new Date(aft.dueDate).getHours(), 14);
  // end of month (spelled out) → same as eom (last day, 5pm)
  const eom = parseQuickAdd('submit report end of month', LISTS);
  assert.equal(eom.name, 'submit report');
  assert.equal(new Date(eom.dueDate).getHours(), 17);
});

test('Tier 2 ?-only forms: day-of-month, day-first date, mid month, cob', () => {
  assert.equal(new Date(parseQuickAdd('x ?27th', LISTS).dueDate).getDate(), 27);
  assert.equal(new Date(parseQuickAdd('x ?the 15th', LISTS).dueDate).getDate(), 15);
  assert.equal(new Date(parseQuickAdd('x ?on the 3rd', LISTS).dueDate).getDate(), 3);
  // day-first "27 jan" / "3 may"
  const dm = parseQuickAdd('x ?27 jan', LISTS);
  assert.equal(new Date(dm.dueDate).getMonth(), 0);
  assert.equal(new Date(dm.dueDate).getDate(), 27);
  // mid january → the 15th
  assert.equal(new Date(parseQuickAdd('x ?mid january', LISTS).dueDate).getDate(), 15);
  // cob / end of day → 9pm
  assert.equal(new Date(parseQuickAdd('x ?cob', LISTS).dueDate).getHours(), 21);
  // standalone part of day (?-only)
  assert.equal(new Date(parseQuickAdd('x ?evening', LISTS).dueDate).getHours(), 18);
  // month abbreviations work with ? (regression: ?jul 13 / ?july 13)
  assert.equal(new Date(parseQuickAdd('x ?jul 13', LISTS).dueDate).getMonth(), 6);
  assert.equal(new Date(parseQuickAdd('x ?july 13', LISTS).dueDate).getMonth(), 6);
});

test('Tier 2 forms are ?-only and never stolen from a bare title', () => {
  // "the 3rd floor" must NOT become a due date (day-of-month is ?-only)
  assert.equal(parseQuickAdd('book the 3rd floor room', LISTS).dueDate, undefined);
  // "3 may" bare must not steal the modal verb "may"
  assert.equal(parseQuickAdd('you 3 may go now', LISTS).dueDate, undefined);
  // bare "27th" / "mid january" / "cob" stay in the title
  assert.equal(parseQuickAdd('the 27th amendment', LISTS).dueDate, undefined);
  assert.equal(parseQuickAdd('cob salad recipe', LISTS).dueDate, undefined);
});

test('explicit ?date beats a bare phrase; bare phrase never double-fires', () => {
  const r = parseQuickAdd('prep notes tomorrow ?friday', LISTS);
  assert.equal(new Date(r.dueDate).getDay(), 5);   // the ?date won
  assert.equal(r.name, 'prep notes tomorrow');      // bare "tomorrow" left alone
});

test('ambiguous day abbreviations are NOT stolen from task names', () => {
  // "sat", "sun", "mon", "wed" are common English words — bare use stays text.
  assert.equal(parseQuickAdd('fix where we sat down', LISTS).dueDate, undefined);
  assert.equal(parseQuickAdd('buy sun screen', LISTS).dueDate, undefined);
  assert.equal(parseQuickAdd('fix where we sat down', LISTS).name, 'fix where we sat down');
  // ...but they still parse with a marker or a time attached.
  assert.ok(parseQuickAdd('x ?sat', LISTS).dueDate);
  assert.ok(parseQuickAdd('gym sat 3pm', LISTS).dueDate);
  assert.equal(parseQuickAdd('gym sat 3pm', LISTS).name, 'gym');
  // full day names are strong signals and still parse bare
  assert.ok(parseQuickAdd('recap monday', LISTS).dueDate);
});

test('parseDateExpression: relative and compound forms', () => {
  const in3 = parseDateExpression('in 3 days');
  const expect = new Date(); expect.setDate(expect.getDate() + 3);
  assert.equal(in3.getDate(), expect.getDate());
  assert.equal(parseDateExpression('today 3pm').getHours(), 15);
  assert.equal(parseDateExpression('eod').getHours(), 21);
  assert.equal(parseDateExpression('totally not a date'), null);
});

test('parseTimeString forms', () => {
  assert.deepEqual(parseTimeString('3pm'), { hours: 15, minutes: 0 });
  assert.deepEqual(parseTimeString('14:30'), { hours: 14, minutes: 30 });
  assert.deepEqual(parseTimeString('noon'), { hours: 12, minutes: 0 });
  assert.deepEqual(parseTimeString('12am'), { hours: 0, minutes: 0 });
  assert.equal(parseTimeString('25:99'), null);
});

test('setDefaultDueTime changes the clock on time-less dates only', () => {
  try {
    assert.equal(setDefaultDueTime('18:30'), true);
    const d = parseDateExpression('tomorrow');
    assert.equal(d.getHours(), 18);
    assert.equal(d.getMinutes(), 30);
    // an explicit time always wins over the default
    assert.equal(parseDateExpression('tomorrow 3pm').getHours(), 15);
    // semantic clocks are untouched (today stays evening, eod stays 21:00)
    assert.equal(parseDateExpression('eod').getHours(), 21);
    // invalid values are rejected and leave the default alone
    assert.equal(setDefaultDueTime('25:00'), false);
    assert.equal(setDefaultDueTime('breakfast'), false);
    assert.equal(parseDateExpression('tomorrow').getHours(), 18);
  } finally {
    setDefaultDueTime('09:00');   // module-level state — always restore for later tests
  }
});

test('peelPriority extracts standalone priority tokens (reading-list dump)', () => {
  assert.deepEqual(peelPriority('https://example.com/a !!!'),
    { text: 'https://example.com/a', priority: 'high' });
  assert.deepEqual(peelPriority('!1 https://example.com/a'),
    { text: 'https://example.com/a', priority: 'high' });
  assert.deepEqual(peelPriority('finish the Deutsch book !!'),
    { text: 'finish the Deutsch book', priority: 'medium' });
  // glued punctuation is one token, never a priority marker
  assert.deepEqual(peelPriority('read this now!!!'),
    { text: 'read this now!!!', priority: null });
  // no token → text untouched, null priority
  assert.deepEqual(peelPriority('https://example.com/a'),
    { text: 'https://example.com/a', priority: null });
});

test('dateOff option skips all date extraction (tap-to-revert chip)', () => {
  const r = parseQuickAdd('call mom tomorrow at 5pm', LISTS, { dateOff: true });
  assert.equal(r.name, 'call mom tomorrow at 5pm');
  assert.equal(r.dueDate, undefined);
  // explicit ?date left verbatim in the name, no unparsed-date warning
  const q = parseQuickAdd('pay rent ?friday', LISTS, { dateOff: true });
  assert.equal(q.name, 'pay rent ?friday');
  assert.equal(q.dueDate, undefined);
  assert.equal(q.unparsedDate, null);
  // priority / tags / ls: still parse normally
  const p = parseQuickAdd('ship it friday !!! ls:todos', LISTS, { dateOff: true });
  assert.equal(p.priority, 'high');
  assert.equal(p.listId, 'L2');
  assert.equal(p.name, 'ship it friday');
});
