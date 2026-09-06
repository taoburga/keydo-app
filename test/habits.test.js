// Tests for lib/app-data.js — the habits store (definitions + per-day
// checkmarks). Same temp-dir pattern as app-data.test.js: TODO_APP_DATA_DIR
// must be set BEFORE the dynamic import.
//
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'todo-habits-'));
process.env.TODO_APP_DATA_DIR = DIR;
const { habitsRead, habitAdd, habitUpdate, habitDelete, habitToggle } = await import('../lib/app-data.js');

const TODAY = '2026-07-12';

test('add, read, and validate habits', async () => {
  const h = await habitAdd({ name: 'In bed before 11', target: 4 });
  assert.ok(h.id);
  assert.equal(h.name, 'In bed before 11');
  assert.equal(h.target, 4);
  assert.equal(h.archivedAt, null);

  const data = await habitsRead();
  assert.equal(data.habits.length, 1);
  assert.deepEqual(data.checks, {});

  await assert.rejects(() => habitAdd({ name: '', target: 4 }), /name/);
  await assert.rejects(() => habitAdd({ name: 'x', target: 0 }), /target/);
  await assert.rejects(() => habitAdd({ name: 'x', target: 8 }), /target/);
  await assert.rejects(() => habitAdd({ name: 'x', target: 2.5 }), /target/);
});

test('toggle checks: on, off, sorted; future and too-old rejected', async () => {
  const h = await habitAdd({ name: 'Exercise', target: 4 });

  const on = await habitToggle(h.id, '2026-07-10', TODAY);
  assert.equal(on.checked, true);
  await habitToggle(h.id, '2026-07-08', TODAY);
  let data = await habitsRead();
  assert.deepEqual(data.checks[h.id], ['2026-07-08', '2026-07-10']);   // sorted

  const off = await habitToggle(h.id, '2026-07-10', TODAY);
  assert.equal(off.checked, false);
  data = await habitsRead();
  assert.deepEqual(data.checks[h.id], ['2026-07-08']);

  await assert.rejects(() => habitToggle(h.id, '2026-07-13', TODAY), /future/);
  // History is editable for 70 days (the full eight-week modal plus slack).
  await assert.rejects(() => habitToggle(h.id, '2026-04-01', TODAY), /last 70/);
  await assert.rejects(() => habitToggle(h.id, 'nonsense', TODAY), /YYYY-MM-DD/);
  await assert.rejects(() => habitToggle('nope', TODAY, TODAY), /not found/);
});

test('kinds rotation: labeled checks, validation, cleanup', async () => {
  const h = await habitAdd({ name: 'Gym', target: 4, kinds: ['Push', 'pull', 'legs', 'cardio', 'push'] });
  assert.deepEqual(h.kinds, ['push', 'pull', 'legs', 'cardio']);   // normalized, deduped

  const r = await habitToggle(h.id, '2026-07-10', TODAY, 'push');
  assert.equal(r.checked, true);
  assert.equal(r.kind, 'push');
  let data = await habitsRead();
  assert.equal(data.kinds[h.id]['2026-07-10'], 'push');

  // a label outside the rotation is rejected
  await assert.rejects(() => habitToggle(h.id, '2026-07-11', TODAY, 'yoga'), /not one of/);

  // plain check (no kind) on a kinds habit is fine
  const plain = await habitToggle(h.id, '2026-07-11', TODAY);
  assert.equal(plain.checked, true);
  assert.equal(plain.kind, null);

  // unchecking clears the label with the check
  await habitToggle(h.id, '2026-07-10', TODAY);
  data = await habitsRead();
  assert.equal((data.kinds[h.id] || {})['2026-07-10'], undefined);

  // kinds are editable; empty array clears the rotation
  const upd = await habitUpdate(h.id, { kinds: ['upper', 'lower'] });
  assert.deepEqual(upd.kinds, ['upper', 'lower']);
  const cleared = await habitUpdate(h.id, { kinds: [] });
  assert.equal(cleared.kinds, undefined);

  await habitDelete(h.id);
  data = await habitsRead();
  assert.equal(data.kinds[h.id], undefined);
});

test('update name/target/archive; delete removes checks too', async () => {
  const h = await habitAdd({ name: 'Read', target: 3 });
  await habitToggle(h.id, TODAY, TODAY);

  const upd = await habitUpdate(h.id, { name: 'Read a book', target: 5 });
  assert.equal(upd.name, 'Read a book');
  assert.equal(upd.target, 5);

  const arch = await habitUpdate(h.id, { archived: true });
  assert.ok(arch.archivedAt);
  const unarch = await habitUpdate(h.id, { archived: false });
  assert.equal(unarch.archivedAt, null);

  await assert.rejects(() => habitUpdate(h.id, { target: 9 }), /target/);
  await assert.rejects(() => habitUpdate('nope', { name: 'x' }), /not found/);

  await habitDelete(h.id);
  const data = await habitsRead();
  assert.ok(!data.habits.some(x => x.id === h.id));
  assert.equal(data.checks[h.id], undefined);
  await assert.rejects(() => habitDelete(h.id), /not found/);
});

test('a corrupt habits.json falls back to the .bak (no history loss)', async () => {
  const h = await habitAdd({ name: 'Durable', target: 3 });
  await habitToggle(h.id, TODAY, TODAY);   // second write → .bak now holds the habit
  // simulate corruption of the main file
  writeFileSync(join(DIR, 'habits.json'), '{"garbage": tru', 'utf8');
  const data = await habitsRead();
  const back = data.habits.find(x => x.name === 'Durable');
  assert.ok(back, 'habit recovered from backup');
  // the backup is one write behind: it has the habit, maybe not the last check —
  // the guarantee is "at most the single last change is lost"
});
