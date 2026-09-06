// Thin Node client for the Swift `reminders-daemon`. The daemon is spawned once
// at process start, holds an EKEventStore, and speaks newline-delimited JSON
// over stdio. Per-call latency: ~1-10ms (was 200-500ms via osascript).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(__dirname, '..', 'bin', 'reminders-daemon');

// ---------------------------------------------------------------------------
// daemon lifecycle (singleton)
// ---------------------------------------------------------------------------

let proc = null;
let nextId = 1;
const pending = new Map();             // id → { resolve, reject, t0 }
// `ready` is per-spawn now: a fresh deferred is created at every startDaemon().
// The previous module-level singleton meant a daemon crash left a settled
// promise behind, so subsequent calls awaited a stale resolution (or a
// permanently-rejected promise that caused all future calls to hang).
let readyDeferred = null;              // { promise, resolve, reject } — null until first spawn
const changeListeners = new Set();     // (() => void) listeners for store-change pushes
let stdoutBuffer = '';
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024; // 8 MiB safety cap; a single line should never approach this.

// Restart-storm protection. If the daemon keeps crashing inside the window,
// open a cooldown so we don't hammer EventKit with respawn attempts.
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const COOLDOWN_MS = 30_000;
let restartCount = 0;
let restartWindowStart = 0;
let cooldownUntil = 0;
// Last `fatal` event payload from the daemon (e.g. Reminders access denied).
// Used to give exit errors an actionable message instead of "exited code=2".
let lastFatalError = null;

function _newDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function startDaemon() {
  if (proc) return;

  const now = Date.now();
  if (now < cooldownUntil) {
    // Don't spawn — surface the cooldown to the next call().
    const remainingS = Math.ceil((cooldownUntil - now) / 1000);
    readyDeferred = _newDeferred();
    readyDeferred.reject(new Error(`reminders-daemon in cooldown after repeated crashes (${remainingS}s remaining)`));
    return;
  }

  // Roll the window if we're outside it.
  if (now - restartWindowStart > RESTART_WINDOW_MS) {
    restartWindowStart = now;
    restartCount = 0;
  }

  readyDeferred = _newDeferred();
  // A previous daemon may have died mid-line; a leftover partial line would
  // corrupt the new daemon's first message (its `ready` event) and leave every
  // call awaiting ready forever. Always start a spawn with a clean buffer.
  stdoutBuffer = '';
  lastFatalError = null;
  proc = spawn(DAEMON_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stdout.setEncoding('utf8'); // streaming decoder preserves split multibyte characters
  proc.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      console.error('[daemon] stdout buffer exceeded cap; dropping. Killing daemon.');
      stdoutBuffer = '';
      try { proc?.kill('SIGKILL'); } catch {}
      return;
    }
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { console.error('[daemon] received a malformed response line'); continue; }
      handleMessage(msg);
    }
  });

  // Without an error listener on stdin, an EPIPE here would be uncaught and crash the process.
  proc.stdin.on('error', err => {
    console.error(`[daemon] stdin error code=${String(err?.code || 'unknown').toLowerCase()}`);
  });

  proc.stderr.on('data', d => {
    process.stderr.write('[daemon] ' + d.toString());
  });

  proc.on('exit', (code, signal) => {
    // Prefer the daemon's own fatal message (e.g. "Reminders access denied —
    // enable it in System Settings…") over a bare exit code.
    const err = new Error(lastFatalError
      ? `reminders-daemon: ${lastFatalError}`
      : `reminders-daemon exited (code=${code}, signal=${signal})`);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    proc = null;
    // If exit happened before ready resolved, reject so the awaiting call doesn't hang.
    // (Reject after a prior resolve is a no-op — promises are single-state.)
    if (readyDeferred) {
      try { readyDeferred.reject(err); } catch {}
    }
    // Restart bookkeeping: count this crash against the window.
    restartCount++;
    if (restartCount > MAX_RESTARTS_PER_WINDOW) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      restartCount = 0;
      restartWindowStart = 0;
      console.error(`[daemon] crashed ${MAX_RESTARTS_PER_WINDOW + 1}× within ${RESTART_WINDOW_MS / 1000}s — entering ${COOLDOWN_MS / 1000}s cooldown`);
    }
  });

  proc.on('error', err => {
    console.error(`[daemon] spawn error code=${String(err?.code || 'unknown').toLowerCase()}`);
    // Spawn failures (e.g. binary missing) may never emit `exit`, so reset
    // `proc` here too — otherwise startDaemon() early-returns on the dead
    // handle forever and a rebuilt binary is never picked up.
    proc = null;
    if (readyDeferred) readyDeferred.reject(err);
  });
}

function handleMessage(msg) {
  if (msg.event === 'ready') {
    if (readyDeferred) readyDeferred.resolve();
    return;
  }
  if (msg.event === 'fatal') {
    lastFatalError = msg.error || 'daemon fatal';
    const err = new Error(lastFatalError);
    if (readyDeferred) readyDeferred.reject(err);
    return;
  }
  if (msg.event === 'changed') {
    for (const fn of changeListeners) {
      try { fn(); } catch { console.error('[daemon] change listener failed'); }
    }
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) resolve(msg.result);
    else {
      const err = new Error(msg.error || 'daemon error');
      // Daemon-flagged caller mistakes (bad date, list not found, …) — the
      // HTTP layer maps these to 400 instead of 500.
      err.userError = !!msg.userError;
      reject(err);
    }
  }
}

// The ready phase has its own (generous) timeout: the daemon blocks on the
// macOS Reminders permission prompt before emitting `ready`, and without a
// cap an unanswered prompt (or a wedged TCC state) hangs every request
// forever — the per-op timeout below only starts counting *after* ready.
const READY_TIMEOUT_MS = 30_000;

function _withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function call(op, args = {}, { timeoutMs = 30000 } = {}) {
  startDaemon();
  // Capture the deferred current at call-time so a daemon crash + respawn
  // mid-call doesn't accidentally have us await the next spawn's deferred.
  const myReady = readyDeferred?.promise;
  if (!myReady) return Promise.reject(new Error('daemon not started'));
  const readyOrTimeout = _withTimeout(myReady, READY_TIMEOUT_MS,
    `reminders-daemon not ready after ${READY_TIMEOUT_MS / 1000}s — if a Reminders permission prompt is open, grant it and retry`);
  return readyOrTimeout.then(() => new Promise((resolve, reject) => {
    if (!proc || !proc.stdin.writable) return reject(new Error('daemon not running'));
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`daemon op '${op}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(id, {
      resolve: r => { clearTimeout(timer); resolve(r); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    // Wrap because a write to a closed pipe throws synchronously sometimes (EPIPE).
    try {
      proc.stdin.write(JSON.stringify({ id, op, args, deadline: Date.now() + timeoutMs - 1000 }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  }));
}

// Make sure the daemon dies with us.
function shutdown() {
  if (proc) {
    try { proc.stdin.end(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
    proc = null;
  }
}
process.on('exit', shutdown);
process.on('SIGINT',  () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

// ---------------------------------------------------------------------------
// public api (same shape as before so server.js doesn't change)
// ---------------------------------------------------------------------------

export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

export async function warmup() {
  // Triggers daemon startup + EKEventStore init; resolves once daemon is ready.
  await call('ping');
  const lists = await call('listLists');
  return { ok: true, lists: lists.length };
}

// ----- habit-bridge list exclusion -----
// When phone habit sync is on (lib/habit-bridge.js), a managed "Habit tracker"
// list exists in Reminders. It is app plumbing, not tasks: hide it here, at
// the one chokepoint BOTH processes (app server and MCP server) read through,
// so the sidebar, counts, history diffing, search, summaries and every MCP
// tool never see it. The bridge itself passes { includeBridge: true }.
// The id lives in habit-bridge.json (app-data); cache it briefly — the MCP
// process learns of changes via the TTL, the app server via the same.
import { habitBridgeStateRead, settingsRead } from './app-data.js';
let _bridgeCache = { at: 0, id: null };
// The bridge calls this right after writing habit-bridge.json so a just-made
// list is excluded immediately (the history diff runs ~2.5s after a change
// event — a stale 5s cache there would log the bridge reminders as tasks).
export function invalidateBridgeListCache() { _bridgeCache.at = 0; }
async function _bridgeListId() {
  if (Date.now() - _bridgeCache.at > 5000) {
    let id = null;
    try {
      const state = await habitBridgeStateRead();
      if ((await settingsRead()).habitSync && state.listId && state.owner) {
        const items = await call('getReminders', { listId: state.listId, includeCompleted: true });
        // A user-added task makes the list visible; never hide their content.
        const prefix = `[todo-app habit projection: ${state.owner}]\n`;
        if (items.every(r => (r.body || '').startsWith(prefix))) id = state.listId;
      }
    } catch { /* show the list if ownership cannot be verified */ }
    _bridgeCache = { at: Date.now(), id };
  }
  return _bridgeCache.id;
}

export async function listLists({ includeBridge = false } = {}) {
  const lists = await call('listLists');
  if (includeBridge) return lists;
  const bid = await _bridgeListId();
  return bid ? lists.filter(l => l && l.id !== bid) : lists;
}

export async function listCounts() {
  const counts = await call('listCounts');
  const bid = await _bridgeListId();
  if (bid && counts && typeof counts === 'object') delete counts[bid];
  return counts;
}

export function getReminders(listId, { includeCompleted = false } = {}) {
  // By explicit list id — reachable only for ids the caller already has, and
  // the bridge list never appears in listLists. No filter needed.
  return call('getReminders', { listId, includeCompleted });
}

export async function getAllReminders({ includeCompleted = false } = {}) {
  const tasks = await call('getAllReminders', { includeCompleted });
  const bid = await _bridgeListId();
  return bid ? tasks.filter(t => t && t.listId !== bid) : tasks;
}

export function addReminder(payload) {
  return call('addReminder', payload);
}

export function updateReminder(id, updates) {
  return call('updateReminder', { id, ...updates });
}

// Single-reminder snapshot. Used to capture a recoverable copy BEFORE a delete
// (the delete is irreversible, so the trash write must land first).
export async function getReminder(id) {
  const task = await call('getReminder', { id });
  if (task.listId === await _bridgeListId()) throw Object.assign(new Error('reminder not found'), { userError: true });
  return task;
}

export function deleteReminder(id) {
  return call('deleteReminder', { id });
}

export function createList(name) {
  return call('createList', { name });
}

export function renameList(listId, name) {
  return call('renameList', { listId, name });
}

// Deletes the list AND its reminders. Returns `deleted`: snapshots of every
// reminder that was inside, for the caller to stash in the recoverable trash.
export function deleteList(listId) {
  return call('deleteList', { listId });
}

// Read-only calendar events in [start, end) for the calendar pane. First call
// triggers the macOS Calendars permission prompt (lazy TCC).
export function getCalendarEvents(startISO, endISO) {
  return call('getEvents', { start: startISO, end: endISO });
}
