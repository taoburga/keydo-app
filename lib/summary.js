// Pure functions for tasks_summary. No I/O — caller passes in the full
// task set. Keeps the logic testable and deterministic.

const FLAG_TAG_RE = /(?:^|\s)#flag(?=$|\s)/i;

function _isFlagged(t) {
  return FLAG_TAG_RE.test(t.name || '') || FLAG_TAG_RE.test(t.body || '');
}

// All-day dueDates arrive from the daemon as local-midnight-formatted-as-UTC,
// which reads as the wrong calendar day in positive-offset timezones. Surface
// them as a bare local YYYY-MM-DD (matching _publicTask in mcp-tools.js).
function _localYMD(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function _endOfToday() {
  const d = _startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

function _endOfWeek() {
  // 7 days from start-of-today.
  const d = _startOfToday();
  d.setDate(d.getDate() + 7);
  return d;
}

function _slim(t) {
  // Keep summaries lean — full task objects bloat the model's context.
  return {
    id: t.id,
    name: t.name,
    list_id: t.listId,
    due_date: t.dueDate ? (t.allDay ? _localYMD(new Date(t.dueDate)) : t.dueDate) : null,
    all_day: !!t.allDay,
    priority: t.priority || 'none',
    flagged: _isFlagged(t),
    completed: !!t.completed,
  };
}

// Returns a "state of your tasks" briefing. Designed for one-call daily-briefing
// integration: the model gets enough to answer "what's pressing?" without
// chaining 4 tool calls.
export function buildSummary(tasks, { topN = 5 } = {}) {
  const open = tasks.filter(t => !t.completed);
  const today = _startOfToday();
  const tomorrow = _endOfToday();
  const weekEnd = _endOfWeek();

  const overdue = open.filter(t => t.dueDate && new Date(t.dueDate) < today);
  const dueToday = open.filter(t => {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate);
    return d >= today && d < tomorrow;
  });
  const dueThisWeek = open.filter(t => {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate);
    return d >= tomorrow && d < weekEnd;
  });

  const byPriority = {
    high: open.filter(t => t.priority === 'high'),
    medium: open.filter(t => t.priority === 'medium'),
    low: open.filter(t => t.priority === 'low'),
  };

  const flagged = open.filter(_isFlagged);

  // Sort the slices: due first by date asc, otherwise priority desc then name.
  const byDueAsc = (a, b) => new Date(a.dueDate) - new Date(b.dueDate);
  const byPriDesc = (a, b) => {
    const w = { high: 3, medium: 2, low: 1, none: 0 };
    return (w[b.priority] || 0) - (w[a.priority] || 0)
        || (a.name || '').localeCompare(b.name || '');
  };

  return {
    counts: {
      total_open: open.length,
      overdue: overdue.length,
      due_today: dueToday.length,
      due_this_week: dueThisWeek.length,
      flagged: flagged.length,
      by_priority: {
        high: byPriority.high.length,
        medium: byPriority.medium.length,
        low: byPriority.low.length,
      },
    },
    overdue: overdue.sort(byDueAsc).slice(0, topN).map(_slim),
    due_today: dueToday.sort(byDueAsc).slice(0, topN).map(_slim),
    due_this_week: dueThisWeek.sort(byDueAsc).slice(0, topN).map(_slim),
    high_priority: byPriority.high.sort(byPriDesc).slice(0, topN).map(_slim),
    flagged: flagged.sort(byPriDesc).slice(0, topN).map(_slim),
    generated_at: new Date().toISOString(),
  };
}

export const _internal = { _isFlagged, _slim };
