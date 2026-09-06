// Tests for lib/summary.js (pure, no I/O by design).
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, _internal } from '../lib/summary.js';

function isoAt(daysFromToday, hour = 12) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString();
}

const TASKS = [
  { id: 'a', name: 'overdue thing', listId: 'L', dueDate: isoAt(-2), priority: 'none' },
  { id: 'b', name: 'today thing', listId: 'L', dueDate: isoAt(0), priority: 'high' },
  { id: 'c', name: 'this week thing', listId: 'L', dueDate: isoAt(3), priority: 'low' },
  { id: 'd', name: 'far future thing', listId: 'L', dueDate: isoAt(30), priority: 'none' },
  { id: 'e', name: 'no due #flag', listId: 'L', priority: 'medium' },
  { id: 'f', name: 'done thing', listId: 'L', dueDate: isoAt(0), completed: true, priority: 'high' },
];

test('buckets: overdue / today / this-week are disjoint and exclude completed', () => {
  const s = buildSummary(TASKS);
  assert.equal(s.counts.total_open, 5);          // 'f' is completed
  assert.equal(s.counts.overdue, 1);
  assert.equal(s.counts.due_today, 1);
  assert.equal(s.counts.due_this_week, 1);       // 'd' (30 days out) excluded
  assert.deepEqual(s.overdue.map(t => t.id), ['a']);
  assert.deepEqual(s.due_today.map(t => t.id), ['b']);
  assert.deepEqual(s.due_this_week.map(t => t.id), ['c']);
});

test('priority counts and flag detection', () => {
  const s = buildSummary(TASKS);
  assert.deepEqual(s.counts.by_priority, { high: 1, medium: 1, low: 1 });
  assert.equal(s.counts.flagged, 1);
  assert.deepEqual(s.flagged.map(t => t.id), ['e']);
});

test('#flag matches only as a standalone token', () => {
  const { _isFlagged } = _internal;
  assert.equal(_isFlagged({ name: 'pay #flag bill' }), true);
  assert.equal(_isFlagged({ name: '', body: 'notes #FLAG' }), true);
  assert.equal(_isFlagged({ name: 'review #flagship launch' }), false);
});

test('topN caps each slice', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, name: `task ${i}`, listId: 'L', dueDate: isoAt(-1 - i),
  }));
  const s = buildSummary(many, { topN: 3 });
  assert.equal(s.counts.overdue, 10);
  assert.equal(s.overdue.length, 3);
  // Sorted ascending: the most-overdue first.
  assert.deepEqual(s.overdue.map(t => t.id), ['t9', 't8', 't7']);
});

test('slim shape exposes exactly the documented fields', () => {
  const s = buildSummary(TASKS);
  assert.deepEqual(Object.keys(s.due_today[0]).sort(),
    ['all_day', 'completed', 'due_date', 'flagged', 'id', 'list_id', 'name', 'priority']);
});

test('all-day due dates surface as a bare local YYYY-MM-DD, not raw UTC', () => {
  // Daemon encodes an all-day task as local-midnight-formatted-as-UTC. In a
  // positive-offset timezone that ISO reads as the previous calendar day, so
  // the slim shape must convert it back to local components.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const s = buildSummary([
    { id: 'ad', name: 'all-day today', listId: 'L', dueDate: today.toISOString(), allDay: true, priority: 'none' },
  ]);
  const row = s.due_today.find(t => t.id === 'ad');
  assert.ok(row, 'all-day task should land in due_today');
  assert.equal(row.due_date, ymd);
  assert.equal(row.all_day, true);
});
