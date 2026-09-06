// First-run guided tour. Self-contained leaf module (app.js imports it; no
// app-state access) — mirrors the buddy.js pattern. A dim overlay spotlights
// one part of the UI per step with a short instruction card. Esc skips at any
// point; finishing or skipping marks it seen (localStorage) so it never
// auto-runs again. Re-runnable from ⌘K ("Start tutorial…", confirm-gated in
// app.js). All text renders via textContent.

const SEEN_KEY = 'todo-app:tutorial:v1';   // '1' = completed or skipped

// Keep this minimal — the tour is six short steps, not a manual. Voice matches
// the app: lowercase, concise. `target: null` centers the card with no spotlight.
const STEPS = [
  {
    target: null,
    title: 'welcome to todo',
    body: 'a fast, keyboard-first front end for your Apple Reminders — everything here syncs to iPhone and iCloud. this 30-second tour shows the essentials. Esc skips it anytime.',
  },
  {
    target: '#quickAdd',
    title: 'add tasks in plain english',
    body: 'press n and type a task the way you\'d say it — "pay rent friday at noon" or "call mom tomorrow at 5pm". the date is picked up automatically, no special syntax needed.',
    points: [
      '?date pins a date explicitly: ?friday, ?may 3, ?every monday',
      '! sets priority: !1 high · !2 medium · !3 low',
      '#errands adds a tag · ls:groceries picks the list',
    ],
  },
  {
    target: '#lists',
    title: 'your lists',
    body: 'these are your real Reminders lists. press 1–9 to jump between them, ⇧L makes a new one. hover a list for pin (show as a side pane) and delete.',
  },
  {
    target: '#tasks',
    title: 'work the list',
    body: 'j/k or arrows move · e completes · p cycles priority · z snoozes until tomorrow · dd deletes (recoverable for 7 days) · ⏎ opens the full editor.',
  },
  {
    target: '#smartLists',
    title: 'smart views',
    body: 'Today, Important, and friends build themselves from dates and priorities. tick a checkbox to pin a view side-by-side, or drag a task onto Today to schedule it.',
  },
  {
    target: null,
    title: 'capture from anywhere',
    body: '⌥⇧T opens quick capture even while another app is frontmost. ⌘K runs every command (including this tour again), and ? lists all shortcuts. that’s it — enjoy.',
  },
];

let _active = false;
let _step = 0;
let _els = null;   // { overlay, spot, card, title, body, dots, back, next, skip }

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch {}
}

function _build() {
  const overlay = document.createElement('div');
  overlay.id = 'tutorialOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'guided tour');

  const spot = document.createElement('div');
  spot.className = 'tut-spot';

  const card = document.createElement('div');
  card.className = 'tut-card';
  const title = document.createElement('h2');
  const body = document.createElement('p');
  const points = document.createElement('ul');
  points.className = 'tut-points';
  const dots = document.createElement('div');
  dots.className = 'tut-dots';
  const row = document.createElement('div');
  row.className = 'tut-actions';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'tut-skip';
  skip.textContent = 'skip tour';
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '‹ back';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'tut-next';
  row.append(skip, back, next);
  card.append(title, body, points, dots, row);
  overlay.append(spot, card);
  document.body.appendChild(overlay);

  skip.addEventListener('click', () => stop());
  back.addEventListener('click', () => _show(_step - 1));
  next.addEventListener('click', () => {
    if (_step >= STEPS.length - 1) stop();
    else _show(_step + 1);
  });
  return { overlay, spot, card, title, body, points, dots, back, next, skip };
}

function _onKey(e) {
  if (!_active) return;
  e.stopPropagation();
  if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); stop(); return; }
  if (e.key === 'Enter' || e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    if (_step >= STEPS.length - 1) stop();
    else _show(_step + 1);
  }
  if (e.key === 'ArrowLeft') { e.preventDefault(); _show(_step - 1); }
}

function _onResize() { if (_active) _show(_step); }

function _show(i) {
  _step = Math.max(0, Math.min(STEPS.length - 1, i));
  const s = STEPS[_step];
  const { spot, card, title, body, points, dots, back, next } = _els;
  title.textContent = s.title;
  body.textContent = s.body;
  points.textContent = '';
  for (const p of s.points || []) {
    const li = document.createElement('li');
    li.textContent = p;
    points.appendChild(li);
  }
  points.style.display = (s.points && s.points.length) ? 'block' : 'none';
  back.style.visibility = _step === 0 ? 'hidden' : 'visible';
  next.textContent = _step === STEPS.length - 1 ? 'done' : 'next ›';
  dots.textContent = '';
  STEPS.forEach((_, j) => {
    const d = document.createElement('span');
    d.className = 'tut-dot' + (j === _step ? ' on' : '');
    dots.appendChild(d);
  });

  const target = s.target ? document.querySelector(s.target) : null;
  const pad = 6;
  if (target) {
    const r = target.getBoundingClientRect();
    spot.style.display = 'block';
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    // Card beside the spotlight: right of it if there's room, else below,
    // clamped to the viewport.
    const margin = 14;
    const cw = Math.min(340, window.innerWidth - margin * 2);
    card.style.width = `${cw}px`;
    let cx = r.right + margin;
    let cy = r.top;
    if (cx + cw > window.innerWidth - margin) {
      // No room to the right — go below the spotlight instead. The x clamp is
      // floored at the margin LAST, so a viewport narrower than the card can
      // never push it off the left edge.
      cx = Math.min(r.left, window.innerWidth - cw - margin);
      cx = Math.max(margin, cx);
      cy = r.bottom + margin;
    }
    if (cy + 220 > window.innerHeight) cy = Math.max(margin, window.innerHeight - 240);
    card.style.left = `${cx}px`;
    card.style.top = `${cy}px`;
    card.style.transform = 'none';
  } else {
    spot.style.display = 'none';
    card.style.left = '50%';
    card.style.top = '38%';
    card.style.transform = 'translate(-50%, -50%)';
  }
  next.focus();
}

function start() {
  if (_active) return;
  _active = true;
  if (!_els) _els = _build();
  _els.overlay.classList.add('on');
  document.addEventListener('keydown', _onKey, true);
  window.addEventListener('resize', _onResize);
  _show(0);
}

function stop() {
  if (!_active) return;
  _active = false;
  markSeen();   // skipped counts as seen — never nag
  _els.overlay.classList.remove('on');
  document.removeEventListener('keydown', _onKey, true);
  window.removeEventListener('resize', _onResize);
}

// Auto-run once for brand-new users. Called by app.js after the first
// successful boot load, so the sidebar and task list exist to spotlight.
function maybeAutoStart() {
  if (!seen()) start();
}

function isActive() { return _active; }

export const Tutorial = { start, stop, maybeAutoStart, seen, isActive };
