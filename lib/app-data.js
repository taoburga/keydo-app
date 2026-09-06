import { atomicWrite, withFileLock } from './file-store.js';
// Server-side app data under ~/Library/Application Support/todo-app/.
// Two stores, both local-only, no cloud:
//   trash.json  — a recoverable bin of deleted tasks (and, later, lists). Every
//                 delete (web app OR MCP) drops the full pre-delete snapshot
//                 here; a restore re-creates the task from it. Kept TRASH_TTL.
//   audit.jsonl — an append-only log of every MCP mutation (before/after). This
//                 is the "what did Claude change" trail behind the guardrails.
//
// Why server-side and not localStorage: deletions happen from BOTH the web UI
// and the MCP (a separate process), and WebView localStorage can be evicted.
// A file in Application Support is the one place both processes can write and
// that survives a cache wipe.
//
// Concurrency note: the web server and MCP server are separate processes.
// Atomic rename alone cannot protect a read-modify-write sequence, so trash
// mutations take a short cross-process lock and use unique temporary files.

import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// TODO_APP_DATA_DIR overrides the location — used by tests; unset in production.
export const APP_DATA_DIR = process.env.TODO_APP_DATA_DIR
  || join(homedir(), 'Library', 'Application Support', 'todo-app');
const TRASH_FILE = join(APP_DATA_DIR, 'trash.json');
const TRASH_BAK = `${TRASH_FILE}.bak`;
const AUDIT_FILE = join(APP_DATA_DIR, 'audit.jsonl');

const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // keep deleted items 7 days
const TRASH_MAX = 2000;                          // hard cap so the file can't grow unbounded

async function _ensureDir() {
  await mkdir(APP_DATA_DIR, { recursive: true });
}

function _parseTrash(raw) {
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : null;
}

// Durability, same contract as habits.json: every write keeps the last good
// copy in trash.json.bak, and a read falls back to it when the main file is
// missing or corrupt (guarantee: at most the last single change is lost).
// Without this, one truncated write read as an EMPTY bin — and the next delete
// then overwrote the file with a single entry, losing every recoverable task
// for good, silently. The trash is the app's data-loss safety net; it gets at
// least the durability the habit tracker has. Keep both halves.
async function _readBacked(file, parse, empty) {
  let unreadable = false;
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const value = parse(await readFile(candidate, 'utf8'));
      if (value) return value;
      unreadable = true;
    } catch (e) { if (e.code !== 'ENOENT') unreadable = true; }
  }
  if (unreadable) throw new Error('Local data and its backup are unreadable; refusing to overwrite them.');
  return empty;
}
async function _readTrash() { return _readBacked(TRASH_FILE, _parseTrash, []); }

// Drop expired entries and sort newest first. Capacity is checked before additions.
function _prune(entries, now) {
  const cutoff = now - TRASH_TTL_MS;
  return entries
    .filter(e => e && typeof e.deletedAt === 'number' && e.deletedAt >= cutoff)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

async function _writeTrashAtomic(entries) {
  try {
    const current = await readFile(TRASH_FILE, 'utf8');
    if (_parseTrash(current)) await atomicWrite(TRASH_BAK, current);
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  await atomicWrite(TRASH_FILE, JSON.stringify(entries));
}

// Serialize across the app and MCP. Locks are never stolen from live writers.
async function _withTrashLock(fn) { return withFileLock(TRASH_FILE, fn); }

function _newTrashEntry(task, source, deletedBy, now = Date.now()) {
  return {
    trashId: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    deletedAt: now,
    source,
    deletedBy: deletedBy || null,
    originalId: task.id,
    task,
  };
}

// Add a deleted task to the trash. `task` is the daemon's reminder dict
// (the deleted snapshot). `source` is 'app' | 'mcp'. Returns the trash entry,
// or null if there's nothing to store.
export async function trashAdd({ task, source = 'app', deletedBy } = {}) {
  if (!task || !task.id) return null;
  const [entry] = await trashAddMany({ tasks: [task], source, deletedBy });
  return entry || null;
}

// Stage a group in ONE locked write. List deletion uses this so a failure can
// never leave half a list in the bin while the live list remains untouched.
export async function trashAddMany({ tasks, source = 'app', deletedBy } = {}) {
  const valid = Array.isArray(tasks) ? tasks.filter(t => t && t.id) : [];
  if (!valid.length) return [];
  return _withTrashLock(async () => {
    const now = Date.now();
    const added = valid.map(task => _newTrashEntry(task, source, deletedBy, now));
    const entries = _prune([...added, ...(await _readTrash())], now);
    if (entries.length > TRASH_MAX) throw new Error('Recovery bin is full (2,000 tasks). Nothing was deleted. Restore items or explicitly empty space in Recently deleted first.');
    await _writeTrashAtomic(entries);
    return added;
  });
}

// List live (non-expired) trash entries, newest first.
export async function trashList() {
  const entries = await _readTrash();
  const pruned = _prune(entries, Date.now());
  // Opportunistically rewrite if pruning removed anything, so the file stays tidy.
  if (pruned.length !== entries.length) {
    try {
      await _withTrashLock(async () => {
        const fresh = await _readTrash();
        const freshPruned = _prune(fresh, Date.now());
        if (freshPruned.length !== fresh.length) await _writeTrashAtomic(freshPruned);
      });
    } catch { /* best-effort */ }
  }
  return pruned;
}

export async function trashGet(trashId) {
  const entries = _prune(await _readTrash(), Date.now());
  return entries.find(e => e.trashId === trashId) || null;
}

export async function trashRemove(trashId) {
  await trashRemoveMany([trashId]);
}

export async function trashRemoveMany(trashIds) {
  const ids = new Set((trashIds || []).filter(Boolean));
  if (!ids.size) return;
  await _withTrashLock(async () => {
    const entries = _prune(await _readTrash(), Date.now()).filter(e => !ids.has(e.trashId));
    await _writeTrashAtomic(entries);
  });
}

// Append one record to the MCP audit log. Best-effort: a logging failure must
// never block or fail the real operation.
export async function auditAppend(record) {
  try {
    await _ensureDir();
    await _appendRetained(AUDIT_FILE, [{ at: Date.now(), ...record }], 90 * 86400000);
  } catch { /* swallow — audit is advisory */ }
}

// ----- app settings -----
// settings.json holds the few preferences that must be shared BEYOND the
// WebView's localStorage — today just `defaultDueTime` ("HH:MM"), because the
// global-hotkey capture panel parses quick-add text on the SERVER, and both
// parse paths (app and server) must stamp the same default clock time on
// "tomorrow" / "friday". Written by PATCH /api/settings from the in-app
// settings pane. Purely-frontend preferences (theme, accent, sound…) stay in
// localStorage — don't migrate them here without a cross-process reason.

const SETTINGS_FILE = join(APP_DATA_DIR, 'settings.json');

export async function settingsRead() {
  try {
    const data = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('Settings are unreadable; refusing to replace them.');
  }
}

// Shallow-merge a patch into the stored settings; returns the merged object.
// Callers validate values BEFORE writing — this layer only persists.
async function _settingsWrite(patch) {
  const merged = { ...(await settingsRead()), ...patch };
  await _ensureDir();
  await atomicWrite(SETTINGS_FILE, JSON.stringify(merged));
  return merged;
}

// ----- habits -----
// habits.json holds habit definitions + per-day checkmarks. Habits are NOT
// tasks: the optional phone bridge is a disposable projection. Weekly frequency targets ("4x/week"), not daily streaks —
// the forgiving model. Server-side so a daily-briefing skill (via the MCP) can
// read progress; the web app is the only writer today.
// Shape: { habits: [{id, name, target, kinds?, createdAt, archivedAt|null}],
//          checks: { [habitId]: ["YYYY-MM-DD", ...] },       (LOCAL dates)
//          kinds:  { [habitId]: { "YYYY-MM-DD": "push" } } }
// `kinds` on a habit is an ordered rotation of check labels (gym: push /
// pull / legs / cardio); the per-date map records which label a check got,
// so the UI can suggest what's next.

const HABITS_FILE = join(APP_DATA_DIR, 'habits.json');
const HABIT_NAME_MAX = 60;
const HABIT_MAX = 25;                 // sanity cap on definitions
const HABIT_CHECK_BACKDAYS = 70;      // how far back a check may be toggled —
                                      // covers the full 8-week history modal,
                                      // which is editable (check off Sunday on
                                      // Monday, fix a missed week, etc.)
const HABIT_KINDS_MAX = 8;
const HABIT_KIND_LEN = 16;

// Durability: every write first copies the current good file to habits.json.bak,
// then writes tmp + atomic rename. Reads fall back to the .bak if the main file
// is missing or corrupt, so a bad write can lose at most the single last change,
// never the history.
const HABITS_BAK = `${join(APP_DATA_DIR, 'habits.json')}.bak`;

function _parseHabits(raw) {
  const data = JSON.parse(raw);
  if (data && typeof data === 'object' && Array.isArray(data.habits)) {
    return {
      habits: data.habits,
      checks: (data.checks && typeof data.checks === 'object') ? data.checks : {},
      kinds: (data.kinds && typeof data.kinds === 'object') ? data.kinds : {},
    };
  }
  return null;
}

async function _readHabits() {
  return _readBacked(HABITS_FILE, _parseHabits, { habits: [], checks: {}, kinds: {} });
}

// Normalize + validate a kinds rotation. null/undefined → undefined (none);
// an empty array clears the rotation.
function _cleanKinds(kinds) {
  if (kinds === null || kinds === undefined) return undefined;
  if (!Array.isArray(kinds)) throw new Error('kinds must be a list of labels');
  const out = [];
  for (const k of kinds) {
    const v = String(k || '').trim().toLowerCase().slice(0, HABIT_KIND_LEN);
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length > HABIT_KINDS_MAX) throw new Error(`at most ${HABIT_KINDS_MAX} kinds`);
  return out;
}

async function _writeHabitsAtomic(data) {
  try {
    const current = await readFile(HABITS_FILE, 'utf8');
    if (_parseHabits(current)) await atomicWrite(HABITS_BAK, current);
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  await atomicWrite(HABITS_FILE, JSON.stringify(data));
}

const _HABIT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function habitsRead() {
  return _readHabits();
}

async function _habitAdd({ name, target, kinds } = {}) {
  const n = typeof name === 'string' ? name.trim().slice(0, HABIT_NAME_MAX) : '';
  const t = Number(target);
  if (!n) throw new Error('habit needs a name');
  if (!Number.isInteger(t) || t < 1 || t > 7) throw new Error('target must be 1-7 (times per week)');
  const k = _cleanKinds(kinds);
  const data = await _readHabits();
  if (data.habits.filter(h => !h.archivedAt).length >= HABIT_MAX) throw new Error(`habit cap (${HABIT_MAX}) reached`);
  const habit = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: n,
    target: t,
    createdAt: Date.now(),
    archivedAt: null,
  };
  if (k && k.length) habit.kinds = k;
  data.habits.push(habit);
  await _writeHabitsAtomic(data);
  return habit;
}

async function _habitUpdate(id, patch = {}) {
  const data = await _readHabits();
  const habit = data.habits.find(h => h.id === id);
  if (!habit) throw new Error('habit not found');
  if (patch.name !== undefined) {
    const n = typeof patch.name === 'string' ? patch.name.trim().slice(0, HABIT_NAME_MAX) : '';
    if (!n) throw new Error('habit needs a name');
    habit.name = n;
  }
  if (patch.target !== undefined) {
    const t = Number(patch.target);
    if (!Number.isInteger(t) || t < 1 || t > 7) throw new Error('target must be 1-7 (times per week)');
    habit.target = t;
  }
  if (patch.archived !== undefined) habit.archivedAt = patch.archived ? Date.now() : null;
  if (patch.kinds !== undefined) {
    const k = _cleanKinds(patch.kinds);
    if (k && k.length) habit.kinds = k;
    else delete habit.kinds;
  }
  await _writeHabitsAtomic(data);
  return habit;
}

// Hard delete: definition AND its checkmarks. The UI confirms first.
async function _habitDelete(id) {
  const data = await _readHabits();
  const before = data.habits.length;
  data.habits = data.habits.filter(h => h.id !== id);
  if (data.habits.length === before) throw new Error('habit not found');
  delete data.checks[id];
  delete data.kinds[id];
  await _writeHabitsAtomic(data);
}

// Toggle a checkmark for one LOCAL day. `todayStr` is the caller's local
// "today" (the server must not guess the browser's timezone). Only today and
// the recent past are editable — never the future.
async function _habitToggle(id, dateStr, todayStr, kind, ensure = false) {
  if (!_HABIT_DATE_RE.test(dateStr || '') || !_HABIT_DATE_RE.test(todayStr || '')) {
    throw new Error('dates must be YYYY-MM-DD');
  }
  if (dateStr > todayStr) throw new Error('cannot check a future day');
  const back = new Date(`${todayStr}T00:00:00`);
  back.setDate(back.getDate() - HABIT_CHECK_BACKDAYS);
  const backStr = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-${String(back.getDate()).padStart(2, '0')}`;
  if (dateStr < backStr) throw new Error(`can only edit the last ${HABIT_CHECK_BACKDAYS} days`);
  const data = await _readHabits();
  const habit = data.habits.find(h => h.id === id);
  if (!habit) throw new Error('habit not found');
  const list = data.checks[id] || [];
  const i = list.indexOf(dateStr);
  if (ensure && i >= 0) return { habitId: id, date: dateStr, checked: true, kind: data.kinds[id]?.[dateStr] || null };
  const checked = i < 0;
  if (checked) list.push(dateStr);
  else list.splice(i, 1);
  list.sort();
  data.checks[id] = list;
  // Kind label (gym: push/pull/legs/cardio) rides along with the check and
  // dies with it. Only labels from the habit's own rotation are accepted.
  const kindMap = data.kinds[id] || {};
  if (checked && kind !== undefined && kind !== null && kind !== '') {
    const k = String(kind).trim().toLowerCase();
    if (!Array.isArray(habit.kinds) || !habit.kinds.includes(k)) {
      throw new Error(`"${k}" is not one of this habit's kinds`);
    }
    kindMap[dateStr] = k;
  } else {
    delete kindMap[dateStr];
  }
  if (Object.keys(kindMap).length) data.kinds[id] = kindMap;
  else delete data.kinds[id];
  await _writeHabitsAtomic(data);
  return { habitId: id, date: dateStr, checked, kind: checked ? (kindMap[dateStr] || null) : null };
}

// ----- habit → Reminders bridge state -----
// habit-bridge.json tracks the EventKit side of phone habit sync (see
// lib/habit-bridge.js): the bridged list's calendarIdentifier and the
// habitId → reminderId map. Tiny, low-stakes, single-writer (the app server);
// writes are serialized across processes. The listId is ALSO read by
// lib/reminders.js (both server and MCP processes) to hide the bridge list
// from every ordinary task read.

const HABIT_BRIDGE_FILE = join(APP_DATA_DIR, 'habit-bridge.json');

export async function habitBridgeStateRead() {
  try {
    const data = JSON.parse(await readFile(HABIT_BRIDGE_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { legacyIds: Array.isArray(data.legacyIds) ? data.legacyIds : [], owner: data.owner || null, listId: data.listId || null, map: (data.map && typeof data.map === 'object') ? data.map : {} };
    }
  } catch { /* missing or corrupt → no bridge */ }
  return { listId: null, map: {} };
}

async function _habitBridgeStateWrite(state) {
  await _ensureDir();
  await atomicWrite(HABIT_BRIDGE_FILE, JSON.stringify(state));
}

// ----- morning briefing -----
// briefing.json holds the latest chief-of-staff briefing, published by a
// daily-briefing skill through the MCP (`briefing_set`) and shown by the web app as
// a once-a-day pop-up. One briefing at a time — a new write replaces the old.
// Server-side for the same reason as the trash: the writer (MCP) and the
// reader (web server) are different processes.

const BRIEFING_FILE = join(APP_DATA_DIR, 'briefing.json');

export async function briefingRead() {
  try {
    const data = JSON.parse(await readFile(BRIEFING_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch {
    return null;   // missing or corrupt → no briefing
  }
}

async function _briefingWrite(briefing) {
  await _ensureDir();
  await atomicWrite(BRIEFING_FILE, JSON.stringify(briefing));
}

// ----- check-in feedback -----
// The user's reactions to a briefing, captured in the app's pop-up: "done" marks on
// plan items and free-text notes for the next check-in. Append-only JSONL; the
// daily-briefing skill reads it back through the MCP (briefing_get) and tracks in its
// own ledger how far it has processed (entries carry an `at` timestamp).

const FEEDBACK_FILE = join(APP_DATA_DIR, 'checkin-feedback.jsonl');
const FEEDBACK_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // two weeks is plenty of runway
const FEEDBACK_MAX = 200;

export async function feedbackAppend(entry) {
  await _ensureDir();
  await _appendRetained(FEEDBACK_FILE, [{ at: Date.now(), ...entry }], FEEDBACK_TTL_MS);
}

export async function feedbackList() {
  try {
    const lines = (await readFile(FEEDBACK_FILE, 'utf8')).split('\n').filter(Boolean);
    const cutoff = Date.now() - FEEDBACK_TTL_MS;
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e && typeof e.at === 'number' && e.at >= cutoff) out.push(e);
      } catch { /* skip corrupt line */ }
    }
    return out.slice(-FEEDBACK_MAX);
  } catch {
    return [];   // missing file → no feedback
  }
}

// ----- meeting prep -----
// prep.json: meeting-prep briefs published by a meeting-prep (or daily-briefing)
// skill through the MCP (meeting_prep_set), keyed by "<date>|<normalized
// title>" so a re-publish for the same meeting replaces the old brief. The
// calendar pane matches entries to events by date + title/start and shows a
// clickable card. Kept 90 days, capped, pruned on every write and read so the
// file stays small however many meetings pile up.
// prep-feedback.jsonl: the user's reactions from the prep card ("done" / "dismiss"
// marks on open-loop items, free-text notes). Read back via meeting_prep_get
// so later prep and check-in runs stop resurfacing handled items.

const PREP_FILE = join(APP_DATA_DIR, 'prep.json');
const PREP_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PREP_MAX = 500;

// Canonical key for one meeting's prep. Title is normalized (case/whitespace)
// so the skill's copy of a calendar title matches the EventKit one.
export function prepKey(date, title) {
  const t = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
  return `${date}|${t}`;
}

async function _readPreps() {
  try {
    const data = JSON.parse(await readFile(PREP_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('Meeting preps are unreadable; refusing to replace them.');
  }
}

// Drop entries older than the TTL (by their meeting date), newest-date-first
// cap so the store can't grow unbounded.
function _prunePreps(map, now) {
  const cutoff = now - PREP_TTL_MS;
  const keep = Object.entries(map)
    .filter(([, e]) => {
      if (!e || typeof e.date !== 'string') return false;
      const [y, m, d] = e.date.split('-').map(Number);
      const t = new Date(y, (m || 1) - 1, d || 1).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => (b[1].date > a[1].date ? 1 : -1))
    .slice(0, PREP_MAX);
  return Object.fromEntries(keep);
}

async function _writePrepsAtomic(map) {
  await _ensureDir();
  await atomicWrite(PREP_FILE, JSON.stringify(map));
}

// Publish (or replace) one meeting's prep. Returns the stored entry.
async function _prepSet(entry) {
  const key = prepKey(entry.date, entry.title);
  const map = _prunePreps({ ...(await _readPreps()), [key]: { ...entry, key } }, Date.now());
  await _writePrepsAtomic(map);
  return map[key] || { ...entry, key };
}

// List preps, optionally for one YYYY-MM-DD date. Newest meeting date first.
export async function prepList({ date } = {}) {
  const map = _prunePreps(await _readPreps(), Date.now());
  const all = Object.values(map).sort((a, b) => (a.date < b.date ? 1 : -1));
  return date ? all.filter(e => e.date === date) : all;
}

const PREP_FEEDBACK_FILE = join(APP_DATA_DIR, 'prep-feedback.jsonl');
const PREP_FEEDBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREP_FEEDBACK_MAX = 500;

export async function prepFeedbackAppend(entry) {
  await _ensureDir();
  await _appendRetained(PREP_FEEDBACK_FILE, [{ at: Date.now(), ...entry }], PREP_FEEDBACK_TTL_MS);
}

export async function prepFeedbackList() {
  try {
    const lines = (await readFile(PREP_FEEDBACK_FILE, 'utf8')).split('\n').filter(Boolean);
    const cutoff = Date.now() - PREP_FEEDBACK_TTL_MS;
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e && typeof e.at === 'number' && e.at >= cutoff) out.push(e);
      } catch { /* skip corrupt line */ }
    }
    return out.slice(-PREP_FEEDBACK_MAX);
  } catch {
    return [];   // missing file → no feedback
  }
}

// ----- task history -----
// history.jsonl: append-only log of task lifecycle events (added / completed /
// uncompleted / deleted), derived by server.js diffing full-task-set snapshots
// on every daemon change notification. Captures changes from ANY surface (app,
// MCP, iPhone, Siri) — but only while the app/server is running. Read back by
// the MCP `tasks_history` tool for daily-briefing context and scoreboards.

const HISTORY_FILE = join(APP_DATA_DIR, 'history.jsonl');
const HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;   // reads ignore events older than this
const HISTORY_READ_MAX = 1000;
const HISTORY_NAME_MAX = 200;

export async function historyAppend(events) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!list.length) return;
  await _ensureDir();
  await _appendRetained(HISTORY_FILE, list.map(e => ({ ...e,
    name: typeof e.name === 'string' ? e.name.slice(0, HISTORY_NAME_MAX) : '',
  })), HISTORY_TTL_MS);
}

// Newest first. Appends are chronological, so we scan backwards and stop at
// the first entry older than the cutoff.
export async function historyList({ sinceMs = 0, limit = 200 } = {}) {
  try {
    const lines = (await readFile(HISTORY_FILE, 'utf8')).split('\n').filter(Boolean);
    const cutoff = Math.max(sinceMs, Date.now() - HISTORY_TTL_MS);
    const cap = Math.min(limit, HISTORY_READ_MAX);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (!e || typeof e.at !== 'number') continue;
      if (e.at < cutoff) break;
      out.push(e);
    }
    return out;
  } catch {
    return [];   // missing file → no history yet
  }
}

export const habitAdd = async (...args) => { const result = await withFileLock(HABITS_FILE, () => _habitAdd(...args)); notifyDataChange(); return result; };

export const habitUpdate = async (...args) => { const result = await withFileLock(HABITS_FILE, () => _habitUpdate(...args)); notifyDataChange(); return result; };

export const habitDelete = async (...args) => { const result = await withFileLock(HABITS_FILE, () => _habitDelete(...args)); notifyDataChange(); return result; };

export const habitToggle = async (...args) => { const result = await withFileLock(HABITS_FILE, () => _habitToggle(...args)); notifyDataChange(); return result; };

export const settingsWrite = async (...args) => { const result = await withFileLock(SETTINGS_FILE, () => _settingsWrite(...args)); notifyDataChange(); return result; };

export const prepSet = async (...args) => { const result = await withFileLock(PREP_FILE, () => _prepSet(...args)); notifyDataChange(); return result; };

export const briefingWrite = async (...args) => { const result = await withFileLock(BRIEFING_FILE, () => _briefingWrite(...args)); notifyDataChange(); return result; };

export const habitBridgeStateWrite = async (...args) => { const result = await withFileLock(HABIT_BRIDGE_FILE, () => _habitBridgeStateWrite(...args)); notifyDataChange(); return result; };

export const habitEnsureChecked = (id, date, today) => withFileLock(HABITS_FILE, () => _habitToggle(id, date, today, undefined, true));

const dataListeners = new Set();
export function onDataChange(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); }
export function notifyDataChange() { for (const fn of dataListeners) { try { fn(); } catch {} } }

const lastLogPrune = new Map();
async function _appendRetained(file, records, ttl) {
  return withFileLock(file, async () => {
    await _ensureDir();
    const now = Date.now();
    if (now - (lastLogPrune.get(file) || 0) > 86400000) {
      let raw = '';
      try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const keep = raw.split('\n').filter(line => {
        if (!line) return false;
        try { return JSON.parse(line).at >= now - ttl; } catch { return true; }
      });
      await atomicWrite(file, keep.length ? keep.join('\n') + '\n' : '');
      lastLogPrune.set(file, now);
    }
    await appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    notifyDataChange();
  });
}
