// Optional phone projection. Names never establish ownership, and cleanup only
// removes verified projections, never a calendar that may contain user tasks.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as reminders from './reminders.js';
import * as dataStore from './app-data.js';
import { withFileLock } from './file-store.js';

export const HABIT_LIST_NAME = 'Habit tracker';
const LEGACY_NOTE = 'Managed by the todo app on your Mac. Check this off when you do the habit \u2014 '
  + 'it gets logged at home and this checkmark resets itself. '
  + 'Edits made here are overwritten; manage habits on the Mac.';
const marker = owner => `[todo-app habit projection: ${owner}]`;
const note = owner => `${marker(owner)}\nManaged by Todo App. Check this off to log the habit on your Mac. Manage habits on the Mac; keep personal tasks in another list.`;
const localYMD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createHabitBridge({ rem = reminders, data = dataStore, lock = withFileLock } = {}) {
  const exclusive = fn => lock(join(data.APP_DATA_DIR, 'habit-sync'), fn);
  const owned = (r, state) => r && (state.owner
    ? (r.body === note(state.owner) || Object.entries(state.map).some(([h, id]) => id === r.id && r.body === `${note(state.owner)}\nHabit: ${h}`))
    : r.body === LEGACY_NOTE && Object.values(state.map).includes(r.id));

  async function sync() {
    if (!(await data.settingsRead()).habitSync) return;
    let state = await data.habitBridgeStateRead();
    const lists = await rem.listLists({ includeBridge: true });
    let list = lists.find(l => l.id === state.listId);
    let existing = list ? await rem.getReminders(list.id, { includeCompleted: true }) : [];
    // Upgrade only explicitly mapped legacy projections with the exact old
    // managed note. Never adopt a list or reminder by its display name.
    if (list && !state.owner) {
      const legacy = existing.filter(r => owned(r, state));
      if (legacy.length) {
        state.owner = randomUUID();
        // Persist intent first; on an interrupted migration, legacy notes on
        // mapped IDs remain eligible for completing this upgrade below.
        state.legacyIds = legacy.map(r => r.id);
        await data.habitBridgeStateWrite(state);
      } else { list = null; existing = []; state = { listId: null, map: {} }; }
    }
    for (const id of state.legacyIds || []) {
      const r = existing.find(r => r.id === id);
      if (r?.body === LEGACY_NOTE) {
        await rem.updateReminder(id, { body: note(state.owner) });
        r.body = note(state.owner);
      }
    }
    delete state.legacyIds;
    const definitions = await data.habitsRead();
    const active = definitions.habits.filter(h => !h.archivedAt);
    if (!list) {
      if (!active.length) return;
      list = await rem.createList(HABIT_LIST_NAME);
      state = { owner: randomUUID(), listId: list.id, map: {} };
      await data.habitBridgeStateWrite(state);
      rem.invalidateBridgeListCache();
    }
    const today = localYMD(new Date());
    for (const [habitId, remId] of Object.entries(state.map)) {
      const r = existing.find(r => r.id === remId);
      if (!owned(r, state)) { delete state.map[habitId]; continue; }
      if (!r.completed) continue;
      if (active.some(h => h.id === habitId)) {
        const completed = r.completionDate ? new Date(r.completionDate) : new Date();
        if (Number.isNaN(completed.getTime())) throw new Error('Invalid phone completion date; check retained.');
        const date = localYMD(completed) > today ? today : localYMD(completed);
        // Atomic ensure, not read-then-toggle. Failure leaves the phone check
        // intact, including disk-full, permission and edit-window failures.
        await data.habitEnsureChecked(habitId, date, today);
        data.notifyDataChange?.();
      } else if (r.completed) {
        // An archived habit's pending completion may still be valuable.
        continue;
      }
      await rem.updateReminder(remId, { completed: false });
      r.completed = false;
    }
    const fresh = await data.habitsRead();
    const wanted = fresh.habits.filter(h => !h.archivedAt);
    for (const [habitId, remId] of Object.entries(state.map)) {
      if (wanted.some(h => h.id === habitId)) continue;
      const r = existing.find(r => r.id === remId);
      if (owned(r, state) && !r.completed) await rem.deleteReminder(remId);
      if (!r?.completed) delete state.map[habitId];
    }
    for (const habit of wanted) {
      const labels = fresh.kinds[habit.id] || {};
      const last = Object.keys(labels).sort().at(-1);
      const kinds = habit.kinds || [];
      const next = kinds.length ? kinds[(kinds.indexOf(labels[last]) + 1) % kinds.length] : null;
      const title = next ? `${habit.name} (next: ${next})` : habit.name;
      let r = existing.find(r => r.id === state.map[habit.id]);
      // Recover a interrupted mapping write through the unique owner + habit
      // marker, not a potentially colliding name.
      if (!owned(r, state)) {
        const recoveryNote = `${note(state.owner)}\nHabit: ${habit.id}`;
        r = existing.find(r => r.body === recoveryNote);
        if (!r) r = await rem.addReminder({ listId: list.id, name: title, body: recoveryNote });
        state.map[habit.id] = r.id;
      } else if (r.name !== title) await rem.updateReminder(r.id, { name: title });
    }
    await data.habitBridgeStateWrite(state);
    rem.invalidateBridgeListCache();
  }

  async function disable() {
    const state = await data.habitBridgeStateRead();
    if (!state.listId) return;
    const lists = await rem.listLists({ includeBridge: true });
    if (!lists.some(l => l.id === state.listId)) return;
    const items = await rem.getReminders(state.listId, { includeCompleted: true });
    for (const [habitId, id] of Object.entries(state.map)) {
      const r = items.find(r => r.id === id);
      // Preserve completed projections for a later sync, and preserve anything
      // whose ownership marker was edited away. Never delete the calendar.
      if (owned(r, state) && !r.completed) {
        await rem.deleteReminder(id);
        delete state.map[habitId];
      }
    }
    await data.habitBridgeStateWrite(state);
    rem.invalidateBridgeListCache();
  }

  return {
    sync: () => exclusive(sync),
    disable: () => exclusive(disable),
  };
}

const bridge = createHabitBridge();
export async function habitBridgeSync() {
  try { await bridge.sync(); }
  catch { console.error('[habit-bridge] sync failed; pending phone checks retained'); }
}
export const habitBridgeDisable = () => bridge.disable();
