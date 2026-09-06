// Tests for the morning-briefing store (lib/app-data.js) and the briefing_set
// / briefing_get MCP handlers (lib/mcp-tools.js). Runs against a temp dir via
// TODO_APP_DATA_DIR, set BEFORE the dynamic imports (the module reads it at
// import time). The briefing handlers never touch the Reminders daemon, so
// importing mcp-tools here is safe.
//
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TODO_APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'todo-briefing-'));
const { briefingRead, briefingWrite, feedbackAppend, feedbackList } = await import('../lib/app-data.js');
const { handlers } = await import('../lib/mcp-tools.js');

test('briefingRead is null before any write; write→read round-trips', async () => {
  assert.equal(await briefingRead(), null);
  await briefingWrite({ date: '2026-07-03', headline: 'hi' });
  const b = await briefingRead();
  assert.equal(b.date, '2026-07-03');
  assert.equal(b.headline, 'hi');
});

test('briefing_set validates the date', async () => {
  const bad = await handlers.briefing_set({ date: 'tomorrow' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /YYYY-MM-DD/);
  const missing = await handlers.briefing_set({});
  assert.equal(missing.ok, false);
});

test('briefing_set publishes a cleaned briefing and briefing_get reads it back', async () => {
  const res = await handlers.briefing_set({
    date: '2026-07-06',
    headline: '  Monday: strategy synthesis is the big rock.  ',
    plan: [
      { task_id: 'T1', title: 'Draft the Q3 report', slot: '13:30-16:00', why: 'feeds the Jul 10 meeting' },
      { title: '   ' },                      // blank title → dropped
      { title: 'Reply to Sam', slot: '9:00-10:00' },
      { title: 'Alex 1:1', slot: '11:30-12:00', kind: 'fixed' },   // calendar block
      { title: 'Lunch', kind: 'banana' },    // unknown kind → treated as task (kind dropped)
      'not-an-object',                       // junk → dropped
    ],
    needs_answer: [
      { who: 'Sam', what: 'budget draft feedback', source: 'email · 6d', level: 'high' },
      { who: 'Riley', what: 'invoice', level: 'urgent!!' },   // unknown level → dropped, item kept
      { who: 'nobody' },                     // missing `what` → dropped
    ],
    keep_in_mind: ['Fri Jul 10: quarterly strategy meeting', ''],
    scoreboard: '3 of 4 picks done',
  });
  assert.equal(res.ok, true);
  assert.equal(res.dry_run, false);

  const { briefing } = await handlers.briefing_get({});
  assert.equal(briefing.date, '2026-07-06');
  assert.equal(briefing.headline, 'Monday: strategy synthesis is the big rock.');
  assert.equal(briefing.plan.length, 4);
  assert.deepEqual(briefing.plan[0], { title: 'Draft the Q3 report', task_id: 'T1', slot: '13:30-16:00', why: 'feeds the Jul 10 meeting' });
  assert.deepEqual(briefing.plan[2], { title: 'Alex 1:1', slot: '11:30-12:00', kind: 'fixed' });
  assert.deepEqual(briefing.plan[3], { title: 'Lunch' });
  assert.equal(briefing.needs_answer.length, 2);
  assert.equal(briefing.needs_answer[0].source, 'email · 6d');
  assert.equal(briefing.needs_answer[0].level, 'high');
  assert.deepEqual(briefing.needs_answer[1], { who: 'Riley', what: 'invoice' });
  assert.deepEqual(briefing.keep_in_mind, ['Fri Jul 10: quarterly strategy meeting']);
  assert.equal(briefing.scoreboard, '3 of 4 picks done');
  assert.ok(briefing.generated_at && !isNaN(new Date(briefing.generated_at)));
});

test('caps: at most 12 plan items, long strings truncated', async () => {
  const plan = Array.from({ length: 15 }, (_, i) => ({ title: `item ${i}` }));
  const res = await handlers.briefing_set({ date: '2026-07-06', plan, headline: 'x'.repeat(500) });
  assert.equal(res.ok, true);
  assert.equal(res.briefing.plan.length, 12);
  assert.equal(res.briefing.headline.length, 240);
  assert.ok(res.briefing.headline.endsWith('…'));
});

test('dry_run previews without writing', async () => {
  const before = await briefingRead();
  const res = await handlers.briefing_set({ date: '2030-01-01', headline: 'preview', dry_run: true });
  assert.equal(res.ok, true);
  assert.equal(res.dry_run, true);
  const after = await briefingRead();
  assert.deepEqual(after, before);   // unchanged
});

test('feedback: append round-trips through feedbackList and briefing_get', async () => {
  assert.deepEqual(await feedbackList(), []);
  await feedbackAppend({ type: 'done', briefing_date: '2026-07-04', plan_index: 1, title: 'Book flights' });
  await feedbackAppend({ type: 'comment', text: 'skip the gym block on Fridays' });
  const list = await feedbackList();
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'done');
  assert.equal(list[0].plan_index, 1);
  assert.ok(typeof list[0].at === 'number');
  assert.equal(list[1].text, 'skip the gym block on Fridays');
  const res = await handlers.briefing_get({});
  assert.equal(res.feedback.length, 2);
});

test('feedback: entries older than 14 days are pruned on read', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = join(process.env.TODO_APP_DATA_DIR, 'checkin-feedback.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  lines[0].at = Date.now() - 15 * 24 * 60 * 60 * 1000;   // backdate the done-mark
  await writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const list = await feedbackList();
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'comment');
});
