// Tests for the meeting-prep store (lib/app-data.js) and the meeting_prep_set
// / meeting_prep_get MCP handlers (lib/mcp-tools.js). Runs against a temp dir
// via TODO_APP_DATA_DIR, set BEFORE the dynamic imports (the module reads it
// at import time). The prep handlers never touch the Reminders daemon, so
// importing mcp-tools here is safe.
//
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TODO_APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'todo-prep-'));
const { prepKey, prepSet, prepList, prepFeedbackAppend, prepFeedbackList } = await import('../lib/app-data.js');
const { handlers } = await import('../lib/mcp-tools.js');

function ymd(daysFromNow = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('prepKey normalizes case and whitespace', () => {
  assert.equal(prepKey('2026-07-06', '  Jordan   Call (Intro) '), '2026-07-06|jordan call (intro)');
});

test('prepSet round-trips; same date+title replaces; prepList filters by date', async () => {
  const today = ymd();
  await prepSet({ date: today, title: 'Jordan call', brief: 'v1' });
  await prepSet({ date: today, title: 'jordan  CALL', brief: 'v2' });   // same key → replace
  await prepSet({ date: ymd(1), title: 'Alex 1:1', brief: 'alex brief' });
  const todays = await prepList({ date: today });
  assert.equal(todays.length, 1);
  assert.equal(todays[0].brief, 'v2');
  assert.equal((await prepList()).length, 2);
});

test('old preps are pruned', async () => {
  await prepSet({ date: '2020-01-01', title: 'ancient', brief: 'x' });
  const all = await prepList();
  assert.ok(!all.some(p => p.title === 'ancient'));
});

test('meeting_prep_set validates and cleans; meeting_prep_get reads back', async () => {
  const bad = await handlers.meeting_prep_set({ date: 'monday', title: 'X', brief: 'y' });
  assert.equal(bad.ok, false);
  const noBrief = await handlers.meeting_prep_set({ date: ymd(), title: 'X', brief: '   ' });
  assert.equal(noBrief.ok, false);

  const res = await handlers.meeting_prep_set({
    date: ymd(),
    title: '  Jordan Lee intro call ',
    start: 'not-a-date',                     // invalid → dropped
    person: 'Jordan Lee (Acme Corp)',
    brief: '  First conversation. 15 min cap. ',
    items: ['Send the follow-up doc', '   ', 42, 'Decide pilot timeline'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.prep.title, 'Jordan Lee intro call');
  assert.equal(res.prep.brief, 'First conversation. 15 min cap.');
  assert.equal(res.prep.start, undefined);
  assert.deepEqual(res.prep.items, ['Send the follow-up doc', 'Decide pilot timeline']);
  assert.ok(res.prep.key);

  const got = await handlers.meeting_prep_get({ date: ymd() });
  assert.equal(got.ok, true);
  assert.ok(got.preps.some(p => p.person === 'Jordan Lee (Acme Corp)'));
  const badDate = await handlers.meeting_prep_get({ date: 'nope' });
  assert.equal(badDate.ok, false);
});

test('dry_run previews without writing', async () => {
  const res = await handlers.meeting_prep_set({ date: ymd(2), title: 'Dry', brief: 'x', dry_run: true });
  assert.equal(res.ok, true);
  assert.equal(res.dry_run, true);
  assert.equal((await prepList({ date: ymd(2) })).length, 0);
});

test('prep feedback appends and reads back through meeting_prep_get', async () => {
  await prepFeedbackAppend({ type: 'done', prep_key: prepKey(ymd(), 'x'), item_text: 'Send the follow-up doc' });
  await prepFeedbackAppend({ type: 'dismiss', prep_key: prepKey(ymd(), 'x'), item_text: 'Not real' });
  const list = await prepFeedbackList();
  assert.equal(list.length, 2);
  assert.ok(list.every(e => typeof e.at === 'number'));
  const got = await handlers.meeting_prep_get({});
  assert.equal(got.feedback.length, 2);
  assert.equal(got.feedback[1].type, 'dismiss');
});
