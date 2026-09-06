// Pure diff between two snapshots of the full Reminders task set. server.js
// uses this to derive history events (added / completed / uncompleted /
// deleted) from the daemon's change notifications — regardless of where the
// change originated (this app, the MCP, iPhone, Siri, Reminders.app). The
// events land in history.jsonl (lib/app-data.js) and feed a daily-briefing skill's memory.

export function snapshotFromTasks(tasks) {
  const map = new Map();
  for (const t of tasks || []) {
    if (t && t.id) {
      map.set(t.id, { name: t.name || '', completed: !!t.completed, listId: t.listId || null });
    }
  }
  return map;
}

// Returns { events, next }. `prev` is a Map from snapshotFromTasks; `tasks`
// is the fresh full task list (including completed).
export function diffSnapshots(prev, tasks, now = Date.now()) {
  const next = snapshotFromTasks(tasks);
  const events = [];
  for (const [id, cur] of next) {
    const old = prev.get(id);
    if (!old) {
      events.push({ at: now, action: 'added', task_id: id, name: cur.name, list_id: cur.listId, completed: cur.completed });
    } else if (old.completed !== cur.completed) {
      events.push({ at: now, action: cur.completed ? 'completed' : 'uncompleted', task_id: id, name: cur.name, list_id: cur.listId });
    }
  }
  for (const [id, old] of prev) {
    if (!next.has(id)) {
      // was_completed=true deletions are often iOS purging old completed
      // reminders on its own schedule — consumers usually ignore those.
      events.push({ at: now, action: 'deleted', task_id: id, name: old.name, list_id: old.listId, was_completed: old.completed });
    }
  }
  return { events, next };
}
