import { reorderTreeTies, remapAction, mapLimited } from './state-safety.js';
// Quick-add syntax parser — pure shared module (also used by the server's
// /api/quickadd endpoint for the global-hotkey capture panel, and by tests).
import { parseQuickAdd, parseDateExpression, parseDateToken, setDefaultDueTime, getDefaultDueTime, peelPriority } from './parse.js';
// Buddy — optional ASCII desk pet in the sidebar (homage to Claude Code's /buddy).
import { Buddy } from './buddy.js';
import { Tutorial } from './tutorial.js';

// ============================================================
// state
// ============================================================
const LS_KEY  = 'todo-app:state:v1';
const PM_KEY  = 'todo-app:parentMap:v1';     // { childId: parentId }, local-only hierarchy
const ORD_KEY = 'todo-app:orderByGroup:v1';  // { groupKey: [siblingIds...] }, user-defined order
const SEC_KEY = 'todo-app:taskSectionMap:v1';   // { taskId: sectionName }, local-only sections
const COL_KEY = 'todo-app:collapsedSections:v1';// { listId: { sectionName: true } }
const CCO_KEY = 'todo-app:completedOlderCollapsed:v1'; // boolean — Older group in smart:completed
const CP_KEY  = 'todo-app:collapsedParents:v1';   // { parentTaskId: true } — collapsed subtree
const CCB_KEY = 'todo-app:completedBucketsCollapsed:v1'; // { bucketKey: true } per-list-view bucket disclosure
const TIE_KEY = 'todo-app:tieOrder:v1';   // { viewKey: { tieKey: [taskIds...] } } — manual order WITHIN same priority/due in non-manual views
const SNZ_KEY = 'todo-app:snoozeMap:v1';  // { taskId: ISO } — snoozed until that DAY (local-only, like sections)
const RMV_KEY = 'todo-app:remindersLastVisit:v1'; // epoch ms — last time the Reminders inbox was opened, drives the "New" section
const READING_KEY = 'todo-app:readingListId:v1';  // id of the list used as the reading list (a real Reminders list)
const ING_KEY = 'todo-app:ingestedParents:v1';  // [childId] — tasks whose hidden #par-<id> tag we've already seeded into parentMap (seed-once, so local moves win)
const BRF_KEY = 'todo-app:briefingSeen:v1';     // 'YYYY-MM-DD' of the briefing last shown/dismissed — a date marker, not task-keyed → stays out of _gcLocalMaps
const BRF_POP_KEY = 'todo-app:briefingPopup:v1'; // '0' = never auto-open the briefing (Settings toggle); ⌘K "today's briefing" still works. Not task-keyed → stays out of _gcLocalMaps
const BRIEFING_ONLY = new URLSearchParams(location.search).get('briefing') === '1'; // pop-out briefing window: pinned briefing fills the page, rest of the UI hidden (html.briefing-only, set pre-paint in index.html)

const persisted = (() => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
})();
const persistedParentMap = (() => {
  try { return JSON.parse(localStorage.getItem(PM_KEY) || '{}'); } catch { return {}; }
})();
const persistedOrder = (() => {
  try { return JSON.parse(localStorage.getItem(ORD_KEY) || '{}'); } catch { return {}; }
})();
const persistedSectionMap = (() => {
  try { return JSON.parse(localStorage.getItem(SEC_KEY) || '{}'); } catch { return {}; }
})();
const persistedCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem(COL_KEY) || '{}'); } catch { return {}; }
})();
const persistedCompletedOlderCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem(CCO_KEY) || 'true'); } catch { return true; }
})();
const persistedCollapsedParents = (() => {
  try { return JSON.parse(localStorage.getItem(CP_KEY) || '{}'); } catch { return {}; }
})();
const persistedCompletedBuckets = (() => {
  try { return JSON.parse(localStorage.getItem(CCB_KEY) || '{}'); } catch { return {}; }
})();
const persistedTieOrder = (() => {
  try { return JSON.parse(localStorage.getItem(TIE_KEY) || '{}'); } catch { return {}; }
})();
const persistedSnooze = (() => {
  try { return JSON.parse(localStorage.getItem(SNZ_KEY) || '{}'); } catch { return {}; }
})();
const persistedIngested = (() => {
  try { const a = JSON.parse(localStorage.getItem(ING_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
})();

const state = {
  lists: [],
  counts: {},                 // { listId: incompleteCount }
  currentListId: persisted.currentListId || null,    // list new tasks go into
  view: persisted.view || 'list',                    // 'list' | 'smart:<key>' | 'tag:<name>'
  showCompletedMap: persisted.showCompletedMap || {}, // { viewKey: bool } per-view preference
  pinnedViews: persisted.pinnedViews || [],           // additional view keys shown side-by-side
  hiddenSmartViews: persisted.hiddenSmartViews || [], // smart-list keys removed from the sidebar (still reachable via ⌘K "Go to")
  calendarOpen: !!persisted.calendarOpen, // right-side calendar day pane visible
  calendarDate: null,          // transient: 'YYYY-MM-DD' the pane is showing (null = today)
  calendarWidth: persisted.calendarWidth || null, // px, set by dragging the pane's left edge
  searchQuery: '',             // active search; when non-empty, view becomes a search-results view
  tasks: [],                   // flattened-with-depth (or with header rows in grouped views)
  allTasks: [],                // raw all-lists cache, used by smart/tag views and tag computation
  tagCounts: {},               // { tag: count } across all incomplete tasks
  parentMap: persistedParentMap, // child→parent map (local; EventKit doesn't expose subtask hierarchy)
  orderByGroup: persistedOrder,  // explicit user-ordered siblings keyed by parentId or `list:<id>`
  taskSectionMap: persistedSectionMap, // { taskId: sectionName }, local sections
  collapsedSections: persistedCollapsed, // { listId: { sectionName: true } }
  completedOlderCollapsed: persistedCompletedOlderCollapsed,  // smart:completed "Older" disclosure
  collapsedParents: persistedCollapsedParents,  // { parentTaskId: true } — subtree hidden
  completedBucketsCollapsed: persistedCompletedBuckets, // { bucketKey: true } completed buckets in list views
  tieOrder: persistedTieOrder, // { viewKey: { tieKey: [taskIds...] } } — within-tie manual reorder for non-manual views
  snoozeMap: persistedSnooze,  // { taskId: ISO } — task rests (dimmed, bottom) until that day; local-only
  ingestedParents: persistedIngested, // Set<childId> — #par-<id> tags already seeded into parentMap (seed-once; local moves win after)
  detailPaneKey: null,         // transient: which pinned pane hosts the open detail strip (null = main pane)
  focusedPane: null,           // transient: pinned pane with keyboard focus (←/→ cycles; null = main pane)
  paneSelIdx: 0,               // selection index within the focused pinned pane
  _stickyEditId: null,         // transient: a task just priority-cycled — held in its slot until the next rebuild settles it
  _stickyEditView: null,       // transient: the view key the sticky edit belongs to
  _pendingSelectId: null,      // transient: re-select this task id after the next loadTasks settle (focus-leave re-sort)
  sortByList: persisted.sortByList || {}, // { listId: 'manual'|'due'|'priority'|'title'|'created' }
  selectedIdx: 0,
  detailTaskId: null,          // transient: which task's inline quick-action strip is open (id, not idx — keyboard nav doesn't follow)
  loading: false,
  lastKey: null,
  lastKeyAt: 0,
  inFlight: 0,                // count of pending writes
};

function _currentViewKey() {
  // During a search, state.view is still 'list' but isListView() is false —
  // without a dedicated key, preferences would persist under the junk key
  // literal 'list' that no other view ever reads.
  if (state.searchQuery) return 'search';
  return isListView() ? 'list:' + state.currentListId : state.view;
}
function getShowCompleted() { return !!state.showCompletedMap[_currentViewKey()]; }
function toggleShowCompleted() {
  const k = _currentViewKey();
  state.showCompletedMap[k] = !state.showCompletedMap[k];
  persist();
}

// ----- smart-list catalogue + view helpers -----
// `sidebar: false` views stay reachable via the ⌘K palette ("Go to: …") but
// don't take up sidebar space. `drop` describes what dragging a task onto the
// sidebar row (or a pinned pane of that view) does to the task.
const SMART_LISTS = [
  { key: 'today',      label: 'Today',           icon: '☀', drop: 'due-today' },
  { key: 'important',  label: 'Important today', icon: '⚡', drop: 'due-today-p1' },
  { key: 'scheduled',  label: 'Scheduled',       icon: '◷', sidebar: false },
  { key: 'flagged',    label: 'Flagged',         icon: '★', drop: 'flag' },
  { key: 'all',        label: 'All',             icon: '◍', sidebar: false },
  { key: 'byPriority', label: 'By priority',     icon: '!' },
  { key: 'byList',     label: 'By list',         icon: '☰', sidebar: false },
  { key: 'completed',  label: 'Completed',       icon: '✓' },
];

function isListView()    { return state.view === 'list' && !state.searchQuery; }
function isSearchView()  { return !!state.searchQuery; }

function persist() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    currentListId: state.currentListId,
    showCompletedMap: state.showCompletedMap,
    view: state.view,
    sortByList: state.sortByList,
    pinnedViews: state.pinnedViews,
    hiddenSmartViews: state.hiddenSmartViews,
    calendarOpen: state.calendarOpen,
    calendarWidth: state.calendarWidth,
  }));
}
function persistParentMap() {
  try { localStorage.setItem(PM_KEY, JSON.stringify(state.parentMap)); } catch {}
}
function persistIngested() {
  try { localStorage.setItem(ING_KEY, JSON.stringify([...state.ingestedParents])); } catch {}
}
function persistOrder() {
  try { localStorage.setItem(ORD_KEY, JSON.stringify(state.orderByGroup)); } catch {}
}
function persistSections() {
  try {
    localStorage.setItem(SEC_KEY, JSON.stringify(state.taskSectionMap));
    localStorage.setItem(COL_KEY, JSON.stringify(state.collapsedSections));
  } catch {}
}

// Group key for explicit ordering: a parent id or `list:<listId>` for top-level.
function groupKeyFor(task) {
  const pid = state.parentMap[task.id];
  if (pid) return pid;
  return 'list:' + (task.listId || state.currentListId);
}

const els = {
  lists: document.getElementById('lists'),
  smartLists: document.getElementById('smartLists'),
  tags: document.getElementById('tags'),
  tasks: document.getElementById('tasks'),
  quickAdd: document.getElementById('quickAdd'),
  searchBar: document.getElementById('searchBar'),
  listHeader: document.getElementById('listHeader'),
  status: document.getElementById('status'),
  emptyMsg: document.getElementById('emptyMsg'),
  helpOverlay: document.getElementById('helpOverlay'),
  prompt: document.getElementById('prompt'),
  promptLabel: document.getElementById('promptLabel'),
  promptInput: document.getElementById('promptInput'),
  newListBtn: document.getElementById('newList'),
  pinnedPanes: document.getElementById('pinnedPanes'),
};

// Pin / unpin helpers. Checkbox = "is this view currently visible" — checked when
// the view is the active primary OR a pinned side pane.
function isPinned(viewKey) { return state.pinnedViews.includes(viewKey); }
function isViewVisible(viewKey) {
  if (!viewKey) return false;
  return viewKey === _activeViewKey() || state.pinnedViews.includes(viewKey);
}
function togglePin(viewKey) {
  if (!viewKey) return;
  // Toggling the active view's checkbox is a no-op (you can't "unpin" what
  // you're currently looking at) — surface as a status hint.
  if (viewKey === _activeViewKey()) {
    setStatus('this is your active view — click its name to close it, or switch first');
    return;
  }
  const i = state.pinnedViews.indexOf(viewKey);
  if (i >= 0) { state.pinnedViews.splice(i, 1); _diagCrumb('unpin pane'); }
  else {
    // Cap at 4 columns side by side (the primary view + up to 3 pinned panes),
    // so panes never squeeze below their 240px min-width into horizontal scroll.
    const sidePanesAfter = state.pinnedViews.filter(k => k !== _activeViewKey()).length + 1;
    if (1 + sidePanesAfter > 4) {
      setStatus('max 4 lists side by side — unpin one to add another');
      return;
    }
    state.pinnedViews.push(viewKey);
    _diagCrumb('pin pane');
  }
  persist();
  renderSmartLists();
  renderTags();
  renderLists();
  renderPinnedPanes();
}

// Nest children under their parents (depth-tagged), ordering siblings by `cmp`.
// A list-scoped echo of flattenWithDepth's hierarchy, minus the active-list-only
// machinery (sections, manual sibling order) — used by pinned list panes so
// subtasks indent there too, not just in the main pane. A child whose parent is
// filtered out / on another list / in a cycle falls back to top level (no
// orphans, no vanishing). Collapsed parents are NOT honored: a side pane has no
// expand control, so it always shows the full subtree.
function _nestByParent(tasks, cmp) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const childMap = new Map();
  const roots = [];
  for (const t of tasks) {
    const pid = state.parentMap[t.id];
    if (pid && byId.has(pid) && pid !== t.id && !_createsCycle(t.id, pid)) {
      if (!childMap.has(pid)) childMap.set(pid, []);
      childMap.get(pid).push(t);
    } else {
      roots.push(t);
    }
  }
  const out = [];
  const visit = (t, depth) => {
    const kids = childMap.get(t.id) || [];
    out.push({ ...t, _depth: depth, _hasChildren: kids.length > 0, _childCount: kids.length });
    for (const k of kids.slice().sort(cmp)) visit(k, depth + 1);
  };
  for (const r of roots.slice().sort(cmp)) visit(r, 0);
  return out;
}

// Compute the rendered task list for any view key, given allTasks cache.
// Uses the per-view showCompletedMap entry (NOT the active view's), so each
// pinned pane honors its own preference.
function tasksForViewKey(viewKey) {
  const showCompleted = !!state.showCompletedMap[viewKey];
  if (viewKey.startsWith('list:')) {
    const lid = viewKey.slice(5);
    const filtered = state.allTasks.filter(t => t.listId === lid && (showCompleted || !t.completed));
    // Honor the LIST's own sort mode, not the active view's — a pinned list
    // pane should order like the list itself. ('manual' panes don't model the
    // sibling-group order structure; _comparatorFor falls back to the default.)
    const mode = state.sortByList[lid] || defaultListSort();
    return _nestByParent(filtered, _comparatorFor(mode));
  }
  if (viewKey.startsWith('smart:') || viewKey.startsWith('tag:')) {
    return buildViewTasks(state.allTasks, viewKey);
  }
  return [];
}

// Real (non-header) tasks of a pinned pane, in render order. Pane rendering
// and pane keyboard mode both use this so their indexes always agree.
function _paneTasks(viewKey) {
  return tasksForViewKey(viewKey).filter(t => !_isNonTaskRow(t));
}

function _activeViewKey() {
  return state.view === 'list' ? 'list:' + state.currentListId : state.view;
}

// Splitter between panes — drag to resize neighboring panes via flex-basis on
// the *previous* element vs. the next.
function _makeSplitter() {
  const sp = document.createElement('div');
  sp.className = 'pane-splitter';
  sp.addEventListener('mousedown', (downEv) => {
    downEv.preventDefault();
    sp.classList.add('dragging');
    const prev = sp.previousElementSibling;
    const next = sp.nextElementSibling;
    if (!prev || !next) return;
    const startX = downEv.clientX;
    const startPrev = prev.getBoundingClientRect().width;
    const startNext = next.getBoundingClientRect().width;
    const total = startPrev + startNext;
    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      const newPrev = Math.max(180, Math.min(total - 180, startPrev + dx));
      const newNext = total - newPrev;
      prev.style.flex = `0 0 ${newPrev}px`;
      next.style.flex = `0 0 ${newNext}px`;
    };
    const onUp = () => {
      sp.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  return sp;
}
// Reorder the visible columns by drag. The whole layout is one left-to-right
// sequence: [active view, ...pinned side panes]. Dropping any pane (the main
// one included) before or after another pane rewrites that sequence; whatever
// lands leftmost becomes the active view, and the rest become the pinned panes
// in order. This unifies plain side-pane reordering with promoting/demoting
// the main pane — drop a side pane on the main's left edge to promote it, or
// drag the main pane rightward to hand the lead to whatever slides into first.
function _reorderColumns(dragKey, targetKey, placeAfter) {
  if (!dragKey || !targetKey || dragKey === targetKey) return;
  _diagCrumb('reorder panes');
  const activeKey = _activeViewKey();
  const visiblePinned = state.pinnedViews.filter(k => k !== activeKey);
  let cols = [activeKey, ...visiblePinned].filter(k => k !== dragKey);
  const ti = cols.indexOf(targetKey);
  if (ti < 0) cols.push(dragKey);
  else cols.splice(placeAfter ? ti + 1 : ti, 0, dragKey);
  const newActive = cols[0];
  state.pinnedViews = cols.slice(1);
  persist();
  if (newActive === activeKey) {
    // Active view unchanged — only the side panes moved. (Calling selectList/
    // selectView with the current view would CLOSE it, so guard against that.)
    renderSmartLists();
    renderTags();
    renderLists();
    renderPinnedPanes();
  } else if (newActive.startsWith('list:')) {
    selectList(newActive.slice(5));
  } else {
    selectView(newActive);
  }
}

// Wire a pane (its header is the drag handle) for column reordering. Works for
// every pane including the main one, so `getKey` is a live getter — the main
// pane's view key changes as the active view changes. Pointer-based
// (mousedown/move/up), matching the splitter — native HTML5 drag-and-drop
// proved too finicky here (flickery drop targets, weak feedback). Native DnD
// stays reserved for task rows; this lives on the header, so the two never
// collide. A small movement threshold means a plain click or double-click on
// the header (× button, or the main pane's rename) is never read as a drag.
function _attachPaneReorder(pane, header, getKey) {
  header.addEventListener('mousedown', (downEv) => {
    if (downEv.button !== 0) return;                                 // left button only
    if (downEv.target.closest('.pane-close, input, textarea, select, button, a')) return;
    const dragKey = getKey();
    if (!dragKey) return;
    // A lone pane has nothing to reorder against — don't start a drag (nor show
    // the grab cursor, gated in CSS) when only the main pane is visible. Pane
    // reordering needs ≥2 panes: the main pane plus at least one pinned side pane.
    if (state.pinnedViews.filter(k => k !== _activeViewKey()).length === 0) return;
    // Stop the text-selection gesture before it starts. WebKit keeps extending
    // a selection that began on mousedown even after body user-select flips to
    // none mid-drag, which painted stray highlights over pane content during
    // (and after) a pane drag. Click/dblclick on the header still fire.
    downEv.preventDefault();
    const startX = downEv.clientX, startY = downEv.clientY;
    let dragging = false, dropKey = null, dropAfter = false;
    const clearIndicators = () => {
      document.querySelectorAll('.pane-drop-before, .pane-drop-after')
        .forEach(el => el.classList.remove('pane-drop-before', 'pane-drop-after'));
    };
    const onMove = (mv) => {
      if (!dragging) {
        if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 5) return;
        dragging = true;
        pane.classList.add('pane-dragging');
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        window.getSelection && window.getSelection().removeAllRanges();  // drop any nascent text selection
      }
      const over = document.elementFromPoint(mv.clientX, mv.clientY);
      const target = over && over.closest('.pane');
      clearIndicators();
      dropKey = null;
      // Any of our panes is a valid target: the primary (main) pane or a pinned
      // side pane. The edge the cursor is on decides before/after — uniform for
      // all panes, so the drop indicator looks the same everywhere.
      const isOurs = target && (target.classList.contains('primary') || els.pinnedPanes.contains(target));
      if (!isOurs || target === pane) return;
      const rect = target.getBoundingClientRect();
      dropAfter = mv.clientX > rect.left + rect.width / 2;
      dropKey = target.classList.contains('primary') ? _activeViewKey() : target.dataset.viewKey;
      target.classList.toggle('pane-drop-after', dropAfter);
      target.classList.toggle('pane-drop-before', !dropAfter);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      pane.classList.remove('pane-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      clearIndicators();
      if (dragging && dropKey) _reorderColumns(dragKey, dropKey, dropAfter);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function renderPinnedPanes() {
  if (!els.pinnedPanes) return;
  els.pinnedPanes.innerHTML = '';
  // Splitter between primary and pinned-panes-container — placed in the parent.
  const taskArea = document.getElementById('taskPaneArea');
  if (taskArea) {
    taskArea.querySelectorAll(':scope > .pane-splitter').forEach(sp => sp.remove());
  }
  const activeKey = _activeViewKey();
  const visiblePinned = state.pinnedViews.filter(k => k !== activeKey);
  // Only enable the main pane's drag affordance (grab cursor) when there's a
  // side pane to reorder against — see `_attachPaneReorder` and the CSS gate.
  if (taskArea) taskArea.classList.toggle('has-panes', visiblePinned.length > 0);
  // Keyboard focus can't point at a pane that no longer exists.
  if (state.focusedPane && !visiblePinned.includes(state.focusedPane)) {
    state.focusedPane = null;
    state.paneSelIdx = 0;
  }
  if (taskArea && visiblePinned.length > 0) {
    taskArea.insertBefore(_makeSplitter(), els.pinnedPanes);
  }
  // Auto-size: all visible panes share the width equally by default. The
  // pinned-panes CONTAINER must weigh as much as the panes it holds —
  // otherwise N pinned panes split a single flex share between them while
  // the primary keeps half the window. Manual splitter drags set inline px
  // sizes; reset them whenever the pane count changes so a stale drag can't
  // squeeze newly added panes forever.
  const primaryPane = document.getElementById('taskPane');
  if (els.pinnedPanes.dataset.paneCount !== String(visiblePinned.length)) {
    els.pinnedPanes.dataset.paneCount = String(visiblePinned.length);
    if (primaryPane) primaryPane.style.flex = '';
    els.pinnedPanes.style.flex = visiblePinned.length > 0 ? `${visiblePinned.length} 1 0` : '';
  }
  for (const key of visiblePinned) {
    const pane = document.createElement('section');
    pane.className = 'pane';
    pane.dataset.viewKey = key;
    pane.innerHTML = `
      <div class="pane-header">
        <h1></h1>
        <button class="pane-close" type="button" aria-label="unpin pane" title="unpin">×</button>
      </div>
      <ul class="pinned-tasks"></ul>
    `;
    pane.querySelector('h1').textContent = _viewKeyTitle(key);
    if (state.focusedPane === key) pane.classList.add('kb-focused');
    pane.querySelector('.pane-close').addEventListener('click', () => togglePin(key));
    _attachPaneReorder(pane, pane.querySelector('.pane-header'), () => key);
    if (key.startsWith('list:')) {
      const targetListId = key.slice(5);
      attachListDropZone(pane, () => targetListId);
    } else if (key.startsWith('smart:')) {
      // Dropping a task on a pinned Today / Important / Flagged pane applies
      // that view's meaning, same as dropping on the sidebar row.
      const s = SMART_LISTS.find(x => 'smart:' + x.key === key);
      if (s && s.drop) attachSmartDropZone(pane, () => ({ kind: s.drop, label: s.label }));
    }

    const ul = pane.querySelector('.pinned-tasks');
    const tasks = _paneTasks(key);   // same source the pane keyboard mode uses — indexes must align
    if (state.focusedPane === key && state.paneSelIdx >= tasks.length) {
      state.paneSelIdx = Math.max(0, tasks.length - 1);
    }
    let paneIdx = -1;
    for (const t of tasks) {
      paneIdx++;
      const li = document.createElement('li');
      li.className = 'task';
      li.dataset.id = t.id;
      li.dataset.depth = String(t._depth || 0);   // indent subtasks under their parent
      if (t.completed) li.classList.add('completed');
      if (_isResting(t)) li.classList.add('resting');
      if (state.focusedPane === key && paneIdx === state.paneSelIdx) li.classList.add('selected');
      li.draggable = true;
      li.addEventListener('dragstart', (e) => onDragStart(e, t));
      li.addEventListener('dragend',   () => onDragEnd());
      li.innerHTML = `<span class="checkbox"></span><span class="title-col"><span class="name"></span></span><span class="meta"></span>`;
      li.querySelector('.name').textContent = displayNameNoTags(t);
      _appendTagChips(li.querySelector('.name'), visibleTagsInName(t));
      const due = formatDue(t.dueDate);
      const meta = li.querySelector('.meta');
      if (t.priority && t.priority !== 'none') {
        const p = document.createElement('span');
        p.className = `pri ${t.priority}`;
        p.textContent = t.priority === 'high' ? 'P1' : t.priority === 'medium' ? 'P2' : 'P3';
        meta.appendChild(p);
      }
      if (due) {
        const d = document.createElement('span');
        d.className = `due ${due.cls}`;
        d.textContent = due.label;
        meta.appendChild(d);
      }
      // Click checkbox = toggle complete; refresh pinned panes after.
      // Push the same undo entry as the main-pane toggle so ⌘Z works here too.
      li.querySelector('.checkbox').addEventListener('click', async (e) => {
        e.stopPropagation();
        const marking = !t.completed;
        const detachSnapshot = (marking && _hasChildren(t.id)) ? _detachParent(t.id) : null;
        const undoEntry = { type: 'complete', taskId: t.id, prevCompleted: t.completed, detachSnapshot };
        pushUndo(undoEntry);
        if (marking) { playCompletionTick(); Buddy.onTaskCompleted(t.name); }
        // Same completion animation as the main list before the row refreshes away.
        if (marking) await _animateRowCompletion(li);
        try {
          await api.updateRem(t.id, { completed: !t.completed });
          await refreshAllTasks();
          renderPinnedPanes();
          if (state.view !== 'list' || tasksForViewKey('list:' + state.currentListId).find(x => x.id === t.id)) {
            await loadTasks();
          }
        } catch (err) {
          // Failed save → drop the stale undo entry and re-indent children.
          if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
          if (detachSnapshot) _reattachParent(detachSnapshot);
          reportError('save failed', err);
        }
      });
      // Single click: open the inline quick-action strip right here in the
      // pane (date / priority / list / editor). Double click: jump to this
      // view with the task selected — the old primary swaps into this pane's
      // slot so no view silently disappears from the layout.
      li.addEventListener('click', (e) => {
        if (e.target.closest('.checkbox, a, button, select, input')) return;
        state.detailTaskId = t.id;
        state.detailPaneKey = key;
        renderPinnedPanes();
      });
      li.addEventListener('dblclick', async (e) => {
        if (e.target.closest('.checkbox, a, button, select, input')) return;
        state.detailTaskId = null;
        state.detailPaneKey = null;
        await _navigateFromPane(key, t.id);
      });
      ul.appendChild(li);
      if (state.detailTaskId === t.id && state.detailPaneKey === key && !t.completed) {
        ul.appendChild(_buildInlineDetail(t, key));
      }
    }
    if (tasks.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'no tasks';
      ul.appendChild(empty);
    }
    els.pinnedPanes.appendChild(pane);
  }
  if (state.focusedPane) {
    const sel = els.pinnedPanes.querySelector('.pane.kb-focused .task.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

// ←/→ moves keyboard focus between the main pane and pinned panes; while a
// pane is focused, j/k move its selection and the task-action keys (e, p, b,
// z, f, dd, ⏎) act on the pane's selected task. Esc returns to the main pane.
function _cyclePaneFocus(dir) {
  const panes = state.pinnedViews.filter(k => k !== _activeViewKey());
  if (!panes.length) return;
  const order = [null, ...panes];   // null = main pane
  const cur = order.indexOf(state.focusedPane);
  const next = order[(cur + dir + order.length) % order.length];
  state.focusedPane = next;
  state.paneSelIdx = 0;
  renderPinnedPanes();
  setStatus(next ? `pane: ${_viewKeyTitle(next)} — j/k move · e done · esc back` : '');
}

// Returns true when the key was handled in pane mode (so the global handler
// stops). Unhandled keys fall through to global behavior (r, c, n, ?, 1-9 …).
async function _paneKeydown(e) {
  const key = state.focusedPane;
  const tasks = _paneTasks(key);
  const move = (delta) => {
    if (!tasks.length) return;
    state.paneSelIdx = Math.max(0, Math.min(tasks.length - 1, state.paneSelIdx + delta));
    const pane = els.pinnedPanes.querySelector(`.pane[data-view-key="${CSS.escape(key)}"]`);
    if (!pane) return;
    pane.querySelectorAll('.task.selected').forEach(el => el.classList.remove('selected'));
    const rows = pane.querySelectorAll('.pinned-tasks .task');
    const row = rows[state.paneSelIdx];
    if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
  };
  const t = tasks[Math.min(state.paneSelIdx, tasks.length - 1)];
  switch (e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); move(1); return true;
    case 'k': case 'ArrowUp':   e.preventDefault(); move(-1); return true;
    case 'e':
      e.preventDefault();
      if (t) await toggleComplete(null, t);
      return true;
    case 'p': e.preventDefault(); if (t) await cyclePriority(t); return true;
    case 'b': e.preventDefault(); if (t) await bumpDue(t); return true;
    case 'w': e.preventDefault(); if (t) await quickReschedule('weekend', t); return true;
    case 'B': e.preventDefault(); if (t) await quickReschedule('back-day', t); return true;
    case 'z': e.preventDefault(); if (t) await snoozePrompt(t); return true;
    case 'f': e.preventDefault(); if (t) await toggleFlag(t); return true;
    case 'Enter':
      e.preventDefault();
      if (t) {
        const id = t.id;
        state.focusedPane = null;
        await _navigateFromPane(key, id, true);   // jump over + open the full editor
      }
      return true;
    case 'd':
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isDoubleTap('d')) { if (t) await deleteTask(t); recordKey(null); }
      else { setStatus('press d again to delete'); recordKey('d'); }
      return true;
    case 'Tab': case 's': case 'S':
      // List-structure keys only make sense in the main pane.
      e.preventDefault();
      setStatus('esc to the main pane for indent / sort / sections');
      return true;
  }
  return false;
}

function _viewKeyTitle(key) {
  if (key.startsWith('list:')) {
    const l = state.lists.find(l => l.id === key.slice(5));
    return l ? l.name : 'List';
  }
  if (key.startsWith('smart:')) {
    const s = SMART_LISTS.find(s => 'smart:' + s.key === key);
    return s ? s.label : key;
  }
  if (key.startsWith('tag:')) return '#' + key.slice(4);
  return key;
}

// ============================================================
// api
// ============================================================
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '', code = '';
    try {
      const body = await res.json();
      detail = body.error || '';
      code = body.code || '';
    } catch {}
    const err = new Error(`${res.status} ${detail || res.statusText}`);
    err.status = res.status;
    err.code = code;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

const _creationKeys = new Map();
async function _createReminder(payload) {
  const signature = JSON.stringify(payload);
  let key = _creationKeys.get(signature);
  if (!key) { key = crypto.randomUUID(); _creationKeys.set(signature, key); }
  const result = await jsonFetch('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, operationId: key }) });
  if (!result || typeof result.id !== 'string') throw new Error('Create response was incomplete; retry with the same input.');
  _creationKeys.delete(signature);
  return result;
}
const api = {
  lists:      ()                 => jsonFetch('/api/lists'),
  counts:     ()                 => jsonFetch('/api/lists/counts'),
  createList: (name)             => jsonFetch('/api/lists',                    { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  renameList: (id, name)         => jsonFetch(`/api/lists/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  deleteList: (id)               => jsonFetch(`/api/lists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reminders:  (listId, withDone) => jsonFetch(`/api/reminders?list=${encodeURIComponent(listId)}${withDone ? '&completed=1' : ''}`),
  allReminders: (withDone)       => jsonFetch('/api/reminders' + (withDone ? '?completed=1' : '')),
  addRem: _createReminder,
  updateRem:  (id, p)            => jsonFetch(`/api/reminders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  deleteRem:  (id)               => jsonFetch(`/api/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pageTitle:  (u)                => jsonFetch(`/api/page-title?url=${encodeURIComponent(u)}`),
  report:     (type, text, diagnostics) => jsonFetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, text, diagnostics }) }),
  reportsExport: ()              => jsonFetch('/api/reports/export'),
  calendar:   (date)             => jsonFetch('/api/calendar' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  trashList:    ()         => jsonFetch('/api/trash'),
  trashRestore: (trashId)  => jsonFetch(`/api/trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST' }),
  trashPurge:   (trashId)  => jsonFetch(`/api/trash/${encodeURIComponent(trashId)}`, { method: 'DELETE' }),
  history:      (limit = 500) => jsonFetch(`/api/history?limit=${limit}`),
  briefing:     ()         => jsonFetch('/api/briefing'),
  briefingFeedback: (p)    => jsonFetch('/api/briefing/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  prep:         (date)     => jsonFetch('/api/prep' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  prepFeedback: (p)        => jsonFetch('/api/prep/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  settings:     ()         => jsonFetch('/api/settings'),
  settingsSave: (p)        => jsonFetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  habits:       ()         => jsonFetch('/api/habits'),
  habitAdd:     (p)        => jsonFetch('/api/habits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  habitUpdate:  (id, p)    => jsonFetch(`/api/habits/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  habitDelete:  (id)       => jsonFetch(`/api/habits/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  habitToggle:  (id, date, today, kind) => jsonFetch(`/api/habits/${encodeURIComponent(id)}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, today, kind }) }),
};

// ----- tag parsing -----
const TAG_RE = /(?:^|\s)#([\w-]+)/g;   // #tagname after start or whitespace
function tagsInTask(t) {
  const text = (t.name || '') + '\n' + (t.body || '');
  const out = new Set();
  for (const m of text.matchAll(TAG_RE)) out.add(m[1].toLowerCase());
  return out;
}
function isFlagged(t)   { return tagsInTask(t).has('flag'); }
function withoutTag(s, tag) {
  // Strip ` #tag` or `#tag ` or `#tag` from end/middle of a string.
  return (s || '').replace(new RegExp(`\\s*#${tag}\\b`, 'gi'), '').trim();
}
function withTag(s, tag) {
  if (new RegExp(`\\b#${tag}\\b`, 'i').test(s)) return s;
  return ((s || '').trim() + ' #' + tag).trim();
}

// Internal/reserved tags that NEVER show in rendered titles, tag chips, the
// sidebar tag list, or status messages.
// - flag: emulates ★ (no native EventKit flag).
// - sec-<slug>: section assignment (Option B / future iCloud-syncable sections).
// - par-<id>: parent linking — value is the parent's EventKit id. Written by the
//   MCP (tasks_add parent_id) so external clients can create subtasks; ingested
//   into the local parentMap by _ingestParentTags. See ING_KEY.
const INTERNAL_TAG_RE = /\s*#(?:flag|sec-[\w-]+|par-[\w-]+)\b/gi;
// Tag (sans leading #) is internal/reserved — same set as INTERNAL_TAG_RE.
function _isInternalTag(tag) { return /^(?:flag|sec-|par-)/i.test(tag); }

function displayName(t) {
  return ((t.name || '').replace(INTERNAL_TAG_RE, '')).trim();
}

// Title text with ALL hashtags stripped — visible tags render as chips alongside,
// so they shouldn't also clutter the title text.
function displayNameNoTags(t) {
  return displayName(t).replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// User-visible tags (everything except internal: flag, sec-*, par-*).
// Returns tag strings without the leading #.
function visibleTagsInName(t) {
  const out = [];
  for (const m of (t.name || '').matchAll(TAG_RE)) {
    const tag = m[1];
    if (_isInternalTag(tag)) continue;
    out.push(tag);
  }
  return out;
}

// Seed local subtask links from hidden `#par-<parentId>` tags. The MCP (or any
// external client) encodes a child's parent as `#par-<parent EventKit id>` in
// the title; we read it ONCE per task into state.parentMap, then record the id
// in state.ingestedParents so we never re-apply it. That seed-once rule is what
// lets a later manual move (drag / indent / outdent) stick — the tag becomes
// inert after first sight rather than snapping the task back every refresh.
// Case-preserving capture: EventKit ids are case-sensitive, so we must not
// lowercase the parent id the way tagsInTask does.
const PAR_TAG_RE = /(?:^|\s)#par-([\w-]+)\b/;
function _ingestParentTags(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return;
  let mapDirty = false, seenDirty = false;
  for (const t of tasks) {
    if (!t || !t.id || _isNonTaskRow(t)) continue;
    if (state.ingestedParents.has(t.id)) continue;   // already seeded — local state wins from here
    const m = PAR_TAG_RE.exec(t.name || '');
    if (!m) continue;
    state.ingestedParents.add(t.id); seenDirty = true;
    const parentId = m[1];
    if (parentId === t.id) continue;                  // self-reference — ignore
    if (state.parentMap[t.id] === parentId) continue; // link already present
    if (_createsCycle(t.id, parentId)) continue;      // never introduce a cycle
    state.parentMap[t.id] = parentId;
    mapDirty = true;
  }
  if (mapDirty) persistParentMap();
  if (seenDirty) persistIngested();
}

// Append visible #tag chips inline inside the .name span so they share the
// same line as the title (saves vertical space). Same green styling as the
// live quick-add preview.
function _appendTagChips(nameEl, tags) {
  if (!tags || !tags.length) return;
  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = '#' + tag;
    nameEl.appendChild(chip);
  }
}
function recomputeTagCounts() {
  const counts = {};
  const rlId = (_readingList() || {}).id;   // reading items don't feed the cross-list TAGS section
  for (const t of state.allTasks) {
    if (t.completed || t.listId === rlId) continue;
    for (const tag of tagsInTask(t)) {
      if (_isInternalTag(tag)) continue;   // flag/sec-/par- are plumbing, never browsable tags
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  state.tagCounts = counts;
}


// ============================================================
// formatters & sorting
// ============================================================
function formatDue(iso) {
  if (!iso) return null;
  const d = new Date(iso); const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const startOfTaskDay = new Date(d); startOfTaskDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startOfTaskDay - startOfToday) / 86400000);
  let label = '', cls = '';
  if (diffDays < 0) {
    cls = 'overdue';
    if (diffDays === -1)         label = 'yesterday';
    else if (diffDays >= -6)     label = `${-diffDays} days ago`;
    else if (diffDays >= -13)    label = 'last week';
    else if (diffDays >= -27)    label = `${Math.round(-diffDays / 7)} weeks ago`;
    else if (diffDays >= -365)   label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
    else                          label = d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' }).toLowerCase();
  }
  // "Due earlier today" renders red — but all-day reminders land at 00:00
  // (see the all-day check below), which would make them look overdue from
  // 12:00 AM onward. All-day due-today is just "today".
  else if (d < now && !(d.getHours() === 0 && d.getMinutes() === 0))
                                 { label = 'today';   cls = 'overdue'; }
  else if (diffDays === 0)       { label = 'today';   cls = 'today'; }
  else if (diffDays === 1)       { label = 'tomorrow'; }
  else if (diffDays < 7)         { label = d.toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase(); }
  else if (diffDays < 365)       { label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase(); }
  else                           { label = d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' }).toLowerCase(); }
  // Append a compact time when the user set a non-default time (shared with the
  // live quick-add preview so both read the same, e.g. "jul 3 3p").
  label += _dueTimeSuffix(d, diffDays);
  return { label, cls };
}

// The compact time suffix (" 3p", " 9:30a") for a due date, or '' when the time
// is the parser's default (today→6pm, all other days→the configurable default
// due time) or an all-day 00:00.
// The non-today default is read from parse.js, NOT hardcoded: with Settings →
// default due time set to anything but 09:00, a hardcoded 9 made every
// bare-dated task render a redundant time chip (" 8a") for its own default.
function _dueTimeSuffix(d, diffDays) {
  const h = d.getHours(), m = d.getMinutes();
  const def = getDefaultDueTime();
  const defaultHour   = (diffDays === 0) ? 18 : def.hours;
  const defaultMinute = (diffDays === 0) ? 0  : def.minutes;
  if ((h === defaultHour && m === defaultMinute) || (h === 0 && m === 0)) return '';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h < 12 ? 'a' : 'p';
  return ' ' + (m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`);
}

const PRI_ORDER = { high: 0, medium: 1, low: 2, none: 3 };
function _priWeight(p) { return PRI_ORDER[p] ?? 3; }    // unknown/undefined sorts as "none" (last)

// A task is "resting" when it shouldn't compete with today's work:
//  - a recurring task whose next occurrence is on a FUTURE day (completing
//    "pay rent ?every month" makes EventKit immediately re-open it due next
//    month — it would otherwise pop right back into the working set), or
//  - a task the user explicitly snoozed (z) until a future day.
// Resting tasks sink to the bottom of every sort (just above completed),
// their priority doesn't compete, and they render dimmed until their day.
function _isSnoozed(t) {
  if (!t || !t.id || t.completed) return false;
  const until = state.snoozeMap[t.id];
  if (!until) return false;
  const day = new Date(until); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return day > today;
}
function _isResting(t) {
  if (!t || t.completed) return false;
  if (_isSnoozed(t)) return true;
  if (!t.recurrence || !t.dueDate) return false;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return new Date(t.dueDate) > endOfToday;
}
function _restingCmp(a, b) {
  const ar = _isResting(a), br = _isResting(b);
  if (ar !== br) return ar ? 1 : -1;
  return 0;
}

const _sortFn = (a, b) => {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  const rc = _restingCmp(a, b);
  if (rc) return rc;
  const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  if (aD !== bD) return aD - bD;
  return _priWeight(a.priority) - _priWeight(b.priority);
};

// Sort comparators per mode. All also fall back to completed-last so completed sinks.
// Cycle order matches the user's preference: most-actionable first.
const SORT_MODES = ['due', 'priority', 'created', 'manual'];
const SORT_LABELS = {
  due: 'due date',
  priority: 'priority',
  created: 'newest first',
  manual: 'manual (drag / ⌘⇧↑↓)',
};
function _comparatorFor(mode) {
  if (mode === 'due') return (a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const rc = _restingCmp(a, b);
    if (rc) return rc;
    const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    if (aD !== bD) return aD - bD;
    return _priWeight(a.priority) - _priWeight(b.priority);
  };
  if (mode === 'priority') return (a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const rc = _restingCmp(a, b);
    if (rc) return rc;
    const dp = _priWeight(a.priority) - _priWeight(b.priority);
    if (dp !== 0) return dp;
    const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return aD - bD;
  };
  if (mode === 'created') return (a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const rc = _restingCmp(a, b);
    if (rc) return rc;
    const aC = a.creationDate ? new Date(a.creationDate).getTime() : 0;
    const bC = b.creationDate ? new Date(b.creationDate).getTime() : 0;
    return bC - aC;   // newest first
  };
  return _sortFn;   // 'manual' fallback when there's no explicit order
}
// Lists sort by priority (due date within a priority level) until the user
// picks something else with `s` — new and existing tasks slot by priority by
// default, and drags/⌘⇧↑↓ reorder WITHIN a priority tie instead of flipping
// the whole list to manual. The default is a Settings-pane preference; a
// per-list `s` choice always beats it.
const DEFAULT_SORT_KEY = 'todo-app:defaultSort:v1';   // not task-keyed → stays out of _gcLocalMaps
function defaultListSort() {
  try {
    const v = localStorage.getItem(DEFAULT_SORT_KEY);
    if (SORT_MODES.includes(v)) return v;
  } catch {}
  return 'priority';
}
function currentSortMode() {
  if (!isListView()) return 'manual';
  return state.sortByList[state.currentListId] || defaultListSort();
}
function cycleSortMode() {
  if (!isListView()) { setStatus('sort applies to a list view'); return; }
  const cur = currentSortMode();
  const next = SORT_MODES[(SORT_MODES.indexOf(cur) + 1) % SORT_MODES.length];
  setSortMode(next);
}

// =========================================================================
// tie-group reorder — lets you drag-reorder tasks within the same primary-
// sort bucket (e.g. reorder among P1 tasks in "Important today", or among
// tasks due today in "Scheduled"). Stored as an order list per (view, tieKey).
// =========================================================================

function _currentTieViewKey() {
  if (isListView()) return 'list:' + state.currentListId;
  return state.view;
}

// Returns a key that identifies which "tie bucket" task `t` belongs to under
// the current view's primary sort. Two tasks with the same key can be manually
// reordered relative to each other; different keys can't (would require
// editing the underlying field).
function _tieGroupKeyFor(t) {
  if (!t) return '';
  // Resting (snoozed / future-recurring) tasks live in their own tie bucket.
  // They share a priority/due key with active tasks otherwise, and a saved
  // within-tie order could hoist a snoozed P1 back above active P1s after the
  // comparator sank it — resting must never mix into an active bucket.
  if (_isResting(t)) return 'resting';
  const view = state.view;
  const sortMode = isListView() ? currentSortMode() : null;

  // Priority-primary views
  if (view === 'smart:important' || view === 'smart:byPriority' || sortMode === 'priority') {
    return 'p:' + (t.priority || 'none');
  }
  // Due-date-primary views
  if (view === 'smart:today' || view === 'smart:scheduled' || sortMode === 'due') {
    if (!t.dueDate) return 'd:none';
    const d = new Date(t.dueDate);
    return `d:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  if (sortMode === 'created') {
    if (!t.creationDate) return 'c:none';
    const d = new Date(t.creationDate);
    return `c:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  // Smart:flagged / smart:all / tag views — no tight primary key, so everything
  // ties (any task can be reordered relative to any other).
  return 'all';
}

function _isManualOrderingActive() {
  return isListView() && currentSortMode() === 'manual';
}

function persistTieOrder() {
  try { localStorage.setItem(TIE_KEY, JSON.stringify(state.tieOrder)); } catch {}
}
function persistSnooze() {
  try { localStorage.setItem(SNZ_KEY, JSON.stringify(state.snoozeMap)); } catch {}
}

// Reorder a flat list of tasks so that within each tie-group, tasks follow
// the saved manual order (with new/unsaved tasks staying in their original
// relative position at the end of their group).
function _applyTieOrder(tasks, viewKey) {
  return reorderTreeTies(tasks, state.tieOrder[viewKey], _tieGroupKeyFor);
}

function setSortMode(mode) {
  if (!isListView()) { setStatus('sort applies to a list view'); return; }
  if (!SORT_MODES.includes(mode)) { setStatus(`unknown sort: ${mode}`); return; }
  state.sortByList[state.currentListId] = mode;
  persist();
  loadTasks().then(() => _flashSortMode(mode));   // show the order at the top, by the list name (#6)
}

// #6 — briefly surface the active sort order next to the list title when
// cycling with `s`, so it's clear which order you're looking at. Lives in the
// header (not the sidebar status line) so it reads as "this view's order".
const SORT_FLASH_LABELS = { due: 'due date', priority: 'priority', created: 'newest first', manual: 'manual order' };
function _flashSortMode(mode) {
  if (!els.listHeader) return;
  let el = document.getElementById('sortFlash');
  if (!el) { el = document.createElement('span'); el.id = 'sortFlash'; }
  el.textContent = `· sorted by ${SORT_FLASH_LABELS[mode] || mode}`;
  el.classList.remove('hide');
  els.listHeader.appendChild(el);   // loadTasks just set the title via textContent — append beside it
  clearTimeout(_flashSortMode._t);
  _flashSortMode._t = setTimeout(() => { el.classList.add('hide'); }, 2600);
}

// Sort one sibling group. If the user has manually reordered this group
// (state.orderByGroup[key] exists), tasks in the order list keep their
// position; tasks not yet in it (e.g. just-added) appear above, sorted by
// the default rules.
function _sortGroup(siblings, groupKey) {
  const mode = currentSortMode();
  // For non-manual modes, ignore explicit order and use the comparator
  // (which already demotes resting recurring tasks).
  if (mode !== 'manual') return siblings.slice().sort(_comparatorFor(mode));
  // Manual mode: resting recurring tasks sink below the curated order too —
  // a freshly re-opened "every month" task shouldn't reclaim its old slot
  // until its day arrives.
  const resting = siblings.filter(_isResting)
    .sort((a, b) => new Date(a.dueDate || state.snoozeMap[a.id] || 0) - new Date(b.dueDate || state.snoozeMap[b.id] || 0));
  const active = siblings.filter(s => !_isResting(s));
  const orderList = state.orderByGroup[groupKey];
  if (!orderList || !orderList.length) return [...active.sort(_sortFn), ...resting];
  const orderIdx = new Map(orderList.map((id, i) => [id, i]));
  const ordered = [];
  const unordered = [];
  for (const s of active) {
    if (orderIdx.has(s.id)) ordered.push(s); else unordered.push(s);
  }
  ordered.sort((a, b) => orderIdx.get(a.id) - orderIdx.get(b.id));
  unordered.sort(_sortFn);
  return [...unordered, ...ordered, ...resting];
}

// ===================================================================
// Reminders inbox: "New" / "Other" sections (by creation recency)
// ===================================================================
// The default Reminders list is an inbox — things get dumped there. We split it
// into "New" (added today/yesterday OR since the last time you opened this view)
// and "Other". The threshold is snapshotted ONCE on entry (see loadTasks) so it
// stays stable while you're looking, then advances for next time.
let _remindersNewThreshold = 0;   // epoch ms; tasks created at/after this are "New"
let _remindersThresholdFor = null; // listId the current threshold was computed for (re-render guard)
function _isRemindersInboxId(id) {
  const l = state.lists.find(x => x.id === id);
  return !!l && l.name.trim().toLowerCase() === 'reminders';
}
function _enterRemindersInboxIfNeeded() {
  // Only (re)compute when newly entering the inbox view, not on every re-render
  // (a refresh mid-visit must not advance the threshold and empty out "New").
  if (!isListView() || !_isRemindersInboxId(state.currentListId)) { _remindersThresholdFor = null; return; }
  if (_remindersThresholdFor === state.currentListId) return;
  let stored = 0;
  try { stored = parseInt(localStorage.getItem(RMV_KEY) || '0', 10) || 0; } catch {}
  const startYday = new Date(); startYday.setHours(0, 0, 0, 0); startYday.setDate(startYday.getDate() - 1);
  // New = created since the EARLIER of (start of yesterday, your last visit).
  _remindersNewThreshold = stored ? Math.min(startYday.getTime(), stored) : startYday.getTime();
  _remindersThresholdFor = state.currentListId;
  try { localStorage.setItem(RMV_KEY, String(Date.now())); } catch {}
}

// ===================================================================
// Reading list: a real Reminders list used as a read-later queue
// ===================================================================
function _readingList() {
  let id = null;
  try { id = localStorage.getItem(READING_KEY); } catch {}
  if (id) { const l = state.lists.find(x => x.id === id); if (l) return l; }
  // Adopt an existing list literally named "Reading" (e.g. created on iPhone).
  const byName = state.lists.find(l => l.name.trim().toLowerCase() === 'reading');
  if (byName) { try { localStorage.setItem(READING_KEY, byName.id); } catch {} return byName; }
  return null;
}
function _isReadingView() {
  const rl = _readingList();
  return !!rl && isListView() && state.currentListId === rl.id;
}
let _defaultQuickAddPH = null;
function _updateQuickAddPlaceholder() {
  if (!els.quickAdd) return;
  if (_defaultQuickAddPH === null) _defaultQuickAddPH = els.quickAdd.placeholder || '';
  els.quickAdd.placeholder = _isReadingView()
    ? 'paste a link to read later (several at once is fine)…'
    : _defaultQuickAddPH;
}

// Flatten tasks into a depth-tagged list using state.parentMap + orderByGroup + sections.
// - Children appear immediately after their parent (so moving a parent moves the whole subtree).
// - Tasks whose parent is filtered/missing fall back to top-level (no orphans).
// - Sections render in any list-view sort mode. Within a section, tasks follow the active
//   sort (manual/due/priority/title/created); cross-section order stays alphabetical.
function flattenWithDepth(tasks) {
  // Defensive: strip ALL pseudo-rows (headers, sections, completed-bucket
  // rows) so that re-flattening an already-flattened list doesn't accumulate
  // phantom headers — or worse, sort completed-bucket headers among real
  // tasks (they have no id and `completed` undefined, so they used to float
  // mid-list on every optimistic re-sort).
  tasks = tasks.filter(t => t && !_isNonTaskRow(t));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const childMap = new Map();
  const roots = [];
  for (const t of tasks) {
    const pid = state.parentMap[t.id];
    // A task inside a parentMap cycle (possible via undo edge cases) would
    // otherwise never become a root and silently vanish from the list —
    // treat cycle members as roots instead.
    if (pid && byId.has(pid) && pid !== t.id && !_createsCycle(t.id, pid)) {
      if (!childMap.has(pid)) childMap.set(pid, []);
      childMap.get(pid).push(t);
    } else {
      roots.push(t);
    }
  }
  const rootKey = 'list:' + (state.currentListId || '');
  const sortedRoots = _sortGroup(roots, rootKey);
  const out = [];
  function visit(t, depth) {
    const kids = childMap.get(t.id) || [];
    const hasKids = kids.length > 0;
    const collapsed = hasKids && !!state.collapsedParents[t.id];
    out.push({ ...t, _depth: depth, _hasChildren: hasKids, _collapsed: collapsed, _childCount: kids.length });
    if (collapsed) return;
    const sortedKids = _sortGroup(kids, t.id);
    for (const k of sortedKids) visit(k, depth + 1);
  }

  const useSections = isListView();
  if (!useSections) {
    for (const r of sortedRoots) visit(r, 0);
    return out;
  }

  // Reminders inbox: group by recency (New / Other), not manual sections.
  if (_isRemindersInboxId(state.currentListId)) {
    const thr = _remindersNewThreshold;
    const isNew = (t) => t.creationDate && new Date(t.creationDate).getTime() >= thr;
    const newRoots = [], otherRoots = [];
    for (const r of sortedRoots) (isNew(r) ? newRoots : otherRoots).push(r);
    if (newRoots.length) {
      out.push({ _isHeader: true, label: 'New', count: newRoots.length });
      for (const r of newRoots) visit(r, 0);
      if (otherRoots.length) out.push({ _isHeader: true, label: 'Other', count: otherRoots.length });
    }
    for (const r of otherRoots) visit(r, 0);   // no headers at all when nothing is new
    return out;
  }

  const ungrouped = [];
  const bySection = new Map();
  for (const r of sortedRoots) {
    const sec = state.taskSectionMap[r.id];
    if (sec) {
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec).push(r);
    } else {
      ungrouped.push(r);
    }
  }
  for (const r of ungrouped) visit(r, 0);
  const collapsedForList = state.collapsedSections[state.currentListId] || {};
  const sortedSections = [...bySection.keys()].sort((a, b) => a.localeCompare(b));
  for (const sec of sortedSections) {
    const children = bySection.get(sec);
    out.push({ _isSection: true, label: sec, count: children.length, collapsed: !!collapsedForList[sec] });
    if (!collapsedForList[sec]) for (const r of children) visit(r, 0);
  }
  return out;
}

// Backwards-compat shim — many call sites still say `sortTasks(...)`.
const sortTasks = flattenWithDepth;

// ============================================================
// rendering
// ============================================================
function _attachPinCheckbox(li, viewKey) {
  const cb = document.createElement('span');
  cb.className = 'pin-toggle';
  cb.setAttribute('role', 'checkbox');
  cb.setAttribute('tabindex', '0');
  const visible = isViewVisible(viewKey);
  const isActive = viewKey === _activeViewKey();
  if (visible) cb.classList.add('on');
  if (isActive) cb.classList.add('active');
  cb.setAttribute('aria-checked', visible ? 'true' : 'false');
  cb.setAttribute('aria-label', isActive
    ? 'currently active view'
    : (isPinned(viewKey) ? 'unpin from side panel' : 'pin to side panel'));
  cb.title = cb.getAttribute('aria-label');
  const toggle = (e) => { e.stopPropagation(); togglePin(viewKey); };
  cb.addEventListener('click', toggle);
  cb.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(e); }
  });
  li.insertBefore(cb, li.firstChild);
}

function renderLists() {
  els.lists.innerHTML = '';
  state.lists.forEach((l, i) => {
    const li = document.createElement('li');
    li.dataset.id = l.id;
    const viewKey = 'list:' + l.id;
    if (state.view === 'list' && l.id === state.currentListId) li.classList.add('active');
    const num = i < 9 ? `${i + 1}` : '·';
    li.innerHTML = `<span class="num"></span><span class="lname"></span><span class="count"></span>`;
    li.querySelector('.num').textContent = num;
    // Hotkey number uses the muted default (CSS), turning accent when the list
    // is the active view — matching the smart-list icons. (No per-list iCloud
    // tint; the mixed colors read as a random blue/orange split.)
    li.querySelector('.lname').textContent = l.name;
    const c = state.counts[l.id];
    if (c != null) li.querySelector('.count').textContent = c;
    li.addEventListener('click', () => selectList(l.id));
    _attachPinCheckbox(li, viewKey);
    attachListDropZone(li, () => l.id);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-delete';
    del.textContent = '×';
    del.title = `delete list "${l.name}"…`;
    del.setAttribute('aria-label', del.title);
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteListFlow(l.id); });
    li.appendChild(del);
    els.lists.appendChild(li);
  });
}

function renderTasks() {
  els.tasks.innerHTML = '';
  if (state.tasks.length === 0) {
    _renderEmptyState();
    els.emptyMsg.classList.remove('hidden');
    return;
  }
  els.emptyMsg.classList.add('hidden');

  const frag = document.createDocumentFragment();
  let _topFocusAssigned = false;
  state.tasks.forEach((t, i) => {
    if (t._isHeader) {
      const h = document.createElement('li');
      h.className = 'group-header';
      h.innerHTML = `<span class="gh-label"></span><span class="gh-count"></span>`;
      h.querySelector('.gh-label').textContent = t.label;
      if (t.count != null) h.querySelector('.gh-count').textContent = t.count;
      frag.appendChild(h);
      return;
    }
    if (t._isCompletedMegaHeader) {
      const h = document.createElement('li');
      h.className = 'completed-mega-header';
      h.innerHTML = `<span class="cmh-label"></span>`;
      h.querySelector('.cmh-label').textContent = t.label;
      frag.appendChild(h);
      return;
    }
    if (t._isCompletedBucketHeader) {
      const h = document.createElement('li');
      h.className = 'section-header completed-bucket';
      const arrow = t.collapsed ? '▸' : '▾';
      h.innerHTML = `<span class="sh-arrow"></span><span class="sh-label"></span><span class="sh-count"></span>`;
      h.querySelector('.sh-arrow').textContent = arrow;
      h.querySelector('.sh-label').textContent = t.label;
      h.querySelector('.sh-count').textContent = t.count;
      h.addEventListener('click', () => toggleCompletedBucket(t.bucketKey));
      frag.appendChild(h);
      return;
    }
    if (t._isCompletedOlderHeader) {
      const h = document.createElement('li');
      h.className = 'section-header';
      const arrow = t.collapsed ? '▸' : '▾';
      h.innerHTML = `<span class="sh-arrow"></span><span class="sh-label"></span><span class="sh-count"></span>`;
      h.querySelector('.sh-arrow').textContent = arrow;
      h.querySelector('.sh-label').textContent = t.label;
      h.querySelector('.sh-count').textContent = t.count;
      h.addEventListener('click', () => toggleCompletedOlderCollapse());
      frag.appendChild(h);
      return;
    }
    if (t._isSection) {
      const h = document.createElement('li');
      h.className = 'section-header';
      const arrow = t.collapsed ? '▸' : '▾';
      h.innerHTML = `<span class="sh-arrow"></span><span class="sh-label"></span><span class="sh-count"></span>`;
      h.querySelector('.sh-arrow').textContent = arrow;
      h.querySelector('.sh-label').textContent = t.label;
      h.querySelector('.sh-count').textContent = t.count;
      h.addEventListener('click', () => toggleSectionCollapse(t.label));
      // Drop target: any task dropped here gets reassigned to this section.
      h.addEventListener('dragover', (e) => {
        if (!_dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        h.classList.add('drop-target');
      });
      h.addEventListener('dragleave', () => h.classList.remove('drop-target'));
      h.addEventListener('drop', (e) => {
        e.preventDefault();
        h.classList.remove('drop-target');
        if (!_dragId) return;
        const dragged = state.tasks.find(x => x.id === _dragId);
        if (!dragged) return;
        state.taskSectionMap[_dragId] = t.label;
        persistSections();
        onDragEnd();
        loadTasks().catch(err => reportError('reload failed', err));
      });
      frag.appendChild(h);
      return;
    }

    const li = document.createElement('li');
    li.className = 'task';
    li.dataset.id = t.id;
    li.dataset.depth = String(t._depth || 0);
    li.dataset.pri = t.priority || 'none';
    if (t.completed) li.classList.add('completed');
    if (i === state.selectedIdx) li.classList.add('selected');
    if (t._optimistic) li.classList.add('optimistic');
    if (_isResting(t)) li.classList.add('resting');
    // First active (non-completed) task gets a subtle "focus on this" stripe.
    if (!_topFocusAssigned && !t.completed) {
      li.classList.add('top-focus');
      _topFocusAssigned = true;
    }

    li.innerHTML = `<span class="checkbox"></span><span class="title-col"><span class="name"></span></span><span class="meta"></span>`;
    const nameEl = li.querySelector('.name');
    _appendTextWithLinks(nameEl, displayNameNoTags(t));
    _appendTagChips(nameEl, visibleTagsInName(t));
    if (t._hasChildren) {
      li.classList.add('parent-task');
      if (t._collapsed) li.classList.add('subtree-collapsed');
    }

    // Google-style subtitle: first line of body shown under the name.
    if (t.body) {
      const sub = document.createElement('span');
      sub.className = 'subtitle';
      const firstLine = t.body.split(/\r?\n/)[0];
      _appendTextWithLinks(sub, firstLine);
      sub.title = t.body;
      li.querySelector('.title-col').appendChild(sub);
    }

    const meta = li.querySelector('.meta');
    if (t.priority && t.priority !== 'none') {
      const p = document.createElement('span');
      p.className = `pri ${t.priority}`;
      p.textContent = t.priority === 'high' ? 'P1' : t.priority === 'medium' ? 'P2' : 'P3';
      meta.appendChild(p);
    }
    const due = formatDue(t.dueDate);
    if (due) {
      const d = document.createElement('span');
      d.className = `due ${due.cls}`;
      d.textContent = due.label;
      meta.appendChild(d);
    }
    if (_isSnoozed(t)) {
      const z = document.createElement('span');
      z.className = 'snooze-chip';
      z.textContent = 'zzz ' + ((formatDue(state.snoozeMap[t.id]) || {}).label || '');
      z.title = 'snoozed — press z to change or wake';
      meta.appendChild(z);
    }
    if (t.url) {
      // Script-ish schemes must never become a clickable href: a task synced
      // from any device (or written via MCP) with a javascript: URL would
      // execute inside the WKWebView when clicked. The daemon also rejects
      // these on write; this guards data that predates that check. App
      // deep-links (slack:// etc.) stay clickable — the shell routes them
      // to the default handler.
      const link = document.createElement(_isSafeUrl(t.url) ? 'a' : 'span');
      link.className = 'url-chip';
      if (link.tagName === 'A') {
        link.href = t.url;
        link.target = '_blank';
        link.rel = 'noopener';
      }
      link.title = t.url;
      link.textContent = _shortenUrl(t.url);
      link.addEventListener('click', e => e.stopPropagation());   // don't trigger row select
      meta.appendChild(link);
    }
    if (t.recurrence) {
      const r = document.createElement('span');
      r.className = 'recur-chip';
      r.title = 'repeats: ' + t.recurrence;
      r.textContent = '↻ ' + t.recurrence;
      meta.appendChild(r);
    }
    if (t.alarms && t.alarms.length > 0) {
      const a = document.createElement('span');
      a.className = 'alarm-chip';
      a.title = `${t.alarms.length} alert${t.alarms.length === 1 ? '' : 's'}`;
      a.textContent = '🔔';
      meta.appendChild(a);
    }
    if (isFlagged(t)) {
      const f = document.createElement('span');
      f.className = 'flag';
      f.textContent = '★';
      f.title = 'flagged';
      meta.appendChild(f);
    }
    if (t._hasChildren) {
      const tog = document.createElement('button');
      tog.className = 'parent-toggle';
      tog.type = 'button';
      tog.tabIndex = -1;
      tog.textContent = t._collapsed ? `▸ ${t._childCount}` : '▾';
      tog.title = t._collapsed
        ? `expand ${t._childCount} subtask${t._childCount === 1 ? '' : 's'}`
        : 'collapse subtasks';
      tog.setAttribute('aria-label', tog.title);
      tog.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleParentCollapse(t.id);
      });
      meta.appendChild(tog);
    }

    li.addEventListener('click', (e) => {
      // Editor (full or inline) is open in this row — let its inputs handle the click.
      if (li.classList.contains('editing') || li.classList.contains('inline-editing')) return;
      if (e.target.closest('.checkbox')) { toggleComplete(i); return; }
      if (e.target.closest('a, button, .parent-toggle'))  return;
      // Single click: select + anchor the inline detail strip to *this* task.
      // Keyboard nav (j/k/arrows) moves selection but leaves the strip in
      // place. Click another task to move it; click outside to dismiss.
      // Double-click opens the full editor.
      state.selectedIdx = i;
      state.detailTaskId = t.id;
      if (state.detailPaneKey) { state.detailPaneKey = null; renderPinnedPanes(); }
      renderTasks();
    });
    li.addEventListener('dblclick', (e) => {
      if (li.classList.contains('editing') || li.classList.contains('inline-editing')) return;
      if (e.target.closest('.checkbox, a, button, .parent-toggle')) return;
      state.selectedIdx = i;
      // Hide the inline detail strip before opening the full editor so they
      // don't both show at once.
      state.detailTaskId = null;
      renderTasks();
      openExpandedEditor();
    });
    // Mouse hover moves the selection without re-rendering everything.
    // Skip if the cursor hasn't actually moved since the last keypress —
    // otherwise a re-render under a stationary cursor would steal the
    // selection back from j/k/arrow-key navigation.
    li.addEventListener('mouseenter', () => {
      if (!_mouseHoverActive) return;
      if (state.selectedIdx === i) return;
      state.selectedIdx = i;
      els.tasks.querySelectorAll('.task.selected').forEach(el => el.classList.remove('selected'));
      li.classList.add('selected');
    });

    // ----- drag-and-drop -----
    // Always draggable except optimistic placeholders. Drop semantics depend on
    // the active view: list+manual → reorder siblings; list+non-manual or smart
    // view → reorder within the same tie-group (priority/due bucket).
    if (!t._optimistic) {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => onDragStart(e, t));
      li.addEventListener('dragend',   () => onDragEnd());
      li.addEventListener('dragover',  (e) => onDragOver(e, t));
      li.addEventListener('dragleave', (e) => onDragLeave(e, li));
      li.addEventListener('drop',      (e) => onDrop(e, t));
    }

    frag.appendChild(li);
    if (state.detailTaskId === t.id && !state.detailPaneKey && !t.completed && !t._optimistic) {
      const detail = _buildInlineDetail(t);
      if (detail) frag.appendChild(detail);
    }
  });
  els.tasks.appendChild(frag);
  const sel = els.tasks.querySelector('.task.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// Quick-capture overlay (Todoist-style). Opened via ⌥⇧T (the same hotkey is
// system-wide: in-app it lands here; elsewhere the shell shows a native panel).
// Title field accepts the same parser tokens as quickAdd: !high / ?friday at
// 3pm / ls:<list> / #tag. Dedicated chips below override anything parsed.
function openQuickCapture() {
  const overlay = document.getElementById('quickCapture');
  if (!overlay) return;
  // Already open (e.g. ⌥⇧T double-tapped): bail. Re-opening would wipe what's
  // been typed and stack a second keydown listener — Enter would then submit
  // once per leaked listener, creating duplicate tasks.
  if (!overlay.classList.contains('hidden')) return;
  // Close any open editor / palette first.
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  if (_isPaletteOpen()) closePalette();
  const nameEl  = document.getElementById('qcName');
  const bodyEl  = document.getElementById('qcBody');
  const dateEl  = document.getElementById('qcDate');
  const priEl   = document.getElementById('qcPri');
  const alertEl = document.getElementById('qcAlert');
  const listEl  = document.getElementById('qcList');

  nameEl.value = ''; bodyEl.value = ''; dateEl.value = '';
  priEl.value = 'none'; alertEl.value = 'none';
  // Escape the id too, not just the name: the repo's rule is that NO
  // list-derived string reaches innerHTML unescaped. EventKit ids are UUIDs
  // today, which is exactly the kind of assumption that quietly stops holding.
  listEl.innerHTML = state.lists.map(l =>
    `<option value="${_escHtml(l.id)}"${l.id === state.currentListId ? ' selected' : ''}>${_escHtml(l.name)}</option>`
  ).join('');

  overlay.classList.remove('hidden');
  setTimeout(() => { nameEl.focus(); }, 0);

  let resolved = false;
  const close = () => {
    if (resolved) return; resolved = true;
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
  };
  const submit = async () => {
    if (resolved) return;
    const rawName = nameEl.value.trim();
    if (!rawName) { nameEl.focus(); return; }
    const parsed = parseQuickAdd(rawName, state.lists);
    const name = parsed.name || rawName;

    let dueDate = parsed.dueDate;
    const dateRaw = dateEl.value.trim();
    if (dateRaw) {
      const stripped = dateRaw.replace(/^\?/, '').trim();
      const d = parseDateExpression(stripped) || parseDateToken(stripped.toLowerCase());
      if (d) dueDate = d.toISOString();
      else { setStatus(`couldn’t parse date "${dateRaw}"`); return; }
    }

    const priority = (priEl.value !== 'none') ? priEl.value : (parsed.priority || undefined);
    const targetListId = listEl.value || parsed.listId || state.currentListId;
    const alarms = alertEl.value === 'none' ? undefined
                                            : [{ type: 'relative', offset: parseFloat(alertEl.value) }];
    const body = bodyEl.value.trim() || undefined;
    const recurrence = parsed.recurrence;

    close();
    setBusy(true);
    try {
      await api.addRem({ listId: targetListId, name, body, priority, dueDate, recurrence, alarms });
      bumpCount(targetListId, +1);
      await refreshAllTasks();
      if (state.view === 'list' && state.currentListId === targetListId) await loadTasks();
      const target = state.lists.find(l => l.id === targetListId);
      setStatus(`added to ${target ? target.name : 'list'}`);
    } catch (err) {
      reportError('add failed', err);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e) => {
    if (resolved) return;
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submit(); return; }
    if (e.key === 'Enter' && e.target === nameEl) { e.preventDefault(); e.stopPropagation(); submit(); return; }
    if (e.key === 'Enter' && e.target === dateEl) { e.preventDefault(); e.stopPropagation(); submit(); return; }
    // Tab and Shift+Tab cycle naturally between focusable form fields.
  };
  const onBackdrop = (ev) => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
}

// Jump from a pinned pane to its view. The old primary takes this pane's
// pinned slot (if it wasn't pinned already), so the set of visible views
// stays stable — clicking into a pane must never silently drop a view
// (e.g. an empty Today that was active-but-unpinned used to vanish).
async function _navigateFromPane(paneKey, taskId, openEditor = false) {
  const oldActive = _activeViewKey();
  const hasOld = state.view !== 'list' || !!state.currentListId;
  if (hasOld && !state.pinnedViews.includes(oldActive)) {
    const i = state.pinnedViews.indexOf(paneKey);
    if (i >= 0) state.pinnedViews[i] = oldActive;
    else state.pinnedViews.push(oldActive);
    persist();
  }
  if (paneKey.startsWith('list:')) await selectList(paneKey.slice(5));
  else await selectView(paneKey);
  if (taskId) {
    const idx = state.tasks.findIndex(x => x.id === taskId);
    if (idx >= 0) { state.selectedIdx = idx; renderTasks(); }
  }
  if (openEditor) await openExpandedEditor();
}

// Inline quick-action strip shown under the selected task. Single-click on a
// task reveals this; double-click opens the full editor. Each chip applies
// immediately via api.updateRem (optimistic + rollback on error).
// With `paneKey` set, the strip lives inside a pinned pane: it edits the
// allTasks copy optimistically, re-renders the panes, and its "…" button
// navigates to the pane's view before opening the full editor.
function _buildInlineDetail(t, paneKey = null) {
  const row = document.createElement('li');
  row.className = 'task-detail';
  row.dataset.depth = String(t._depth || 0);
  // Ids escaped alongside names — see openQuickCapture.
  const lists = state.lists.map(l => `<option value="${_escHtml(l.id)}"${l.id === t.listId ? ' selected' : ''}>${_escHtml(l.name)}</option>`).join('');
  const priCur = t.priority || 'none';
  const dueIso = t.dueDate || '';
  const dueText = dueIso ? _formatDueForInput(dueIso) : '';
  row.innerHTML = `
    <div class="td-inner">
      <span class="td-label">date</span>
      <button class="td-chip" data-act="today" type="button" tabindex="-1">Today</button>
      <button class="td-chip" data-act="tomorrow" type="button" tabindex="-1">Tomorrow</button>
      <button class="td-chip" data-act="weekend" type="button" tabindex="-1">Weekend</button>
      <button class="td-chip" data-act="next-week" type="button" tabindex="-1">+7d</button>
      <input class="td-date" type="text" placeholder="date — friday 9am · may 3" />
      ${dueIso ? '<button class="td-chip td-clear" data-act="clear-date" type="button" tabindex="-1" title="clear date">×</button>' : ''}
      <span class="td-sep"></span>
      <span class="td-label">priority</span>
      ${['high','medium','low','none'].map(p => `<button class="td-chip td-pri ${p}${p === priCur ? ' active' : ''}" data-pri="${p}" type="button" tabindex="-1">${p === 'high' ? 'P1' : p === 'medium' ? 'P2' : p === 'low' ? 'P3' : '×'}</button>`).join('')}
      <span class="td-sep"></span>
      <span class="td-label">list</span>
      <select class="td-list" tabindex="-1">${lists}</select>
      <span class="td-spacer"></span>
      <button class="td-chip td-more" type="button" tabindex="-1" title="open full editor (or double-click the row)">…</button>
    </div>
  `;
  const dateInput = row.querySelector('.td-date');
  dateInput.value = dueText;

  const rerender = paneKey ? renderPinnedPanes : renderTasks;
  // All-day tasks stay all-day through chip/typed date edits (bare YYYY-MM-DD
  // on the wire) unless an explicit time was typed — same rule as the editor.
  const _wireDue = (d, typedExplicitTime) =>
    (t.allDay && t.dueDate && !typedExplicitTime) ? _localYMD(d) : d.toISOString();
  const apply = async (patch) => {
    const target = paneKey ? (state.allTasks.find(x => x.id === t.id) || t) : t;
    // Local copy: a bare-date patch (all-day) renders via local-midnight ISO +
    // allDay flag, mirroring what the daemon will read back.
    const local = { ...patch };
    if (typeof local.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(local.dueDate)) {
      const [y, mo, da] = local.dueDate.split('-').map(Number);
      local.dueDate = new Date(y, mo - 1, da).toISOString();
      local.allDay = true;
    } else if ('dueDate' in local) {
      local.allDay = false;
    }
    // Wire-format prev for undo: an all-day task's prior due must round-trip
    // as a bare date (not timed local-midnight ISO), and "no priority" must
    // restore as 'none' (null would be silently skipped by the daemon).
    const prevPatch = {};
    for (const k of Object.keys(patch)) {
      if (k === 'dueDate') {
        prevPatch.dueDate = target.dueDate
          ? (target.allDay ? _localYMD(new Date(target.dueDate)) : target.dueDate)
          : null;
      } else if (k === 'priority') {
        prevPatch.priority = target.priority || 'none';
      } else {
        prevPatch[k] = target[k];
      }
    }
    const undoEntry = { type: 'patch', taskId: t.id, prev: prevPatch, next: { ...patch } };
    pushUndo(undoEntry);

    const orig = {};
    for (const k of Object.keys(local)) orig[k] = target[k];
    Object.assign(target, local);
    rerender();
    try {
      await api.updateRem(t.id, patch);
      if (paneKey) { await refreshAllTasks(); await loadTasks(); }
      else _backgroundRefresh();
    }
    catch (e) {
      Object.assign(target, orig);
      rerender();
      if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
      reportError('save failed', e);
    }
  };

  row.querySelectorAll('.td-chip[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'clear-date') return apply({ dueDate: null });
      const phrase = act === 'today' ? 'today' : act === 'tomorrow' ? 'tomorrow' : act === 'weekend' ? 'weekend' : 'next-week';
      const d = parseDateExpression(phrase) || parseDateToken(phrase);
      if (d) apply({ dueDate: _wireDue(d, false) });
    });
  });
  row.querySelectorAll('.td-pri').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      apply({ priority: btn.dataset.pri });
    });
  });
  dateInput.addEventListener('click', e => e.stopPropagation());
  dateInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = dateInput.value.trim();
      if (!v) { apply({ dueDate: null }); return; }
      const stripped = v.replace(/^\?/, '').trim();
      const d = parseDateExpression(stripped) || parseDateToken(stripped.toLowerCase());
      const typedTime = /(\d{1,2}(:\d{2})?\s*(am|pm))|noon|midnight|\d{1,2}:\d{2}/i.test(stripped);
      if (d) apply({ dueDate: _wireDue(d, typedTime) });
      else setStatus(`couldn’t parse "${v}" as a date`);
    } else if (e.key === 'Escape' || e.key === '`') {
      e.preventDefault();
      dateInput.blur();
    }
  });
  const listSel = row.querySelector('.td-list');
  listSel.addEventListener('click', e => e.stopPropagation());
  listSel.addEventListener('change', () => {
    const newListId = listSel.value;
    if (newListId !== t.listId) moveTaskToList(t.id, newListId);
  });
  const moreBtn = row.querySelector('.td-more');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (paneKey) _navigateFromPane(paneKey, t.id, true);
    else openExpandedEditor();
  });
  // Click into the strip itself — don't bubble up and re-trigger row click logic.
  row.addEventListener('click', (e) => e.stopPropagation());
  return row;
}

function _escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

// Schemes that execute code in the page context — never render as href.
// (Mirrors the daemon's write-time blocklist.)
function _isSafeUrl(s) {
  try { return !['javascript:', 'data:', 'vbscript:', 'file:'].includes(new URL(s).protocol); }
  catch { return false; }
}

// Compact display label for a URL: hostname plus a tiny path indicator. Falls
// back to a length-limited slice for non-URL strings or parse failures.
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
function _shortenUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const path = (u.pathname || '') + (u.search || '') + (u.hash || '');
    if (!path || path === '/') return host;
    if (path.length <= 14) return host + path;
    return host + '/…';
  } catch {
    return url.length > 30 ? url.slice(0, 28) + '…' : url;
  }
}

// Append `text` into `parent` as text nodes, replacing any URL it contains
// with a clickable shortened <a class="inline-link">. Uses DOM nodes (not
// innerHTML) so user-supplied text can't inject markup.
function _appendTextWithLinks(parent, text) {
  if (!text) return;
  let last = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1];
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'inline-link';
    a.textContent = _shortenUrl(m[1]);
    a.title = m[1];
    a.addEventListener('click', e => e.stopPropagation());
    parent.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// Hover-vs-keyboard selection arbitration. mouseenter fires when the DOM
// re-renders under a stationary cursor, which would clobber a fresh keyboard
// selection. We only honor mouseenter after the user has actually moved the
// mouse since the last keypress. Keypresses disengage hover-tracking; the
// next real mousemove re-engages it.
let _mouseHoverActive = false;
// True while the addInline input is open. Checked by the global keydown
// handler to defer all keys to the input. Set in addInline; cleared by its
// cleanup (commit/cancel) and any blur fallback.
let _inlineEditActive = false;
document.addEventListener('mousemove', () => { _mouseHoverActive = true; });
document.addEventListener('keydown', () => { _mouseHoverActive = false; }, true);

// Click anywhere outside a task row / its inline detail strip closes the
// inline detail. Skip when the full editor is open (it has its own outside-
// click → save handler) or any overlay is up.
document.addEventListener('click', (e) => {
  if (state.detailTaskId == null) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) return;
  const overlayUp = ['helpOverlay','prompt','quickCapture','palette','reportModal','trashModal','logbookModal','confirmModal','briefingModal','triageModal','habitHistoryModal']
    .some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
  if (overlayUp) return;
  if (e.target.closest('.task, .task-detail')) return;
  state.detailTaskId = null;
  const wasPane = state.detailPaneKey;
  state.detailPaneKey = null;
  if (wasPane) renderPinnedPanes();
  else renderTasks();
}, true);

// ----- drag-and-drop logic -----

let _dragId = null;       // task id currently being dragged
let _dropPos = null;      // { targetId, where: 'above' | 'below' }

function onDragStart(e, t) {
  _dragId = t.id;
  _dropPos = null;
  try { e.dataTransfer.setData('text/plain', t.id); } catch {}
  e.dataTransfer.effectAllowed = 'move';
  // Mark dragged li
  e.currentTarget.classList.add('dragging');
}
function onDragEnd() {
  _dragId = null;
  _dropPos = null;
  document.querySelectorAll('.task.dragging, .task.drop-above, .task.drop-below')
    .forEach(el => el.classList.remove('dragging', 'drop-above', 'drop-below'));
}
function onDragOver(e, target) {
  if (!_dragId || _dragId === target.id) return;
  const draggedTask = state.allTasks.find(x => x.id === _dragId) ||
                      state.tasks.find(x => x.id === _dragId);
  if (!draggedTask) return;

  // Two reorder modes:
  //   (a) list view + manual sort → reorder among siblings (same parent, same list).
  //   (b) any non-manual view → reorder within the same tie-group (priority/due bucket).
  // Cross-list drags fall through both and bubble to the pane-level drop zone.
  if (_isManualOrderingActive()) {
    if (draggedTask.listId !== target.listId) return;
    const dPid = state.parentMap[draggedTask.id] || null;
    const tPid = state.parentMap[target.id]      || null;
    if (dPid !== tPid) return;
  } else {
    if (_tieGroupKeyFor(draggedTask) !== _tieGroupKeyFor(target)) return;
  }

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const li = e.currentTarget;
  const rect = li.getBoundingClientRect();
  const where = (e.clientY < rect.top + rect.height / 2) ? 'above' : 'below';
  document.querySelectorAll('.task.drop-above, .task.drop-below')
    .forEach(el => { if (el !== li) el.classList.remove('drop-above', 'drop-below'); });
  li.classList.toggle('drop-above', where === 'above');
  li.classList.toggle('drop-below', where === 'below');
  _dropPos = { targetId: target.id, where };
}
function onDragLeave(e, li) {
  // Only clear if the cursor truly left this li (not just moved to a child).
  if (!li.contains(e.relatedTarget)) {
    li.classList.remove('drop-above', 'drop-below');
  }
}
function onDrop(e, target) {
  if (!_dragId) return;
  const draggedTask = state.allTasks.find(x => x.id === _dragId) ||
                      state.tasks.find(x => x.id === _dragId);
  if (!draggedTask) { onDragEnd(); return; }

  // Cross-list drop in manual mode: bubble to the pane-level drop zone.
  if (_isManualOrderingActive() && draggedTask.listId !== target.listId) return;
  // Different tie-group in non-manual mode: bail (and let any pane drop handle).
  if (!_isManualOrderingActive() && _tieGroupKeyFor(draggedTask) !== _tieGroupKeyFor(target)) return;

  e.preventDefault();
  if (!_dropPos || _dragId === target.id) { onDragEnd(); return; }
  _diagCrumb('reorder task (drag)');

  if (_isManualOrderingActive()) {
    const dPid = state.parentMap[draggedTask.id] || null;
    const tPid = state.parentMap[target.id]      || null;
    if (dPid !== tPid) { onDragEnd(); return; }

    // Top-level drops also adopt the target's section.
    if (!dPid && !tPid) {
      const tSec = state.taskSectionMap[target.id] || null;
      const dSec = state.taskSectionMap[draggedTask.id] || null;
      if (tSec !== dSec) {
        if (tSec) state.taskSectionMap[draggedTask.id] = tSec;
        else      delete state.taskSectionMap[draggedTask.id];
        persistSections();
      }
    }

    const siblings = _siblingsOf(draggedTask).map(s => s.id);
    const fromIdx = siblings.indexOf(_dragId);
    let toIdx = siblings.indexOf(target.id);
    if (_dropPos.where === 'below') toIdx += 1;
    siblings.splice(fromIdx, 1);
    if (fromIdx < toIdx) toIdx -= 1;
    siblings.splice(toIdx, 0, _dragId);

    state.orderByGroup[groupKeyFor(draggedTask)] = siblings;
    persistOrder();
    onDragEnd();
    state.tasks = flattenWithDepth(state.tasks);
    state.selectedIdx = state.tasks.findIndex(x => x.id === _dragId);
    renderTasks();
    return;
  }

  // Tie-group reorder mode (non-manual list view OR smart/tag view).
  // Build the current order of THIS tie-group from state.tasks (already in
  // displayed order), splice the dragged id into its new position, save.
  const tieKey = _tieGroupKeyFor(draggedTask);
  const viewKey = _currentTieViewKey();
  const groupIds = state.tasks
    .filter(x => !x._isHeader && !x._isSection && !x._isCompletedMegaHeader && !x._isCompletedBucketHeader)
    .filter(x => _tieGroupKeyFor(x) === tieKey)
    .map(x => x.id);
  const fromIdx = groupIds.indexOf(_dragId);
  let toIdx    = groupIds.indexOf(target.id);
  if (_dropPos.where === 'below') toIdx += 1;
  if (fromIdx === -1 || toIdx === -1) { onDragEnd(); return; }
  groupIds.splice(fromIdx, 1);
  if (fromIdx < toIdx) toIdx -= 1;
  groupIds.splice(toIdx, 0, _dragId);

  if (!state.tieOrder[viewKey]) state.tieOrder[viewKey] = {};
  state.tieOrder[viewKey][tieKey] = groupIds;
  persistTieOrder();
  onDragEnd();
  loadTasks();
}

// Move a task to a different list (cross-list drag-drop). Severs local
// parent/child links since they're list-scoped (subtasks live in same list as
// parent in EventKit).
async function moveTaskToList(taskId, targetListId) {
  const t = state.allTasks.find(x => x.id === taskId);
  if (!t) return;
  const fromListId = t.listId;
  if (!targetListId || fromListId === targetListId) return;
  const target = state.lists.find(l => l.id === targetListId);
  _diagCrumb('move task to list (drag)');
  try {
    await api.updateRem(taskId, { listId: targetListId });
    if (state.parentMap[taskId]) delete state.parentMap[taskId];
    for (const [child, parent] of Object.entries(state.parentMap)) {
      if (parent === taskId) delete state.parentMap[child];
    }
    bumpCount(fromListId, -1);
    bumpCount(targetListId, +1);
    await refreshAllTasks();
    if (state.view === 'list' &&
        (state.currentListId === fromListId || state.currentListId === targetListId)) {
      await loadTasks();
    } else {
      renderTasks();
    }
    renderPinnedPanes();
    renderLists();
    setStatus(`moved to ${target ? target.name : 'list'}`);
  } catch (err) {
    reportError('move failed', err);
  }
}

// Wire a DOM element as a cross-list drop zone for tasks. `getTargetListId`
// returns the destination list id (so the same helper works for panes,
// sidebar rows, etc.). Adds/removes a `dropping` class for visual feedback.
function attachListDropZone(el, getTargetListId) {
  el.addEventListener('dragover', (e) => {
    if (!_dragId) return;
    const targetListId = getTargetListId();
    if (!targetListId) return;
    const dragged = state.allTasks.find(x => x.id === _dragId);
    if (!dragged || dragged.listId === targetListId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target-list');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target-list');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-target-list');
    if (!_dragId) return;
    const targetListId = getTargetListId();
    if (!targetListId) return;
    const dragged = state.allTasks.find(x => x.id === _dragId);
    if (!dragged || dragged.listId === targetListId) { onDragEnd(); return; }
    e.preventDefault();
    e.stopPropagation();
    const movedId = _dragId;
    onDragEnd();
    moveTaskToList(movedId, targetListId);
  });
}

// Drop a task onto a smart-list sidebar row, a pinned smart pane, or the
// primary pane while it shows a smart view, to apply that view's meaning:
// Today → due today; Important today → due today + P1; Flagged → flag it.
// Quick way to assemble a day plan by drag. `getDrop` is a getter (the
// primary pane's view changes) returning { kind, label } or null.
function attachSmartDropZone(el, getDrop) {
  el.addEventListener('dragover', (e) => {
    if (!_dragId || !getDrop()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target-list');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target-list');
  });
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-target-list');
    const d = getDrop();
    if (!_dragId || !d) return;
    e.preventDefault();
    e.stopPropagation();
    const { kind: dropKind, label } = d;
    const t = state.allTasks.find(x => x.id === _dragId) || state.tasks.find(x => x.id === _dragId);
    onDragEnd();
    if (!t) return;

    const patch = {};
    const prev = {};
    if (dropKind === 'due-today' || dropKind === 'due-today-p1') {
      let newDue;
      if (t.allDay) {
        // Keep all-day tasks all-day: date-only string for today.
        const n = new Date();
        const pad = x => String(x).padStart(2, '0');
        newDue = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
      } else {
        const d = new Date();
        if (t.dueDate) {
          const old = new Date(t.dueDate);
          d.setHours(old.getHours(), old.getMinutes(), 0, 0);   // keep time-of-day
        } else {
          d.setHours(18, 0, 0, 0);                              // today's default
        }
        newDue = d.toISOString();
      }
      if (newDue !== t.dueDate) { patch.dueDate = newDue; prev.dueDate = t.dueDate; }
      if (dropKind === 'due-today-p1' && t.priority !== 'high') {
        patch.priority = 'high';
        prev.priority = t.priority || 'none';
      }
    } else if (dropKind === 'flag') {
      if (!isFlagged(t)) { patch.name = withTag(t.name, 'flag'); prev.name = t.name; }
    }
    if (Object.keys(patch).length === 0) { setStatus(`already in ${label}`); return; }

    _diagCrumb('drop on smart list → ' + dropKind);
    pushUndo({ type: 'patch', taskId: t.id, prev, next: patch });
    setBusy(true);
    try {
      await api.updateRem(t.id, patch);
      await refreshAllTasks();
      await loadTasks();
      setStatus(dropKind === 'due-today-p1' ? `due today · P1 — "${displayNameNoTags(t)}"`
              : dropKind === 'flag'         ? `flagged — "${displayNameNoTags(t)}"`
              :                               `due today — "${displayNameNoTags(t)}"`);
    } catch (err) {
      undoStack.pop();
      reportError('change failed', err);
    } finally { setBusy(false); }
  });
}

// Sidebar-foot hints/messages. Auto-clear after a few seconds so a transient
// hint ("press d again", "max 4 lists…") doesn't linger — progress strings
// ('loading…'/'syncing…') are driven separately by _refreshBusy, and the
// `=== text` guard means this never wipes an in-flight progress indicator.
function setStatus(text) {
  text = text || '';
  clearTimeout(setStatus._clear);
  els.status.textContent = text;
  if (text) {
    setStatus._clear = setTimeout(() => {
      if (els.status.textContent === text) els.status.textContent = '';
    }, 3500);
  }
}

// Translate raw protocol errors into something the user can act on. Raw detail
// still goes to the console for debugging sessions.
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return "can't reach the local server — quit and relaunch Todo App";
  }
  if (/reminders access/i.test(m)) {
    return 'Reminders access is off — System Settings → Privacy & Security → Reminders → enable Todo App, then press r';
  }
  if (/not ready|timed out|exited|cooldown|daemon/i.test(m)) {
    return 'the Reminders connection hiccuped — press r to retry';
  }
  return m;
}

// Failure channel: errors get a transient red toast (the sidebar-footer
// status line is too easy to miss when a save silently rolls back) plus the
// status line, plus the console.
function reportError(prefix, e, opts = {}) {
  console.error(prefix, e);
  const msg = `${prefix}: ${friendlyError(e)}`;
  setStatus(msg);
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');   // screen readers announce rollbacks
    document.body.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(reportError._t);
  if (opts.retry) {
    // Sticky banner for startup-class failures: stays up until retried or
    // replaced. (The old 4.5s toast left a dead-looking empty app behind.)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-retry';
    btn.textContent = 'retry';
    btn.addEventListener('click', () => {
      el.classList.remove('show');
      el.textContent = '';
      opts.retry();
    });
    el.appendChild(btn);
  } else {
    reportError._t = setTimeout(() => el.classList.remove('show'), 4500);
  }
  el.classList.add('show');
  _diagError('reported', `${prefix}: ${(e && e.message) || e}`);
}

// ============================================================
// issue reports  (⌘K "Report a bug / feature request")
// ============================================================
// LOCAL-ONLY today: the modal POSTs a content-free diagnostic envelope + the
// user's text to /api/report, which writes a gitignored markdown file under
// reports/ (and we also copy the same markdown to the clipboard, paste-ready).
// A Claude session in this repo reads reports/ and fixes the issue, then marks
// the file fixed (see reports/README.md).
//
// PRIVACY INVARIANT — the envelope is content-free BY CONSTRUCTION: counts,
// enums, settings, sizes, fixed error categories, and fixed breadcrumbs only, never
// task names/notes/urls. That's what would let a future "send to the maintainer"
// transport reuse this exact builder without leaking task data. Keep it that way.
const REPORT_MODE = 'local';     // future: 'beta' would POST the same envelope to a remote sink

const _diag = { errors: [], crumbs: [] };
const _DIAG_CAP = 30;            // ring-buffer length for errors + breadcrumbs

// Diagnostics never retain a free-form error message. Daemon validation errors
// can echo a user-entered URL/date/recurrence/kind, and arbitrary JS errors can
// include DOM text. Keep only a small fixed vocabulary that is useful for
// grouping reports.
function _errorCategory(value) {
  const s = String(value == null ? '' : value).toLowerCase();
  if (/permission|access denied|not authorized/.test(s)) return 'permission';
  if (/timed out|timeout/.test(s)) return 'timeout';
  if (/network|fetch|connection|econn|socket|offline/.test(s)) return 'network';
  if (/not found|missing/.test(s)) return 'not_found';
  if (/read-only|readonly/.test(s)) return 'read_only';
  if (/syntaxerror|syntax error/.test(s)) return 'syntax_error';
  if (/typeerror|type error/.test(s)) return 'type_error';
  if (/referenceerror|reference error/.test(s)) return 'reference_error';
  if (/rangeerror|range error/.test(s)) return 'range_error';
  if (/bad_request|invalid|must be|required|unknown recurrence/.test(s)) return 'bad_request';
  if (/unavailable|not ready|daemon|exited|cooldown/.test(s)) return 'unavailable';
  return 'unexpected';
}
// A view key is STRUCTURE plus user data: `tag:<name>` carries a tag the user
// wrote (often a person's name) and `list:<id>` carries an EventKit id. The
// envelope promises counts and settings only, so keep the shape and drop the
// payload — `tag:…` / `list:…`, exactly as selectList already omits list names.
function _redactViewKey(v) {
  const s = String(v || '');
  if (s.startsWith('tag:'))  return 'tag:…';
  if (s.startsWith('list:')) return 'list:…';
  return s;   // 'smart:today', 'search', 'list' — fixed vocabulary, no user data
}
function _diagCrumb(label) {
  // Every call site passes fixed vocabulary (view keys are redacted first).
  _diag.crumbs.push({ t: Date.now(), m: String(label || '').slice(0, 80) });
  if (_diag.crumbs.length > _DIAG_CAP) _diag.crumbs.shift();
}
// Store file/line locations only. The first line of a stack is the free-form
// error message and can contain user data, so it is deliberately discarded.
function _redactStack(stack) {
  if (!stack) return '';
  const frames = [];
  for (const line of String(stack).split('\n').slice(1, 8)) {
    const m = line.match(/([A-Za-z0-9_.-]+\.(?:js|mjs|html)):(\d+):(\d+)/);
    if (m) frames.push(`${m[1]}:${m[2]}:${m[3]}`);
    if (frames.length >= 4) break;
  }
  return frames.join(' | ');
}
function _diagError(kind, msg, stack) {
  const entry = { t: Date.now(), kind, category: _errorCategory(msg) };
  const st = _redactStack(stack);
  if (st) entry.stack = st;
  _diag.errors.push(entry);
  if (_diag.errors.length > _DIAG_CAP) _diag.errors.shift();
  // Kept separately so the single most recent crash survives ring-buffer
  // eviction — a burst of benign errors can't push the real one out.
  _diag.lastError = entry;
}
window.addEventListener('error', (e) => {
  const err = e && e.error;
  _diagError('window.error', (e && (e.message || (err && err.message))) || 'error', err && err.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  _diagError('unhandledrejection', (r && r.message) || String(r || 'rejection'), r && r.stack);
});

// Build the content-free snapshot attached to a report. Each section is guarded
// so a single bad read never blocks filing a report.
function _buildDiagnostics() {
  const out = { schema: 1 };
  const safe = (k, fn) => { try { out[k] = fn(); } catch { out[k] = { _error: 'diagnostic_section_failed' }; } };
  const now = new Date();
  out.capturedAt = now.toISOString();
  out.tzOffsetMin = now.getTimezoneOffset();
  safe('app', () => ({
    url: location.pathname,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    theme: localStorage.getItem(THEME_KEY) || 'system',
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  }));
  safe('view', () => ({
    current: _redactViewKey(_currentViewKey()),
    sort: isListView() ? currentSortMode() : null,
    showCompleted: getShowCompleted(),
    pinnedPanes: state.pinnedViews.length,
    focusedPane: _redactViewKey(state.focusedPane) || null,
  }));
  safe('counts', () => {
    const realTasks = state.tasks.filter(t => !_isNonTaskRow(t));
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    let overdue = 0;
    for (const t of (state.allTasks || [])) {
      if (!t.completed && t.dueDate && new Date(t.dueDate) < startOfToday) overdue++;
    }
    return {
      lists: state.lists.length,
      tasksVisible: realTasks.length,
      allTasks: (state.allTasks || []).length,
      overdue,
      tags: Object.keys(state.tagCounts || {}).length,
      snoozed: Object.keys(state.snoozeMap || {}).length,
      sections: Object.keys(state.taskSectionMap || {}).length,
      parentLinks: Object.keys(state.parentMap || {}).length,
      inFlight: state.inFlight,
    };
  });
  safe('settings', () => ({
    sound: _soundEnabled(),
    buddyOn: Buddy.enabled(),
    hasBuddy: !!Buddy.name(),
    customAccent: !!customAccentHex(),        // boolean only — the hex itself is harmless but counts stay the habit
    briefingPopup: _briefingAutoPopEnabled(),
    defaultSort: defaultListSort(),
  }));
  // localStorage keys + their SIZES only — never values (task content lives here).
  safe('storage', () => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('todo-app:') && !/^(task|parent|order|tie|collapsed|completed|snooze)/i.test(k)) continue;
      ls[k] = (localStorage.getItem(k) || '').length;
    }
    return ls;
  });
  // Live-sync health: catches the "edit didn't stick / sync froze" class of
  // bug. readyState 0=connecting 1=open 2=closed; null if EventSource never
  // constructed. All numbers/enums — no task content.
  safe('sync', () => ({
    sse: (_sseSource ? _sseSource.readyState : null),
    secsSinceRefresh: Math.round((Date.now() - _lastFullRefreshAt) / 1000),
    inFlight: state.inFlight,
    pendingRefresh: !!_liveRefreshTimer,
  }));
  out.recentErrors = _diag.errors.slice(-15);
  if (_diag.lastError) out.lastError = _diag.lastError;
  out.breadcrumbs = _diag.crumbs.slice(-25);
  return out;
}

let _reportResolved = false;
function openReportModal(initialType) {
  const overlay = document.getElementById('reportModal');
  if (!overlay || !overlay.classList.contains('hidden')) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  if (_isPaletteOpen()) closePalette();

  const typeEl = document.getElementById('rpType');
  const textEl = document.getElementById('rpText');
  const previewEl = document.getElementById('rpPreview');
  const previewWrap = document.getElementById('rpPreviewWrap');

  typeEl.value = (initialType === 'feature') ? 'feature' : 'bug';
  textEl.value = '';
  previewWrap.open = false;
  const diagnostics = _buildDiagnostics();   // snapshot NOW, before focus shifts state
  previewEl.textContent = JSON.stringify(diagnostics, null, 2);

  overlay.classList.remove('hidden');
  setTimeout(() => { textEl.focus(); }, 0);

  _reportResolved = false;
  const close = () => {
    if (_reportResolved) return; _reportResolved = true;
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
  };
  const submit = async () => {
    if (_reportResolved) return;
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    const type = typeEl.value === 'feature' ? 'feature' : 'bug';
    close();
    setBusy(true);
    try {
      const res = await api.report(type, text, diagnostics);
      let copied = false;
      try { await navigator.clipboard.writeText(res.markdown); copied = true; } catch {}
      setStatus(`${type === 'feature' ? 'request' : 'report'} saved → ${res.file}${copied ? ' (copied for Claude)' : ''}`);
    } catch (err) {
      reportError('report failed', err);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e) => {
    if (_reportResolved) return;
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submit(); return; }
  };
  const onBackdrop = (ev) => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
}

async function exportReportsForSharing() {
  setBusy(true);
  try {
    const packet = await api.reportsExport();
    if (!packet || !packet.count || !packet.markdown) {
      setStatus('no open bug reports or feature requests to export');
      return;
    }
    const copied = await _copyTextToClipboard(packet.markdown);
    if (!copied) {
      reportError('export failed', new Error('clipboard copy failed'));
      return;
    }
    setStatus(`copied ${packet.count} report${packet.count === 1 ? '' : 's'} — paste into an email or a GitHub issue`);
  } catch (err) {
    reportError('report export failed', err);
  } finally {
    setBusy(false);
  }
}

// "Recently deleted" — the recoverable trash (server-side, 7-day window). Lists
// deleted tasks from BOTH the app and the MCP, each with Restore + Delete-forever.
// Items here are snapshots, not live tasks; restore re-creates them in Reminders
// (a new EventKit id, but name / notes / url / priority / due / recurrence back).
function _relTimeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

function _trashMessageRow(listEl, text) {
  listEl.replaceChildren();
  const li = document.createElement('li');
  li.className = 'trash-empty';
  li.textContent = text;
  listEl.appendChild(li);
}

async function openTrashModal() {
  const overlay = document.getElementById('trashModal');
  if (!overlay || !overlay.classList.contains('hidden')) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  if (_isPaletteOpen()) closePalette();
  const listEl = document.getElementById('trashList');
  _trashMessageRow(listEl, 'loading…');
  overlay.classList.remove('hidden');

  const render = (entries) => {
    if (!entries.length) { _trashMessageRow(listEl, 'nothing in the trash.'); return; }
    listEl.replaceChildren();
    for (const entry of entries) {
      const t = entry.task || {};
      const li = document.createElement('li');
      li.className = 'trash-row';

      const main = document.createElement('div');
      main.className = 'trash-main';
      const name = document.createElement('span');
      name.className = 'trash-name';
      name.textContent = displayNameNoTags(t) || t.name || '(untitled)';   // textContent: user content, never innerHTML
      const meta = document.createElement('span');
      meta.className = 'trash-meta';
      const bits = [];
      if (t.listName) bits.push(t.listName);
      bits.push(`deleted ${_relTimeAgo(entry.deletedAt)}`);
      if (entry.source === 'mcp') bits.push('via Claude');
      meta.textContent = bits.join(' · ');
      main.appendChild(name);
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'trash-actions';
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'trash-restore';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', async () => {
        restoreBtn.disabled = true;
        try {
          await api.trashRestore(entry.trashId);
          li.remove();
          if (!listEl.querySelector('.trash-row')) _trashMessageRow(listEl, 'nothing in the trash.');
          await refreshAllTasks();
          await loadTasks();
          renderPinnedPanes();
          setStatus(`restored "${displayNameNoTags(t) || t.name}"`);
        } catch (err) { restoreBtn.disabled = false; reportError('restore failed', err); }
      });
      const purgeBtn = document.createElement('button');
      purgeBtn.className = 'trash-purge';
      purgeBtn.textContent = 'Delete forever';
      purgeBtn.title = 'remove permanently — this cannot be undone';
      purgeBtn.addEventListener('click', async () => {
        purgeBtn.disabled = true;
        try {
          await api.trashPurge(entry.trashId);
          li.remove();
          if (!listEl.querySelector('.trash-row')) _trashMessageRow(listEl, 'nothing in the trash.');
        } catch (err) { purgeBtn.disabled = false; reportError('delete failed', err); }
      });
      actions.appendChild(restoreBtn);
      actions.appendChild(purgeBtn);

      li.appendChild(main);
      li.appendChild(actions);
      listEl.appendChild(li);
    }
  };

  try {
    render(await api.trashList());
  } catch (err) {
    _trashMessageRow(listEl, 'could not load the trash.');
    reportError('trash load failed', err);
  }

  let resolved = false;
  const close = () => {
    if (resolved) return; resolved = true;
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
  };
  // Capture phase + stopPropagation isolates the modal: with no focused input,
  // keys would otherwise drive the background list (j/k nav, etc.).
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); close(); }
    e.stopPropagation();
  };
  const onBackdrop = (ev) => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
}

// ----- logbook (item 25) — completed/deleted history, grouped by day -----
// Read-only journal over the server's task-lifecycle log (history.jsonl,
// every surface incl. iPhone, 90-day window). Names render via textContent
// only; internal tags are stripped for display.
let _logbookEvents = null;
function _logDisplayName(name) {
  return (name || '').replace(/\s*#(?:par|sec)-[^\s]+/gi, '').replace(/\s*#flag\b/gi, '').trim() || '(untitled)';
}
function _renderLogbook() {
  const listEl = document.getElementById('logbookList');
  const q = (document.getElementById('logbookFilter').value || '').trim().toLowerCase();
  const listName = id => (state.lists.find(l => l.id === id) || {}).name || '';
  const events = (_logbookEvents || []).filter(ev =>
    !q || _logDisplayName(ev.name).toLowerCase().includes(q) || listName(ev.list_id).toLowerCase().includes(q));
  listEl.replaceChildren();
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = q ? 'nothing matches.' : 'nothing here yet — finished tasks land here as you complete them.';
    listEl.appendChild(li);
    return;
  }
  // Group the (newest-first) events by local day, header carries a done-count.
  const groups = [];
  for (const ev of events) {
    const d = new Date(ev.at);
    const key = _localYMD(d);
    if (!groups.length || groups[groups.length - 1].key !== key) {
      // "today", then full weekday names for the past week ("Monday, July 6"),
      // then just the date once weekday names stop meaning anything.
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const daysAgo = Math.round((now - dayStart) / 86400000);
      const label = daysAgo === 0 ? 'today'
        : daysAgo <= 7 ? d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
        : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
      groups.push({ key, label, items: [] });
    }
    groups[groups.length - 1].items.push(ev);
  }
  for (const g of groups) {
    const done = g.items.filter(ev => ev.action === 'completed').length;
    const head = document.createElement('li');
    head.className = 'log-day';
    head.textContent = g.label;
    const count = document.createElement('span');
    count.className = 'log-day-count';
    count.textContent = done ? `${done} done` : '';
    head.appendChild(count);
    listEl.appendChild(head);
    for (const ev of g.items) {
      const li = document.createElement('li');
      li.className = 'log-row' + (ev.action === 'deleted' ? ' deleted' : '');
      const mark = document.createElement('span');
      mark.className = 'log-mark';
      mark.textContent = ev.action === 'deleted' ? '×' : '✓';
      const name = document.createElement('span');
      name.className = 'log-name';
      name.textContent = _logDisplayName(ev.name);
      const meta = document.createElement('span');
      meta.className = 'log-meta';
      const bits = [];
      const ln = listName(ev.list_id);
      if (ln) bits.push(ln);
      bits.push(new Date(ev.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      meta.textContent = bits.join(' · ');
      li.appendChild(mark);
      li.appendChild(name);
      li.appendChild(meta);
      listEl.appendChild(li);
    }
  }
}
async function openLogbookModal() {
  const overlay = document.getElementById('logbookModal');
  if (!overlay || !overlay.classList.contains('hidden')) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  if (_isPaletteOpen()) closePalette();
  const filterEl = document.getElementById('logbookFilter');
  filterEl.value = '';
  document.getElementById('logbookList').replaceChildren();
  overlay.classList.remove('hidden');
  try {
    // Two sources (2026-07-08). Completions come from EventKit itself: every
    // completed reminder carries its real completionDate, which reaches back
    // far beyond the app's own history log (the log only exists since the
    // recorder shipped). The history log contributes completions of tasks
    // that were later truly deleted, plus deletions — filtered hard: iOS
    // purges of old completed reminders (was_completed) and any "deleted"
    // event whose task still exists (a partial-fetch phantom) never render,
    // and dedupe-by-id collapses the same event recorded twice when two
    // servers were running.
    const [hist, all] = await Promise.all([api.history(500), api.allReminders(true)]);
    const live = new Set((all || []).map(t => t.id));
    const rows = [];
    for (const t of all || []) {
      if (t.completed && t.completionDate) {
        const at = Date.parse(t.completionDate);
        if (Number.isFinite(at)) rows.push({ at, action: 'completed', task_id: t.id, name: t.name, list_id: t.listId });
      }
    }
    const seenDeleted = new Set();
    for (const ev of ((hist && hist.events) || [])) {
      if (ev.action === 'completed' && !live.has(ev.task_id)) {
        rows.push(ev);
      } else if (ev.action === 'deleted' && !ev.was_completed && !live.has(ev.task_id) && !seenDeleted.has(ev.task_id)) {
        seenDeleted.add(ev.task_id);
        rows.push(ev);
      }
    }
    rows.sort((a, b) => b.at - a.at);
    _logbookEvents = rows;
  } catch (err) {
    _logbookEvents = [];
    reportError('logbook load failed', err);
  }
  _renderLogbook();
  filterEl.oninput = _renderLogbook;   // oninput (not addEventListener): reopen must not stack handlers
  filterEl.focus();

  let resolved = false;
  const close = () => {
    if (resolved) return; resolved = true;
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
  };
  // Capture + stopPropagation isolates the modal from the background list's
  // key handling; typing still reaches the filter input (default action).
  const onKey = (e) => {
    if (e.key === 'Escape' || (e.key === '`' && e.target !== filterEl)) { e.preventDefault(); close(); }
    e.stopPropagation();
  };
  const onBackdrop = (ev) => { if (ev.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
}

// Progress indicator ('loading…' / 'syncing…' in the sidebar foot). Shown only
// if the operation outlasts a short grace period, so fast actions (switching
// lists, quick writes) never flash it. Explicit hints/errors via setStatus stay
// instant — _refreshBusy only ever writes/clears the two progress strings.
const BUSY_GRACE_MS = 250;
let _busyTimer = null;
function _busyLabel() {
  if (state.loading) return 'loading…';
  if (state.inFlight > 0) return 'syncing…';
  return '';
}
function _refreshBusy() {
  const label = _busyLabel();
  if (label) {
    if (_busyTimer) return;            // a deferred show is already pending
    _busyTimer = setTimeout(() => {
      _busyTimer = null;
      const l = _busyLabel();
      if (l) els.status.textContent = l;
    }, BUSY_GRACE_MS);
  } else {
    if (_busyTimer) { clearTimeout(_busyTimer); _busyTimer = null; }
    // Only clear if WE'RE the one showing a progress string — never stomp a hint.
    if (els.status.textContent === 'loading…' || els.status.textContent === 'syncing…') {
      els.status.textContent = '';
    }
  }
}
function setBusy(busy) {
  if (busy) state.inFlight++; else state.inFlight = Math.max(0, state.inFlight - 1);
  _refreshBusy();
}

// ----- theme & completion-sound preferences -----
// Theme is applied pre-paint by the inline script in index.html; this module
// only needs the cycle command. 'system' = unset data-theme (CSS media query
// decides); 'dark'/'light' force it.
const THEME_KEY = 'todo-app:theme:v1';
const SOUND_KEY = 'todo-app:sound:v1';
// Zen mode: one body class that hides the decorative chrome (buddy, hint bar,
// sidebar counts). A visibility preset, NOT a design fork — no layout or
// styling may branch on it beyond display:none rules in style.css. Buddy's own
// on/off setting is untouched; zen just hides it while active.
const ZEN_KEY = 'todo-app:zen:v1';
function _zenEnabled() { return localStorage.getItem(ZEN_KEY) === '1'; }
function setZenMode(on) {
  try { localStorage.setItem(ZEN_KEY, on ? '1' : '0'); } catch {}
  document.body.classList.toggle('zen', on);
  setStatus(on ? 'zen mode on — decorative chrome hidden' : 'zen mode off');
}
function toggleZenMode() { setZenMode(!_zenEnabled()); }
document.body.classList.toggle('zen', _zenEnabled());   // apply persisted state at boot
function setTheme(next) {
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  if (next === 'dark' || next === 'light') document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  setStatus(`theme: ${next}`);
}
function cycleTheme() {
  const order = ['system', 'dark', 'light'];
  const cur = localStorage.getItem(THEME_KEY) || 'system';
  setTheme(order[(order.indexOf(cur) + 1) % order.length]);
}

// ----- custom accent color -----
// Settings → accent color overrides --accent (and derives the --accent-2
// hover shade per theme) via an injected <style id="customAccent">. The same
// style is built pre-paint by the inline script in index.html — KEEP THE TWO
// BUILDERS IN SYNC. No override → the element is absent and the theme's
// default accent applies.
const ACCENT_KEY = 'todo-app:accent:v1';
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
function _accentCss(hex) {
  // Selector shapes MATCH style.css's theme blocks (including the media-query
  // system-light one) so the override wins on specificity in every theme
  // state, not just default dark. --accent-2 is the hover shade: lighter than
  // the accent in dark mode, darker in light mode, like the built-in pairs.
  return `:root, :root[data-theme="light"] { --accent: ${hex}; }\n`
       + `:root { --accent-2: color-mix(in oklab, ${hex} 72%, white); }\n`
       + `:root[data-theme="light"] { --accent-2: color-mix(in oklab, ${hex} 78%, black); }\n`
       + `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --accent: ${hex}; --accent-2: color-mix(in oklab, ${hex} 78%, black); } }`;
}
// The persisted override, or null when the theme default is in effect.
function customAccentHex() {
  try { const v = localStorage.getItem(ACCENT_KEY); return ACCENT_RE.test(v || '') ? v.toLowerCase() : null; } catch { return null; }
}
// Strictly validated before it touches the style element — a non-hex value
// must never be interpolated into CSS. null (or anything invalid) resets.
function applyAccentColor(hex) {
  let el = document.getElementById('customAccent');
  if (hex && ACCENT_RE.test(hex)) {
    if (!el) { el = document.createElement('style'); el.id = 'customAccent'; document.head.appendChild(el); }
    el.textContent = _accentCss(hex);
    try { localStorage.setItem(ACCENT_KEY, hex.toLowerCase()); } catch {}
  } else {
    if (el) el.remove();
    try { localStorage.removeItem(ACCENT_KEY); } catch {}
  }
}
// Whatever --accent currently computes to (override or theme default).
function effectiveAccentHex() {
  const v = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim();
  return ACCENT_RE.test(v) ? v.toLowerCase() : '#d97757';
}

// A quiet two-note tick when a task is completed (Things-style). Synthesized
// with WebAudio — no asset, no network. Toggleable from the ⌘K palette.
let _audioCtx = null;
function _soundEnabled() { return localStorage.getItem(SOUND_KEY) !== '0'; }
function playCompletionTick() {
  if (!_soundEnabled()) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const t = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, t);
    osc.frequency.exponentialRampToValueAtTime(1480, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  } catch {}
}
function setCompletionSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch {}
  setStatus(on ? 'completion sound on' : 'completion sound off');
  if (on) playCompletionTick();
}
function toggleCompletionSound() { setCompletionSound(!_soundEnabled()); }

// ----- empty-state character -----
const EMPTY_LINES = [
  'nothing here. press n to add — or enjoy the space.',
  'all clear.',
  'empty. as intended.',
  'nothing due. plan, or rest.',
  'zero tasks. a good number.',
];
function _renderEmptyState() {
  // Static markup only — no user data flows through this innerHTML.
  els.emptyMsg.innerHTML = `
    <svg class="empty-mark" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="4"/>
      <path d="M50 4 a46 46 0 0 1 0 92 a23 23 0 0 1 0 -46 a23 23 0 0 0 0 -46" fill="currentColor"/>
      <circle cx="50" cy="27" r="6.5" fill="currentColor"/>
      <circle cx="50" cy="73" r="6.5" fill="var(--bg)"/>
    </svg>
    <div class="empty-line"></div>`;
  let line;
  if (state.view === 'list' && !state.currentListId && !state.searchQuery) {
    line = state.lists.length
      ? 'no view open — press 1–9 or click a list in the sidebar'
      : 'no lists yet — press ⇧L to create your first list';
  } else {
    const day = Math.floor(Date.now() / 86400000);
    line = EMPTY_LINES[day % EMPTY_LINES.length];
  }
  els.emptyMsg.querySelector('.empty-line').textContent = line;
}

// ============================================================
// data ops (background-write where possible)
// ============================================================
async function loadLists() {
  state.lists = await api.lists();
  if (state.currentListId && !state.lists.find(l => l.id === state.currentListId)) {
    state.currentListId = null;
  }
  if (!state.currentListId && state.lists.length) state.currentListId = state.lists[0].id;
  persist();
  renderLists();
  renderSmartLists();
  // Lazy load counts after lists render so the user sees the sidebar immediately.
  api.counts().then(c => { state.counts = c; renderLists(); }).catch(() => {});
}

// Does any visible pane actually need completed tasks in the cache? Fetching
// the entire completed history on every write is the main latency tax on
// daily actions, and it grows forever — so only pay it when a view shows it.
function _needCompletedTasks() {
  if (state.view === 'smart:completed' || state.pinnedViews.includes('smart:completed')) return true;
  if (isSearchView() && getShowCompleted()) return true;
  for (const k of [_activeViewKey(), ...state.pinnedViews]) {
    if (state.showCompletedMap[k]) return true;
  }
  return false;
}
let _allTasksHasCompleted = false;

// Pull the full all-lists set so smart views and tag computation have data.
let _allTasksRequest = 0;
async function refreshAllTasks() {
  const request = ++_allTasksRequest;
  const withCompleted = _needCompletedTasks();
  const tasks = await api.allReminders(withCompleted);
  if (request !== _allTasksRequest) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) { _scheduleLiveRefresh(); return; }
  state.allTasks = tasks;
  _allTasksHasCompleted = withCompleted;
  _ingestParentTags(state.allTasks);   // seed subtask links from #par-<id> tags before any view builds
  // Wake snoozes whose day has arrived.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let snoozeDirty = false;
  for (const [id, until] of Object.entries(state.snoozeMap)) {
    if (new Date(until) <= todayStart) { delete state.snoozeMap[id]; snoozeDirty = true; }
  }
  if (snoozeDirty) persistSnooze();
  recomputeTagCounts();
  renderTags();
  renderSmartLists();   // keeps the Today/Important/Flagged count badges live
  renderPinnedPanes();
  _buddyTodayPulse();
}

// ----- buddy event signals -----
// Open Today tasks (mirrors the smart:today filter). The buddy celebrates the
// >0 → 0 transition — hooked into refreshAllTasks so completions from any
// path (main pane, pinned pane, iPhone/MCP via SSE) count. First refresh only
// seeds the counter (null guard), so an empty Today at startup stays quiet.
function _todayOpenCount() {
  const endToday = new Date();
  endToday.setHours(0, 0, 0, 0);
  endToday.setDate(endToday.getDate() + 1);
  const rlId = (_readingList() || {}).id;
  return state.allTasks.filter(t =>
    !t.completed && t.dueDate && new Date(t.dueDate) < endToday && !_isSnoozed(t) && t.listId !== rlId).length;
}
let _lastTodayCount = null;
function _buddyTodayPulse() {
  const n = _todayOpenCount();
  if (_lastTodayCount > 0 && n === 0) Buddy.onTodayCleared();
  _lastTodayCount = n;
}

// Fire-and-forget cache refresh after an optimistic list-view write, so
// pinned panes and tag counts don't go stale until the next full reload.
function _backgroundRefresh() {
  refreshAllTasks().catch(() => {});
}

// Garbage-collect localStorage maps against the live task set. Tasks deleted
// from iPhone/Reminders.app/MCP never hit _purgeTaskLocalRefs, and tieOrder /
// collapsedParents were never purged at all — without a sweep, dead ids (and
// ids orphaned by iCloud id churn) accumulate forever. Runs at most once a
// day, best-effort, and defers while an optimistic write is in flight.
const GC_KEY = 'todo-app:lastGc:v1';
async function _gcLocalMaps() {
  try {
    const last = Number(localStorage.getItem(GC_KEY) || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    if (state.tasks.some(t => t._optimistic)) return;   // retry next launch
    const all = await api.allReminders(true);           // needs the FULL set incl. completed
    const live = new Set(all.map(t => t.id));
    if (live.size === 0 || state.inFlight || _editingNow()) return;
    const observed = JSON.parse(localStorage.getItem('todo-app:gcMissing:v1') || '{}');
    const referenced = new Set([
      ...Object.keys(state.parentMap), ...Object.values(state.parentMap),
      ...Object.keys(state.taskSectionMap), ...Object.keys(state.collapsedParents),
      ...Object.keys(state.snoozeMap), ...state.ingestedParents,
      ...Object.values(state.orderByGroup).flat(),
      ...Object.values(state.tieOrder).flatMap(groups => Object.values(groups).flat()),
    ]);
    const now = Date.now();
    for (const id of referenced) {
      if (live.has(id)) delete observed[id];
      else if (!observed[id]) observed[id] = now;
    }
    localStorage.setItem('todo-app:gcMissing:v1', JSON.stringify(observed));
    // Conservative retention: a short-lived partial snapshot cannot remove
    // organization, even if it is nonempty. Backup before the eventual sweep.
    for (const id of referenced) {
      if (observed[id] && now - observed[id] < 30 * 86400000) live.add(id);
    }
    localStorage.setItem('todo-app:organizationBackup:v1', JSON.stringify({
      at: now, parentMap: state.parentMap, taskSectionMap: state.taskSectionMap,
      orderByGroup: state.orderByGroup, collapsedParents: state.collapsedParents,
      snoozeMap: state.snoozeMap, ingestedParents: [...state.ingestedParents], tieOrder: state.tieOrder,
    }));
    if (live.size === 0) return;                        // suspicious — don't purge on empty data
    let dirty = false;
    for (const [c, p] of Object.entries(state.parentMap)) {
      if (!live.has(c) || !live.has(p)) { delete state.parentMap[c]; dirty = true; }
    }
    for (const id of Object.keys(state.taskSectionMap)) {
      if (!live.has(id)) { delete state.taskSectionMap[id]; dirty = true; }
    }
    for (const k of Object.keys(state.orderByGroup)) {
      if (!k.startsWith('list:') && !live.has(k)) { delete state.orderByGroup[k]; dirty = true; continue; }
      const filtered = state.orderByGroup[k].filter(id => live.has(id));
      if (filtered.length !== state.orderByGroup[k].length) { state.orderByGroup[k] = filtered; dirty = true; }
      if (filtered.length === 0) { delete state.orderByGroup[k]; dirty = true; }
    }
    for (const id of Object.keys(state.collapsedParents)) {
      if (!live.has(id)) { delete state.collapsedParents[id]; dirty = true; }
    }
    for (const id of Object.keys(state.snoozeMap)) {
      if (!live.has(id)) { delete state.snoozeMap[id]; dirty = true; }
    }
    for (const id of [...state.ingestedParents]) {
      if (!live.has(id)) { state.ingestedParents.delete(id); dirty = true; }
    }
    for (const vk of Object.keys(state.tieOrder)) {
      const ties = state.tieOrder[vk];
      for (const tk of Object.keys(ties)) {
        const filtered = ties[tk].filter(id => live.has(id));
        if (filtered.length !== ties[tk].length) { ties[tk] = filtered; dirty = true; }
        if (ties[tk].length === 0) { delete ties[tk]; dirty = true; }
      }
      if (Object.keys(ties).length === 0) { delete state.tieOrder[vk]; dirty = true; }
    }
    if (dirty) {
      persistParentMap(); persistOrder(); persistSections(); persistTieOrder(); persistSnooze(); persistIngested();
      try { localStorage.setItem(CP_KEY, JSON.stringify(state.collapsedParents)); } catch {}
    }
    localStorage.setItem(GC_KEY, String(Date.now()));
  } catch {} // best-effort
}

// Search operators: `due:today|tomorrow|week|overdue|none`, `#tag` (prefix
// match, so live typing narrows), `list:<name>` (fuzzy, same matcher as ls:).
// The remainder is the usual substring query. Returns { text, filters }.
function _parseSearchQuery(raw) {
  const filters = [];
  let text = String(raw);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const dayN = (n) => { const d = new Date(today0); d.setDate(d.getDate() + n); return d; };
  text = text.replace(/(?:^|\s)due:(\S+)/gi, (full, v) => {
    v = v.toLowerCase();
    if (v === 'today')         filters.push(t => t.dueDate && new Date(t.dueDate) >= today0 && new Date(t.dueDate) < dayN(1));
    else if (v === 'tomorrow') filters.push(t => t.dueDate && new Date(t.dueDate) >= dayN(1) && new Date(t.dueDate) < dayN(2));
    else if (v === 'week')     filters.push(t => t.dueDate && new Date(t.dueDate) >= today0 && new Date(t.dueDate) < dayN(7));
    else if (v === 'overdue')  filters.push(t => t.dueDate && new Date(t.dueDate) < today0 && !t.completed);
    else if (v === 'none')     filters.push(t => !t.dueDate);
    else return full;          // unknown value — leave it as plain text
    return ' ';
  });
  text = text.replace(/(?:^|\s)#([\w-]+)/g, (_, tag) => {
    const p = tag.toLowerCase();
    filters.push(t => [...tagsInTask(t)].some(x => x.startsWith(p)));
    return ' ';
  });
  text = text.replace(/(?:^|\s)list:(\S+)/gi, (_, tok) => {
    const norm = s => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
    const n = norm(tok);
    const match = state.lists.find(l => norm(l.name) === n)
      || state.lists.find(l => norm(l.name).startsWith(n))
      || state.lists.find(l => norm(l.name).includes(n));
    filters.push(match ? (t => t.listId === match.id) : (() => false));
    return ' ';
  });
  return { text: text.trim().toLowerCase(), filters };
}

// Priority-defer (#1). Cycling priority with `p` should NOT yank the row out
// from under you the instant you press it — in a priority-sorted list it would
// jump, and in a smart view like "Important today" it could vanish from the
// filter mid-adjustment. So `cyclePriority` updates the row in place and just
// re-renders (no re-sort): it visibly holds its slot. The row then settles into
// its real sorted position (or drops from the filter) on the NEXT view rebuild —
// the debounced echo of our own save (so rapid re-cycling stays put until you
// stop), or immediately when you move selection off it.
//
// _settleStickyEdit runs on every rebuild. It never re-pins (an earlier version
// did, which could strand a just-prioritized task at the bottom forever if the
// save-echo re-pinned it while focus stayed on it and you then moved away by
// mouse). It just clears the sticky flag and, if focus is still on the edited
// task, keeps the selection following it to its new sorted home (or a neighbor
// if it dropped out of a filtered view) via _pendingSelectId.
function _settleStickyEdit(built, prevRows) {
  const id = state._stickyEditId;
  if (!id) return built;
  if (state._stickyEditView === state.view) {
    const sel = prevRows[state.selectedIdx];               // selection as it stood before this rebuild
    if (sel && sel.id === id) state._pendingSelectId = id; // follow the task as it sorts into place
  }
  _clearStickyEdit();
  return built;
}
function _clearStickyEdit() { state._stickyEditId = null; state._stickyEditView = null; }

let _tasksRequest = 0;
async function loadTasks() {
  const request = ++_tasksRequest;
  const viewKey = _activeViewKey();
  const current = () => request === _tasksRequest && viewKey === _activeViewKey();
  const canCommit = () => {
    if (!current()) return false;
    if (document.querySelector('.task.editing, .task.inline-editing')) { _scheduleLiveRefresh(); return false; }
    return true;
  };
  state.loading = true; _refreshBusy();
  const _prevRows = state.tasks;   // snapshot for the sticky-pin (#1): the slot the edited row held pre-rebuild
  try {
    _enterRemindersInboxIfNeeded();   // snapshot the "New" cutoff once per inbox visit (self-resets elsewhere)
    _updateQuickAddPlaceholder();      // link-dump prompt in the reading list, task prompt elsewhere
    els.listHeader.textContent = '—';     // explicit reset — protects against stale name when current list is gone
    if (isSearchView()) {
      if (state.allTasks.length === 0 || (_needCompletedTasks() && !_allTasksHasCompleted)) await refreshAllTasks();
      if (!canCommit()) return;
      const { text: q, filters } = _parseSearchQuery(state.searchQuery);
      const matches = state.allTasks.filter(t => {
        if (!getShowCompleted() && t.completed) return false;
        for (const f of filters) if (!f(t)) return false;
        if (!q) return filters.length > 0;   // operator-only query
        return (t.name || '').toLowerCase().includes(q)
            || (t.body || '').toLowerCase().includes(q)
            || (t.url  || '').toLowerCase().includes(q);
      });
      state.tasks = matches.slice().sort(_sortFn).map(t => ({ ...t, _depth: 0 }));
      els.listHeader.textContent = `Search: "${state.searchQuery}" — ${matches.length} match${matches.length === 1 ? '' : 'es'}`;
    } else if (isListView()) {
      // Single-list view (existing behavior)
      if (!state.currentListId) {
        // "No view open" state (active view was click-closed).
        state.tasks = [];
        els.listHeader.textContent = '—';
        renderTasks();
        return;
      }
      const tasks = await api.reminders(state.currentListId, getShowCompleted());
      if (!canCommit()) return;
      _ingestParentTags(tasks);   // seed subtask links from #par-<id> tags before flatten nests them
      const openTasks   = tasks.filter(t => !t.completed);
      const doneTasks   = tasks.filter(t =>  t.completed);
      const flatOpen    = sortTasks(openTasks);
      // For non-manual list sort modes, apply the user's within-tie reorder.
      const reorderedOpen = _isManualOrderingActive()
        ? flatOpen
        : _applyTieOrder(flatOpen, _currentTieViewKey());
      state.tasks = reorderedOpen.concat(_bucketCompletedTasks(doneTasks));
      const list = state.lists.find(l => l.id === state.currentListId);
      els.listHeader.textContent = list ? list.name : '—';
    } else {
      // Smart-list or tag view — uses the all-tasks cache. Refetch if the
      // cache is empty OR this view needs completed tasks and the cache was
      // fetched without them.
      if (state.allTasks.length === 0 || (_needCompletedTasks() && !_allTasksHasCompleted)) await refreshAllTasks();
      if (!canCommit()) return;
      state.tasks = _applyTieOrder(buildViewTasks(state.allTasks, state.view), _currentTieViewKey());
      els.listHeader.textContent = viewTitle(state.view);
    }
    // Priority-defer (#1): a just-prioritized row settles into its sorted spot
    // on this rebuild; honor a pending re-select so selection follows the task
    // (or lands on the one you moved to), not a stale clamp guess.
    state.tasks = _settleStickyEdit(state.tasks, _prevRows);
    if (state._pendingSelectId) {
      const pi = state.tasks.findIndex(t => t.id === state._pendingSelectId);
      if (pi >= 0) state.selectedIdx = pi;
      state._pendingSelectId = null;
    }
    if (state.selectedIdx >= state.tasks.length) state.selectedIdx = Math.max(0, state.tasks.length - 1);
    while (state.selectedIdx < state.tasks.length && _isNonTaskRow(state.tasks[state.selectedIdx])) state.selectedIdx++;
    if (state.selectedIdx >= state.tasks.length) state.selectedIdx = 0;
    renderTasks();
  } catch (e) {
    if (current()) reportError('load failed', e);
  } finally {
    if (current()) state.loading = false; _refreshBusy();
  }
}

function viewTitle(view) {
  if (view === 'list') return (state.lists.find(l => l.id === state.currentListId) || {}).name || '—';
  if (view.startsWith('smart:')) return (SMART_LISTS.find(s => 'smart:' + s.key === view) || {}).label || view;
  if (view.startsWith('tag:'))   return '#' + view.slice(4);
  return '—';
}

// Compute the rendered task list for non-list views: filter, sort, optionally insert group headers.
function buildViewTasks(all, view) {
  // Reading-list items live only in the Reading list itself (and search). They
  // never surface in cross-list views — Today, Important today, Flagged, By
  // priority, Scheduled, All, By list, #tag — even when marked P1 or due today.
  // A reading is never as urgent as a real task. Priority/tags still work for
  // organizing WITHIN the reading list (that list view doesn't route through here).
  const _rl = _readingList();
  let pool = _rl ? all.filter(t => t.listId !== _rl.id) : all;
  // Common filters
  const today = new Date(); today.setHours(0,0,0,0);
  const endToday = new Date(today); endToday.setDate(endToday.getDate() + 1);

  if (view === 'smart:today') {
    // Snoozed tasks hide from Today until their day even if technically due.
    pool = pool.filter(t => !t.completed && t.dueDate && new Date(t.dueDate) < endToday && !_isSnoozed(t));
  } else if (view === 'smart:important') {
    pool = pool.filter(t => {
      if (t.completed) return false;
      // A P1 recurring task resting until a future occurrence isn't
      // important *today* — its priority applies on its day.
      if (_isResting(t)) return false;
      const dueToday = t.dueDate && new Date(t.dueDate) < endToday;
      const isP1 = t.priority === 'high';
      return dueToday || isP1;
    });
  } else if (view === 'smart:scheduled') {
    pool = pool.filter(t => !t.completed && t.dueDate);
  } else if (view === 'smart:all') {
    pool = pool.filter(t => !t.completed);
  } else if (view === 'smart:flagged') {
    pool = pool.filter(t => !t.completed && isFlagged(t));
  } else if (view === 'smart:completed') {
    pool = pool.filter(t => t.completed);
  } else if (view === 'smart:byPriority' || view === 'smart:byList') {
    pool = pool.filter(t => getShowCompleted() || !t.completed);
  } else if (view.startsWith('tag:')) {
    const tag = view.slice(4).toLowerCase();
    pool = pool.filter(t => {
      if (!getShowCompleted() && t.completed) return false;
      return tagsInTask(t).has(tag);
    });
  }

  // Group / sort
  if (view === 'smart:byPriority') {
    const buckets = { high: [], medium: [], low: [], none: [] };
    for (const t of pool) buckets[t.priority || 'none'].push(t);
    const groups = [
      { key: 'high',   label: 'High',        items: buckets.high   },
      { key: 'medium', label: 'Medium',      items: buckets.medium },
      { key: 'low',    label: 'Low',         items: buckets.low    },
      { key: 'none',   label: 'No priority', items: buckets.none   },
    ];
    return _flattenGroups(groups);
  }
  if (view === 'smart:byList') {
    const byId = new Map();
    for (const l of state.lists) byId.set(l.id, { label: l.name, items: [] });
    for (const t of pool) {
      const b = byId.get(t.listId);
      if (b) b.items.push(t);
    }
    const groups = Array.from(byId.values()).map(g => ({ ...g, key: g.label }));
    return _flattenGroups(groups);
  }
  // Flat sort for the rest
  const sorted = pool.slice().sort(_sortFn);
  if (view === 'smart:today') {
    // Overdue / Today split — the morning's first question. Headers only when
    // both groups exist (an all-clear Today shouldn't grow furniture).
    const overdue = [], dueToday = [];
    for (const t of sorted) (new Date(t.dueDate) < today ? overdue : dueToday).push(t);
    if (overdue.length && dueToday.length) {
      return [
        { _isHeader: true, label: 'Overdue', key: 'today:overdue', count: overdue.length },
        ...overdue.map(t => ({ ...t, _depth: 0 })),
        { _isHeader: true, label: 'Today', key: 'today:due', count: dueToday.length },
        ...dueToday.map(t => ({ ...t, _depth: 0 })),
      ];
    }
    return sorted.map(t => ({ ...t, _depth: 0 }));
  }
  if (view === 'smart:important') {
    sorted.sort((a, b) => {
      const ap = _priWeight(a.priority);
      const bp = _priWeight(b.priority);
      if (ap !== bp) return ap - bp;
      const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return aD - bD;
    });
  } else if (view === 'smart:scheduled') {
    sorted.sort((a, b) => {
      const aD = new Date(a.dueDate).getTime();
      const bD = new Date(b.dueDate).getTime();
      return aD - bD;
    });
  } else if (view === 'smart:completed') {
    sorted.sort((a, b) => {
      const aD = a.completionDate ? new Date(a.completionDate).getTime() : 0;
      const bD = b.completionDate ? new Date(b.completionDate).getTime() : 0;
      return bD - aD;
    });
    // Split into "Past 7 days" (always visible) and "Older" (collapsible, default collapsed).
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - 7);
    const recent = [], older = [];
    for (const t of sorted) {
      const d = t.completionDate ? new Date(t.completionDate) : null;
      if (d && d >= cutoff) recent.push(t); else older.push(t);
    }
    const out = [];
    if (recent.length) {
      out.push({ _isHeader: true, label: 'Past 7 days', key: 'completed:recent', count: recent.length });
      for (const t of recent) out.push({ ...t, _depth: 0 });
    }
    if (older.length) {
      out.push({
        _isCompletedOlderHeader: true,
        label: 'Older',
        count: older.length,
        collapsed: !!state.completedOlderCollapsed,
      });
      if (!state.completedOlderCollapsed) {
        for (const t of older) out.push({ ...t, _depth: 0 });
      }
    }
    return out;
  }
  return sorted.map(t => ({ ...t, _depth: 0 }));
}

// Group completed tasks into time buckets for list views: Today / Yesterday /
// Last 7 days / Last month / Earlier. "Last month" and "Earlier" default to
// collapsed; the others default to expanded. Bucket disclosure persists in
// state.completedBucketsCollapsed (per-bucket-key, shared across lists).
function _bucketCompletedTasks(done) {
  if (!done || done.length === 0) return [];
  const sorted = done.slice().sort((a, b) => {
    const aD = a.completionDate ? new Date(a.completionDate).getTime() : 0;
    const bD = b.completionDate ? new Date(b.completionDate).getTime() : 0;
    return bD - aD;     // newest first
  });
  const startToday  = new Date(); startToday.setHours(0,0,0,0);
  const startYday   = new Date(startToday); startYday.setDate(startYday.getDate() - 1);
  const start7      = new Date(startToday); start7.setDate(start7.getDate() - 7);
  const start30     = new Date(startToday); start30.setDate(start30.getDate() - 30);

  const buckets = [
    { key: 'today',   label: 'Today',         items: [], defaultCollapsed: false },
    { key: 'yday',    label: 'Yesterday',     items: [], defaultCollapsed: false },
    { key: 'last7',   label: 'Last 7 days',   items: [], defaultCollapsed: false },
    { key: 'last30',  label: 'Last month',    items: [], defaultCollapsed: true  },
    { key: 'earlier', label: 'Earlier',       items: [], defaultCollapsed: true  },
  ];
  for (const t of sorted) {
    const d = t.completionDate ? new Date(t.completionDate) : null;
    if (!d)                       buckets[4].items.push(t);
    else if (d >= startToday)     buckets[0].items.push(t);
    else if (d >= startYday)      buckets[1].items.push(t);
    else if (d >= start7)         buckets[2].items.push(t);
    else if (d >= start30)        buckets[3].items.push(t);
    else                          buckets[4].items.push(t);
  }
  const totalCount = sorted.length;
  const out = [{
    _isCompletedMegaHeader: true,
    label: `Completed (${totalCount})`,
    count: totalCount,
  }];
  for (const b of buckets) {
    if (b.items.length === 0) continue;
    const bucketKey = `completed:${b.key}`;
    // Default-collapsed buckets stay collapsed unless the user explicitly toggled them open.
    const stored = state.completedBucketsCollapsed[bucketKey];
    const collapsed = stored === undefined ? b.defaultCollapsed : !!stored;
    out.push({
      _isCompletedBucketHeader: true,
      bucketKey,
      label: b.label,
      count: b.items.length,
      collapsed,
    });
    if (!collapsed) {
      for (const t of b.items) out.push({ ...t, _depth: 0 });
    }
  }
  return out;
}

async function toggleCompletedOlderCollapse() {
  state.completedOlderCollapsed = !state.completedOlderCollapsed;
  try { localStorage.setItem(CCO_KEY, JSON.stringify(state.completedOlderCollapsed)); } catch {}
  await loadTasks();
}

function toggleParentCollapse(parentId) {
  if (state.collapsedParents[parentId]) delete state.collapsedParents[parentId];
  else state.collapsedParents[parentId] = true;
  try { localStorage.setItem(CP_KEY, JSON.stringify(state.collapsedParents)); } catch {}
  // state.tasks may already contain completed-bucket header rows that
  // flattenWithDepth would mistake for tasks — refetch + reflatten cleanly.
  loadTasks();
}

function toggleCompletedBucket(bucketKey) {
  if (state.completedBucketsCollapsed[bucketKey]) {
    delete state.completedBucketsCollapsed[bucketKey];
  } else {
    state.completedBucketsCollapsed[bucketKey] = true;
  }
  try { localStorage.setItem(CCB_KEY, JSON.stringify(state.completedBucketsCollapsed)); } catch {}
  loadTasks();
}

function _flattenGroups(groups) {
  const out = [];
  for (const g of groups) {
    const sorted = g.items.slice().sort(_sortFn);
    if (sorted.length === 0) continue;
    out.push({ _isHeader: true, label: g.label, key: g.key, count: sorted.length });
    for (const t of sorted) out.push({ ...t, _depth: 0 });
  }
  return out;
}

// Clicking the active view's sidebar row again CLOSES it: unpin it if it was
// pinned, promote the first remaining pinned view to primary, else fall back
// to an empty "no view open" state (number keys / clicks bring any list back).
async function _closeActiveView() {
  const key = _activeViewKey();
  const i = state.pinnedViews.indexOf(key);
  if (i >= 0) state.pinnedViews.splice(i, 1);
  const next = state.pinnedViews[0] || null;
  if (next && next.startsWith('list:')) {
    state.view = 'list';
    state.currentListId = next.slice(5);
  } else if (next) {
    state.view = next;
  } else {
    state.view = 'list';
    state.currentListId = null;
  }
  state.selectedIdx = 0;
  state.tasks = [];
  persist();
  renderSmartLists();
  renderTags();
  renderLists();
  renderPinnedPanes();
  await loadTasks();
}

async function selectView(view) {
  if (state.view === view) { await _closeActiveView(); return; }
  // Redacted: a `tag:` view key carries a user-written tag (frequently a
  // person's name). selectList already omits the list name for the same reason.
  _diagCrumb('view → ' + _redactViewKey(view));
  state.view = view;
  state.selectedIdx = 0;
  state.tasks = [];
  persist();
  renderSmartLists();
  renderTags();
  renderLists();
  renderPinnedPanes();
  await loadTasks();
}

async function selectList(id) {
  if (state.view === 'list' && id === state.currentListId) { await _closeActiveView(); return; }
  _diagCrumb('view → a list');   // list name omitted — could be user-sensitive
  state.view = 'list';
  state.currentListId = id;
  state.selectedIdx = 0;
  state.tasks = [];
  persist();
  renderSmartLists();
  renderTags();
  renderLists();
  renderPinnedPanes();
  els.listHeader.textContent = (state.lists.find(l => l.id === id) || {}).name || '—';
  renderTasks();
  await loadTasks();
}

// Sidebar: smart lists (hidden ones stay reachable via ⌘K "Go to: …")
// The day-planning views carry a live open count; By priority / Completed
// don't (one mirrors the total, the other is noise).
const SMART_COUNT_KEYS = new Set(['today', 'important', 'flagged']);
function renderSmartLists() {
  if (!els.smartLists) return;
  els.smartLists.innerHTML = '';
  for (const s of SMART_LISTS) {
    if (s.sidebar === false) continue;
    if (state.hiddenSmartViews.includes(s.key)) continue;
    const li = document.createElement('li');
    const viewKey = 'smart:' + s.key;
    if (state.view === viewKey) li.classList.add('active');
    li.innerHTML = `<span class="icon"></span><span class="lname"></span><span class="count"></span>`;
    li.querySelector('.icon').textContent = s.icon;
    li.querySelector('.lname').textContent = s.label;
    if (SMART_COUNT_KEYS.has(s.key)) {
      const n = _paneTasks(viewKey).filter(t => !t.completed).length;
      li.querySelector('.count').textContent = n || '';
    }
    li.addEventListener('click', () => selectView(viewKey));
    _attachPinCheckbox(li, viewKey);
    if (s.drop) attachSmartDropZone(li, () => ({ kind: s.drop, label: s.label }));
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'row-delete';
    hide.textContent = '×';
    hide.title = `hide "${s.label}" from sidebar…`;
    hide.setAttribute('aria-label', hide.title);
    hide.addEventListener('click', (e) => { e.stopPropagation(); hideSmartViewFlow(s.key, s.label); });
    li.appendChild(hide);
    els.smartLists.appendChild(li);
  }
}

// Sidebar: tags
function renderTags() {
  if (!els.tags) return;
  els.tags.innerHTML = '';
  const sorted = Object.entries(state.tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [tag, count] of sorted) {
    const li = document.createElement('li');
    const viewKey = 'tag:' + tag;
    if (state.view === viewKey) li.classList.add('active');
    li.innerHTML = `<span class="icon tag-hash">#</span><span class="lname"></span><span class="count"></span>`;
    li.querySelector('.lname').textContent = tag;
    li.querySelector('.count').textContent = count;
    li.addEventListener('click', () => selectView(viewKey));
    _attachPinCheckbox(li, viewKey);
    els.tags.appendChild(li);
  }
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.style.color = 'var(--fg-faint)';
    li.style.fontSize = '11px';
    li.style.padding = '4px 14px';
    li.style.lineHeight = '1.4';
    li.style.cursor = 'default';
    li.innerHTML = 'write <code style="color:var(--fg-dim);font-family:var(--mono)">#tag</code> in any task title or notes';
    els.tags.appendChild(li);
  }
}

// ===================================================================
// Habits — sidebar dots (weekly frequency targets; NOT tasks)
// ===================================================================
// Definitions + checks live server-side (habits.json in app-data, see
// lib/app-data.js) so a daily-briefing skill (see examples/skills) can read progress.
// Habits never touch EventKit: no due dates, no overdue red, no iPhone
// noise. Week starts Monday; a check is one LOCAL day. Any past-or-today
// dot in the visible week is clickable (store allows 14 days back), so
// "in bed before 11" can be marked the morning after.
let _habitsData = { habits: [], checks: {}, kinds: {} };

// Rotation suggestion for habits with kinds (gym: push → pull → legs →
// cardio → push …): the kind after the most recent labeled check. A plain
// unlabeled check doesn't advance the rotation.
function _habitNextKind(h) {
  if (!Array.isArray(h.kinds) || !h.kinds.length) return null;
  const km = (_habitsData.kinds || {})[h.id] || {};
  const dates = Object.keys(km).sort();
  if (!dates.length) return h.kinds[0];
  const last = km[dates[dates.length - 1]];
  const i = h.kinds.indexOf(last);
  return h.kinds[(i + 1) % h.kinds.length];
}

function _habitWeekDates() {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return _localYMD(d);
  });
}

function _activeHabits() { return (_habitsData.habits || []).filter(h => !h.archivedAt); }

let _habitsRequest = 0;
async function loadHabits() {
  const request = ++_habitsRequest;
  try { const data = await api.habits(); if (request !== _habitsRequest) return; _habitsData = data; } catch { /* offline → keep last state */ }
  renderHabits();
}

function renderHabits() {
  const ol = document.getElementById('habits');
  const head = document.getElementById('habitsHead');
  if (!ol || !head) return;
  ol.innerHTML = '';
  const habits = _activeHabits();
  head.hidden = habits.length === 0;
  if (!habits.length) return;
  const week = _habitWeekDates();
  const today = _localYMD(new Date());
  for (const h of habits) {
    const checks = new Set(_habitsData.checks[h.id] || []);
    const kindMap = (_habitsData.kinds || {})[h.id] || {};
    const done = week.filter(d => checks.has(d)).length;
    const hit = done >= h.target;
    const li = document.createElement('li');
    // Target reached: the whole row glows gentle green (extra checks still count).
    li.className = 'habit-row' + (hit ? ' hit' : '');

    const top = document.createElement('div');
    top.className = 'habit-top';
    const name = document.createElement('span');
    name.className = 'habit-name';
    name.textContent = h.name;
    name.title = `${h.name} — click for history`;
    name.addEventListener('click', () => openHabitHistory());
    top.appendChild(name);
    // "what's next" hint for rotation habits — the whole point of labeling
    const nextKind = _habitNextKind(h);
    if (nextKind) {
      const nk = document.createElement('span');
      nk.className = 'habit-next';
      nk.textContent = '→ ' + nextKind;
      nk.title = `next up: ${nextKind}`;
      top.appendChild(nk);
    }
    const count = document.createElement('span');
    count.className = 'habit-count' + (hit ? ' hit' : '');
    count.textContent = `${done}/${h.target}`;
    count.title = `${done} of ${h.target} this week`;
    top.appendChild(count);
    li.appendChild(top);

    const dots = document.createElement('div');
    dots.className = 'habit-dots';
    for (const d of week) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'habit-dot' + (checks.has(d) ? ' on' : '') + (d === today ? ' today' : '');
      const future = d > today;
      dot.disabled = future;
      if (!future) {
        const kindLabel = kindMap[d] ? ` ✓ ${kindMap[d]}` : (checks.has(d) ? ' ✓' : '');
        dot.title = `${h.name} — ${d}${kindLabel}`;
      }
      dot.addEventListener('click', (ev) => _habitDotClick(h.id, d, ev));
      dots.appendChild(dot);
    }
    li.appendChild(dots);
    ol.appendChild(li);
  }
}

// ----- habit history — past weeks at a glance, editable -----
// View over the full checks record in habits.json (nothing is ever pruned
// there; every write keeps a one-step .bak). Click a habit's name or ⌘K
// "Habit history". Dots are EDITABLE for past days (check off Sunday on
// Monday, fix a missed week): same toggle + kind-menu path as the sidebar
// strip; the server allows edits back HABIT_CHECK_BACKDAYS (70) days, which
// covers all 8 rendered weeks. Future days stay inert.
const HABIT_HISTORY_WEEKS = 8;

function openHabitHistory() {
  const overlay = document.getElementById('habitHistoryModal');
  if (!overlay || !overlay.classList.contains('hidden')) return;
  _habitKindMenuClose();
  _renderHabitHistory();
  overlay.classList.remove('hidden');
  const close = () => {
    _habitKindMenuClose();
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('mousedown', onBackdrop);
  };
  const onKey = (e) => {
    e.stopPropagation();
    // An open kind menu owns Escape (closes just the menu, not the modal).
    if (_habitKindMenuCleanup) return;
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); close(); }
  };
  const onBackdrop = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', onBackdrop);
}

function _renderHabitHistory() {
  const body = document.getElementById('habitHistoryBody');
  body.replaceChildren();
  const habits = _activeHabits();
  if (!habits.length) {
    const p = document.createElement('p');
    p.className = 'hh-empty';
    p.textContent = 'no habits yet — add one in Settings.';
    body.appendChild(p);
    return;
  }
  const today = _localYMD(new Date());
  // Monday of the current week, then walk back a week at a time.
  const monday0 = new Date();
  monday0.setHours(0, 0, 0, 0);
  monday0.setDate(monday0.getDate() - ((monday0.getDay() + 6) % 7));
  for (const h of habits) {
    const checks = new Set(_habitsData.checks[h.id] || []);
    const kindMap = (_habitsData.kinds || {})[h.id] || {};
    const sec = document.createElement('section');
    sec.className = 'hh-habit';
    const title = document.createElement('h3');
    title.textContent = h.name;
    const tgt = document.createElement('span');
    tgt.className = 'hh-target';
    tgt.textContent = ` ${h.target}×/week`;
    title.appendChild(tgt);
    sec.appendChild(title);
    for (let w = 0; w < HABIT_HISTORY_WEEKS; w++) {
      const monday = new Date(monday0);
      monday.setDate(monday0.getDate() - w * 7);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        return _localYMD(d);
      });
      const done = days.filter(d => checks.has(d)).length;
      // Don't render empty weeks from before the habit existed.
      if (w > 0 && done === 0 && h.createdAt && new Date(h.createdAt) > new Date(days[6] + 'T23:59:59')) continue;
      const row = document.createElement('div');
      row.className = 'hh-week' + (done >= h.target ? ' hit' : '');
      const label = document.createElement('span');
      label.className = 'hh-week-label';
      label.textContent = w === 0 ? 'this week'
        : w === 1 ? 'last week'
        : monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase()
          + ' – ' + new Date(days[6] + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
      row.appendChild(label);
      const dots = document.createElement('span');
      dots.className = 'hh-dots';
      for (const d of days) {
        const future = d > today;
        // Past/today dots are buttons: click toggles the check (kind menu and
        // all), exactly like the sidebar strip. Future dots stay inert spans.
        const dot = document.createElement(future ? 'span' : 'button');
        dot.className = 'hh-dot' + (checks.has(d) ? ' on' : '') + (future ? ' future' : '');
        dot.title = `${d}${kindMap[d] ? ' ✓ ' + kindMap[d] : (checks.has(d) ? ' ✓' : '')}`;
        if (kindMap[d]) {
          dot.classList.add('kind');
          dot.textContent = kindMap[d][0];   // first letter inside the dot
        }
        if (!future) {
          dot.type = 'button';
          dot.setAttribute('aria-label', `${h.name} ${d}${checks.has(d) ? ': checked' : ''}`);
          dot.addEventListener('click', (ev) => _habitDotClick(h.id, d, ev));
        }
        dots.appendChild(dot);
      }
      row.appendChild(dots);
      const count = document.createElement('span');
      count.className = 'hh-count' + (done >= h.target ? ' hit' : '');
      count.textContent = `${done}/${h.target}`;
      row.appendChild(count);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
}

async function _habitDotClick(id, date, ev = null) {
  _habitKindMenuClose();
  const h = _activeHabits().find(x => x.id === id);
  const isChecked = (_habitsData.checks[id] || []).includes(date);
  // Checking a rotation habit asks which kind first (unchecking never does).
  if (h && Array.isArray(h.kinds) && h.kinds.length && !isChecked) {
    _habitKindMenuOpen(h, date, ev);
    return;
  }
  await _habitToggleApply(id, date);
}

async function _habitToggleApply(id, date, kind) {
  ++_habitsRequest;
  const today = _localYMD(new Date());
  try {
    const r = await api.habitToggle(id, date, today, kind);
    const list = _habitsData.checks[id] || (_habitsData.checks[id] = []);
    const i = list.indexOf(date);
    if (r.checked && i < 0) list.push(date);
    if (!r.checked && i >= 0) list.splice(i, 1);
    const km = _habitsData.kinds[id] || (_habitsData.kinds[id] = {});
    if (r.checked && r.kind) km[date] = r.kind;
    else delete km[date];
    renderHabits();
    // Toggles can come from the (editable) history modal — keep it in sync.
    const hh = document.getElementById('habitHistoryModal');
    if (hh && !hh.classList.contains('hidden')) _renderHabitHistory();
    if (r.checked) {
      const h = _activeHabits().find(x => x.id === id);
      const week = new Set(_habitWeekDates());
      const done = (_habitsData.checks[id] || []).filter(d => week.has(d)).length;
      if (h && done === h.target) {
        setStatus(`${h.name}: ${done}/${h.target} — week target hit`);
        try { playCompletionTick(); } catch { /* sound optional */ }
      } else if (r.kind) {
        setStatus(`${r.kind} ✓`);
      }
    }
  } catch (e) { reportError('habit toggle failed', e); }
}

// Tiny chooser next to the clicked dot: the rotation's kinds (suggested one
// first, marked "next") plus a plain unlabeled check. textContent only.
let _habitKindMenuCleanup = null;
function _habitKindMenuClose() {
  if (_habitKindMenuCleanup) { _habitKindMenuCleanup(); _habitKindMenuCleanup = null; }
}
function _habitKindMenuOpen(h, date, ev) {
  const menu = document.createElement('div');
  menu.id = 'habitKindMenu';
  const suggested = _habitNextKind(h);
  const options = [...h.kinds.filter(k => k === suggested), ...h.kinds.filter(k => k !== suggested)];
  for (const k of options) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'habit-kind-row' + (k === suggested ? ' suggested' : '');
    row.textContent = k === suggested ? `${k} · next` : k;
    row.addEventListener('click', () => { _habitKindMenuClose(); _habitToggleApply(h.id, date, k); });
    menu.appendChild(row);
  }
  const plain = document.createElement('button');
  plain.type = 'button';
  plain.className = 'habit-kind-row plain';
  plain.textContent = '✓ no label';
  plain.addEventListener('click', () => { _habitKindMenuClose(); _habitToggleApply(h.id, date); });
  menu.appendChild(plain);
  document.body.appendChild(menu);
  // Position by the clicked dot; keyboard path (⌘K toggle) has no event —
  // it lands near the habit's row in the sidebar.
  const anchor = ev && ev.target ? ev.target.getBoundingClientRect() : null;
  const x = anchor ? Math.min(anchor.left, window.innerWidth - 150) : 16;
  const y = anchor ? anchor.bottom + 6 : window.innerHeight - 200;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  const away = (e) => { if (!menu.contains(e.target)) _habitKindMenuClose(); };
  const esc = (e) => {
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); e.stopPropagation(); _habitKindMenuClose(); }
  };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', esc, true);
  _habitKindMenuCleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', esc, true);
  };
}

// The week strip depends on "today" — re-render occasionally so a window
// left open overnight rolls to the new day/week without a reload.
setInterval(renderHabits, 15 * 60 * 1000);

// ----- writes: optimistic UI, background server call, no full reload -----

function bumpCount(listId, delta) {
  if (!listId) return;
  state.counts[listId] = Math.max(0, (state.counts[listId] || 0) + delta);
  renderLists();
}

// ===================================================================
// Reading list — link dump with auto-titles
// ===================================================================
function _domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return u; }
}

// Dump one or more links (pasted, whitespace/newline separated) into the
// reading list. Each becomes an item named by its domain immediately; the page
// title is fetched in the background and fills in the name.
async function addReadingLinks(raw) {
  // The reading box is a link dump, not a task parser — but priority tokens
  // still work: "https://… !!!" → a P1 reading item.
  const { text, priority } = peelPriority(raw.trim());
  els.quickAdd.value = '';
  els.quickAdd.blur();
  const rl = _readingList();
  if (!rl) { setStatus('no reading list open'); return; }
  const urls = [...new Set(text.match(/https?:\/\/[^\s]+/gi) || [])];
  if (urls.length === 0) {
    // No link — treat the text as a plain reading entry ("finish the Deutsch book").
    setBusy(true);
    try { const payload = { listId: rl.id, name: text, priority: priority || undefined }; const c = await api.addRem(payload); pushUndo({ type: 'add', taskId: c.id, payload }); await refreshAllTasks(); await loadTasks(); bumpCount(rl.id, 1); }
    catch (e) { if (!els.quickAdd.value) els.quickAdd.value = raw; reportError('add failed', e); }
    finally { setBusy(false); }
    return;
  }
  setBusy(true);
  const created = [];
  try {
    for (const u of urls) {
      const c = await api.addRem({ listId: rl.id, name: _domainOf(u), url: u, priority: priority || undefined });
      if (c && c.id) { created.push({ id: c.id, url: u }); pushUndo({ type: 'add', taskId: c.id, payload: { listId: rl.id, name: c.name, url: u, priority } }); }
    }
    await refreshAllTasks();
    await loadTasks();
    bumpCount(rl.id, urls.length);
  } catch (e) {
    if (!els.quickAdd.value) els.quickAdd.value = urls.slice(created.length).join('\n');
    reportError('add failed', e);
  } finally {
    setBusy(false);
  }
  if (created.length > 1) setStatus(`added ${created.length} links; fetching titles…`);
  _fillReadingTitles(created);
}

// A reading item's display name: "Title | Site Name" when we have a
// recognizable publication name (og:site_name), else just the title. The site
// name makes an unfamiliar title placeable ("If You're To Die | Bentham's Bulldog").
function _readingName(r) {
  if (!r) return null;
  const title = (r.title || '').trim();
  if (!title) return null;
  const site = (r.siteName || '').trim();
  if (site && !title.toLowerCase().includes(site.toLowerCase())) return `${title} | ${site}`;
  return title;
}

// Background: fetch each link's title + site name, rename its item, refresh once.
async function _fillReadingTitles(items) {
  if (!items.length) return;
  let any = false;
  await mapLimited(items, 4, async ({ id, url }) => {
    try {
      const name = _readingName(await api.pageTitle(url));
      if (name) { await api.updateRem(id, { name }); any = true; }
    } catch {}
  });
  if (any) { await refreshAllTasks(); if (_isReadingView()) await loadTasks(); }
}

// Re-fetch every reading item's title + site name. Fixes items saved before a
// decoding/site-name improvement and backfills names. (⌘K "Refresh reading titles".)
async function refreshReadingTitles() {
  const rl = _readingList();
  if (!rl) { setStatus('no reading list'); return; }
  const items = state.allTasks.filter(t => t.listId === rl.id && t.url && !t.completed);
  if (!items.length) { setStatus('no reading links to refresh'); return; }
  setStatus(`refreshing ${items.length} title${items.length === 1 ? '' : 's'}…`);
  setBusy(true);
  let n = 0;
  await mapLimited(items, 4, async (t) => {
    try {
      const name = _readingName(await api.pageTitle(t.url));
      if (name && name !== t.name) { await api.updateRem(t.id, { name }); n++; }
    } catch {}
  });
  setBusy(false);
  await refreshAllTasks();
  if (_isReadingView()) await loadTasks();
  setStatus(`refreshed ${n} title${n === 1 ? '' : 's'}`);
}

// Open the reading list, creating a "Reading" list the first time.
async function openReadingList() {
  let rl = _readingList();
  if (!rl) {
    setBusy(true);
    try {
      const created = await api.createList('Reading');
      const id = created && (created.id || (created.list && created.list.id));
      if (id) { try { localStorage.setItem(READING_KEY, id); } catch {} }
      await loadLists();
    } catch (e) { reportError('couldn’t create the reading list', e); setBusy(false); return; }
    setBusy(false);
    rl = _readingList();
  }
  if (rl) {
    if (!state.sortByList[rl.id]) { state.sortByList[rl.id] = 'created'; persist(); }  // newest dumps on top
    selectList(rl.id);
  } else setStatus('couldn’t open the reading list');
}

async function quickAdd() {
  const raw = els.quickAdd.value;
  if (!raw.trim()) return;
  // In the reading list, the add box is a link dump, not a task parser.
  if (_isReadingView()) { await addReadingLinks(raw); return; }
  if (!state.currentListId) {
    setStatus('no list selected — create one with shift+L');
    return;
  }
  const parsed = parseQuickAdd(raw, state.lists, { dateOff: _quickAddDateOff });
  _quickAddDateOff = false;   // per-input flag — never outlives the submit
  if (!parsed.name) {
    setStatus('couldn’t parse a task name (input was all priority/date tokens)');
    return;
  }
  if (parsed.unparsedDate) setStatus(`couldn’t parse "?${parsed.unparsedDate}" as a date — added without one`);

  // View-aware defaults (Todoist behavior): a task added while looking at a
  // day-planning view should land IN that view, not vanish into its list
  // dateless. Explicit tokens always win.
  if (!isListView() && !state.searchQuery) {
    const v = state.view;
    if ((v === 'smart:today' || v === 'smart:important') && !parsed.dueDate) {
      const d = new Date(); d.setHours(18, 0, 0, 0);
      parsed.dueDate = d.toISOString();
    }
    if (v === 'smart:important' && !parsed.priority) parsed.priority = 'high';
    if (v === 'smart:flagged' && !tagsInTask({ name: parsed.name, body: '' }).has('flag')) {
      parsed.name = withTag(parsed.name, 'flag');
    }
    if (v.startsWith('tag:')) {
      const tag = v.slice(4);
      if (!tagsInTask({ name: parsed.name, body: '' }).has(tag.toLowerCase())) {
        parsed.name = `${parsed.name} #${tag}`;
      }
    }
    if (v === 'smart:scheduled' && !parsed.dueDate) {
      setStatus('added without a date — visible in its list, not in Scheduled');
    }
  }

  _diagCrumb('quick-add task');
  els.quickAdd.value = '';
  els.quickAdd.blur();

  // ls:<token> picks a destination list; falls back to the current list if the
  // token didn't match anything (with a status hint so the user knows).
  const targetListId = parsed.listId || state.currentListId;
  if (parsed.listToken && !parsed.listId) {
    setStatus(`ls:${parsed.listToken} didn't match a list — added to current`);
  } else if (parsed.listId && parsed.listId !== state.currentListId) {
    const target = state.lists.find(l => l.id === parsed.listId);
    setStatus(`added to ${target ? target.name : 'list'}`);
  }

  // In smart/tag views (or when adding to a list other than the active one),
  // just write and refresh — no optimistic insert.
  if (!isListView() || targetListId !== state.currentListId) {
    setBusy(true);
    try {
      const created = await api.addRem({
        listId: targetListId,
        name: parsed.name,
        priority: parsed.priority,
        dueDate: parsed.dueDate,
        recurrence: parsed.recurrence,
        url: parsed.url,
      });
      pushUndo({
        type: 'add', taskId: created.id,
        payload: {
          listId: targetListId, name: parsed.name, priority: parsed.priority,
          dueDate: parsed.dueDate, recurrence: parsed.recurrence, url: parsed.url,
        },
      });
      await refreshAllTasks();
      await loadTasks();
      bumpCount(targetListId, +1);
    } catch (e) {
      reportError('add failed', e);
    } finally {
      setBusy(false);
    }
    return;
  }

  // Optimistic insert with a temporary id.
  const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmp = {
    id: tempId,
    name: parsed.name,
    body: '',
    completed: false,
    dueDate: parsed.dueDate || null,
    priority: parsed.priority || 'none',
    url: parsed.url || null,
    listId: targetListId,
    _optimistic: true,
  };
  state.tasks = sortTasks([...state.tasks, tmp]);
  state.selectedIdx = state.tasks.findIndex(t => t.id === tempId);
  bumpCount(targetListId, +1);
  renderTasks();

  setBusy(true);
  try {
    const created = await api.addRem({
      listId: targetListId,
      name: parsed.name,
      priority: parsed.priority,
      dueDate: parsed.dueDate,
      recurrence: parsed.recurrence,
      url: parsed.url,
    });
    pushUndo({
      type: 'add', taskId: created.id,
      payload: {
        listId: targetListId, name: parsed.name, priority: parsed.priority,
        dueDate: parsed.dueDate, recurrence: parsed.recurrence, url: parsed.url,
      },
    });
    // Replace the temp with real id.
    const idx = state.tasks.findIndex(t => t.id === tempId);
    if (idx >= 0) {
      state.tasks[idx] = { ...state.tasks[idx], id: created.id, _optimistic: false };
      if (state.selectedIdx === idx) state.selectedIdx = idx;
      renderTasks();
    }
    _backgroundRefresh();
  } catch (e) {
    // Roll back.
    state.tasks = state.tasks.filter(t => t.id !== tempId);
    bumpCount(targetListId, -1);
    renderTasks();
    reportError('add failed', e);
  } finally {
    setBusy(false);
  }
}

// Completion animation timing. A row plays its check-pop + strike sweep, then
// holds struck-through before it's removed (or refreshed away in smart lists).
// Kept in sync with the `complete-linger` keyframe in style.css.
const COMPLETION_LINGER_MS = 1500;
// Add `.completing` to a row and resolve once the linger has played, so every
// completion path (plain list / smart list / tag / search / pinned panes) gets
// the same animation instead of an instant vanish. Best-effort: a concurrent
// live-sync refresh can re-render the row mid-animation.
function _animateRowCompletion(li) {
  return new Promise((resolve) => {
    if (!li) { resolve(); return; }
    li.classList.add('completing');
    setTimeout(resolve, COMPLETION_LINGER_MS);
  });
}

async function toggleComplete(idx, paneTask = null) {
  const i = idx ?? state.selectedIdx;
  const t = paneTask || state.tasks[i];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;

  // If we're marking complete (not unmarking) and t is a parent with
  // sub-tasks, detach them in place so they don't disappear with the
  // hidden parent. Snapshot lets undo re-indent them.
  let detachSnapshot = null;
  if (!t.completed && _hasChildren(t.id)) {
    detachSnapshot = _detachParent(t.id);
  }
  _diagCrumb(t.completed ? 'reopen task' : 'complete task');
  const undoEntry = { type: 'complete', taskId: t.id, prevCompleted: t.completed, detachSnapshot };
  pushUndo(undoEntry);
  // A failed save must take its undo entry with it — otherwise a later ⌘Z
  // flips a task that never changed.
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
    if (detachSnapshot) _reattachParent(detachSnapshot);
  };
  const marking = !t.completed;   // true = completing, false = un-completing
  if (marking) { playCompletionTick(); Buddy.onTaskCompleted(t.name); }

  if (!isListView() || paneTask) {
    // Smart list / tag / search / pinned pane: these recompute membership on
    // refresh, so a completed task normally leaves the view on the next load.
    // Play the completion animation and let it linger BEFORE that refresh, so it
    // matches a plain list instead of vanishing instantly.
    const animate = marking && (paneTask || !getShowCompleted());
    if (animate) {
      const scope = paneTask ? els.pinnedPanes : els.tasks;
      await _animateRowCompletion(scope.querySelector(`.task[data-id="${CSS.escape(t.id)}"]`));
    }
    setBusy(true);
    try {
      await api.updateRem(t.id, { completed: !t.completed });
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  const wasCompleted = t.completed;
  t.completed = !wasCompleted;
  bumpCount(t.listId || state.currentListId, t.completed ? -1 : +1);

  // Visual confirmation: if we hide completed and we just completed it, animate
  // the row's strikethrough+fill briefly before removing it from the list.
  let completionTimer = null;
  let saveFailed = false;
  if (!getShowCompleted() && t.completed) {
    renderTasks();
    const li = els.tasks.querySelector(`.task[data-id="${CSS.escape(t.id)}"]`);
    if (li) li.classList.add('completing');
    completionTimer = setTimeout(() => {
      completionTimer = null;
      if (saveFailed) return;
      state.tasks = state.tasks.filter(x => x.id !== t.id);
      if (state.selectedIdx >= state.tasks.length) state.selectedIdx = Math.max(0, state.tasks.length - 1);
      renderTasks();
    }, COMPLETION_LINGER_MS);
  } else {
    renderTasks();
  }

  setBusy(true);
  try {
    await api.updateRem(t.id, { completed: !wasCompleted });
    _backgroundRefresh();   // keep pinned panes + tag counts current
  } catch (e) {
    saveFailed = true;
    if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
    t.completed = wasCompleted;
    bumpCount(t.listId || state.currentListId, wasCompleted ? -1 : +1);
    state.tasks = sortTasks([...state.tasks, t].filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i));
    dropUndoEntry();
    renderTasks();
    reportError('save failed', e);
  } finally {
    setBusy(false);
  }
}

async function cyclePriority(paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  const order = ['none', 'high', 'medium', 'low'];
  const next = order[(order.indexOf(t.priority) + 1) % order.length];
  _diagCrumb('priority → ' + next);

  const undoEntry = { type: 'patch', taskId: t.id, prev: { priority: t.priority || 'none' }, next: { priority: next } };
  pushUndo(undoEntry);
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
  };

  // Pane override — route through the api + full refresh (panes have no local
  // selection model to keep in sync).
  if (paneTask) {
    setBusy(true);
    try {
      await api.updateRem(t.id, { priority: next });
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  const prev = t.priority;
  t.priority = next;

  if (isListView()) {
    // Priority-defer (#1): don't re-sort under the cursor. Update the row in
    // place and re-render so it visibly holds its slot; it settles into the new
    // priority order on the next rebuild (the debounced save-echo, or a
    // keyboard move off it) via _settleStickyEdit.
    state._stickyEditId = t.id;
    state._stickyEditView = state.view;
    renderTasks();
    setBusy(true);
    try { await api.updateRem(t.id, { priority: next }); _backgroundRefresh(); }
    catch (e) { t.priority = prev; _clearStickyEdit(); state.tasks = sortTasks(state.tasks); renderTasks(); dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  // Smart-list / tag view (#1): a lowered priority may drop the task from the
  // filter. Hold it in place for the moment — update in place (no refilter),
  // mark it sticky, and patch the cache so the next rebuild (echo/move) sees the
  // new priority. _settleStickyEdit lets it settle/drop on that rebuild.
  state._stickyEditId = t.id;
  state._stickyEditView = state.view;
  const cached = state.allTasks.find(x => x.id === t.id);
  const prevCached = cached ? cached.priority : undefined;
  if (cached) cached.priority = next;
  renderTasks();

  setBusy(true);
  try { await api.updateRem(t.id, { priority: next }); }
  catch (e) {
    t.priority = prev;
    if (cached) cached.priority = prevCached;
    _clearStickyEdit();
    renderTasks();
    dropUndoEntry();
    reportError('save failed', e);
  } finally { setBusy(false); }
}

// Local-date string from a Date — the wire format for all-day due dates.
// Never toISOString().slice: that's the UTC date, off by one for evenings.
function _localYMD(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Bump due date. Behavior:
//   - No due → tomorrow at 18:00
//   - Due more than 1 day in the past (day before yesterday or earlier) → snap
//     to today (preserve time-of-day) so rapid b doesn't keep stepping
//     through ancient dates one day at a time.
//   - Otherwise → +1 calendar day (yesterday→today, today→tomorrow, etc.)
//   - All-day tasks stay all-day: bare YYYY-MM-DD on the wire, no time logic.
// Pushes a dueChange undo entry so ⌘Z reverts (dropped again if the save fails).
async function bumpDue(paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;

  const wasAllDay = !!(t.allDay && t.dueDate);
  let base;
  if (t.dueDate) {
    base = new Date(t.dueDate);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const baseDay = new Date(base); baseDay.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((baseDay - today) / 86400000);
    if (dayDiff < -1) {
      // More than 1 day overdue → snap to today.
      base.setFullYear(today.getFullYear(), today.getMonth(), today.getDate());
    } else {
      base.setDate(base.getDate() + 1);
    }
  } else {
    base = new Date();
    base.setDate(base.getDate() + 1);
  }
  let newDue;     // wire format sent to the daemon
  let localDue;   // optimistic local copy (matches what a daemon read returns)
  if (wasAllDay) {
    newDue = _localYMD(base);
    localDue = new Date(base.getFullYear(), base.getMonth(), base.getDate()).toISOString();
  } else {
    // If the result lands on today, normalize to 18:00 (today's default time)
    // so it renders as just "today" with no time chip and doesn't appear
    // overdue. Other days keep whatever time was already set (or default 9:00
    // for the "no due" → tomorrow path).
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const baseStart = new Date(base); baseStart.setHours(0, 0, 0, 0);
    if (baseStart.getTime() === todayStart.getTime()) {
      base.setHours(18, 0, 0, 0);
    } else if (!t.dueDate) {
      // Time-less task → the shared default due time (Settings), matching
      // quickReschedule and parse.js. Was a hardcoded 9:00.
      const def = getDefaultDueTime();
      base.setHours(def.hours, def.minutes, 0, 0);
    }
    newDue = base.toISOString();
    localDue = newDue;
  }
  // Undo replays these over the wire — an all-day prev must round-trip as a
  // bare date, not as timed local-midnight ISO.
  const prevWire = wasAllDay ? _localYMD(new Date(t.dueDate)) : t.dueDate;
  const undoEntry = { type: 'dueChange', taskId: t.id, prevDue: prevWire, nextDue: newDue };
  pushUndo(undoEntry);
  // A failed save must take its undo entry with it — otherwise a later ⌘Z
  // rewrites a due date that never changed.
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
  };

  if (!isListView() || paneTask) {
    setBusy(true);
    try {
      await api.updateRem(t.id, { dueDate: newDue });
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  const prevLocal = t.dueDate;
  t.dueDate = localDue;
  state.tasks = sortTasks(state.tasks);
  state.selectedIdx = state.tasks.findIndex(x => x.id === t.id);
  renderTasks();

  setBusy(true);
  try { await api.updateRem(t.id, { dueDate: newDue }); _backgroundRefresh(); }
  catch (e) { t.dueDate = prevLocal; renderTasks(); dropUndoEntry(); reportError('save failed', e); }
  finally { setBusy(false); }
}

// Quick reschedule presets — `w` (weekend), ⇧B (back a day), the detail
// strip's date chips' keyboard siblings, and the ⌘K "Due: …" commands
// Mirrors
// bumpDue's undo entry and its two save paths exactly.
// kind: 'today' | 'tomorrow' | 'weekend' | 'next-week' | 'back-day' | 'clear'
async function quickReschedule(kind, paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;

  const wasAllDay = !!(t.allDay && t.dueDate);
  let newDue, localDue;
  if (kind === 'clear') {
    if (!t.dueDate) { setStatus('no due date to clear'); return; }
    newDue = null; localDue = null;
  } else if (kind === 'back-day' && !t.dueDate) {
    setStatus('no due date to nudge back'); return;
  } else {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    if (kind === 'tomorrow') day.setDate(day.getDate() + 1);
    else if (kind === 'next-week') day.setDate(day.getDate() + 7);
    else if (kind === 'weekend') {
      // Same rule as parse.js "this weekend": upcoming Saturday, incl. today.
      let diff = 6 - day.getDay(); if (diff < 0) diff += 7;
      day.setDate(day.getDate() + diff);
    } else if (kind === 'back-day') {
      const b = new Date(t.dueDate);
      day.setFullYear(b.getFullYear(), b.getMonth(), b.getDate() - 1);
    }
    const base = new Date(day);
    if (wasAllDay) {
      newDue = _localYMD(base);
      localDue = new Date(base.getFullYear(), base.getMonth(), base.getDate()).toISOString();
    } else {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (base.getTime() === todayStart.getTime()) {
        // Landing on today always normalizes to 18:00 (same rule as `b`) so
        // the task renders as plain "today", never instantly overdue.
        base.setHours(18, 0, 0, 0);
      } else if (t.dueDate) {
        const prev = new Date(t.dueDate);
        base.setHours(prev.getHours(), prev.getMinutes(), 0, 0);   // keep the task's own clock
      } else {
        // Time-less task: the shared default due time (Settings), like parse.js.
        const m = /^(\d{2}):(\d{2})$/.exec(_sharedSettings.defaultDueTime || '');
        base.setHours(m ? Number(m[1]) : 9, m ? Number(m[2]) : 0, 0, 0);
      }
      newDue = base.toISOString();
      localDue = newDue;
    }
  }

  const prevWire = t.dueDate ? (wasAllDay ? _localYMD(new Date(t.dueDate)) : t.dueDate) : null;
  const undoEntry = { type: 'dueChange', taskId: t.id, prevDue: prevWire, nextDue: newDue };
  pushUndo(undoEntry);
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
  };

  if (!isListView() || paneTask) {
    setBusy(true);
    try {
      await api.updateRem(t.id, { dueDate: newDue });
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  const prevLocal = t.dueDate;
  t.dueDate = localDue;
  state.tasks = sortTasks(state.tasks);
  state.selectedIdx = state.tasks.findIndex(x => x.id === t.id);
  renderTasks();
  setBusy(true);
  try { await api.updateRem(t.id, { dueDate: newDue }); _backgroundRefresh(); }
  catch (e) { t.dueDate = prevLocal; renderTasks(); dropUndoEntry(); reportError('save failed', e); }
  finally { setBusy(false); }
}

// Reschedule every open overdue task to today in one shot (the canonical
// Monday-morning rescue). Timed tasks land at 18:00 (the "today" default,
// matching b's snap-to-today); all-day tasks stay all-day. One bulkPatch
// undo entry reverts the whole batch.
async function rescheduleAllOverdue() {
  if (state.allTasks.length === 0) await refreshAllTasks().catch(() => {});
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const overdue = state.allTasks.filter(t =>
    !t.completed && t.dueDate && new Date(t.dueDate) < today0);
  if (overdue.length === 0) { setStatus('nothing overdue — clean slate'); return; }

  const todayBare = _localYMD(new Date());
  const today18 = new Date(); today18.setHours(18, 0, 0, 0);
  const items = overdue.map(t => ({
    taskId: t.id,
    prev: { dueDate: t.allDay ? _localYMD(new Date(t.dueDate)) : t.dueDate },
    next: { dueDate: t.allDay ? todayBare : today18.toISOString() },
  }));
  const undoEntry = { type: 'bulkPatch', items };
  pushUndo(undoEntry);

  setBusy(true);
  let failed = 0;
  try {
    for (const it of items) {
      try { await api.updateRem(it.taskId, it.next); } catch { failed++; }
    }
    await refreshAllTasks();
    await loadTasks();
  } finally { setBusy(false); }
  if (failed === items.length) {
    // Nothing actually changed — don't leave a no-op undo entry behind.
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
    reportError('reschedule failed', new Error('no overdue task could be updated'));
    return;
  }
  setStatus(failed
    ? `rescheduled ${items.length - failed} overdue → today (${failed} failed)`
    : `rescheduled ${items.length} overdue → today — ⌘Z undoes all`);
}

// ----- snooze -----
// Rest the selected task (dimmed, bottom of every sort, hidden from Today /
// Important) until a chosen day. Local-only — like sections, snooze never
// touches EventKit, so iPhone/MCP still see the task unchanged.
async function snoozePrompt(paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  const cur = state.snoozeMap[t.id];
  const value = await openPrompt(
    cur ? `snoozed — new day, or empty to wake "${displayNameNoTags(t)}"`
        : `snooze "${displayNameNoTags(t)}" until (tomorrow · sat · next week · may 3)`,
    ''
  );
  if (value === null) return;
  const v = value.trim();
  if (!v) {
    if (cur) {
      _diagCrumb('snooze cleared');
      pushUndo({ type: 'snooze', taskId: t.id, prevUntil: cur, nextUntil: null });
      delete state.snoozeMap[t.id];
      persistSnooze();
      setStatus('woken up');
      await loadTasks();
      renderPinnedPanes();
    }
    return;
  }
  const d = parseDateExpression(v.replace(/^\?/, '')) || parseDateToken(v.toLowerCase());
  if (!d) { setStatus(`couldn’t parse "${v}" as a date`); return; }
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (day <= today) { setStatus('snooze needs a future day'); return; }
  _diagCrumb('snooze set');
  const nextUntil = day.toISOString();
  pushUndo({ type: 'snooze', taskId: t.id, prevUntil: cur || null, nextUntil });
  state.snoozeMap[t.id] = nextUntil;
  persistSnooze();
  setStatus(`snoozed until ${(formatDue(d.toISOString()) || {}).label || v}`);
  Buddy.onSnoozed();
  await loadTasks();
  renderPinnedPanes();
}

// ===================================================================
// Plan your day — one-at-a-time triage of overdue + today (item 21)
// ===================================================================
// ⌘K "Plan your day". Design rules (borrowed from Sunsama-style daily planning):
// NO separate plan object — every action writes the REAL task through the
// existing verbs (complete / quickReschedule / snooze) so the views and the
// briefing can never disagree; optional and skippable, never a gate; ends
// with an explicit finish screen; after ~3pm it nudges toward tomorrow.
let _triage = null;   // { queue: [{t, acted, bucket, undoEntry}], idx, counts, finished, busy, closeFn }

// Record an action on the current item. Re-acting on an item you stepped BACK
// to (k) must not tally twice, so the previous action's count is reversed
// first — the summary used to overcount every revisited task.
function _triageMark(cur, acted, bucket) {
  const s = _triage;
  if (!s || !cur) return;
  if (cur.bucket) s.counts[cur.bucket]--;
  cur.acted = acted;
  cur.bucket = bucket;
  s.counts[bucket]++;
}

function _triageClearMark(cur) {
  const s = _triage;
  if (!s || !cur) return;
  if (cur.bucket) s.counts[cur.bucket] = Math.max(0, s.counts[cur.bucket] - 1);
  cur.acted = null;
  cur.bucket = null;
  cur.undoEntry = null;
}

function _triageAdvance() {
  const s = _triage;
  if (!s) return;
  s.idx++;
  if (s.idx >= s.queue.length) s.finished = true;
}

// Run one real mutation and bind the exact undo entry it created to this card.
// The modal is locked while it saves, so fast repeated keys cannot make the
// global undo stack and the visible card drift apart.
async function _triageApplyMutation(cur, acted, bucket, mutate) {
  const s = _triage;
  if (!s || s.busy || !cur) return false;
  const beforeTop = undoStack[undoStack.length - 1] || null;
  s.busy = true;
  _renderTriage();
  try {
    await mutate();
    const entry = undoStack[undoStack.length - 1] || null;
    // Existing mutation helpers remove their entry when a save fails.
    if (!entry || entry === beforeTop || entry.taskId !== cur.t.id) return false;
    cur.undoEntry = entry;
    _triageMark(cur, acted, bucket);
    _triageAdvance();
    return true;
  } finally {
    if (_triage === s) {
      s.busy = false;
      _renderTriage();
    }
  }
}

async function _triageBack() {
  const s = _triage;
  if (!s || s.busy || s.idx <= 0) return;
  const targetIdx = s.idx - 1;
  const prev = s.queue[targetIdx];
  const action = prev.undoEntry;

  // "Kept today" and skipped cards made no mutation; just clear their tally
  // and revisit them. Every mutating action must own the current top entry.
  if (!action) {
    if (prev.acted && prev.acted !== 'kept') {
      reportError('could not go back', new Error('the matching undo action is unavailable'));
      return;
    }
    _triageClearMark(prev);
    s.idx = targetIdx;
    s.finished = false;
    _renderTriage();
    return;
  }
  if (undoStack[undoStack.length - 1] !== action) {
    reportError('could not go back', new Error('a newer action must be undone first'));
    return;
  }

  s.busy = true;
  _renderTriage();
  undoStack.pop();
  try {
    setBusy(true);
    await _applyAction(action, 'undo');
    await refreshAllTasks();
    await loadTasks();
    _triageClearMark(prev);
    s.idx = targetIdx;
    s.finished = false;
    setStatus('previous plan action undone');
  } catch (e) {
    undoStack.push(action);
    reportError('could not go back', e);
  } finally {
    setBusy(false);
    if (_triage === s) {
      s.busy = false;
      _renderTriage();
    }
  }
}

function _triageQueue() {
  const rlId = (_readingList() || {}).id;
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  return state.allTasks
    .filter(t => !t.completed && t.dueDate && !_isSnoozed(t) && t.listId !== rlId
      && new Date(t.dueDate) <= todayEnd)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))   // most overdue first
    .map(t => ({ t, acted: null, bucket: null, undoEntry: null }));
}

async function openTriage() {
  if (_triage) return;
  if (_isPaletteOpen()) closePalette();
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  // Always refresh first: the queue is a snapshot, and triaging yesterday's
  // stale picture would be worse than a one-second wait.
  try { await refreshAllTasks(); } catch { /* offline — triage what we have */ }
  const overlay = document.getElementById('triageModal');
  _triage = {
    queue: _triageQueue(),
    idx: 0,
    counts: { done: 0, rescheduled: 0, kept: 0, snoozed: 0 },
    finished: false,
    busy: false,
  };
  if (!_triage.queue.length) _triage.finished = true;
  _diagCrumb('triage opened');

  const onKey = async (e) => {
    const s = _triage;
    if (!s) return;
    // Modified combos are not ours — let ⌘W/⌘Q etc. reach the native key
    // equivalents (same bail as the global handler's meta block).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (s.busy) { e.preventDefault(); e.stopPropagation(); return; }
    // The pick-a-date input owns its keys (Enter commits, Esc closes just it).
    if (e.target && e.target.id === 'triageDate') {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); await _triageDateCommit(); }
      else if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); _renderTriage(); }
      return;
    }
    e.stopPropagation();   // modal traps keys — nothing may steer the list behind it
    if (e.key === 'Escape' || e.key === '`') {
      e.preventDefault();
      if (s.finished) s.closeFn();
      else { s.finished = true; _renderTriage(); }   // Esc = finish early, summary first
      return;
    }
    if (s.finished) {
      if (e.key === 'Enter') { e.preventDefault(); s.closeFn(); }
      else if (e.key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); await _triageBack(); }
      return;
    }
    const cur = s.queue[s.idx];
    const advance = () => { _triageAdvance(); _renderTriage(); };
    switch (e.key) {
      case ' ': case 'j': case 'ArrowRight':
        e.preventDefault(); advance(); break;
      case 'k': case 'ArrowLeft':
        e.preventDefault(); await _triageBack(); break;
      case 'e':
        e.preventDefault();
        await _triageApplyMutation(cur, 'done', 'done', () => toggleComplete(null, cur.t));
        break;
      case 't': {
        e.preventDefault();
        // A task already due today just stays — never rewrite its clock.
        const isToday = _localYMD(new Date(cur.t.dueDate)) === _localYMD(new Date());
        if (isToday) {
          _triageMark(cur, 'kept', 'kept');
          _triageAdvance();
          _renderTriage();
        } else {
          await _triageApplyMutation(cur, 'today', 'rescheduled', () => quickReschedule('today', cur.t));
        }
        break;
      }
      case 'm':
        e.preventDefault();
        await _triageApplyMutation(cur, 'tomorrow', 'rescheduled', () => quickReschedule('tomorrow', cur.t));
        break;
      case 'w':
        e.preventDefault();
        await _triageApplyMutation(cur, 'weekend', 'rescheduled', () => quickReschedule('weekend', cur.t));
        break;
      case 'x':
        e.preventDefault();
        await _triageApplyMutation(cur, 'next week', 'rescheduled', () => quickReschedule('next-week', cur.t));
        break;
      case 'd':
        e.preventDefault(); _triageDateInput(); break;
      case 'z': {
        e.preventDefault();
        const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + 1);
        const nextUntil = day.toISOString();
        await _triageApplyMutation(cur, 'snoozed', 'snoozed', async () => {
          const entry = {
            type: 'snooze',
            taskId: cur.t.id,
            prevUntil: state.snoozeMap[cur.t.id] || null,
            nextUntil,
          };
          pushUndo(entry);
          state.snoozeMap[cur.t.id] = nextUntil;
          persistSnooze();
          Buddy.onSnoozed();
          await loadTasks();
          renderPinnedPanes();
        });
        break;
      }
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) e.preventDefault();   // no system beep
    }
  };
  const onBackdrop = (e) => { if (e.target === overlay && _triage) _triage.closeFn(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', onBackdrop);
  _triage.closeFn = () => {
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('mousedown', onBackdrop);
    _triage = null;
  };
  overlay.classList.remove('hidden');
  _renderTriage();
}

function _renderTriage() {
  const s = _triage;
  if (!s) return;
  const sub = document.getElementById('triageSub');
  const body = document.getElementById('triageBody');
  const hint = document.getElementById('triageHint');
  body.replaceChildren();

  if (s.finished) {
    const skipped = s.queue.filter(q => !q.acted).length;
    const today = _localYMD(new Date());
    const rlId = (_readingList() || {}).id;
    const onToday = state.allTasks.filter(t => !t.completed && t.dueDate && !_isSnoozed(t)
      && t.listId !== rlId && _localYMD(new Date(t.dueDate)) <= today).length;
    sub.textContent = s.queue.length
      ? `that's your day — ${onToday} task${onToday === 1 ? '' : 's'} on today`
      : 'nothing overdue or due today — clean slate';
    const ul = document.createElement('ul');
    ul.className = 'triage-summary';
    const rows = [
      [s.counts.done, 'completed'],
      [s.counts.kept, 'kept on today'],
      [s.counts.rescheduled, 'rescheduled'],
      [s.counts.snoozed, 'snoozed'],
      [skipped, 'left as they were'],
    ];
    for (const [n, label] of rows) {
      if (!n) continue;
      const li = document.createElement('li');
      li.textContent = `${n} ${label}`;
      ul.appendChild(li);
    }
    if (ul.children.length) body.appendChild(ul);
    hint.textContent = 'esc / ⏎ close';
    return;
  }

  const { t, acted } = s.queue[s.idx];
  const afterThree = new Date().getHours() >= 15;
  sub.textContent = `${s.idx + 1} of ${s.queue.length}`
    + (afterThree ? ' · late in the day — consider sending what’s left to tomorrow (m)' : '');

  const name = document.createElement('div');
  name.className = 'triage-name';
  name.textContent = displayNameNoTags(t);
  body.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'triage-meta';
  const bits = [];
  const listName = (state.lists.find(l => l.id === t.listId) || {}).name;
  if (listName) bits.push(listName);
  const due = formatDue(t.dueDate);
  if (due && due.label) bits.push(due.label);
  if (t.priority && t.priority !== 'none') {
    bits.push(t.priority === 'high' ? 'P1' : t.priority === 'medium' ? 'P2' : 'P3');
  }
  meta.textContent = bits.join(' · ');
  if (due && due.cls === 'overdue') meta.classList.add('overdue');
  body.appendChild(meta);

  if (acted) {
    const badge = document.createElement('div');
    badge.className = 'triage-acted';
    badge.textContent = `✓ ${acted}`;
    body.appendChild(badge);
  }

  hint.textContent = s.busy
    ? 'saving…'
    : 'e done · t today · m tomorrow · w weekend · x next week · d date… · z snooze · space skip · k back · esc finish';
}

// `d` — type any date ("friday", "may 3", "in 2 weeks"); the quick-add parser
// does the reading. Esc backs out to the keys, Enter applies.
function _triageDateInput() {
  const body = document.getElementById('triageBody');
  if (document.getElementById('triageDate')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'triageDate';
  input.placeholder = 'due when? (friday · may 3 · in 2 weeks)';
  body.appendChild(input);
  input.focus();
}

async function _triageDateCommit() {
  const s = _triage;
  const input = document.getElementById('triageDate');
  if (!s || s.finished || s.busy || !input) return;
  const v = input.value.trim();
  if (!v) { _renderTriage(); return; }
  const d = parseDateExpression(v.replace(/^\?/, '')) || parseDateToken(v.toLowerCase());
  if (!d) { setStatus(`couldn’t parse "${v}" as a date`); input.select(); return; }
  const cur = s.queue[s.idx];
  const t = cur.t;
  const newDue = (t.allDay && t.dueDate) ? _localYMD(d) : d.toISOString();
  const prevWire = t.dueDate ? ((t.allDay && t.dueDate) ? _localYMD(new Date(t.dueDate)) : t.dueDate) : null;
  const undoEntry = { type: 'dueChange', taskId: t.id, prevDue: prevWire, nextDue: newDue };
  s.busy = true;
  input.disabled = true;
  pushUndo(undoEntry);
  try {
    await api.updateRem(t.id, { dueDate: newDue });
    await refreshAllTasks();
    await loadTasks();
    cur.undoEntry = undoEntry;
    _triageMark(cur, (formatDue(d.toISOString()) || {}).label || 'rescheduled', 'rescheduled');
    _triageAdvance();
  } catch (e) {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
    reportError('save failed', e);
  } finally {
    if (_triage === s) {
      s.busy = false;
      _renderTriage();
    }
  }
}

// ----- sections -----
async function toggleSectionCollapse(name) {
  const lid = state.currentListId;
  if (!lid) return;
  if (!state.collapsedSections[lid]) state.collapsedSections[lid] = {};
  state.collapsedSections[lid][name] = !state.collapsedSections[lid][name];
  persistSections();
  // Re-fetch from server: the previous render had pruned children of the
  // collapsed section; re-flattening from state.tasks would lose them entirely.
  await loadTasks();
}

async function setSection(targetSection) {
  if (!isListView()) { setStatus('sections only work in a list view'); return; }
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) {
    setStatus('select a task first (j/k to move), then ⇧S to assign a section');
    return;
  }
  let trimmed;
  if (typeof targetSection === 'string') {
    trimmed = targetSection.trim();
  } else {
    const cur = state.taskSectionMap[t.id] || '';
    const value = await openPrompt(`section for "${t.name}" (empty to clear)`, cur);
    if (value === null) return;
    trimmed = value.trim();
  }
  if (trimmed) state.taskSectionMap[t.id] = trimmed;
  else delete state.taskSectionMap[t.id];
  persistSections();
  await loadTasks();
  setStatus(trimmed ? `section: ${trimmed}` : 'section cleared');
}

async function toggleFlag(paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  const flagged = isFlagged(t);
  const newName = flagged ? withoutTag(t.name, 'flag') : withTag(t.name, 'flag');

  const undoEntry = { type: 'patch', taskId: t.id, prev: { name: t.name }, next: { name: newName } };
  pushUndo(undoEntry);
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
  };

  if (!isListView() || paneTask) {
    setBusy(true);
    try {
      await api.updateRem(t.id, { name: newName });
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('save failed', e); }
    finally { setBusy(false); }
    return;
  }

  const prev = t.name;
  t.name = newName;
  state.tasks = sortTasks(state.tasks);
  state.selectedIdx = state.tasks.findIndex(x => x.id === t.id);
  renderTasks();

  setBusy(true);
  try { await api.updateRem(t.id, { name: newName }); _backgroundRefresh(); }
  catch (e) { t.name = prev; renderTasks(); dropUndoEntry(); reportError('save failed', e); }
  finally { setBusy(false); }
}

// Undo + redo stacks. Each action records enough state to flip in either
// direction. ⌘Z pops from undo; ⌘⇧Z pops from redo. A new user action
// invalidates redo history (standard undo-tree behavior).
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 20;
function pushUndo(action) {
  undoStack.push(action);
  while (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function _remapTaskId(oldId, newId, currentAction) {
  if (!oldId || oldId === newId) return;
  for (const action of [...undoStack, ...redoStack, currentAction]) remapAction(action, oldId, newId);
  for (const map of [state.parentMap, state.taskSectionMap, state.collapsedParents, state.snoozeMap]) {
    if (Object.hasOwn(map, oldId)) { map[newId] = map[oldId]; delete map[oldId]; }
  }
  for (const [child, parent] of Object.entries(state.parentMap)) if (parent === oldId) state.parentMap[child] = newId;
  if (state.orderByGroup[oldId]) { state.orderByGroup[newId] = state.orderByGroup[oldId]; delete state.orderByGroup[oldId]; }
  for (const [key, ids] of Object.entries(state.orderByGroup)) state.orderByGroup[key] = ids.map(id => id === oldId ? newId : id);
  for (const groups of Object.values(state.tieOrder)) for (const [key, ids] of Object.entries(groups)) groups[key] = ids.map(id => id === oldId ? newId : id);
  if (state.ingestedParents.delete(oldId)) state.ingestedParents.add(newId);
  persistParentMap(); persistSections(); persistOrder(); persistTieOrder(); persistSnooze(); persistIngested();
  try { localStorage.setItem(CP_KEY, JSON.stringify(state.collapsedParents)); } catch {}
}

// Apply an action in one direction. `dir` is 'undo' (revert) or 'redo' (apply).
// For delete: undo recreates the task; redo deletes it again (using the
// remapped id, since recreate assigns a new EKReminder id).
async function _applyAction(action, dir) {
  if (action.type === 'delete') {
    if (dir === 'undo') {
      const t = action.task;
      // Prefer the SERVER's restore path (restoreFromTrash): it is the one
      // implementation that puts an all-day task back as a bare YYYY-MM-DD
      // instead of timed-midnight, restores `completed`, and re-homes the task
      // when its list is gone. This used to be a second, lossier addRem here —
      // two restore implementations that disagreed. Fall back to the manual
      // re-create only when there's no trash entry (a delete that predates the
      // trash, or a trash write that was rolled back).
      let created = null;
      if (action.trashId) {
        try {
          const r = await api.trashRestore(action.trashId);
          created = r && r.restored;
          action.trashId = null;   // consumed — restore removes the entry
        } catch (e) {
          // A missing/expired entry is the only safe reason to fall back to a
          // manual re-create. Falling through on a daemon/network failure can
          // duplicate a task whose restore actually succeeded.
          if (!(e.status === 400 && e.detail === 'trash item not found or expired')) throw e;
        }
      }
      if (!created) {
        created = await api.addRem({
          listId: t.listId,
          name: t.name,
          body: t.body,
          priority: t.priority,
          // All-day tasks go back as a bare local date, never timed-midnight.
          dueDate: (t.allDay && t.dueDate) ? _localYMD(new Date(t.dueDate)) : t.dueDate,
          url: t.url,
          recurrence: Array.isArray(t.recurrenceRules) ? undefined : t.recurrence,
          recurrenceRules: t.recurrenceRules,
          completed: !!t.completed, completionDate: t.completionDate,
          alarms: t.alarms,
        });

      }
      // Restore parent / section first.
      if (action.parent)  state.parentMap[created.id] = action.parent;
      if (action.section) state.taskSectionMap[created.id] = action.section;
      persistParentMap(); persistSections();
      // If the task had sub-tasks, re-attach them under the new id (and
      // pop the children back out of the parent's group).
      if (action.detachSnapshot) {
        _reattachParent(action.detachSnapshot, created.id);
      } else if (action.orderGroupKey && Array.isArray(action.orderSiblingIds)) {
        // Plain leaf-task delete: just splice the new id back into its group.
        const ids = action.orderSiblingIds.slice();
        const pos = Math.min(action.orderPos ?? ids.length, ids.length);
        ids.splice(pos, 0, created.id);
        state.orderByGroup[action.orderGroupKey] = ids;
        persistOrder();
      }
      _remapTaskId(action.taskId, created.id, action);
      action.taskId = created.id;
      // Fallback path only (the trashRestore branch already consumed the
      // entry): the task is back, so purge its now-stale trash entry or a
      // later "restore" from the bin would duplicate it. Best-effort.
      if (action.trashId) {
        try { await api.trashPurge(action.trashId); } catch { /* bin prunes itself */ }
        action.trashId = null;
      }
      setStatus(`undeleted "${displayName(t)}"`);
    } else {
      // Redo: detach again first (children might have been rearranged
      // during the un-deleted period — re-snapshot fresh state).
      if (_hasChildren(action.taskId)) {
        action.detachSnapshot = _detachParent(action.taskId);
      }
      const r = await api.deleteRem(action.taskId);
      if (r && r.trashId) action.trashId = r.trashId;
      _purgeTaskLocalRefs(action.taskId);
      setStatus('redo: deleted again');
    }
  } else if (action.type === 'complete') {
    const target = dir === 'undo' ? action.prevCompleted : !action.prevCompleted;
    await api.updateRem(action.taskId, { completed: target });
    // If we de-indented children when marking complete, mirror that on
    // undo (re-indent) and redo (de-indent again).
    if (action.detachSnapshot && dir === 'undo' && target === false) {
      _reattachParent(action.detachSnapshot);
    } else if (dir === 'redo' && target === true) {
      // Re-snapshot in case children changed while uncompleted.
      if (_hasChildren(action.taskId)) {
        action.detachSnapshot = _detachParent(action.taskId);
      }
    }
    setStatus(target ? 'marked done' : 'unmarked done');
  } else if (action.type === 'dueChange') {
    const target = dir === 'undo' ? action.prevDue : action.nextDue;
    await api.updateRem(action.taskId, { dueDate: target });
    setStatus(dir === 'undo' ? 'due restored' : 'due re-bumped');
  } else if (action.type === 'snooze') {
    const target = dir === 'undo' ? action.prevUntil : action.nextUntil;
    if (target) state.snoozeMap[action.taskId] = target;
    else delete state.snoozeMap[action.taskId];
    persistSnooze();
    setStatus(target ? 'snooze restored' : 'snooze removed');
  } else if (action.type === 'patch') {
    // Generic field patch (smart-list drops): prev/next are updateRem bodies.
    await api.updateRem(action.taskId, dir === 'undo' ? action.prev : action.next);
    setStatus(dir === 'undo' ? 'change undone' : 'change redone');
  } else if (action.type === 'add') {
    // Task creation (quick-add / inline add / subtask add). Undo deletes the
    // created task (recoverable via trash); redo re-creates it (new EventKit
    // id, remapped like delete-undo). Previously adds never
    // pushed undo entries, so ⌘Z reached past them to older actions.
    if (dir === 'undo') {
      const r = await api.deleteRem(action.taskId);
      if (r && r.trashId) action.trashId = r.trashId;
      _purgeTaskLocalRefs(action.taskId);
      setStatus('undid add');
    } else {
      const created = action.trashId
        ? (await api.trashRestore(action.trashId)).restored
        : await api.addRem(action.payload);
      action.trashId = null;
      if (action.parent) {
        state.parentMap[created.id] = action.parent;
        persistParentMap();
      }
      _remapTaskId(action.taskId, created.id, action);
      action.taskId = created.id;
      // Same duplicate guard as delete-undo: the task exists again, so its
      // trash entry from the undo is stale.
      if (action.trashId) {
        try { await api.trashPurge(action.trashId); } catch { /* bin prunes itself */ }
        action.trashId = null;
      }
      setStatus('redo: added again');
    }
  } else if (action.type === 'bulkPatch') {
    // One entry covering N tasks (reschedule-all-overdue). Best-effort: a
    // task deleted in the meantime shouldn't block the rest of the undo.
    let failed = 0;
    for (const it of action.items) {
      try { await api.updateRem(it.taskId, dir === 'undo' ? it.prev : it.next); }
      catch { failed++; }
    }
    const n = action.items.length - failed;
    setStatus(`${dir === 'undo' ? 'undid' : 'redid'} ${n} change${n === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`);
  }
}

let _undoBusy = false;
async function performUndo() {
  if (_undoBusy) return;
  const action = undoStack.pop();
  if (!action) { setStatus('nothing to undo'); return; }
  _undoBusy = true;
  _diagCrumb('undo → ' + (action.type || '?'));
  try {
    setBusy(true);
    await _applyAction(action, 'undo');
    redoStack.push(action);
    await refreshAllTasks();
    await loadTasks();
  } catch (e) {
    if (!redoStack.includes(action)) undoStack.push(action);
    reportError('undo failed', e);
  } finally { _undoBusy = false; setBusy(false); }
}

async function performRedo() {
  if (_undoBusy) return;
  const action = redoStack.pop();
  if (!action) { setStatus('nothing to redo'); return; }
  _undoBusy = true;
  _diagCrumb('redo → ' + (action.type || '?'));
  try {
    setBusy(true);
    await _applyAction(action, 'redo');
    undoStack.push(action);
    await refreshAllTasks();
    await loadTasks();
  } catch (e) {
    if (!undoStack.includes(action)) redoStack.push(action);
    reportError('redo failed', e);
  } finally { _undoBusy = false; setBusy(false); }
}

// Remove any localStorage references to a deleted task id (sections, parent map, sibling order).
// Detach a parent task from its sub-tasks: children become top-level (or
// promoted to grandparent if there is one) and are inserted at the parent's
// old position in its own group, so they "stay in place" visually under
// manual ordering. Returns a snapshot used by _reattachParent for undo.
//
// Used when deleting a parent (the parent goes away entirely) or when
// marking a parent complete (the parent is hidden from the active view).
function _detachParent(taskId) {
  const groupKey = state.parentMap[taskId] || ('list:' + state.currentListId);
  const grandparent = state.parentMap[taskId] || null;
  const groupIds = (state.orderByGroup[groupKey] || []).slice();
  const parentPos = groupIds.indexOf(taskId);

  // Find children: scan parentMap for entries pointing at taskId.
  const childIds = [];
  for (const [c, p] of Object.entries(state.parentMap)) {
    if (p === taskId) childIds.push(c);
  }

  // Preserve the children's existing intra-parent order if we have one;
  // otherwise fall back to the scan order.
  const childOrderInParent = (state.orderByGroup[taskId] || []).slice();
  const orderedChildIds = childOrderInParent.length
    ? [...childOrderInParent.filter(c => childIds.includes(c)),
       ...childIds.filter(c => !childOrderInParent.includes(c))]
    : childIds.slice();

  const snapshot = {
    taskId,
    groupKey,
    parentPos,
    grandparent,
    orderedChildIds,
    childOrderInParent,
  };

  // De-indent children: drop their parent association. (If a grandparent
  // exists, we still drop it — keeping them at parent's old depth would
  // require deeper restructuring; flat de-indent matches the user's
  // request.)
  for (const c of childIds) delete state.parentMap[c];

  // Replace parent in its group with the children.
  if (parentPos >= 0) {
    groupIds.splice(parentPos, 1, ...orderedChildIds);
    state.orderByGroup[groupKey] = groupIds;
  } else if (orderedChildIds.length) {
    // Parent wasn't tracked in orderByGroup — append children to the end.
    state.orderByGroup[groupKey] = [...groupIds, ...orderedChildIds];
  }
  // The parent's child group is no longer relevant (parent is gone/hidden).
  delete state.orderByGroup[taskId];

  persistParentMap();
  persistOrder();
  return snapshot;
}

// Reverse of _detachParent. taskId in the snapshot may be remapped to a
// new id (e.g. after a delete-undo creates a new EKReminder).
function _reattachParent(snapshot, remappedTaskId) {
  const taskId = remappedTaskId || snapshot.taskId;
  // Remove children from the parent's group.
  const groupIds = (state.orderByGroup[snapshot.groupKey] || []).slice();
  for (const c of snapshot.orderedChildIds) {
    const i = groupIds.indexOf(c);
    if (i >= 0) groupIds.splice(i, 1);
  }
  // Re-insert parent at its old position.
  const pos = Math.max(0, Math.min(snapshot.parentPos, groupIds.length));
  groupIds.splice(pos, 0, taskId);
  state.orderByGroup[snapshot.groupKey] = groupIds;

  // Restore children's parent associations. Cycle guard: if a child became
  // an ancestor of the (re-created) parent during the detached period, naively
  // restoring the link would create a parentMap cycle and hide the subtree.
  for (const c of snapshot.orderedChildIds) {
    if (c !== taskId && !_createsCycle(c, taskId)) state.parentMap[c] = taskId;
  }

  // Restore intra-parent order if there was one.
  if (snapshot.childOrderInParent.length) {
    state.orderByGroup[taskId] = snapshot.childOrderInParent.slice();
  }

  persistParentMap();
  persistOrder();
}

function _hasChildren(taskId) {
  for (const p of Object.values(state.parentMap)) if (p === taskId) return true;
  return false;
}

// Drop an id from every orderByGroup sibling list (also used by addInline's
// cancel path so abandoned tmp_ ids don't persist forever).
function _removeFromOrderGroups(id) {
  let dirty = false;
  for (const k of Object.keys(state.orderByGroup)) {
    const list = state.orderByGroup[k];
    const i = list.indexOf(id);
    if (i >= 0) { list.splice(i, 1); dirty = true; }
  }
  if (dirty) persistOrder();
}

function _purgeTaskLocalRefs(id) {
  // snooze
  if (state.snoozeMap[id]) { delete state.snoozeMap[id]; persistSnooze(); }
  // sections
  if (state.taskSectionMap[id]) { delete state.taskSectionMap[id]; persistSections(); }
  // parent map: remove direct entry + promote any orphaned children to grandparent (or top)
  const removedParent = state.parentMap[id];
  delete state.parentMap[id];
  for (const [child, parent] of Object.entries(state.parentMap)) {
    if (parent === id) {
      if (removedParent) state.parentMap[child] = removedParent;
      else delete state.parentMap[child];
    }
  }
  persistParentMap();
  // ingested-tag memory: forget this id so a future task reusing it can re-seed
  if (state.ingestedParents.delete(id)) persistIngested();
  // order map: drop the id from any sibling list
  _removeFromOrderGroups(id);
  // collapse state: a deleted parent's disclosure flag is dead weight
  if (state.collapsedParents[id]) {
    delete state.collapsedParents[id];
    try { localStorage.setItem(CP_KEY, JSON.stringify(state.collapsedParents)); } catch {}
  }
  // within-tie order: drop the id from every view's tie buckets. These two maps
  // were swept ONLY by the daily _gcLocalMaps, so a deleted id lingered up to
  // 24h — the convention is that a task-keyed map is cleaned in both places.
  let tieDirty = false;
  for (const vk of Object.keys(state.tieOrder)) {
    const ties = state.tieOrder[vk];
    for (const tk of Object.keys(ties)) {
      const i = ties[tk].indexOf(id);
      if (i >= 0) { ties[tk].splice(i, 1); tieDirty = true; }
      if (ties[tk].length === 0) { delete ties[tk]; tieDirty = true; }
    }
    if (Object.keys(ties).length === 0) { delete state.tieOrder[vk]; tieDirty = true; }
  }
  if (tieDirty) persistTieOrder();
}

async function deleteTask(paneTask = null) {
  const t = paneTask || state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  _diagCrumb('delete task');

  // If the task has sub-tasks, detach them first so they stay in place.
  // _detachParent rewrites parentMap + orderByGroup; the snapshot lets
  // undo re-attach them.
  const detachSnapshot = _hasChildren(t.id) ? _detachParent(t.id) : null;

  // Snapshot the task's own position in its containing group AFTER the
  // detach (the group has been rewritten so the task no longer appears
  // in it — capture from the snapshot).
  const orderGroupKey = detachSnapshot
    ? detachSnapshot.groupKey
    : (state.parentMap[t.id] || ('list:' + (t.listId || state.currentListId)));
  const orderSiblingIds = (state.orderByGroup[orderGroupKey] || []).slice();
  const orderPos = detachSnapshot
    ? detachSnapshot.parentPos
    : orderSiblingIds.indexOf(t.id);
  if (!detachSnapshot && orderPos >= 0) orderSiblingIds.splice(orderPos, 1);
  const undoEntry = {
    type: 'delete',
    taskId: t.id,
    task: { ...t },
    parent: state.parentMap[t.id] || null,
    section: state.taskSectionMap[t.id] || null,
    orderGroupKey,
    orderSiblingIds,
    orderPos: orderPos >= 0 ? orderPos : orderSiblingIds.length,
    detachSnapshot,
  };
  pushUndo(undoEntry);
  // A failed delete must take its undo entry with it — otherwise a later ⌘Z
  // would "restore" a task that was never deleted, creating a duplicate.
  const dropUndoEntry = () => {
    if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
    if (detachSnapshot) _reattachParent(detachSnapshot);
  };

  if (!isListView() || paneTask) {
    setBusy(true);
    try {
      const r = await api.deleteRem(t.id);
      if (r && r.trashId) undoEntry.trashId = r.trashId;
      _purgeTaskLocalRefs(t.id);
      await refreshAllTasks();
      await loadTasks();
    } catch (e) { dropUndoEntry(); reportError('delete failed', e); }
    finally { setBusy(false); }
    return;
  }

  const idx = state.selectedIdx;
  const removed = state.tasks.splice(idx, 1)[0];
  if (state.selectedIdx >= state.tasks.length) state.selectedIdx = Math.max(0, state.tasks.length - 1);
  if (!removed.completed) bumpCount(removed.listId || state.currentListId, -1);

  renderTasks();

  setBusy(true);
  try {
    const r = await api.deleteRem(removed.id);
    if (r && r.trashId) undoEntry.trashId = r.trashId;
    // Purge local maps only after the server confirms — purging up front
    // meant a failed delete still flattened subtasks and lost the task's
    // section + manual position.
    _purgeTaskLocalRefs(removed.id);
    _backgroundRefresh();
  }
  catch (e) {
    state.tasks.splice(idx, 0, removed);
    if (!removed.completed) bumpCount(removed.listId || state.currentListId, +1);
    dropUndoEntry();
    renderTasks();
    reportError('delete failed', e);
  } finally { setBusy(false); }
}

// ----- subtasks: tab-to-indent / shift+tab-to-outdent (local-only) -----

function _createsCycle(taskId, newParentId) {
  let pid = newParentId;
  const visited = new Set();
  while (pid) {
    if (pid === taskId) return true;
    if (visited.has(pid)) return false;     // already a cycle elsewhere; bail
    visited.add(pid);
    pid = state.parentMap[pid];
  }
  return false;
}

function _reflattenPreservingSelection() {
  const selectedId = state.tasks[state.selectedIdx]?.id;
  state.tasks = flattenWithDepth(state.tasks);
  if (selectedId) {
    const idx = state.tasks.findIndex(x => x.id === selectedId);
    if (idx >= 0) state.selectedIdx = idx;
  }
  if (state.selectedIdx >= state.tasks.length) state.selectedIdx = Math.max(0, state.tasks.length - 1);
  if (state.selectedIdx < 0) state.selectedIdx = 0;
}

function indentTask() {
  if (!isListView()) { setStatus('indent/outdent only works in a list view'); return; }
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  if (state.selectedIdx === 0) { setStatus("can’t indent — nothing above"); return; }
  const above = state.tasks[state.selectedIdx - 1];
  if (above.id === t.id) return;

  // "Match-then-deepen": if the above task is at a deeper or equal depth and
  // we're not already its sibling, jump to match. Otherwise deepen (become its
  // child). The depth guard prevents an accidental OUTDENT when above is
  // actually shallower than us (which would happen if above had no parent and
  // we did — the old bug).
  const aboveParent   = state.parentMap[above.id] || null;
  const currentParent = state.parentMap[t.id]     || null;
  const aboveDepth    = above._depth   || 0;
  const currentDepth  = t._depth       || 0;
  let newParent;
  if (aboveParent !== currentParent && aboveDepth >= currentDepth) {
    newParent = aboveParent;       // match above's depth (sibling of above)
  } else {
    newParent = above.id;          // deepen → become child of above
  }

  // No-op if newParent is the existing one.
  if (newParent === currentParent) return;
  // null parent (top level) is a perfectly valid target.
  if (newParent === null) { delete state.parentMap[t.id]; }
  else if (_createsCycle(t.id, newParent)) {
    setStatus("can’t indent — would create a cycle"); return;
  } else {
    state.parentMap[t.id] = newParent;
  }
  persistParentMap();
  _reflattenPreservingSelection();
  renderTasks();
}

function outdentTask() {
  if (!isListView()) { setStatus('indent/outdent only works in a list view'); return; }
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  const currentParent = state.parentMap[t.id];
  if (!currentParent) { setStatus("already at top level"); return; }
  const grandparent = state.parentMap[currentParent];
  if (grandparent) state.parentMap[t.id] = grandparent;
  else delete state.parentMap[t.id];
  persistParentMap();
  _reflattenPreservingSelection();
  renderTasks();
}

// ----- explicit reordering: ⌘⇧↑ / ⌘⇧↓ to move a task among siblings -----

function _siblingsOf(task) {
  const pid = state.parentMap[task.id] || null;
  return state.tasks.filter(x => !x._isHeader && !x._isSection && (state.parentMap[x.id] || null) === pid);
}

function moveTask(direction) {
  if (!isListView()) { setStatus('reordering only works in a list view'); return; }
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  // Computed sorts (priority/due/created): move WITHIN the tie bucket, exactly
  // like drag-reorder — never silently flip the whole list to manual. (An
  // earlier auto-switch here kept demoting priority-sorted lists to manual,
  // which the user explicitly doesn't want.)
  if (currentSortMode() !== 'manual') {
    _moveWithinTie(t, direction);
    return;
  }
  const siblings = _siblingsOf(t);
  const idxInSibs = siblings.findIndex(x => x.id === t.id);
  const newIdx = direction === 'up' ? idxInSibs - 1 : idxInSibs + 1;
  if (newIdx < 0 || newIdx >= siblings.length) {
    setStatus(direction === 'up' ? "already at top of siblings" : "already at bottom of siblings");
    return;
  }
  const ids = siblings.map(s => s.id);
  ids.splice(idxInSibs, 1);
  ids.splice(newIdx, 0, t.id);
  state.orderByGroup[groupKeyFor(t)] = ids;
  persistOrder();
  _reflattenPreservingSelection();
  renderTasks();
}

// ⌘⇧↑↓ counterpart of the drag tie-reorder in onDrop: shuffle the task within
// its tie bucket (same priority / same due day, per the view's primary sort)
// and persist to tieOrder. Crossing buckets would mean editing the field
// itself (use `p` / due-date edit for that), so the edges report instead.
function _moveWithinTie(t, direction) {
  const tieKey = _tieGroupKeyFor(t);
  const viewKey = _currentTieViewKey();
  const groupIds = state.tasks
    .filter(x => !_isNonTaskRow(x) && _tieGroupKeyFor(x) === tieKey)
    .map(x => x.id);
  const fromIdx = groupIds.indexOf(t.id);
  if (fromIdx === -1) return;
  const toIdx = direction === 'up' ? fromIdx - 1 : fromIdx + 1;
  if (toIdx < 0 || toIdx >= groupIds.length) {
    const bucket = currentSortMode() === 'priority' ? 'its priority group' : 'its group';
    setStatus(direction === 'up' ? `already at top of ${bucket}` : `already at bottom of ${bucket}`);
    return;
  }
  groupIds.splice(fromIdx, 1);
  groupIds.splice(toIdx, 0, t.id);
  if (!state.tieOrder[viewKey]) state.tieOrder[viewKey] = {};
  state.tieOrder[viewKey][tieKey] = groupIds;
  persistTieOrder();
  state._pendingSelectId = t.id;
  loadTasks().catch(err => reportError('reorder failed', err));
}

// ----- add new task inline (⌘⏎ sibling, ⌘⌥⏎ sub-item) -----

async function addInline({ asChild = false }) {
  if (!isListView()) {
    setStatus('inline add only works in a list view — use the top bar to add');
    els.quickAdd.focus();
    return;
  }
  const selected = state.tasks[state.selectedIdx];
  if (selected && _isNonTaskRow(selected)) { setStatus('select a task first'); return; }

  // Determine the parent of the new task.
  let parentId = null;
  if (asChild && selected && !selected._optimistic) {
    parentId = selected.id;
  } else if (selected) {
    parentId = state.parentMap[selected.id] || null;
  }

  if (!state.currentListId) { setStatus('no list selected'); return; }

  // Computed sorts keep their order: the new task settles wherever the sort
  // puts it (priority mode → its priority bucket). No silent flip to manual —
  // reordering next to the selection is a manual-mode behavior only.

  const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmp = {
    id: tempId, name: '', body: '', completed: false,
    dueDate: null, priority: 'none',
    listId: state.currentListId, _optimistic: true,
  };
  if (parentId) state.parentMap[tempId] = parentId;

  // Pin the new task's position by writing to orderByGroup. Group key:
  // parentId for sub-items, `list:<currentListId>` for top-level siblings.
  const groupKey = parentId || ('list:' + state.currentListId);
  const siblingIds = state.tasks
    .filter(x => !x._isHeader && !x._isSection && (state.parentMap[x.id] || null) === parentId)
    .map(s => s.id);
  let pos;
  if (asChild) {
    pos = 0;
  } else if (selected) {
    const i = siblingIds.indexOf(selected.id);
    pos = i >= 0 ? i + 1 : siblingIds.length;
  } else {
    pos = siblingIds.length;
  }
  siblingIds.splice(pos, 0, tempId);
  state.orderByGroup[groupKey] = siblingIds;
  persistOrder();

  state.tasks.push(tmp);
  state.tasks = flattenWithDepth(state.tasks);
  state.selectedIdx = state.tasks.findIndex(x => x.id === tempId);
  renderTasks();

  // Open inline editor on the new task.
  const li = els.tasks.querySelector('.task.selected');
  if (!li) return;
  // Mark .inline-editing (NOT .editing — that class is reserved for the
  // expanded full-row editor and applies block-level rounded box styling
  // that looks wrong here). The row click handler and outside-click logic
  // check both classes.
  li.classList.add('inline-editing');
  const nameEl = li.querySelector('.name');
  nameEl.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.placeholder = asChild ? 'sub-task…' : 'new task…';
  nameEl.appendChild(input);
  input.focus();
  _inlineEditActive = true;

  let resolved = false;
  const cleanup = () => {
    if (resolved) return; resolved = true;
    _inlineEditActive = false;
  };
  const cancel = () => {
    cleanup();
    state.tasks = state.tasks.filter(t => t.id !== tempId);
    delete state.parentMap[tempId];
    _removeFromOrderGroups(tempId);   // the temp id was persisted up front
    state.tasks = flattenWithDepth(state.tasks);
    renderTasks();
  };
  const commit = async () => {
    const v = input.value.trim();
    if (!v) return cancel();
    cleanup();
    // flattenWithDepth produces shallow copies, so the closure-captured `tmp`
    // is no longer in state.tasks after the initial render. Update the LIVE
    // copy so the next flatten preserves the typed name. (Without this, the
    // API call still saved the right name — iPhone synced correctly — but
    // the local UI rendered an empty title until a reload.)
    const liveTmp = state.tasks.find(x => x.id === tempId);
    if (liveTmp) liveTmp.name = v;
    tmp.name = v;
    state.tasks = flattenWithDepth(state.tasks);
    state.selectedIdx = state.tasks.findIndex(x => x.id === tempId);
    renderTasks();
    bumpCount(state.currentListId, +1);
    setBusy(true);
    try {
      const created = await api.addRem({ listId: state.currentListId, name: v });
      pushUndo({
        type: 'add', taskId: created.id, parent: parentId,
        payload: { listId: state.currentListId, name: v },
      });
      // Migrate tempId → realId across state.
      const idx = state.tasks.findIndex(x => x.id === tempId);
      if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], id: created.id, _optimistic: false };
      if (state.parentMap[tempId]) {
        state.parentMap[created.id] = state.parentMap[tempId];
        delete state.parentMap[tempId];
        persistParentMap();
      }
      // If the parent group has explicit order, swap the temp id for the real one.
      for (const k of Object.keys(state.orderByGroup)) {
        const list = state.orderByGroup[k];
        const i = list.indexOf(tempId);
        if (i >= 0) { list[i] = created.id; persistOrder(); break; }
      }
      state.tasks = flattenWithDepth(state.tasks);
      state.selectedIdx = state.tasks.findIndex(x => x.id === created.id);
      renderTasks();
      _backgroundRefresh();
    } catch (e) {
      state.tasks = state.tasks.filter(t => t.id !== tempId);
      delete state.parentMap[tempId];
      _removeFromOrderGroups(tempId);
      bumpCount(state.currentListId, -1);
      renderTasks();
      reportError('add failed', e);
    } finally {
      setBusy(false);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); commit(); }
    else if (e.key === 'Escape' || e.key === '`'){ e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => {
    _inlineEditActive = false;
    if (!resolved) commit();
  });
}

function _formatDueForInput(iso) {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const startOfTaskDay = new Date(d); startOfTaskDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startOfTaskDay - startOfToday) / 86400000);

  // Friendly date portion that round-trips through parseDateExpression / parseDateToken.
  let datePart;
  // Emit-time for non-"today" dates per parseDateToken — the CONFIGURABLE
  // default, not a hardcoded 9. Hardcoding it made the editor show
  // "friday at 8am" for a task the parser itself had stamped 8am, and then
  // write that redundant time straight back.
  const _def = getDefaultDueTime();
  let defaultHour = _def.hours;
  let defaultMinute = _def.minutes;
  if (diffDays === 0)       { datePart = 'today'; defaultHour = 18; defaultMinute = 0; }   // today defaults to 6pm
  else if (diffDays === 1)  { datePart = 'tomorrow'; }
  else if (diffDays === -1) { datePart = 'yesterday'; }
  else if (diffDays >= 2 && diffDays <= 6) {
    datePart = d.toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase();
  }
  else if (diffDays <= -2 && diffDays >= -6) {
    datePart = `${-diffDays} days ago`;
  }
  else {
    // YYYY-MM-DD fallback — built from LOCAL components. toISOString() is the
    // UTC calendar date, which for evening times is the NEXT day; the
    // click-out-save would then write that shifted date back, moving the due
    // date +1 day every time the editor was opened and closed.
    const pad = n => String(n).padStart(2, '0');
    datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Show the time only when it differs from the parser's default for this date phrase, so we
  // don't visually clutter "today" with "today at 6pm" but DO surface "today at 3pm" so the
  // user (and alarms) can rely on the actual stored time.
  const hours = d.getHours();
  const minutes = d.getMinutes();
  if (hours === defaultHour && minutes === defaultMinute) return datePart;
  const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  const ampm = hours < 12 ? 'am' : 'pm';
  const timePart = minutes === 0 ? `${h12}${ampm}` : `${h12}:${minutes.toString().padStart(2, '0')}${ampm}`;
  return `${datePart} at ${timePart}`;
}

// Multi-field expanded editor: name → notes → due. Tab cycles, ⌘⏎ saves, Esc cancels.
async function openExpandedEditor() {
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t) || t._optimistic) return;
  _diagCrumb('open full editor');
  // Close the inline detail strip first — otherwise the lean strip would
  // remain visible directly under the full editor (visual duplication).
  if (state.detailTaskId != null) {
    state.detailTaskId = null;
    if (state.detailPaneKey) { state.detailPaneKey = null; renderPinnedPanes(); }
    renderTasks();
  }
  const li = els.tasks.querySelector('.task.selected');
  if (!li) return;

  const origAlertOffset = (!t.alarms || t.alarms.length === 0) ? 'none'
    : (t.alarms.length === 1 && t.alarms[0].type === 'relative') ? String(t.alarms[0].offset)
    : '__custom__';   // location / absolute / multiple alarms — not modelable here
  const orig = {
    name: t.name, body: t.body || '', dueDate: t.dueDate, url: t.url || '',
    recurrence: t.recurrence || 'none', alertOffset: origAlertOffset,
    allDay: !!t.allDay,
  };
  li.classList.add('editing');
  li.innerHTML = `
    <div class="editor-stack">
      <input class="ed-name" type="text" placeholder="task name" />
      <textarea class="ed-body" placeholder="notes"></textarea>
      <div class="editor-meta-row">
        <input class="ed-due ed-chip" type="text" placeholder="due — today 3pm · friday at 9am · may 3 · in 3 days" />
        <select class="ed-recur ed-chip">
          <option value="none">no repeat</option>
          <option value="daily">daily</option>
          <option value="weekdays">weekdays</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="yearly">yearly</option>
        </select>
        <select class="ed-alert ed-chip">
          <option value="none">no alert</option>
          <option value="0">at due time</option>
          <option value="-300">5m before</option>
          <option value="-1800">30m before</option>
          <option value="-3600">1h before</option>
          <option value="-86400">1d before</option>
        </select>
        <input class="ed-url ed-chip" type="text" placeholder="url" />
      </div>
      <div class="editor-hint">tab cycles · ⏎ / click-out save · esc cancels</div>
    </div>
  `;
  const nameEl  = li.querySelector('.ed-name');
  const bodyEl  = li.querySelector('.ed-body');
  const dueEl   = li.querySelector('.ed-due');
  const urlEl   = li.querySelector('.ed-url');
  const recurEl = li.querySelector('.ed-recur');
  const alertEl = li.querySelector('.ed-alert');
  // Values the selects don't model (interval recurrences like "every 2
  // weeks", day-list rules, non-preset alarm offsets, location / absolute /
  // multiple alarms) get a dynamic option holding the CURRENT value, so
  // opening + saving without touching the select is a no-op. The old
  // behavior: unmatched value left the select reading '', and save wrote ''
  // back — silently clearing the field (or writing a NaN alarm offset).
  const RECUR_PRESETS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
  if (!RECUR_PRESETS.includes(orig.recurrence)) {
    const opt = document.createElement('option');
    opt.value = orig.recurrence;
    opt.textContent = orig.recurrence;   // daemon labels are human-readable
    recurEl.appendChild(opt);
  }
  if (![...alertEl.options].some(o => o.value === orig.alertOffset)) {
    const opt = document.createElement('option');
    opt.value = orig.alertOffset;
    opt.textContent = 'custom alert (kept)';
    alertEl.appendChild(opt);
  }
  nameEl.value  = orig.name;
  bodyEl.value  = orig.body;
  dueEl.value   = _formatDueForInput(orig.dueDate);
  urlEl.value   = orig.url;
  recurEl.value = orig.recurrence;
  alertEl.value = orig.alertOffset;
  nameEl.focus(); nameEl.select();

  let resolved = false;
  let onOutsideClick = null;

  const cleanup = () => {
    if (resolved) return; resolved = true;
    if (onOutsideClick) document.removeEventListener('click', onOutsideClick, true);
    li.classList.remove('editing');
    renderTasks();
  };
  const cancel = () => cleanup();
  const save = async () => {
    const newName = nameEl.value.trim() || orig.name;
    const newBody = bodyEl.value;
    const newUrl  = urlEl.value.trim();
    const dueRaw  = dueEl.value.trim();
    let newDue = null;
    if (dueRaw) {
      const stripped = dueRaw.replace(/^\?/, '').trim();
      const parsed = parseDateExpression(stripped) || parseDateToken(stripped.toLowerCase());
      if (parsed) {
        const iso = parsed.toISOString();
        const typedExplicitTime = /(\d{1,2}(:\d{2})?\s*(am|pm))|noon|midnight|\d{1,2}:\d{2}/i.test(stripped);
        if (iso === orig.dueDate) {
          newDue = orig.dueDate;     // unchanged — no patch
        } else if (orig.allDay && !typedExplicitTime) {
          // The task was all-day and the user didn't type a time → keep it
          // all-day. The daemon stores bare YYYY-MM-DD as date-only
          // components (no midnight notification, no visible 12:00 AM).
          newDue = _localYMD(parsed);
        } else {
          newDue = iso;
        }
      }
      else { setStatus(`couldn’t parse "${dueRaw}" as a date — leaving due date unchanged`); newDue = orig.dueDate; }
    }

    cleanup();

    const patch = {};
    if (newName !== orig.name) patch.name = newName;
    if (newBody !== orig.body) patch.body = newBody;
    if (newDue !== orig.dueDate) patch.dueDate = newDue;
    if (newUrl !== orig.url) patch.url = newUrl;

    const newRecur = recurEl.value;
    if (newRecur !== orig.recurrence) patch.recurrence = newRecur;
    const newAlert = alertEl.value;
    if (newAlert !== orig.alertOffset) {
      patch.alarms = newAlert === 'none' ? [] : [{ type: 'relative', offset: parseFloat(newAlert) }];
    }

    if (Object.keys(patch).length === 0) return;

    // Undo entry: prev values for exactly the patched fields, in wire format.
    // Use full daemon snapshots so undo preserves rich rules and alarms.
    const prevPatch = {};
    if ('name' in patch) prevPatch.name = orig.name;
    if ('body' in patch) prevPatch.body = orig.body;
    if ('url' in patch) prevPatch.url = orig.url;
    if ('dueDate' in patch) {
      prevPatch.dueDate = orig.dueDate
        ? (orig.allDay ? _localYMD(new Date(orig.dueDate)) : orig.dueDate)
        : null;
    }
    if ('recurrence' in patch) {
      if (Array.isArray(t.recurrenceRules)) prevPatch.recurrenceRules = t.recurrenceRules;
      else if (orig.recurrence !== 'custom') prevPatch.recurrence = orig.recurrence;
    }
    if ('alarms' in patch) prevPatch.alarms = t.alarms || [];
    const undoEntry = { type: 'patch', taskId: t.id, prev: prevPatch, next: { ...patch } };
    pushUndo(undoEntry);

    if (isListView()) {
      // A date-only patch means all-day: apply it locally as local-midnight
      // ISO so formatDue doesn't read it as UTC midnight (= previous day).
      const optimistic = { ...patch };
      if (typeof optimistic.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(optimistic.dueDate)) {
        const [y, mo, da] = optimistic.dueDate.split('-').map(Number);
        optimistic.dueDate = new Date(y, mo - 1, da).toISOString();
        optimistic.allDay = true;
      } else if ('dueDate' in optimistic) {
        optimistic.allDay = false;
      }
      Object.assign(t, optimistic);
      state.tasks = sortTasks(state.tasks);
      state.selectedIdx = state.tasks.findIndex(x => x.id === t.id);
      renderTasks();
    }

    setBusy(true);
    try {
      await api.updateRem(t.id, patch);
      if (!isListView()) { await refreshAllTasks(); await loadTasks(); }
      else _backgroundRefresh();
    } catch (e) {
      Object.assign(t, orig);
      renderTasks();
      if (undoStack[undoStack.length - 1] === undoEntry) undoStack.pop();
      reportError('save failed', e);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); return; }
    // Tab handled by browser default for cycling between focusable inputs.
  };
  for (const el of [nameEl, bodyEl, dueEl, urlEl, recurEl, alertEl]) el.addEventListener('keydown', onKey);

  // Click outside the editor → save and swallow the click so it doesn't
  // activate whatever was clicked (another task, sidebar list, etc.). Esc / `
  // cancel; click-out commits. Native <select> popups render outside the DOM
  // but option-picks dispatch only 'change' events, not 'click', so they don't
  // trigger this listener. Deferred one tick so the click that opened the
  // editor doesn't immediately close it.
  onOutsideClick = (ev) => {
    if (li.contains(ev.target)) return;
    ev.stopPropagation();
    ev.preventDefault();
    save();
  };
  setTimeout(() => {
    if (resolved) return;
    document.addEventListener('click', onOutsideClick, true);
  }, 0);
}

// Backwards-compat alias — code elsewhere may still call inlineEditName.
const inlineEditName = openExpandedEditor;

async function renameCurrentList() {
  if (!isListView()) { setStatus('rename only works in list view'); return; }
  const list = state.lists.find(l => l.id === state.currentListId);
  if (!list) return;
  const newName = await openPrompt('rename list', list.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === list.name) return;
  setBusy(true);
  try {
    await api.renameList(list.id, trimmed);
    list.name = trimmed;
    els.listHeader.textContent = trimmed;
    renderLists();
    renderPinnedPanes();
  } catch (e) { reportError('rename failed', e); }
  finally { setBusy(false); }
}

async function newListPrompt() {
  const name = await openPrompt('new list name');
  if (!name || !name.trim()) return;
  setBusy(true);
  try {
    const created = await api.createList(name.trim());
    state.lists.push({ id: created.id, name: created.name });
    renderLists();
    await selectList(created.id);
  } catch (e) {
    reportError('create failed', e);
  } finally { setBusy(false); }
}

async function refresh() {
  setStatus('refreshing…');
  // Calendar rides along with every manual refresh (`r`, and ⌘R via the
  // shell's Refresh menu item, which forwards a plain `r` keydown). Google →
  // macOS Calendar sync doesn't always fire a store-change event promptly,
  // so a manual poke needs to re-pull events too.
  if (state.calendarOpen) _loadCalendar().catch(() => {});
  try {
    await loadLists();
    await loadLists();
    if (_editingNow()) { _scheduleLiveRefresh(); return; }
    await refreshAllTasks();
    if (_editingNow()) { _scheduleLiveRefresh(); return; }
    await loadTasks();
    await loadHabits();
    api.counts().then(c => { state.counts = c; renderLists(); }).catch(() => {});
    setStatus('');
  } catch (e) {
    // Without this catch, a refresh against a restarting server silently
    // showed stale data as if it had refreshed (plus an unhandled rejection).
    reportError('refresh failed', e);
  }
}

// ============================================================
// calendar day pane — read-only EventKit events, Superhuman-style
// day agenda on the right. Toggle via ⌘K; ‹ today › to move days.
// First open triggers the macOS Calendars permission prompt.
// ============================================================
function _calYMD(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function _calShownDate() { return state.calendarDate || _calYMD(new Date()); }
function _calTimeLabel(iso) {
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase().replace(/\s/g, '');
}
function _calTitleFor(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = _calYMD(new Date());
  const tomorrow = (() => { const t = new Date(); t.setDate(t.getDate() + 1); return _calYMD(t); })();
  const yesterday = (() => { const t = new Date(); t.setDate(t.getDate() - 1); return _calYMD(t); })();
  if (ymd === today) return 'Today';
  if (ymd === tomorrow) return 'Tomorrow';
  if (ymd === yesterday) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// Timeline geometry: one hour = CAL_HOUR_H px, full 24h grid so empty slots
// are visible, auto-scrolled to the useful part of the day.
const CAL_HOUR_H = 44;
const CAL_GUTTER = 40;   // left rail for the hour labels
// A timed event that covers (almost) the whole visible day would hog an
// overlap column for 24 hours and squeeze everything else — treat it as an
// all-day chip instead (multi-day trips, "busy all day" blocks, …).
const CAL_CHIP_MIN = 20 * 60;   // minutes

// Assign side-by-side columns to overlapping events (classic day-view layout):
// events that overlap transitively form a cluster; within a cluster each event
// takes the first column that is free at its start, and every event in the
// cluster shares the cluster's column count for its width.
function _calAssignColumns(evts) {
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds = [];
    for (const e of cluster) {
      let c = colEnds.findIndex(end => end <= e._startMin);
      if (c === -1) { c = colEnds.length; colEnds.push(0); }
      colEnds[c] = e._endMin;
      e._col = c;
    }
    for (const e of cluster) e._cols = colEnds.length;
    cluster = [];
  };
  for (const e of evts) {
    if (e._startMin >= clusterEnd) { flush(); clusterEnd = e._endMin; }
    else clusterEnd = Math.max(clusterEnd, e._endMin);
    cluster.push(e);
  }
  flush();
}

function _calHourLabel(h) {
  if (h === 0) return '12am';
  if (h < 12) return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

// Hover card with the FULL event details — block titles truncate hard in a
// narrow pane. One shared element, shown after a short hover, hidden on
// leave/scroll/re-render. All content via textContent.
let _calHoverEl = null, _calHoverTimer = null;
function _calHideHover() {
  clearTimeout(_calHoverTimer);
  _calHoverTimer = null;
  if (_calHoverEl) _calHoverEl.classList.add('hidden');
}
function _calShowHover(anchor, ev) {
  if (!_calHoverEl) {
    _calHoverEl = document.createElement('div');
    _calHoverEl.id = 'calHover';
    _calHoverEl.className = 'hidden';
    document.body.appendChild(_calHoverEl);
  }
  const el = _calHoverEl;
  el.textContent = '';
  const t = document.createElement('div');
  t.className = 'ch-title';
  t.textContent = ev.title || '(untitled)';
  el.appendChild(t);
  const lines = [];
  if (ev.allDay) lines.push('all day');
  else if (ev.start) lines.push(`${_calTimeLabel(ev.start)}${ev.end ? '–' + _calTimeLabel(ev.end) : ''}`);
  if (ev.location) lines.push(ev.location);
  if (ev.calendar) lines.push(ev.calendar);
  for (const line of lines) {
    const p = document.createElement('div');
    p.className = 'ch-line';
    p.textContent = line;
    el.appendChild(p);
  }
  el.classList.remove('hidden');
  // Prefer sitting to the LEFT of the pane so it never covers the timeline;
  // clamp to the viewport either way.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = r.left - w - 10;
  if (x < 8) x = Math.min(r.left + 4, window.innerWidth - w - 8);
  let y = Math.max(8, Math.min(r.top, window.innerHeight - h - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}
function _calAttachHover(el, ev) {
  el.addEventListener('mouseenter', () => {
    clearTimeout(_calHoverTimer);
    _calHoverTimer = setTimeout(() => _calShowHover(el, ev), 220);
  });
  el.addEventListener('mouseleave', _calHideHover);
}

// ---- meeting prep on calendar events ----
// Briefs published by a meeting-prep or daily-briefing skill (MCP meeting_prep_set →
// prep.json); GET /api/prep serves the shown day's. A matching event gets a
// marker (.has-prep); clicking it opens #prepCard — a pinned, text-selectable
// card with the brief, done/dismiss buttons per open-loop item, and a copy
// button. All content renders via textContent; prep strings are data.

const _prepNorm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function _prepForEvent(preps, ev) {
  if (!preps.length) return null;
  const t = _prepNorm(ev.title);
  return preps.find(p => _prepNorm(p.title) === t)
      || preps.find(p => p.start && ev.start && Math.abs(new Date(p.start) - new Date(ev.start)) < 60000)
      || null;
}

// Clipboard write with a WebKit-friendly fallback. Explicit copy buttons beat
// text selection here: briefing plan rows and calendar blocks are clickable,
// so a select-drag gets swallowed by their click handlers.
async function _copyTextToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

let _prepCardEl = null, _prepCardCleanup = null, _prepFeedback = [];
function _closePrepCard() {
  if (_prepCardCleanup) _prepCardCleanup();
}
function _prepAsText(prep) {
  const lines = [prep.person || prep.title];
  lines.push([prep.date, prep.start ? _calTimeLabel(prep.start) : ''].filter(Boolean).join(' · '));
  lines.push('', prep.brief || '');
  if (Array.isArray(prep.items) && prep.items.length) {
    lines.push('', 'Open loops:');
    for (const it of prep.items) lines.push('- ' + it);
  }
  return lines.join('\n');
}
function _openPrepCard(prep, anchor) {
  _calHideHover();
  _closePrepCard();
  if (!_prepCardEl) {
    _prepCardEl = document.createElement('div');
    _prepCardEl.id = 'prepCard';
    document.body.appendChild(_prepCardEl);
  }
  const el = _prepCardEl;
  el.textContent = '';
  el.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'prep-head';
  const t = document.createElement('div');
  t.className = 'prep-title';
  t.textContent = prep.person || prep.title;
  head.appendChild(t);
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'prep-copy';
  copyBtn.textContent = 'copy';
  copyBtn.addEventListener('click', async () => {
    setStatus(await _copyTextToClipboard(_prepAsText(prep)) ? 'prep copied' : 'copy failed');
  });
  head.appendChild(copyBtn);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'prep-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'close';
  closeBtn.addEventListener('click', _closePrepCard);
  head.appendChild(closeBtn);
  el.appendChild(head);

  const subBits = [];
  if (!prep.person || _prepNorm(prep.person) !== _prepNorm(prep.title)) subBits.push(prep.title);
  if (prep.start) subBits.push(_calTimeLabel(prep.start));
  if (subBits.length) {
    const sub = document.createElement('div');
    sub.className = 'prep-sub';
    sub.textContent = subBits.join(' · ');
    el.appendChild(sub);
  }

  const briefEl = document.createElement('div');
  briefEl.className = 'prep-brief';
  briefEl.textContent = prep.brief || '';
  el.appendChild(briefEl);

  if (Array.isArray(prep.items) && prep.items.length) {
    // Done/dismiss marks already given for this prep (dismiss = "never a real
    // item": hidden here, and the skills won't resurface it).
    const marks = new Map();
    for (const f of _prepFeedback) {
      if (f && f.prep_key === prep.key && f.item_text) marks.set(f.item_text, f.type);
    }
    const ul = document.createElement('ul');
    ul.className = 'prep-items';
    for (const item of prep.items) {
      const mark = marks.get(item);
      if (mark === 'dismiss') continue;
      const li = document.createElement('li');
      const done = mark === 'done';
      if (done) li.classList.add('done');
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'brf-check';
      check.title = done ? 'done' : 'mark done';
      check.textContent = done ? '✓' : '';
      check.disabled = done;
      const text = document.createElement('span');
      text.className = 'prep-item-text';
      text.textContent = item;
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'prep-dismiss';
      dismiss.title = 'dismiss — not a real item';
      dismiss.textContent = '×';
      const send = async (type) => {
        try {
          await api.prepFeedback({ type, prep_key: prep.key, item_text: item });
          _prepFeedback.push({ type, prep_key: prep.key, item_text: item });
          if (type === 'done') { li.classList.add('done'); check.textContent = '✓'; check.disabled = true; }
          else li.remove();
          setStatus(type === 'done' ? 'marked done' : 'dismissed');
        } catch (err) { reportError('could not save the mark', err); }
      };
      check.addEventListener('click', () => send('done'));
      dismiss.addEventListener('click', () => send('dismiss'));
      li.appendChild(check);
      li.appendChild(text);
      li.appendChild(dismiss);
      ul.appendChild(li);
    }
    if (ul.children.length) el.appendChild(ul);
  }

  // Position like the hover card: prefer the pane's left, clamp to viewport.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = r.left - w - 10;
  if (x < 8) x = Math.min(r.left + 4, window.innerWidth - w - 8);
  el.style.left = `${Math.max(8, x)}px`;   // never off-screen, whatever the anchor rect said
  el.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - h - 8))}px`;

  const onDown = (e) => { if (!el.contains(e.target)) _closePrepCard(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closePrepCard(); }
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  _prepCardCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    el.classList.add('hidden');
    _prepCardCleanup = null;
  };
}
function _calAttachPrep(el, ev, preps) {
  const prep = _prepForEvent(preps, ev);
  if (!prep) return;
  el.classList.add('has-prep');
  el.addEventListener('click', () => _openPrepCard(prep, el));
}

let _calReq = 0;        // stale-response guard for fast day flipping
let _calShownYmd = null; // last rendered day — preserves scroll on same-day refresh
async function _loadCalendar() {
  const body = document.getElementById('calBody');
  const allDayBox = document.getElementById('calAllDay');
  const title = document.getElementById('calTitle');
  if (!body || !state.calendarOpen) return;
  const ymd = _calShownDate();
  title.textContent = _calTitleFor(ymd);
  const sub = document.createElement('span');
  sub.className = 'cal-sub';
  const [y, m, d] = ymd.split('-').map(Number);
  sub.textContent = ' ' + new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (_calTitleFor(ymd).length <= 9 && !/\d/.test(_calTitleFor(ymd))) title.appendChild(sub);
  const req = ++_calReq;
  let data, prepData;
  try {
    // Prep briefs are garnish: their fetch failing must not blank the calendar.
    [data, prepData] = await Promise.all([
      api.calendar(ymd),
      api.prep(ymd).catch(() => null),
    ]);
  } catch (err) {
    if (req !== _calReq) return;
    allDayBox.innerHTML = '';
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'cal-empty';
    p.textContent = (err && err.message) || 'calendar unavailable';
    body.appendChild(p);
    return;
  }
  if (req !== _calReq) return;   // a newer day was requested meanwhile
  const sameDay = _calShownYmd === ymd;
  const prevScroll = sameDay ? body.scrollTop : null;
  _calShownYmd = ymd;
  _calHideHover();
  _closePrepCard();
  allDayBox.innerHTML = '';
  body.innerHTML = '';
  const events = data.events || [];
  const preps = (prepData && prepData.preps) || [];
  _prepFeedback = (prepData && Array.isArray(prepData.feedback)) ? prepData.feedback : [];
  const now = new Date();
  const isToday = ymd === _calYMD(now);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();

  // Minutes-into-day span, clamped to this day's 24h.
  const spanOf = (ev) => {
    const s = ev.start ? new Date(ev.start).getTime() : dayStart;
    const e = ev.end ? new Date(ev.end).getTime() : s + 30 * 60000;
    return {
      startMin: Math.max(0, Math.min(1440, (s - dayStart) / 60000)),
      endMin: Math.max(0, Math.min(1440, (e - dayStart) / 60000)),
    };
  };
  // Real all-day events AND timed events that cover (almost) the whole day
  // render as chips — a 24h "busy" block must not hog a timeline column.
  const isChip = (ev) => {
    if (ev.allDay) return true;
    const { startMin, endMin } = spanOf(ev);
    return endMin - startMin >= CAL_CHIP_MIN;
  };

  // All-day chips live above the scrolling grid so they stay visible.
  for (const ev of events.filter(isChip)) {
    const row = document.createElement('div');
    row.className = 'cal-allday';
    if (ev.color) row.style.setProperty('--cal-color', ev.color);
    const name = document.createElement('span');
    name.className = 'cal-name';
    name.textContent = ev.title || '(untitled)';
    row.appendChild(name);
    _calAttachHover(row, ev);
    _calAttachPrep(row, ev, preps);
    allDayBox.appendChild(row);
  }

  // The 24h grid — hour rules + labels, empty slots included.
  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  grid.style.height = `${24 * CAL_HOUR_H}px`;
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'cal-hour';
    line.style.top = `${h * CAL_HOUR_H}px`;
    const lab = document.createElement('span');
    lab.className = 'cal-hour-label';
    lab.textContent = _calHourLabel(h);
    line.appendChild(lab);
    grid.appendChild(line);
  }

  // Timed events as positioned blocks, clamped to this day's 24h.
  const timed = events.filter(e => !isChip(e) && e.start).map(ev => {
    const { startMin, endMin } = spanOf(ev);
    return { ...ev, _startMin: startMin, _endMin: endMin };
  }).filter(ev => ev._endMin > ev._startMin)
    .sort((a, b) => a._startMin - b._startMin || b._endMin - a._endMin);
  _calAssignColumns(timed);
  for (const ev of timed) {
    const block = document.createElement('div');
    block.className = 'cal-block';
    if (ev.color) block.style.setProperty('--cal-color', ev.color);
    if (isToday && ev._endMin <= (now.getTime() - dayStart) / 60000) block.classList.add('past');
    const top = (ev._startMin / 60) * CAL_HOUR_H;
    const height = Math.max(20, ((ev._endMin - ev._startMin) / 60) * CAL_HOUR_H - 2);
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    // Split the width right of the gutter evenly across overlap columns.
    const cols = ev._cols || 1, col = ev._col || 0;
    block.style.left = `calc(${CAL_GUTTER}px + (100% - ${CAL_GUTTER + 8}px) * ${col / cols})`;
    block.style.width = `calc((100% - ${CAL_GUTTER + 8}px) / ${cols} - 2px)`;
    const name = document.createElement('span');
    name.className = 'cal-name';
    name.textContent = ev.title || '(untitled)';
    block.appendChild(name);
    if (height >= 34) {
      const time = document.createElement('span');
      time.className = 'cal-time';
      time.textContent = _calTimeLabel(ev.start) + (ev.end ? `–${_calTimeLabel(ev.end)}` : '');
      block.appendChild(time);
    }
    _calAttachHover(block, ev);
    _calAttachPrep(block, ev, preps);
    grid.appendChild(block);
  }

  // "Now" line on today's grid.
  if (isToday) {
    const nowMin = (now.getTime() - dayStart) / 60000;
    const line = document.createElement('div');
    line.className = 'cal-now';
    line.style.top = `${(nowMin / 60) * CAL_HOUR_H}px`;
    grid.appendChild(line);
  }

  body.appendChild(grid);
  // Same-day refresh keeps your scroll spot; a new day scrolls to the action:
  // just above "now" for today, else just above the first event (8am fallback).
  if (prevScroll != null) {
    body.scrollTop = prevScroll;
  } else {
    let focusMin = 8 * 60;
    if (isToday) focusMin = (now.getTime() - dayStart) / 60000 - 60;
    else if (timed.length) focusMin = timed[0]._startMin - 30;
    body.scrollTop = Math.max(0, (focusMin / 60) * CAL_HOUR_H);
  }
}

// Keep the "now" line honest while the pane sits open on today (no refetch —
// just reposition; SSE reloads handle data changes).
setInterval(() => {
  if (!state.calendarOpen || _calShownDate() !== _calYMD(new Date())) return;
  const line = document.querySelector('#calBody .cal-now');
  if (!line) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  line.style.top = `${(nowMin / 60) * CAL_HOUR_H}px`;
}, 60_000);
function renderCalendarPane() {
  const pane = document.getElementById('calendarPane');
  if (!pane) return;
  pane.classList.toggle('hidden', !state.calendarOpen);
  if (state.calendarWidth) pane.style.flex = `0 0 ${state.calendarWidth}px`;
  if (state.calendarOpen) _loadCalendar().catch(() => {});
}

// Drag the pane's left edge to resize it (pointer-based, like the pane
// splitter). Width persists across launches.
function _attachCalResize() {
  const pane = document.getElementById('calendarPane');
  if (!pane) return;
  const grip = document.createElement('div');
  grip.className = 'cal-resize';
  grip.title = 'drag to resize';
  pane.appendChild(grip);
  grip.addEventListener('mousedown', (downEv) => {
    if (downEv.button !== 0) return;
    downEv.preventDefault();   // no text-selection gesture (same rule as pane drags)
    grip.classList.add('dragging');
    const startX = downEv.clientX;
    const startW = pane.getBoundingClientRect().width;
    const onMove = (mv) => {
      const w = Math.max(200, Math.min(560, startW + (startX - mv.clientX)));
      pane.style.flex = `0 0 ${w}px`;
    };
    const onUp = () => {
      grip.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      state.calendarWidth = Math.round(pane.getBoundingClientRect().width);
      persist();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
function toggleCalendarPane() {
  state.calendarOpen = !state.calendarOpen;
  if (state.calendarOpen) state.calendarDate = null;   // always reopen on today
  persist();
  renderCalendarPane();
}
function _calShift(days) {
  const [y, m, d] = _calShownDate().split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  state.calendarDate = _calYMD(date);
  _loadCalendar().catch(() => {});
}
{
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('calPrev', () => _calShift(-1));
  on('calNext', () => _calShift(1));
  on('calToday', () => { state.calendarDate = null; _loadCalendar().catch(() => {}); });
  on('calClose', () => toggleCalendarPane());
  const calBody = document.getElementById('calBody');
  if (calBody) calBody.addEventListener('scroll', _calHideHover, { passive: true });
  _attachCalResize();
  renderCalendarPane();   // restore persisted open state on boot
}

// ============================================================
// prompt overlay
// ============================================================
function openPrompt(label, initial = '') {
  return new Promise(resolve => {
    els.promptLabel.textContent = label;
    els.promptInput.value = initial;
    els.prompt.classList.remove('hidden');
    setTimeout(() => { els.promptInput.focus(); els.promptInput.select(); }, 0);
    const onKey = (e) => {
      if (e.key === 'Enter')      { e.preventDefault(); cleanup(); resolve(els.promptInput.value); }
      else if (e.key === 'Escape' || e.key === '`'){ e.preventDefault(); cleanup(); resolve(null); }
      e.stopPropagation();
    };
    const cleanup = () => {
      els.prompt.classList.add('hidden');
      els.promptInput.removeEventListener('keydown', onKey);
    };
    els.promptInput.addEventListener('keydown', onKey);
  });
}

// Destructive-action confirm. Resolves true only on an explicit click (or
// Enter on the focused confirm button); Esc / ` / backdrop click / cancel all
// resolve false. Cancel gets initial focus so a stray Enter can't confirm.
function openConfirm({ title, body, confirmLabel = 'delete', danger = true }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirmModal');
    const ok = document.getElementById('confirmOk');
    const cancel = document.getElementById('confirmCancel');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmBody').textContent = body;
    ok.textContent = confirmLabel;
    ok.classList.toggle('danger', danger);
    overlay.classList.remove('hidden');
    const done = (answer) => {
      overlay.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); done(false); }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => cancel.focus(), 0);
  });
}

// Delete a real Reminders list (its tasks go to the recoverable trash), after
// an explicit confirm naming the list. Local per-list state is swept so a
// future list can't inherit stale sort/pin/order entries.
async function deleteListFlow(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  const yes = await openConfirm({
    title: `delete "${list.name}"?`,
    body: 'The tasks in it will be sent to the trash, and permanently deleted after a week.',
    confirmLabel: 'delete list',
  });
  if (!yes) return;
  _diagCrumb('delete list');
  try {
    const r = await api.deleteList(listId);
    const viewKey = 'list:' + listId;
    state.pinnedViews = state.pinnedViews.filter(k => k !== viewKey);
    delete state.sortByList[listId];
    delete state.showCompletedMap[viewKey];
    delete state.collapsedSections[listId];
    delete state.orderByGroup[viewKey];
    delete state.tieOrder[viewKey];
    persist(); persistOrder(); persistSections(); persistTieOrder();
    if (state.view === 'list' && state.currentListId === listId) {
      const next = state.lists.find(l => l.id !== listId);
      state.currentListId = next ? next.id : null;
      persist();
    }
    await refresh();
    renderPinnedPanes();
    setStatus(`deleted "${list.name}" — ${r.trashed || 0} task${r.trashed === 1 ? '' : 's'} moved to trash`);
  } catch (err) {
    reportError('delete list failed', err);
  }
}

// "Deleting" a smart list just hides it from the sidebar — it's a built-in
// view, so it stays reachable via ⌘K "Go to: …" and restorable from ⌘K.
async function hideSmartViewFlow(key, label) {
  const yes = await openConfirm({
    title: `hide "${label}" from the sidebar?`,
    body: 'Smart lists are built-in views, so nothing is deleted — you can still open it via ⌘K "Go to", and restore it with ⌘K "Restore hidden sidebar views".',
    confirmLabel: 'hide',
  });
  if (!yes) return;
  if (!state.hiddenSmartViews.includes(key)) state.hiddenSmartViews.push(key);
  persist();
  renderSmartLists();
  setStatus(`hid "${label}" — restore anytime via ⌘K`);
}

function toggleHelp() { els.helpOverlay.classList.toggle('hidden'); }

// ============================================================
// morning briefing
// Published by a daily-briefing skill (see examples/skills) through the MCP (briefing_set →
// briefing.json in app data); GET /api/briefing serves it. Auto-pops once on
// the briefing's own date; ⌘K "today's briefing" reopens it anytime (stale
// briefings open with a banner but never auto-pop). Every string renders via
// textContent — briefing content is data, never markup.
// ============================================================
let _briefingCache = null;     // last-fetched briefing, for offline reopen
let _briefingFeedback = [];    // recent done-marks/notes, from GET /api/briefing
let _briefingCloseFn = null;   // set while the modal is open (lets plan rows close it)

function _briefingSeen() { try { return localStorage.getItem(BRF_KEY) || ''; } catch { return ''; } }
function _briefingMarkSeen(date) { try { localStorage.setItem(BRF_KEY, date || ''); } catch {} }
function _briefingAutoPopEnabled() { try { return localStorage.getItem(BRF_POP_KEY) !== '0'; } catch { return true; } }

function _brfHeading(parent, text) {
  const h = document.createElement('h3');
  h.textContent = text;
  parent.appendChild(h);
}

// Close the modal and jump to a plan task: switch to its home list and select
// it (via _pendingSelectId, same mechanism keyboard moves use).
async function _briefingJump(taskId) {
  if (_briefingCloseFn) _briefingCloseFn();
  const t = state.allTasks.find(x => x.id === taskId);
  if (!t) { setStatus('task not found — it may have been deleted'); return; }
  state._pendingSelectId = t.id;
  if (state.view === 'list' && state.currentListId === t.listId) await loadTasks();
  else await selectList(t.listId);
}

// Plain-text serialization for the copy button (paste into Notes, email, …).
function _briefingAsText(b) {
  const L = [`Briefing · ${b.date || ''}`.trim()];
  if (b.headline) L.push(b.headline);
  if (Array.isArray(b.plan) && b.plan.length) {
    L.push('', 'Plan:');
    b.plan.forEach((it, i) => {
      if (!it || !it.title) return;
      L.push(`${i + 1}. ${it.slot ? it.slot + ' ' : ''}${it.title}${it.why ? ' (' + it.why + ')' : ''}`);
    });
  }
  if (Array.isArray(b.needs_answer) && b.needs_answer.length) {
    L.push('', 'Needs answer:');
    for (const n of b.needs_answer) {
      if (n && n.who && n.what) L.push(`- ${n.level ? '[' + n.level + '] ' : ''}${n.who}: ${n.what}${n.source ? ' (' + n.source + ')' : ''}`);
    }
  }
  if (Array.isArray(b.keep_in_mind) && b.keep_in_mind.length) {
    L.push('', 'Keep in mind:');
    for (const k of b.keep_in_mind) if (k) L.push(`- ${k}`);
  }
  if (b.scoreboard) L.push('', b.scoreboard);
  return L.join('\n');
}

function _renderBriefing(b) {
  const body = document.getElementById('briefingBody');
  body.innerHTML = '';   // clearing the static container only — content below is textContent
  const today = _localYMD(new Date());

  // Dateline in the header so it's obvious at a glance the briefing is current.
  // Parse Y-M-D into LOCAL components (new Date('YYYY-MM-DD') is UTC and can
  // land on the wrong day).
  const titleEl = document.getElementById('briefingTitle');
  if (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    const [y, mo, da] = b.date.split('-').map(Number);
    const d = new Date(y, mo - 1, da);
    titleEl.textContent = `today's briefing · ${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`;
  } else {
    titleEl.textContent = "today's briefing";
  }

  // Copy button (a select-drag on plan rows would trigger their click-jump,
  // so an explicit button is the reliable way to get the text out).
  let copyBtn = document.getElementById('briefingCopy');
  if (!copyBtn) {
    copyBtn = document.createElement('button');
    copyBtn.id = 'briefingCopy';
    copyBtn.type = 'button';
    copyBtn.textContent = 'copy';
    copyBtn.title = 'copy the briefing as text';
    titleEl.after(copyBtn);
  }
  copyBtn.onclick = async () => {
    setStatus(await _copyTextToClipboard(_briefingAsText(b)) ? 'briefing copied' : 'copy failed');
  };

  // Pop-out button: the briefing in its own window, so it can sit next to the
  // task list. The shell turns same-origin window.open into a real native
  // window (createWebViewWith in MainWindow.swift); a plain browser gets a tab.
  // Hidden when this page IS the pop-out.
  let popBtn = document.getElementById('briefingPop');
  if (!popBtn && !BRIEFING_ONLY) {
    popBtn = document.createElement('button');
    popBtn.id = 'briefingPop';
    popBtn.type = 'button';
    popBtn.textContent = '⧉ window';
    popBtn.title = 'open the briefing in its own window';
    titleEl.after(popBtn);
  }
  if (popBtn) popBtn.onclick = () => {
    window.open(location.origin + '/?briefing=1', '_blank');
    if (_briefingCloseFn) _briefingCloseFn();
  };

  if (b.date && b.date !== today) {
    const stale = document.createElement('p');
    stale.className = 'brf-stale';
    stale.textContent = `this briefing is from ${b.date} — it may be out of date`;
    body.appendChild(stale);
  }
  if (b.headline) {
    const p = document.createElement('p');
    p.className = 'brf-headline';
    p.textContent = b.headline;
    body.appendChild(p);
  }
  if (Array.isArray(b.plan) && b.plan.length) {
    _brfHeading(body, 'plan');
    const ol = document.createElement('ol');
    ol.className = 'brf-plan';
    // Plan items marked done through the pop-up itself (covers non-task items;
    // task-backed ones are also genuinely completed in Reminders).
    const doneIdx = new Set(_briefingFeedback
      .filter(f => f && f.type === 'done' && f.briefing_date === b.date && Number.isInteger(f.plan_index))
      .map(f => f.plan_index));
    // Rows the user rejected ("not a real task / already done / other plans"): the
    // slot stays visible but empties out. Feedback-only — the task itself is
    // untouched.
    const dismissedIdx = new Set(_briefingFeedback
      .filter(f => f && f.type === 'dismissed' && f.briefing_date === b.date && Number.isInteger(f.plan_index))
      .map(f => f.plan_index));
    b.plan.forEach((item, i) => {
      if (!item || !item.title) return;
      const li = document.createElement('li');
      const isFixed = item.kind === 'fixed';
      const t = !isFixed && item.task_id ? state.allTasks.find(x => x.id === item.task_id) : null;
      const isDismissed = !isFixed && dismissedIdx.has(i);
      const isDone = !isFixed && !isDismissed && (doneIdx.has(i) || !!(t && t.completed));
      if (isFixed) {
        // Calendar event / immovable block: a marker instead of a done-circle.
        li.classList.add('fixed');
        const mark = document.createElement('span');
        mark.className = 'brf-fixed-mark';
        mark.textContent = '◇';
        li.appendChild(mark);
      } else {
        const check = document.createElement('button');
        check.className = 'brf-check';
        check.type = 'button';
        check.title = isDone ? 'done' : 'mark done';
        check.textContent = isDone ? '✓' : '';
        check.disabled = isDone || isDismissed;
        check.addEventListener('click', (e) => { e.stopPropagation(); _briefingMarkDone(i, item, li, check); });
        li.appendChild(check);
      }
      if (item.slot) {
        const slot = document.createElement('span');
        slot.className = 'brf-slot';
        slot.textContent = item.slot;
        li.appendChild(slot);
      }
      const title = document.createElement('span');
      title.className = 'brf-title';
      title.textContent = item.title;
      li.appendChild(title);
      if (!isFixed && !isDone && !isDismissed) {
        // Reject button: "this isn't a real task / already done / doing
        // something else". Leaves the slot in place but empty.
        const dis = document.createElement('button');
        dis.className = 'brf-dismiss';
        dis.type = 'button';
        dis.title = 'dismiss — not doing this today (task is kept)';
        dis.textContent = '×';
        dis.addEventListener('click', (e) => { e.stopPropagation(); _briefingDismiss(i, item, li); });
        li.appendChild(dis);
      }
      if (item.why) {
        const why = document.createElement('div');
        why.className = 'brf-why';
        why.textContent = item.why;
        li.appendChild(why);
      }
      if (isDone) {
        li.classList.add('done');
      } else if (isDismissed) {
        li.classList.add('dismissed');
      } else if (t) {
        li.classList.add('linked');
        li.title = 'click to open this task';
        li.addEventListener('click', () => _briefingJump(t.id));
      }
      ol.appendChild(li);
    });
    body.appendChild(ol);
  }
  if (Array.isArray(b.needs_answer) && b.needs_answer.length) {
    _brfHeading(body, 'needs answer');
    // Handled-marks from the pop-up (type "needs_done"); indexes refer to the
    // ORIGINAL needs_answer array order, not the level-grouped display order.
    const doneNeeds = new Set(_briefingFeedback
      .filter(f => f && f.type === 'needs_done' && f.briefing_date === b.date && Number.isInteger(f.needs_index))
      .map(f => f.needs_index));
    const ul = document.createElement('ul');
    ul.className = 'brf-needs';
    // Grouped by level; a level with no items gets no label at all.
    // Items without a level (older briefings) trail the labeled groups, unlabeled.
    const LEVELS = [['critical', 'critical — answer today'], ['high', 'high prio'], ['medium', 'medium prio'], [undefined, null]];
    for (const [lvl, label] of LEVELS) {
      const group = b.needs_answer
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => item && item.who && item.what &&
          (lvl ? item.level === lvl : !['critical', 'high', 'medium'].includes(item.level)));
      if (!group.length) continue;
      if (label) {
        const lab = document.createElement('li');
        lab.className = `brf-lvl brf-lvl-${lvl}`;
        lab.textContent = label;
        ul.appendChild(lab);
      }
      for (const { item, i } of group) {
        const li = document.createElement('li');
        const isDone = doneNeeds.has(i);
        const check = document.createElement('button');
        check.className = 'brf-check';
        check.type = 'button';
        check.title = isDone ? 'handled' : 'mark handled';
        check.textContent = isDone ? '✓' : '';
        check.disabled = isDone;
        check.addEventListener('click', (e) => { e.stopPropagation(); _briefingNeedsDone(i, item, li, check); });
        li.appendChild(check);
        const text = document.createElement('span');
        text.className = 'brf-needs-text';
        const who = document.createElement('span');
        who.className = 'brf-who';
        who.textContent = item.who;
        text.appendChild(who);
        text.appendChild(document.createTextNode(' — ' + item.what));
        if (item.source) {
          const src = document.createElement('span');
          src.className = 'brf-src';
          src.textContent = ' · ' + item.source;
          text.appendChild(src);
        }
        li.appendChild(text);
        if (isDone) li.classList.add('done');
        ul.appendChild(li);
      }
    }
    body.appendChild(ul);
  }
  if (Array.isArray(b.keep_in_mind) && b.keep_in_mind.length) {
    _brfHeading(body, 'keep in mind');
    const ul = document.createElement('ul');
    ul.className = 'brf-list';
    for (const line of b.keep_in_mind) {
      if (typeof line !== 'string' || !line) continue;
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (b.scoreboard) {
    const p = document.createElement('p');
    p.className = 'brf-scoreboard';
    p.textContent = b.scoreboard;
    body.appendChild(p);
  }
  if (b.generated_at) {
    const p = document.createElement('p');
    p.className = 'brf-meta';
    const when = new Date(b.generated_at);
    p.textContent = isNaN(when) ? '' : `written ${when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    if (p.textContent) body.appendChild(p);
  }

  // Note box: free-text feedback for the next check-in ("already did X",
  // "focus on Y Monday"). Stored server-side; the daily-briefing skill reads it back.
  const box = document.createElement('div');
  box.className = 'brf-comment';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'tell claude something for the next check-in…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const send = document.createElement('button');
  send.type = 'button';
  send.textContent = 'send';
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api.briefingFeedback({ type: 'comment', briefing_date: b.date, text });
      input.value = '';
      setStatus('saved for the next check-in');
    } catch (err) {
      reportError('could not save the note', err);
    }
    send.disabled = false;
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  box.appendChild(input);
  box.appendChild(send);
  body.appendChild(box);
}

// Mark a plan item done from the pop-up: task-backed items are genuinely
// completed in Reminders; everything gets a feedback entry so the next
// check-in (and a re-render) knows.
async function _briefingMarkDone(idx, item, li, check) {
  li.classList.remove('linked');
  li.classList.add('done');
  li.title = '';
  check.textContent = '✓';
  check.disabled = true;
  try {
    if (item.task_id && state.allTasks.some(x => x.id === item.task_id)) {
      await api.updateRem(item.task_id, { completed: true });
      try { playCompletionTick(); } catch { /* sound is optional */ }
    }
    const entry = { type: 'done', plan_index: idx, title: item.title };
    if (_briefingCache && _briefingCache.date) entry.briefing_date = _briefingCache.date;
    if (item.task_id) entry.task_id = item.task_id;
    await api.briefingFeedback(entry);
    _briefingFeedback.push(entry);
    setStatus('marked done');
  } catch (err) {
    reportError('mark done failed', err);
  }
}

// Reject a plan row: "this isn't a real task / already done / doing something
// else". Feedback-only — the underlying task is never completed or deleted;
// the slot stays in the plan but renders empty. The next briefing run reads the
// 'dismissed' entry and drops the item.
async function _briefingDismiss(idx, item, li) {
  li.classList.remove('linked');
  li.classList.add('dismissed');
  li.title = '';
  const check = li.querySelector('.brf-check');
  if (check) check.disabled = true;
  const dis = li.querySelector('.brf-dismiss');
  if (dis) dis.remove();
  try {
    const entry = { type: 'dismissed', plan_index: idx, title: item.title };
    if (_briefingCache && _briefingCache.date) entry.briefing_date = _briefingCache.date;
    if (item.task_id) entry.task_id = item.task_id;
    await api.briefingFeedback(entry);
    _briefingFeedback.push(entry);
    setStatus('dismissed from the plan — the task itself is untouched');
  } catch (err) {
    reportError('dismiss failed', err);
  }
}

// Mark a needs-answer item handled: feedback-only (emails aren't tasks) —
// the next check-in reads it and stops resurfacing that thread.
async function _briefingNeedsDone(idx, item, li, check) {
  li.classList.add('done');
  check.textContent = '✓';
  check.disabled = true;
  try {
    const entry = { type: 'needs_done', needs_index: idx, title: `${item.who} — ${item.what}`.slice(0, 200) };
    if (_briefingCache && _briefingCache.date) entry.briefing_date = _briefingCache.date;
    await api.briefingFeedback(entry);
    _briefingFeedback.push(entry);
    setStatus('marked handled');
  } catch (err) {
    reportError('mark handled failed', err);
  }
}

async function openBriefingModal(pinned = false) {
  try {
    const r = await api.briefing();
    if (r.briefing) _briefingCache = r.briefing;
    if (Array.isArray(r.feedback)) _briefingFeedback = r.feedback;
  } catch { /* offline — fall back to the cache */ }
  const b = _briefingCache;
  if (!b) { setStatus('no briefing yet — publish one from your assistant (see examples/skills/daily-briefing)'); return; }
  _renderBriefing(b);
  const overlay = document.getElementById('briefingModal');
  overlay.classList.remove('hidden');
  // Pop-out window (?briefing=1): the briefing IS the page — no close
  // handlers, and no seen-marker (the pop-out shouldn't consume the
  // once-a-day auto-pop).
  if (pinned) return;
  _briefingMarkSeen(b.date);
  const done = () => {
    overlay.classList.add('hidden');
    overlay.removeEventListener('mousedown', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
    _briefingCloseFn = null;
  };
  const onBackdrop = (e) => { if (e.target === overlay) done(); };
  const onKey = (e) => {
    // Keys aimed at the note input must reach it (stopPropagation in capture
    // phase would starve the target) — only Escape closes from there, so a
    // typed backtick doesn't eat the note.
    if (e.target && e.target.tagName === 'INPUT' && overlay.contains(e.target)) {
      if (e.key === 'Escape') { e.preventDefault(); done(); }
      return;
    }
    e.stopPropagation();   // modal traps keys — j/k etc. must not steer the list behind it
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); done(); }
  };
  overlay.addEventListener('mousedown', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _briefingCloseFn = done;
}

// Auto-pop: only on the briefing's own date, only once (BRF_KEY), and never
// over an edit, another overlay, or the tutorial.
async function _maybeShowBriefing() {
  if (BRIEFING_ONLY) return;   // the pop-out window opens the briefing itself, pinned
  try {
    const r = await api.briefing();
    const b = r.briefing;
    if (!b || !b.date) return;
    _briefingCache = b;
    if (Array.isArray(r.feedback)) _briefingFeedback = r.feedback;
    if (!_briefingAutoPopEnabled()) return;   // Settings toggle — ⌘K reopen still works (cache above is set)
    if (b.date !== _localYMD(new Date())) return;
    if (_briefingSeen() === b.date) return;
    if (_editingNow()) return;
    const overlayUp = ['helpOverlay','prompt','quickCapture','palette','reportModal','trashModal','logbookModal','confirmModal','briefingModal','settingsModal','triageModal','habitHistoryModal']
      .some(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
    if (overlayUp || document.getElementById('tutorialOverlay')) return;
    openBriefingModal();
  } catch { /* server hiccup — the ⌘K command still works */ }
}

// ============================================================
// settings pane (⌘, or ⌘K "Settings…")
// One scrollable card, no tabs. THE RULE: every
// user-facing preference lives BOTH here and as a ⌘K command — the controls
// write the exact same persisted keys the ⌘K toggles use, so the two
// surfaces can't drift. When adding a setting, wire both (or consciously
// decide it's ⌘K-only and say why in a comment here).
// ============================================================
let _settingsCloseFn = null;   // set while the modal is open

// Settings that must be shared with the server (settings.json in app data) —
// today just defaultDueTime, because the global capture panel parses on the
// server. Fetched once at boot; the pane reads/writes this cache.
let _sharedSettings = {};
async function _loadSharedSettings() {
  try {
    const r = await api.settings();
    _sharedSettings = r.settings || {};
    if (typeof _sharedSettings.defaultDueTime === 'string') setDefaultDueTime(_sharedSettings.defaultDueTime);
  } catch { /* server hiccup — parser keeps its 9:00 default */ }
}

function _setEl(id) { return document.getElementById(id); }

// Push current state into every control. Called on open and after any change,
// so a toggle flipped elsewhere (⌘K, `s`, the calendar × button) shows true.
function _syncSettingsUI() {
  const theme = localStorage.getItem(THEME_KEY) || 'system';
  _setEl('setTheme').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.value === theme);
    b.setAttribute('aria-checked', b.dataset.value === theme ? 'true' : 'false');
  });
  const custom = customAccentHex();
  _setEl('setAccent').value = effectiveAccentHex();
  _setEl('setAccentHex').textContent = custom || `${effectiveAccentHex()} · default`;
  const sw = (id, on) => _setEl(id).setAttribute('aria-checked', on ? 'true' : 'false');
  sw('setSound', _soundEnabled());
  sw('setZen', _zenEnabled());
  sw('setBuddy', Buddy.enabled());
  sw('setCalendar', !!state.calendarOpen);
  sw('setBriefing', _briefingAutoPopEnabled());
  sw('setHabitSync', !!_sharedSettings.habitSync);
  _setEl('setSort').value = defaultListSort();
  const due = _sharedSettings.defaultDueTime;
  _setEl('setDueTime').value = (typeof due === 'string' && /^\d{2}:\d{2}$/.test(due)) ? due : '09:00';
  _renderHiddenViewRows();
  _renderHabitRows();
}

// Phone habit sync: a server-side setting (settings.json) because the bridge
// runs in the server (lib/habit-bridge.js). SYNC RULE: reachable from the
// Settings pane switch AND ⌘K, both through this one function.
async function _toggleHabitSync() {
  const next = !_sharedSettings.habitSync;
  try {
    const r = await api.settingsSave({ habitSync: next });
    if (r && r.settings) _sharedSettings = r.settings;
    setStatus(next
      ? 'habit sync on — a "Habit tracker" list is being created in Reminders'
      : 'habit sync off — the "Habit tracker" list was removed');
  } catch (e) { reportError('habit sync toggle failed', e); }
  _syncSettingsUI();
}

// Settings → habits: name, weekly target, and remove per habit. Writes the
// same server store as the sidebar dots and the ⌘K toggle commands.
function _renderHabitRows() {
  const wrap = _setEl('setHabits');
  if (!wrap) return;
  wrap.replaceChildren();
  const habits = _activeHabits();
  if (!habits.length) {
    const p = document.createElement('div');
    p.className = 'set-none';
    p.textContent = 'no habits yet — add one below.';
    wrap.appendChild(p);
    return;
  }
  for (const h of habits) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('span');
    label.className = 'set-label';
    label.textContent = h.name;
    const inline = document.createElement('div');
    inline.className = 'set-inline';
    // Optional rotation labels (gym: push, pull, legs, cardio) — checking a
    // day then asks which one, and the sidebar shows what's next.
    const kindsInput = document.createElement('input');
    kindsInput.type = 'text';
    kindsInput.className = 'set-habit-kinds';
    kindsInput.placeholder = 'kinds: push, pull…';
    kindsInput.title = 'optional rotation, comma-separated (empty = plain checks)';
    kindsInput.setAttribute('aria-label', `${h.name} — rotation kinds`);
    kindsInput.value = Array.isArray(h.kinds) ? h.kinds.join(', ') : '';
    kindsInput.addEventListener('change', async () => {
      const kinds = kindsInput.value.split(',').map(s => s.trim()).filter(Boolean);
      try {
        const r = await api.habitUpdate(h.id, { kinds });
        h.kinds = r.habit.kinds;
        kindsInput.value = Array.isArray(h.kinds) ? h.kinds.join(', ') : '';
        renderHabits();
        setStatus(kinds.length ? `${h.name}: rotation ${kinds.join(' → ')}` : `${h.name}: plain checks`);
      } catch (e) { reportError('habit update failed', e); }
    });
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${h.name} — times per week`);
    for (let n = 1; n <= 7; n++) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n}×/wk`;
      if (n === h.target) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      try {
        await api.habitUpdate(h.id, { target: Number(sel.value) });
        h.target = Number(sel.value);
        renderHabits();
        setStatus(`${h.name}: target ${sel.value}×/week`);
      } catch (e) { reportError('habit update failed', e); }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'set-mini';
    del.textContent = 'remove';
    del.addEventListener('click', async () => {
      const yes = await openConfirm({
        title: `Remove "${h.name}"?`,
        body: 'Its checkmark history goes with it. This cannot be undone.',
        confirmLabel: 'remove',
      });
      if (!yes) return;
      try {
        await api.habitDelete(h.id);
        _habitsData.habits = _habitsData.habits.filter(x => x.id !== h.id);
        delete _habitsData.checks[h.id];
        renderHabits();
        _renderHabitRows();
        setStatus(`removed habit "${h.name}"`);
      } catch (e) { reportError('habit remove failed', e); }
    });
    inline.appendChild(kindsInput);
    inline.appendChild(sel);
    inline.appendChild(del);
    row.appendChild(label);
    row.appendChild(inline);
    wrap.appendChild(row);
  }
}

async function _settingsAddHabit() {
  const nameEl = _setEl('setHabitName');
  const targetEl = _setEl('setHabitTarget');
  const name = (nameEl.value || '').trim();
  if (!name) { setStatus('give the habit a name'); nameEl.focus(); return; }
  try {
    const r = await api.habitAdd({ name, target: Number(targetEl.value) });
    _habitsData.habits.push(r.habit);
    nameEl.value = '';
    renderHabits();
    _renderHabitRows();
    setStatus(`habit added: ${r.habit.name} (${r.habit.target}×/week)`);
  } catch (e) { reportError('habit add failed', e); }
}

function _renderHiddenViewRows() {
  const wrap = _setEl('setHiddenViews');
  wrap.replaceChildren();
  const hidden = (state.hiddenSmartViews || []).map(k => SMART_LISTS.find(s => s.key === k)).filter(Boolean);
  if (!hidden.length) {
    const p = document.createElement('div');
    p.className = 'set-none';
    p.textContent = 'no hidden views — hover a smart list in the sidebar and click × to hide it here.';
    wrap.appendChild(p);
    return;
  }
  for (const s of hidden) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('span');
    label.className = 'set-label';
    label.textContent = s.label;   // built-in view names, but textContent stays the habit
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-mini';
    btn.textContent = 'restore';
    btn.addEventListener('click', () => {
      state.hiddenSmartViews = state.hiddenSmartViews.filter(k => k !== s.key);
      persist();
      renderSmartLists();
      setStatus(`restored "${s.label}"`);
      _renderHiddenViewRows();
    });
    row.appendChild(label);
    row.appendChild(btn);
    wrap.appendChild(row);
  }
}

function openSettingsModal() {
  const overlay = _setEl('settingsModal');
  if (!overlay || !overlay.classList.contains('hidden')) return;
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  if (_isPaletteOpen()) closePalette();
  _syncSettingsUI();
  overlay.classList.remove('hidden');
  const close = () => {
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('mousedown', onBackdrop);
    _settingsCloseFn = null;
  };
  const onKey = (e) => {
    // Keys aimed at a focused control must reach it (arrows in the time
    // field, typing in the color input) — only Escape closes from there.
    const t = e.target;
    if (t && overlay.contains(t) && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      return;
    }
    e.stopPropagation();   // modal traps keys — j/k etc. must not steer the list behind it
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); close(); }
  };
  const onBackdrop = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', onBackdrop);
  _settingsCloseFn = close;
}
function toggleSettingsModal() { if (_settingsCloseFn) _settingsCloseFn(); else openSettingsModal(); }

// One-time control wiring — the elements are static; _syncSettingsUI refreshes
// their values on every open/change.
{
  const on = (id, ev, fn) => { const el = _setEl(id); if (el) el.addEventListener(ev, fn); };
  on('setTheme', 'click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    setTheme(b.dataset.value);
    _syncSettingsUI();
  });
  // 'input' fires continuously while dragging inside the macOS color wheel —
  // apply live so the whole app previews the accent as you drag.
  on('setAccent', 'input', (e) => {
    applyAccentColor(e.target.value);
    _setEl('setAccentHex').textContent = e.target.value.toLowerCase();
  });
  on('setAccentReset', 'click', () => {
    applyAccentColor(null);
    _syncSettingsUI();
    setStatus('accent back to the theme default');
  });
  on('setSound', 'click', () => { setCompletionSound(!_soundEnabled()); _syncSettingsUI(); });
  on('setZen', 'click', () => { toggleZenMode(); _syncSettingsUI(); });
  on('setBuddy', 'click', () => { Buddy.toggle(); _syncSettingsUI(); });
  on('setBuddyCard', 'click', () => {
    if (!Buddy.name() || !Buddy.enabled()) { setStatus('no buddy on duty — toggle it on first'); return; }
    if (_settingsCloseFn) _settingsCloseFn();
    Buddy.showCard();
  });
  on('setCalendar', 'click', () => { toggleCalendarPane(); _syncSettingsUI(); });
  on('setHabitSync', 'click', () => { _toggleHabitSync(); });
  on('setBriefing', 'click', () => {
    const next = !_briefingAutoPopEnabled();
    try { localStorage.setItem(BRF_POP_KEY, next ? '1' : '0'); } catch {}
    setStatus(next ? 'briefing will auto-open once a day' : 'briefing pop-up off — ⌘K "today\'s briefing" still works');
    _syncSettingsUI();
  });
  on('setSort', 'change', async (e) => {
    try { localStorage.setItem(DEFAULT_SORT_KEY, e.target.value); } catch {}
    setStatus(`default sort: ${SORT_LABELS[e.target.value] || e.target.value}`);
    await loadTasks();
    renderPinnedPanes();
  });
  on('setDueTime', 'change', async (e) => {
    const v = e.target.value;
    if (!/^\d{2}:\d{2}$/.test(v)) return;   // field cleared — keep the previous value
    setDefaultDueTime(v);
    _sharedSettings.defaultDueTime = v;
    setStatus(`bare dates now land at ${v}`);
    try { await api.settingsSave({ defaultDueTime: v }); }
    catch (err) { reportError('could not save default due time', err); }
  });
  on('setHabitAdd', 'click', _settingsAddHabit);
  on('setHabitName', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _settingsAddHabit(); } });
  on('setOpenTrash', 'click', () => { if (_settingsCloseFn) _settingsCloseFn(); openTrashModal(); });
  on('setTutorial', 'click', async () => {
    if (_settingsCloseFn) _settingsCloseFn();
    const yes = await openConfirm({ title: 'start the tutorial?', body: 'A 30-second guided tour of the app. Esc skips it at any point.', confirmLabel: 'start tutorial', danger: false });
    if (yes) Tutorial.start();
  });
}

// ============================================================
// command palette (⌘K)
// ============================================================
const _paletteEls = {
  overlay: () => document.getElementById('palette'),
  input:   () => document.getElementById('paletteInput'),
  list:    () => document.getElementById('paletteResults'),
};
let _paletteResults = [];
let _paletteSelectedIdx = 0;

// The task that inline-add palette commands (add below / add subtask) act on.
// Null unless we're in a list view with a real task highlighted and the full
// editor is closed — the full editor owns ⌘⏎ (it saves), so those commands
// must not appear while it's open, and inline add only works in a list view.
// (openPalette already closes any editor, so the editor check mostly documents
// intent, but stays correct if that ever changes.)
function _paletteSelectedTask() {
  if (!isListView()) return null;
  if (document.querySelector('.task.editing')) return null;
  const t = state.tasks[state.selectedIdx];
  if (!t || _isNonTaskRow(t)) return null;
  return t;
}
// The selected task for view-independent per-task commands (copy as text).
// Unlike inline-add, this works in ANY view and follows pane focus — mirrors
// the ⌘C key handler so the palette command and the shortcut agree.
function _paletteCommands() {
  // Global / infrequent / hard-to-memorize commands first. Most per-task commands with single-key
  // shortcuts (e/Space, p, f, b, ⏎, dd, tab) are intentionally omitted — when a task
  // is selected the muscle-memory key is faster than ⌘K. Exceptions: add-below (⌘⏎) and add-subtask
  // (⌘⌥⏎) ARE surfaced (conditionally, only with a task highlighted) — they're easy to forget.
  const selTask = _paletteSelectedTask();
  return [
    { id: 'add',          label: 'Add task',                     hint: 'n',        aliases: ['new', 'create'],         run: () => els.quickAdd.focus() },
    ...(selTask ? [
      { id: 'add-below',   label: 'Add task below',              hint: '⌘⏎',       aliases: ['add sibling', 'new below', 'insert below'], run: () => addInline({ asChild: false }) },
      { id: 'add-subtask', label: 'Add subtask',                 hint: '⌘⌥⏎',      aliases: ['add child', 'sub-item', 'subtask', 'sub-task', 'indent'], run: () => addInline({ asChild: true }) },
    ] : []),
    { id: 'search',       label: 'Search tasks',                 hint: '⌘F',       aliases: ['find', 'filter'],        run: () => { els.searchBar.focus(); els.searchBar.select(); } },
    { id: 'help',         label: 'Help / keyboard shortcuts',    hint: '? · ⌘/',   aliases: ['shortcuts', 'keys'],     run: () => toggleHelp() },
    { id: 'settings',     label: 'Settings…',                    hint: '⌘,',       aliases: ['preferences', 'options', 'prefs', 'config', 'accent', 'appearance'], run: () => openSettingsModal() },
    { id: 'report-bug',   label: 'Report a bug',                 hint: '',         aliases: ['bug', 'issue', 'broken', 'report', 'problem', 'feedback'], run: () => openReportModal('bug') },
    { id: 'report-feature', label: 'Request a feature / idea',   hint: '',         aliases: ['feature', 'request', 'idea', 'suggestion', 'wishlist'], run: () => openReportModal('feature') },
    { id: 'report-export', label: 'Export bug reports & feature requests — copy for email', hint: '', aliases: ['export reports', 'copy reports', 'send feedback', 'email feedback', 'share bug reports'], run: () => exportReportsForSharing() },
    { id: 'recently-deleted', label: 'Recently deleted…',        hint: '',         aliases: ['trash', 'deleted', 'restore', 'undo delete', 'bin', 'recover', 'recently deleted'], run: () => openTrashModal() },
    { id: 'plan-day',     label: 'Plan your day — triage overdue & today', hint: '', aliases: ['triage', 'plan', 'plan my day', 'daily review', 'process'], run: () => openTriage() },
    { id: 'logbook',      label: 'Logbook — what got done, day by day', hint: '',   aliases: ['journal', 'history', 'done log', 'what did i do', 'completed history'], run: () => openLogbookModal() },
    // Habits: one toggle-today command per active habit, plus management in
    // Settings (the SYNC RULE: both surfaces write the same server store).
    ...(_activeHabits().map(h => ({
      id: 'habit-' + h.id,
      label: `Habit: ${h.name} — toggle today`,
      hint: '',
      aliases: ['habit', h.name.toLowerCase()],
      run: () => _habitDotClick(h.id, _localYMD(new Date())),
    }))),
    { id: 'habit-history', label: 'Habit history — past weeks',  hint: '',         aliases: ['habits history', 'streak', 'which days', 'gym log'], run: () => openHabitHistory() },
    { id: 'habit-sync', label: 'Toggle habit sync to iPhone',    hint: '',         aliases: ['phone habits', 'sync habits', 'habit tracker list', 'reminders habits'], run: () => _toggleHabitSync() },
    { id: 'habit-manage', label: 'Manage habits…',               hint: '',         aliases: ['habits', 'add habit', 'new habit', 'edit habits', 'habit tracker'], run: () => openSettingsModal() },
    { id: 'new-list',     label: 'New list',                     hint: '⇧L',       aliases: [],                        run: () => newListPrompt() },
    { id: 'reading',      label: 'Reading list (read later)',    hint: '',         aliases: ['read later', 'links', 'bookmarks', 'reading'], run: () => openReadingList() },
    { id: 'reading-refresh', label: 'Refresh reading titles',     hint: '',         aliases: ['refetch titles', 'fix reading names', 'reading site names'], run: () => refreshReadingTitles() },
    { id: 'rename-list',  label: 'Rename current list',          hint: '',         aliases: [],                        run: () => renameCurrentList() },
    { id: 'delete-list',  label: 'Delete current list…',         hint: '',         aliases: ['remove list', 'delete list'], run: () => { if (isListView() && state.currentListId) deleteListFlow(state.currentListId); else setStatus('open a list first'); } },
    { id: 'restore-smart', label: 'Restore hidden sidebar views', hint: '',        aliases: ['unhide', 'show smart lists', 'restore views'], run: () => { state.hiddenSmartViews = []; persist(); renderSmartLists(); setStatus('sidebar views restored'); } },
    { id: 'toggle-calendar', label: 'Toggle calendar pane',       hint: '',        aliases: ['calendar', 'gcal', 'day view', 'schedule', 'events'], run: () => toggleCalendarPane() },
    { id: 'briefing',     label: "Today's briefing",              hint: '',        aliases: ['brief', 'checkin', 'check-in', 'morning', 'plan', 'claude'], run: () => openBriefingModal() },
    { id: 'start-tutorial', label: 'Start tutorial…',             hint: '',        aliases: ['tour', 'guide', 'onboarding', 'help me', 'tutorial'], run: async () => {
        const yes = await openConfirm({ title: 'start the tutorial?', body: 'A 30-second guided tour of the app. Esc skips it at any point.', confirmLabel: 'start tutorial', danger: false });
        if (yes) Tutorial.start();
      } },
    { id: 'completed',    label: `Show completed: ${getShowCompleted() ? 'on' : 'off'} — toggle`, hint: 'c', aliases: ['hide done', 'show done'], run: async () => { toggleShowCompleted(); await loadTasks(); } },
    { id: 'sort',          label: `Sort: ${SORT_LABELS[currentSortMode()]} — cycle`, hint: 's',   aliases: ['order', 'arrange'],      run: () => cycleSortMode() },
    { id: 'sort-priority', label: 'Sort by priority',            hint: '',         aliases: ['order by priority', 'high first', '!'], run: () => setSortMode('priority') },
    { id: 'sort-due',      label: 'Sort by due date',            hint: '',         aliases: ['order by due', 'date'],  run: () => setSortMode('due') },
    { id: 'sort-created',  label: 'Sort by created (newest first)', hint: '',      aliases: ['order by created', 'recent'], run: () => setSortMode('created') },
    { id: 'sort-manual',   label: 'Sort manual (custom order)',  hint: '',         aliases: ['order manual', 'reset order'], run: () => setSortMode('manual') },
    { id: 'theme',        label: `Theme: ${localStorage.getItem(THEME_KEY) || 'system'} — cycle (system / dark / light)`, hint: '', aliases: ['dark mode', 'light mode', 'appearance'], run: () => cycleTheme() },
    { id: 'sound',        label: `Completion sound: ${_soundEnabled() ? 'on' : 'off'} — toggle`, hint: '', aliases: ['mute', 'tick', 'audio'], run: () => toggleCompletionSound() },
    { id: 'zen',          label: `Zen mode: ${_zenEnabled() ? 'on' : 'off'} — hide decorative chrome`, hint: '', aliases: ['minimal', 'minimalist', 'declutter', 'quiet', 'focus'], run: () => toggleZenMode() },
    { id: 'buddy',        label: `Buddy${Buddy.name() ? ` (${Buddy.name()})` : ''}: ${Buddy.enabled() ? 'on' : 'off'} — toggle`, hint: '', aliases: ['pet', 'companion', 'cat', 'tamagotchi'], run: () => setStatus(Buddy.toggle() ? 'buddy: on' : 'buddy: off') },
    { id: 'buddy-card',   label: 'Buddy: card (stats & rarity)',  hint: '', aliases: ['stats', 'rarity', 'shiny'], run: () => { if (!Buddy.name() || !Buddy.enabled()) { setStatus('no buddy on duty — toggle it on first'); return; } Buddy.showCard(); } },
    { id: 'buddy-egg',    label: 'Buddy: new egg — rehatch (run twice to confirm)', hint: '', aliases: ['rehatch', 'reroll', 'new buddy'], run: () => setStatus(Buddy.rehatchRequest()) },
    { id: 'refresh',      label: 'Refresh from Reminders',       hint: 'r',        aliases: ['reload', 'sync'],        run: () => refresh() },
    { id: 'snooze',       label: 'Snooze task until…',           hint: 'z',        aliases: ['defer', 'later', 'sleep', 'wake'], run: () => snoozePrompt() },
    { id: 'due-today',     label: 'Due: today',                  hint: '',         aliases: ['reschedule today'], run: () => quickReschedule('today') },
    { id: 'due-tomorrow',  label: 'Due: tomorrow',               hint: '',         aliases: ['reschedule tomorrow'], run: () => quickReschedule('tomorrow') },
    { id: 'due-weekend',   label: 'Due: the weekend (Saturday)', hint: 'w',        aliases: ['saturday', 'reschedule weekend'], run: () => quickReschedule('weekend') },
    { id: 'due-next-week', label: 'Due: next week (+7 days)',    hint: '',         aliases: ['reschedule next week'], run: () => quickReschedule('next-week') },
    { id: 'due-clear',     label: 'Due: clear date',             hint: '',         aliases: ['remove due', 'no date', 'undated', 'strip', 'strip due date'], run: () => quickReschedule('clear') },
    { id: 'reschedule-overdue', label: 'Reschedule all overdue → today', hint: '', aliases: ['overdue', 'rescue', 'catch up', 'today'], run: () => rescheduleAllOverdue() },
    { id: 'section',      label: 'Assign section',               hint: '⇧S',       aliases: ['group'],                 run: () => setSection() },
    ...SMART_LISTS.map(s => ({
      id: 'go-' + s.key,
      label: `Go to: ${s.label}`,
      hint: s.sidebar === false ? '' : 'sidebar',
      aliases: ['view', 'open', s.key.toLowerCase()],
      // Guarded: selectView toggles-CLOSED when already active; "Go to" must never close.
      run: () => { if (state.view !== 'smart:' + s.key) selectView('smart:' + s.key); },
    })),
    ...state.lists.map(l => ({
      id: 'go-list-' + l.id,
      label: `Go to list: ${l.name}`,
      hint: '',
      aliases: ['list', 'open', l.name.toLowerCase()],
      run: () => { if (!(state.view === 'list' && state.currentListId === l.id)) selectList(l.id); },
    })),
    ...Object.keys(state.tagCounts || {}).sort().map(tag => ({
      id: 'go-tag-' + tag,
      label: `Go to tag: #${tag}`,
      hint: '',
      aliases: ['tag', tag],
      run: () => { if (state.view !== 'tag:' + tag) selectView('tag:' + tag); },
    })),
    { id: 'undo',         label: 'Undo last action',             hint: '⌘Z',       aliases: ['restore'],               run: () => performUndo() },
    { id: 'redo',         label: 'Redo last undone action',      hint: '⌘⇧Z',      aliases: ['reapply'],               run: () => performRedo() },
  ];
}

function _matchPaletteCommands(query) {
  const all = _paletteCommands();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const scored = [];
  for (const c of all) {
    const label = c.label.toLowerCase();
    const aliases = (c.aliases || []).map(a => a.toLowerCase());
    let score = 0;
    if (label.startsWith(q)) score = Math.max(score, 100);
    else if (label.includes(q)) score = Math.max(score, 50);
    for (const w of label.split(/[\s/(),]+/)) {
      if (w && w.startsWith(q)) { score = Math.max(score, 70); break; }
    }
    for (const a of aliases) {
      if (a.startsWith(q)) score = Math.max(score, 80);
      else if (a.includes(q)) score = Math.max(score, 35);
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.c);
}

function _renderPaletteResults() {
  const ul = _paletteEls.list();
  ul.innerHTML = '';
  if (_paletteResults.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'palette-empty';
    empty.textContent = 'no matching commands';
    ul.appendChild(empty);
    return;
  }
  for (let i = 0; i < _paletteResults.length; i++) {
    const c = _paletteResults[i];
    const li = document.createElement('li');
    li.className = 'palette-item' + (i === _paletteSelectedIdx ? ' selected' : '');
    li.innerHTML = `<span class="palette-label"></span><span class="palette-hint"></span>`;
    li.querySelector('.palette-label').textContent = c.label;
    if (c.hint) li.querySelector('.palette-hint').textContent = c.hint;
    li.addEventListener('click', () => _runPaletteCommandAt(i));
    li.addEventListener('mouseenter', () => _setPaletteSelected(i));
    ul.appendChild(li);
  }
  const sel = ul.querySelector('.palette-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function _setPaletteSelected(i) {
  if (i < 0 || i >= _paletteResults.length) return;
  _paletteSelectedIdx = i;
  const items = _paletteEls.list().querySelectorAll('.palette-item');
  items.forEach((el, idx) => el.classList.toggle('selected', idx === i));
  const sel = items[i];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function _runPaletteCommandAt(i) {
  const c = _paletteResults[i];
  if (!c) return;
  closePalette();
  try { await c.run(); } catch (err) { reportError('command failed', err); }
}

function openPalette() {
  // Close any active editor before stealing focus.
  if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
  const overlay = _paletteEls.overlay();
  const input = _paletteEls.input();
  overlay.classList.remove('hidden');
  input.value = '';
  _paletteResults = _paletteCommands();
  _paletteSelectedIdx = 0;
  _renderPaletteResults();
  setTimeout(() => { input.focus(); }, 0);
}

function closePalette() {
  _paletteEls.overlay().classList.add('hidden');
  _paletteEls.input().value = '';
}

function _isPaletteOpen() { return !_paletteEls.overlay().classList.contains('hidden'); }

// Wire the input. Listeners attached once at init.
{
  const input = _paletteEls.input();
  if (input) {
    input.addEventListener('input', () => {
      _paletteResults = _matchPaletteCommands(input.value);
      _paletteSelectedIdx = 0;
      _renderPaletteResults();
    });
    input.addEventListener('keydown', async (e) => {
      // Stop propagation so the global capture-phase handler doesn't react
      // (e.g., disengage hover-tracking is fine, but j/k must not steer tasks).
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); _setPaletteSelected(_paletteSelectedIdx + 1); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); _setPaletteSelected(_paletteSelectedIdx - 1); }
      else if (e.key === 'Enter')     { e.preventDefault(); await _runPaletteCommandAt(_paletteSelectedIdx); }
    });
  }
  const overlay = _paletteEls.overlay();
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePalette();
    });
  }
}

// Clicking anywhere on the overlay backdrop (outside the inner card) closes it.
els.helpOverlay.addEventListener('click', (e) => {
  if (e.target === els.helpOverlay) els.helpOverlay.classList.add('hidden');
});
// Double-clicking the bottom hint bar opens the full keyboard-shortcut view (same as ?).
const _hintEl = document.getElementById('hint');
if (_hintEl) _hintEl.addEventListener('dblclick', () => toggleHelp());
els.prompt.addEventListener('click', (e) => {
  if (e.target === els.prompt) {
    els.prompt.classList.add('hidden');
    // Treat as cancel: dispatch Escape to the input so the awaiting promise resolves(null).
    els.promptInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
});

// ============================================================
// keyboard
// ============================================================
function isInputFocused() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}
function _isNonTaskRow(row) { return !!row && (row._isHeader || row._isSection || row._isCompletedOlderHeader || row._isCompletedMegaHeader || row._isCompletedBucketHeader); }

// Move keyboard selection without rebuilding the whole task list DOM — a full
// renderTasks() per j/k keypress stutters on long lists. Mirrors the cheap
// class-swap the mouseenter handler already uses.
function moveSelection(newIdx) {
  // #1: moving off a just-prioritized task lets it settle into its real order
  // (or drop from a smart filter). Clear the pin and rebuild, re-selecting the
  // task we moved onto so focus stays put while the edited row reflows.
  if (state._stickyEditId) {
    const target = state.tasks[newIdx];
    if (!target || target.id !== state._stickyEditId) {
      _clearStickyEdit();
      state._pendingSelectId = target && target.id;
      state.selectedIdx = newIdx;   // provisional — loadTasks honors _pendingSelectId once it resolves
      loadTasks().catch(err => reportError('reload failed', err));
      return;
    }
  }
  state.selectedIdx = newIdx;
  const t = state.tasks[newIdx];
  els.tasks.querySelectorAll('.task.selected').forEach(el => el.classList.remove('selected'));
  if (!t || !t.id) return;
  const li = els.tasks.querySelector(`.task[data-id="${CSS.escape(t.id)}"]`);
  if (li) {
    li.classList.add('selected');
    li.scrollIntoView({ block: 'nearest' });
  } else {
    renderTasks();   // row not in DOM (shouldn't happen) — fall back to full render
  }
}
function recordKey(k) { state.lastKey = k; state.lastKeyAt = Date.now(); }
function isDoubleTap(k, ms = 600) { return state.lastKey === k && (Date.now() - state.lastKeyAt) < ms; }

// Catch-all escape: closes overlays / blurs stray inputs even when no element-specific
// handler matched. Individual input listeners (inline-edit, prompt) handle their own
// cancel via stopPropagation, so this only fires when nobody else claimed the event.
function _globalEscape() {
  if (state.focusedPane) {
    state.focusedPane = null;
    state.paneSelIdx = 0;
    renderPinnedPanes();
    setStatus('');
    return true;
  }
  if (!els.helpOverlay.classList.contains('hidden')) {
    els.helpOverlay.classList.add('hidden'); return true;
  }
  if (!els.prompt.classList.contains('hidden')) {
    els.prompt.classList.add('hidden'); return true;
  }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
    a.blur(); return true;
  }
  return false;
}

document.addEventListener('keydown', async (e) => {
  // Plan-your-day triage open: its own capture handler (registered at open,
  // so it runs AFTER this boot-registered one) owns every key. Bail here or
  // the list shortcuts behind the modal double-fire (e.g. `d` primed a
  // delete on the list's selected task while the triage card showed another).
  if (_triage) return;
  // ⌘K toggles the command palette regardless of focus state. Caught first
  // because it should beat the input-focused early-return below.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    e.stopPropagation();
    if (_isPaletteOpen()) closePalette(); else openPalette();
    return;
  }
  // ⌘, toggles settings (the Mac preferences convention). Like ⌘K it beats
  // the input-focused early-return below.
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    e.stopPropagation();
    toggleSettingsModal();
    return;
  }
  // ⌥⇧T opens the quick-capture overlay (Todoist-style). Works from anywhere.
  // Match on e.code so it fires regardless of the macOS Option-key glyph that
  // ends up in e.key (e.g. † for Option+T).
  if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyT')) {
    e.preventDefault();
    e.stopPropagation();
    openQuickCapture();
    return;
  }
  // ⌘F toggles search focus regardless of focus state. If the search bar is
  // already focused, blur it (second press exits). Otherwise focus + select.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    // Close any open editor first (same as ⌘K / ⌥⇧T) — otherwise the search
    // re-render destroys the editor mid-edit and leaves its outside-click
    // listener attached, which would swallow the next click and fire a
    // surprise save with stale values.
    if (document.querySelector('.task.editing, .task.inline-editing')) document.body.click();
    if (document.activeElement === els.searchBar) {
      els.searchBar.blur();
    } else {
      els.searchBar.focus();
      els.searchBar.select();
    }
    return;
  }
  // Inline-edit row in progress (⌘⏎ / ⌘⌥⏎). Bail so all keys reach the
  // input — its listener handles Enter/Esc/`, default text input handles
  // letters. Module-scoped flag (not a DOM query) so a stale class on a
  // task row can't permanently disable the global handler.
  if (_inlineEditActive) return;
  if (isInputFocused()) {
    if (e.target === els.quickAdd) {
      // Autocomplete dropdown first: while it's open, ↑/↓/Enter/Tab/Esc
      // belong to it (Esc closes just the dropdown, not the quick-add).
      if (_qaCompKeydown(e)) return;
      if (e.key === 'Enter')      { e.preventDefault(); await quickAdd(); return; }
      if (e.key === 'Escape' || e.key === '`') {
        e.preventDefault(); els.quickAdd.value = ''; els.quickAdd.blur(); return;
      }
      // '/' leaves the add box only when it's empty; with text typed it's a
      // literal character, so a task like "tank Max/Alex" types fine. (#7)
      if (e.key === '/' && !els.quickAdd.value) {
        e.preventDefault(); els.quickAdd.blur(); return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        els.quickAdd.blur();
        // Land on first focusable task.
        state.selectedIdx = 0;
        while (state.selectedIdx < state.tasks.length && _isNonTaskRow(state.tasks[state.selectedIdx])) state.selectedIdx++;
        renderTasks();
        return;
      }
    }
    if (e.target === els.searchBar) {
      if (e.key === 'Escape' || e.key === '`') {
        e.preventDefault(); els.searchBar.value = ''; state.searchQuery = ''; els.searchBar.blur();
        await loadTasks();
        return;
      }
      // Pressing / with empty search jumps to quick-add (vice-versa of ⌘F from quick-add).
      // If search has content, ignore (treat as typed character).
      if (e.key === '/' && !els.searchBar.value) {
        e.preventDefault(); els.searchBar.blur();
        els.quickAdd.focus(); els.quickAdd.select();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); els.searchBar.blur();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        els.searchBar.blur();
        state.selectedIdx = 0;
        while (state.selectedIdx < state.tasks.length && _isNonTaskRow(state.tasks[state.selectedIdx])) state.selectedIdx++;
        renderTasks();
        return;
      }
    }
    return;
  }
  if (!els.helpOverlay.classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === '`' || e.key === '?') { e.preventDefault(); els.helpOverlay.classList.add('hidden'); }
    return;
  }
  // Fallback for any stray Escape / ` that didn't match an overlay or input.
  if (e.key === 'Escape' || e.key === '`') {
    if (_globalEscape()) { e.preventDefault(); return; }
  }

  // ⌘ shortcuts (Mac) — checked before letter switches.
  if (e.metaKey || e.ctrlKey) {
    // ⌘F handled at top of keydown handler (toggle).
    // ⌘/  → help
    if (e.key === '/') { e.preventDefault(); toggleHelp(); return; }
    // ⌘Z → undo  ·  ⌘⇧Z → redo
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); await performUndo(); return; }
    if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) { e.preventDefault(); await performRedo(); return; }
    // ⌘⌫ (Backspace) → delete (alt for users with extensions intercepting `dd`)
    if (e.key === 'Backspace') { e.preventDefault(); await deleteTask(); return; }
    // ⌘⏎  → add sibling below;  ⌘⌥⏎ → add sub-item under selected
    if (e.key === 'Enter') {
      e.preventDefault();
      await addInline({ asChild: !!e.altKey });
      return;
    }
    // ⌘⇧↑ / ⌘⇧↓ → move task within siblings
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveTask(e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    // Any other ⌘/Ctrl combo is NOT ours: bail without preventDefault so the
    // native key equivalent still fires (⌘W close window, ⌘Q quit, …).
    // Without this, ⌘W fell through to the plain `w` reschedule case
    // (a real bug once).
    return;
  }

  switch (e.key) {
    case 'n': case '/': e.preventDefault(); els.quickAdd.focus(); return;
    case '?':           e.preventDefault(); toggleHelp(); return;
    case 'r': {
      e.preventDefault();
      // r / ⌘R also clears transient state — a half-typed quick-add and any
      // live search — so "why are my tasks gone?" always has a one-key reset
      // ⌘R arrives here too: the shell's Refresh
      // menu item forwards a plain `r` keydown.
      if (els.quickAdd.value) { els.quickAdd.value = ''; els.quickAdd.dispatchEvent(new Event('input')); }
      if (els.searchBar.value || state.searchQuery) { els.searchBar.value = ''; state.searchQuery = ''; }
      await refresh(); return;
    }
    case 'c':
      e.preventDefault();
      toggleShowCompleted();
      setStatus(getShowCompleted() ? 'showing completed' : 'hiding completed');
      await loadTasks();
      return;
    case 'L':
      if (e.shiftKey) { e.preventDefault(); await newListPrompt(); return; }
      break;
  }

  if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    if (idx < state.lists.length) {
      e.preventDefault();
      const id = state.lists[idx].id;
      // Re-pressing the active list's number is a no-op. Toggle-to-close is a
      // mouse affordance (sidebar click); on the keyboard it just reads as
      // "my view vanished".
      if (!(state.view === 'list' && id === state.currentListId)) await selectList(id);
    }
    return;
  }

  // ←/→ move keyboard focus between the main pane and pinned panes.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    _cyclePaneFocus(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  // A pinned pane has keyboard focus: task keys act there. Placed BEFORE the
  // empty-main-pane guard — an empty Today must not block pane keys.
  if (state.focusedPane) {
    if (await _paneKeydown(e)) return;
  }

  if (state.tasks.length === 0) return;

  // Tab / Shift+Tab — subtask indent / outdent
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) outdentTask();
    else indentTask();
    return;
  }

  switch (e.key) {
    case 'j': case 'ArrowDown': {
      e.preventDefault();
      let next = state.selectedIdx + 1;
      while (next < state.tasks.length && _isNonTaskRow(state.tasks[next])) next++;
      if (next < state.tasks.length) moveSelection(next);
      break;
    }
    case 'k': case 'ArrowUp': {
      e.preventDefault();
      let prev = state.selectedIdx - 1;
      while (prev >= 0 && _isNonTaskRow(state.tasks[prev])) prev--;
      if (prev >= 0) moveSelection(prev);
      break;
    }
    case 'e':
      e.preventDefault(); await toggleComplete(); break;
    case 'Enter':
      e.preventDefault(); await inlineEditName(); break;
    case 'p':
      e.preventDefault(); await cyclePriority(); break;
    case 'b':
      e.preventDefault(); await bumpDue(); break;
    case 'w':                                  // due → the weekend (Saturday)
      e.preventDefault(); await quickReschedule('weekend'); break;
    case 'B':                                  // shift+B → due back one day
      e.preventDefault(); await quickReschedule('back-day'); break;
    case 'z':
      e.preventDefault(); await snoozePrompt(); break;
    case 'f':
      e.preventDefault(); await toggleFlag(); break;
    case 's':
      e.preventDefault();
      cycleSortMode();
      break;
    case 'S':                                  // shift+S → assign section
      e.preventDefault();
      await setSection();
      break;
    case 'd':
      e.preventDefault();
      e.stopImmediatePropagation();    // beat Chrome extensions like Global Speed (capture phase)
      if (isDoubleTap('d')) { await deleteTask(); recordKey(null); }
      else { setStatus('press d again to delete'); recordKey('d'); }
      break;
    default:
      // Consume any other single character so AppKit doesn't play the system
      // beep for keys with no shortcut binding (WKWebView forwards unhandled
      // keys to the responder chain). Only swallow simple printable keys —
      // skip Tab/Enter/Esc/etc. so they keep their default behavior.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) e.preventDefault();
      recordKey(null);
  }
}, /* useCapture */ true);


// ============================================================
// init
// ============================================================
els.newListBtn.addEventListener('click', newListPrompt);
els.listHeader.addEventListener('dblclick', () => {
  if (isListView()) renameCurrentList();
});
// Make the main pane draggable too: its header (#listHeader) is the handle,
// and its view key is whatever's currently active. Drag it onto a side pane
// to reorder/demote it (the dblclick-rename above still works — the drag has a
// movement threshold, so a click or double-click never starts one).
{
  const primaryPane = document.getElementById('taskPane');
  if (primaryPane) _attachPaneReorder(primaryPane, els.listHeader, () => _activeViewKey());
}

// Primary pane is a drop zone for cross-list moves whenever it's showing a
// list (so you can drag a task from a pinned pane back into the active list),
// and a smart drop zone when it shows Today / Important / Flagged — dropping
// into the big pane area applies the view's meaning, same as the sidebar row.
{
  const primaryPane = document.getElementById('taskPane');
  if (primaryPane) {
    attachListDropZone(primaryPane, () =>
      (state.view === 'list' && state.currentListId) ? state.currentListId : null
    );
    attachSmartDropZone(primaryPane, () => {
      if (state.searchQuery || !state.view.startsWith('smart:')) return null;
      const s = SMART_LISTS.find(x => 'smart:' + x.key === state.view);
      return s && s.drop ? { kind: s.drop, label: s.label } : null;
    });
  }
}

// Live token preview under the quick-add input.
const _quickAddPreview = document.getElementById('quickAddPreview');
// Tap-to-revert on the parsed date chip: clicking the
// chip demotes the parsed phrase back into the title for THIS input only.
// The flag resets when the box empties or the task is added.
let _quickAddDateOff = false;
function _renderQuickAddPreview() {
  const raw = els.quickAdd.value;
  // The reading list's add box is a link dump, not a task parser — no token chips.
  if (_isReadingView()) { _quickAddPreview.classList.add('hidden'); _quickAddPreview.innerHTML = ''; return; }
  if (!raw.trim()) { _quickAddDateOff = false; _quickAddPreview.classList.add('hidden'); _quickAddPreview.innerHTML = ''; return; }
  const parsed = parseQuickAdd(raw, state.lists, { dateOff: _quickAddDateOff });
  const tags = [];
  // Tags from name
  for (const m of (parsed.name || '').matchAll(TAG_RE)) tags.push(m[1]);
  const chips = [];
  if (parsed.priority) {
    const label = parsed.priority === 'high' ? 'P1 high' : parsed.priority === 'medium' ? 'P2 med' : 'P3 low';
    chips.push(`<span class="tok tok-pri ${parsed.priority}">${label}</span>`);
  }
  if (parsed.dueDate) {
    const d = new Date(parsed.dueDate);
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfDay = new Date(d); startOfDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((startOfDay - startOfToday) / 86400000);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase() + _dueTimeSuffix(d, diffDays);
    chips.push(`<span class="tok tok-due revert" title="click to keep these words in the title (no date)">${label} ×</span>`);
  } else if (_quickAddDateOff) {
    chips.push(`<span class="tok tok-due off" title="click to parse the date again">date off</span>`);
  } else if (parsed.unparsedDate) {
    chips.push(`<span class="tok tok-due bad">?${_escHtml(parsed.unparsedDate)} — not a date</span>`);
  }
  if (parsed.listToken) {
    const target = parsed.listId ? state.lists.find(l => l.id === parsed.listId) : null;
    const cls = parsed.listId ? 'tok tok-list' : 'tok tok-list bad';
    const label = target ? target.name : `ls:${parsed.listToken}?`;
    // List names and tokens are user data — escape like everywhere else
    // (this was the one innerHTML sink in the app that didn't).
    chips.push(`<span class="${cls}">→ ${_escHtml(label)}</span>`);
  }
  for (const tag of tags) chips.push(`<span class="tok tok-tag">#${_escHtml(tag)}</span>`);
  if (chips.length === 0) { _quickAddPreview.classList.add('hidden'); _quickAddPreview.innerHTML = ''; return; }
  _quickAddPreview.innerHTML = chips.join('');
  // mousedown (not click): a click would first blur the input, which hides
  // the preview before the click ever lands. preventDefault keeps focus.
  const dueChip = _quickAddPreview.querySelector('.tok-due.revert, .tok-due.off');
  if (dueChip) {
    dueChip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _quickAddDateOff = !_quickAddDateOff;
      _renderQuickAddPreview();
    });
  }
  _quickAddPreview.classList.remove('hidden');
}
els.quickAdd.addEventListener('input', _renderQuickAddPreview);
els.quickAdd.addEventListener('blur',  () => { _quickAddPreview.classList.add('hidden'); });

// ---- quick-add autocomplete for #tags and ls:lists ----
// A filtered dropdown appears while the token at the caret is `#…` or `ls:…`.
// Keyboard-first: ↑/↓ move, Enter/Tab accept, Esc dismisses (without clearing
// the quick-add). Its keydown handling stops propagation ONLY while the
// dropdown is open, so nothing leaks into the global key map. textContent
// everywhere — tag and list names are user data.
const _qaComplete = document.getElementById('qaComplete');
let _qaCompState = null;   // { mode, tokStart, query, items, sel } | null

function _qaCompHide() {
  _qaCompState = null;
  _qaComplete.classList.add('hidden');
  _qaComplete.innerHTML = '';
}

function _qaCompUpdate() {
  if (_isReadingView()) return _qaCompHide();
  const v = els.quickAdd.value;
  const pos = els.quickAdd.selectionStart;
  if (pos == null) return _qaCompHide();
  // Token = the run of non-space chars ending at the caret.
  let tokStart = pos;
  while (tokStart > 0 && !/\s/.test(v[tokStart - 1])) tokStart--;
  const tok = v.slice(tokStart, pos);
  let mode = null, query = '';
  const tagM = tok.match(/^#([\w-]*)$/);
  const lsM = tok.match(/^ls:(\S*)$/i);
  if (tagM) { mode = 'tag'; query = tagM[1]; }
  else if (lsM) { mode = 'list'; query = lsM[1]; }
  if (!mode) return _qaCompHide();

  const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
  let items;
  if (mode === 'tag') {
    const q = query.toLowerCase();
    items = Object.entries(state.tagCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
      .filter(t => t.toLowerCase().startsWith(q) && t.toLowerCase() !== q);
  } else {
    const q = norm(query);
    items = state.lists
      .map(l => l.name)
      .filter(n => norm(n).includes(q) && norm(n) !== q);
  }
  items = items.slice(0, 8);
  if (!items.length) return _qaCompHide();

  _qaCompState = { mode, tokStart, query, items, sel: 0 };
  _qaCompRender();
}

function _qaCompRender() {
  const s = _qaCompState;
  if (!s) return;
  _qaComplete.innerHTML = '';
  s.items.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'qa-comp-row' + (i === s.sel ? ' sel' : '');
    const mark = document.createElement('span');
    mark.className = 'qa-comp-mark';
    mark.textContent = s.mode === 'tag' ? '#' : '→';
    row.appendChild(mark);
    row.appendChild(document.createTextNode(name));
    // mousedown, not click: a click would blur the input first.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); s.sel = i; _qaCompAccept(); });
    _qaComplete.appendChild(row);
  });
  _qaComplete.classList.remove('hidden');
}

function _qaCompAccept() {
  const s = _qaCompState;
  if (!s) return;
  const picked = s.items[s.sel];
  // Lists insert their normalized shorthand (`ls:todos`) — guaranteed to
  // resolve via _matchListByToken's exact normalized match. Tags insert as-is.
  const insert = s.mode === 'tag'
    ? '#' + picked
    : 'ls:' + picked.toLowerCase().replace(/[\s_-]+/g, '');
  const v = els.quickAdd.value;
  const pos = els.quickAdd.selectionStart;
  els.quickAdd.value = v.slice(0, s.tokStart) + insert + ' ' + v.slice(pos);
  const caret = s.tokStart + insert.length + 1;
  els.quickAdd.setSelectionRange(caret, caret);
  _qaCompHide();
  _renderQuickAddPreview();
}

els.quickAdd.addEventListener('input', _qaCompUpdate);
els.quickAdd.addEventListener('blur', _qaCompHide);

// Called from the global keydown handler's quick-add branch (that handler is
// document-level CAPTURE, so a listener on the input itself would run too
// late — Escape would already have cleared the box). Returns true when the
// key was consumed by the open dropdown.
function _qaCompKeydown(e) {
  const s = _qaCompState;
  if (!s) return false;                    // dropdown closed → keys behave as ever
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    s.sel = (s.sel + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length;
    _qaCompRender();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    _qaCompAccept();
    return true;
  }
  if (e.key === 'Escape' || e.key === '`') {
    e.preventDefault();
    _qaCompHide();                         // dismiss the dropdown, keep the text
    return true;
  }
  return false;
}

// live search: debounce-free; refresh on every keystroke (search is in-memory)
let _searchDebounceTimer = null;
els.searchBar.addEventListener('input', () => {
  state.searchQuery = els.searchBar.value.trim();
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(loadTasks, 80);
});

// ----- live sync -----
// The server's /api/events SSE stream pushes `changed` whenever EventKit
// reports a store change (including iCloud pushes from iPhone/Siri). Refresh
// is debounced and deferred while anything is being edited, so it can never
// clobber typing. EventSource reconnects automatically if the server restarts.
let _liveRefreshTimer = null;
let _lastFullRefreshAt = Date.now();
function _editingNow() {
  const qc = document.getElementById('quickCapture');
  return _inlineEditActive
    || !!document.querySelector('.task.editing, .task.inline-editing')
    || (qc && !qc.classList.contains('hidden'))
    || isInputFocused();
}
async function _liveRefresh() {
  _liveRefreshTimer = null;
  if (_editingNow()) {
    // Try again once the user is (probably) done.
    _liveRefreshTimer = setTimeout(_liveRefresh, 3000);
    return;
  }
  _lastFullRefreshAt = Date.now();
  try {
    await loadLists();
    if (_editingNow()) { _scheduleLiveRefresh(); return; }
    await refreshAllTasks();
    if (_editingNow()) { _scheduleLiveRefresh(); return; }
    await loadTasks();
    await loadHabits();
    api.counts().then(c => { state.counts = c; renderLists(); }).catch(() => {});
    // The daemon's change event fires for calendar edits too (same EKEventStore).
    if (state.calendarOpen) _loadCalendar().catch(() => {});
    // Pop-out briefing window: re-render so a task completed in the main app
    // (or a done-mark from another surface) strikes through here. Skip while
    // a note is being typed — the re-render would wipe the input.
    if (BRIEFING_ONLY) {
      const inp = document.querySelector('#briefingModal .brf-comment input');
      if (!(inp && document.activeElement === inp && inp.value)) openBriefingModal(true).catch(() => {});
    }
  } catch {} // transient — the next change event retries
}
function _scheduleLiveRefresh() {
  if (_liveRefreshTimer) clearTimeout(_liveRefreshTimer);
  _liveRefreshTimer = setTimeout(_liveRefresh, 800);
}
let _sseSource = null;   // kept so diagnostics can read its readyState (sync health)
try {
  _sseSource = new EventSource('/api/events');
  _sseSource.onmessage = () => _scheduleLiveRefresh();
} catch {}
// Fallback for anything the stream misses: refresh when the window regains
// focus and the data is older than 30s.
window.addEventListener('focus', () => {
  if (Date.now() - _lastFullRefreshAt > 30_000) _scheduleLiveRefresh();
});
// Morning case: the app has been open (backgrounded) since yesterday and the
// briefing was published this morning — check on re-focus. Cheap GET; all the
// once-per-day guards live in _maybeShowBriefing.
window.addEventListener('focus', () => {
  if (_briefingSeen() !== _localYMD(new Date())) _maybeShowBriefing();
});

// Boot loads, retryable: a failed startup shows a STICKY banner with a retry
// button (transient toast + empty app read as "the app is broken").
async function _bootLoads() {
  setStatus('connecting to Reminders…');
  try {
    await loadLists();
    await refreshAllTasks();   // populates tag list + cache for smart views
    await loadTasks();
    setStatus('');
    // Pop-out briefing window: open the briefing pinned and skip the
    // main-window rituals (tour, auto-pop, buddy nag). Live sync still runs.
    if (BRIEFING_ONLY) {
      openBriefingModal(true);
      return;
    }
    // First-run guided tour — after the sidebar/tasks exist to spotlight.
    setTimeout(() => Tutorial.maybeAutoStart(), 400);
    // Daily localStorage GC, off the critical path.
    setTimeout(() => { _gcLocalMaps(); }, 5000);
    // Morning briefing pop-up — after the task cache exists (plan rows link to
    // tasks) and past the tutorial's 400ms auto-start check.
    setTimeout(() => { _maybeShowBriefing(); }, 1200);
    // Overdue-pile nag (buddy worries, self-throttled to once a day). Delayed
    // past the ~5s hatch sequence so a first-run egg isn't interrupted.
    setTimeout(() => {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const rlId = (_readingList() || {}).id;
      const overdue = state.allTasks.filter(t => {
        if (t.completed || !t.dueDate || _isSnoozed(t) || t.listId === rlId) return false;
        const d = new Date(t.dueDate); d.setHours(0, 0, 0, 0);
        return d < todayStart;
      }).length;
      if (overdue >= 5) Buddy.onOverduePile(overdue);
    }, 8000);
  } catch (e) {
    reportError('startup failed', e, { retry: _bootLoads });
  }
}

(async () => {
  Buddy.init();   // independent of Reminders data — animate while connecting
  _loadSharedSettings();   // fire-and-forget: default due time for the quick-add parser
  loadHabits();            // fire-and-forget: sidebar habit dots
  await _bootLoads();
  // Force the document to take focus on launch. Without this, the WKWebView
  // shell can start with the WebView un-focused at the AppKit level and
  // every keystroke beeps until the user clicks somewhere inside the page.
  // Make body keyboard-focusable, focus it, then restore tabindex so it
  // doesn't show up in tab order.
  document.body.setAttribute('tabindex', '-1');
  document.body.focus();
  document.body.removeAttribute('tabindex');
})();
