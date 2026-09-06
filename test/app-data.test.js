// Tests for lib/app-data.js — the server-side trash store. Runs against a
// temp dir via TODO_APP_DATA_DIR so it never touches the real Application
// Support data. The module reads that env var at import time, so we set it
// BEFORE dynamically importing the module.
//
// Run with: npm test  (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TODO_APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'todo-trash-'));
const { trashAdd, trashAddMany, trashList, trashGet, trashRemove } = await import('../lib/app-data.js');

const sampleTask = (id, name) => ({ id, name, listId: 'L1', listName: 'To Dos', dueDate: null, allDay: false });

test('a deleted task is added and listed (newest first)', async () => {
  await trashAdd({ task: sampleTask('a1', 'first'), source: 'app' });
  await trashAdd({ task: sampleTask('a2', 'second'), source: 'mcp' });
  const list = await trashList();
  assert.equal(list.length, 2);
  assert.equal(list[0].task.name, 'second');     // newest first
  assert.equal(list[0].source, 'mcp');
  assert.equal(list[1].task.name, 'first');
  assert.ok(list[0].trashId && list[0].deletedAt);
});

test('trashGet finds by id; trashRemove drops it', async () => {
  const entry = await trashAdd({ task: sampleTask('b1', 'purge me'), source: 'app' });
  const got = await trashGet(entry.trashId);
  assert.equal(got.task.name, 'purge me');
  await trashRemove(entry.trashId);
  assert.equal(await trashGet(entry.trashId), null);
});

test('a task with no id is not stored', async () => {
  const res = await trashAdd({ task: { name: 'no id' }, source: 'app' });
  assert.equal(res, null);
});

test('entries older than the 7-day window are pruned on list', async () => {
  const entry = await trashAdd({ task: sampleTask('c1', 'stale'), source: 'app' });
  // Backdate it past the TTL by editing the file directly.
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = join(process.env.TODO_APP_DATA_DIR, 'trash.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const stale = data.find(e => e.trashId === entry.trashId);
  stale.deletedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);   // 8 days ago
  await writeFile(file, JSON.stringify(data), 'utf8');
  const list = await trashList();
  assert.equal(list.find(e => e.trashId === entry.trashId), undefined);
});

test('batch staging is all-or-nothing and preserves every task', async () => {
  const entries = await trashAddMany({
    tasks: [sampleTask('batch-1', 'one'), sampleTask('batch-2', 'two'), sampleTask('batch-3', 'three')],
    source: 'app',
    deletedBy: 'test-list-delete',
  });
  assert.equal(entries.length, 3);
  const ids = new Set((await trashList()).map(e => e.task.id));
  assert.ok(ids.has('batch-1'));
  assert.ok(ids.has('batch-2'));
  assert.ok(ids.has('batch-3'));
});

test('concurrent writes from separate processes retain every entry', async () => {
  const moduleUrl = new URL('../lib/app-data.js', import.meta.url).href;
  const childCode = [
    'const m = await import(process.argv[1]);',
    'const id = process.argv[2];',
    "await m.trashAdd({ task: { id, name: id, listId: 'L1' }, source: 'mcp' });",
  ].join(' ');
  const ids = Array.from({ length: 20 }, (_, i) => `race-${i + 1}`);
  await Promise.all(ids.map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, moduleUrl, id], {
      cwd: process.cwd(),
      env: { ...process.env, TODO_APP_DATA_DIR: process.env.TODO_APP_DATA_DIR },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}: ${stderr}`)));
  })));
  const stored = new Set((await trashList()).map(e => e.task.id));
  for (const id of ids) assert.ok(stored.has(id), `missing concurrent trash entry ${id}`);
});

test('a corrupt primary file falls back to the last good backup', async () => {
  const { writeFile } = await import('node:fs/promises');
  const file = join(process.env.TODO_APP_DATA_DIR, 'trash.json');
  await trashAdd({ task: sampleTask('backup-kept', 'kept'), source: 'app' });
  await trashAdd({ task: sampleTask('backup-last-change', 'last change'), source: 'app' });
  await writeFile(file, '{broken json', 'utf8');
  const ids = new Set((await trashList()).map(e => e.task.id));
  assert.ok(ids.has('backup-kept'));
  assert.equal(ids.has('backup-last-change'), false);
});
