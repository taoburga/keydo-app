// Tests for the task-history recorder: the pure snapshot diff
// (lib/task-history.js) and the history.jsonl store (lib/app-data.js).
// Runs against a temp dir via TODO_APP_DATA_DIR, set before the dynamic import.
//
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { snapshotFromTasks, diffSnapshots } from '../lib/task-history.js';

process.env.TODO_APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'todo-history-'));
const { historyAppend, historyList } = await import('../lib/app-data.js');

const task = (id, name, { completed = false, listId = 'L1' } = {}) => ({ id, name, completed, listId });

test('diff: added, completed, uncompleted, deleted are all detected', () => {
  const prev = snapshotFromTasks([
    task('a', 'stays the same'),
    task('b', 'gets completed'),
    task('c', 'gets uncompleted', { completed: true }),
    task('d', 'gets deleted'),
  ]);
  const { events } = diffSnapshots(prev, [
    task('a', 'stays the same'),
    task('b', 'gets completed', { completed: true }),
    task('c', 'gets uncompleted'),
    task('e', 'brand new'),
  ], 1234);
  const byAction = Object.fromEntries(events.map(e => [e.action, e]));
  assert.equal(events.length, 4);
  assert.equal(byAction.added.task_id, 'e');
  assert.equal(byAction.completed.task_id, 'b');
  assert.equal(byAction.uncompleted.task_id, 'c');
  assert.equal(byAction.deleted.task_id, 'd');
  assert.equal(byAction.deleted.was_completed, false);
  assert.ok(events.every(e => e.at === 1234));
});

test('diff: deleting an already-completed task is marked was_completed (iOS purge signal)', () => {
  const prev = snapshotFromTasks([task('x', 'old done thing', { completed: true })]);
  const { events } = diffSnapshots(prev, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'deleted');
  assert.equal(events[0].was_completed, true);
});

test('diff: no changes → no events; returned snapshot round-trips', () => {
  const tasks = [task('a', 'one'), task('b', 'two', { completed: true })];
  const first = diffSnapshots(snapshotFromTasks(tasks), tasks);
  assert.equal(first.events.length, 0);
  const second = diffSnapshots(first.next, tasks);
  assert.equal(second.events.length, 0);
});

test('store: append + list newest first, since filter works', async () => {
  const now = Date.now();
  await historyAppend([
    { at: now - 3000, action: 'added', task_id: 't1', name: 'older' },
    { at: now - 1000, action: 'completed', task_id: 't2', name: 'newer' },
  ]);
  const all = await historyList();
  assert.equal(all.length, 2);
  assert.equal(all[0].task_id, 't2');   // newest first
  const recent = await historyList({ sinceMs: now - 2000 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].task_id, 't2');
  const limited = await historyList({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].task_id, 't2');
});

test('store: long names are truncated on write', async () => {
  await historyAppend({ at: Date.now(), action: 'added', task_id: 'long', name: 'x'.repeat(500) });
  const [e] = await historyList({ limit: 1 });
  assert.equal(e.name.length, 200);
});
