// Buddy — a tiny ASCII desk pet at the bottom of the sidebar. Homage to
// Claude Code's /buddy (April Fools 2026): species, rarity tiers, shiny
// variants, hats, personality stats, idle loops, click-to-pet hearts, speech
// bubbles, hatch-from-egg.
//
// Self-contained: owns the #buddy + #buddyCard DOM, persists one JSON blob at
// todo-app:buddy:v1 (not task-keyed, so it stays out of the localStorage GC).
// All dialogue lives in buddy-voice.js (data-only); this file is the engine.
// Every frame and bubble line is a static string rendered via textContent.
// Completed-task names are used ONLY for regex topic-matching (never echoed
// into a bubble or anywhere else) — task content is user data.
//
// SPECIES is a data registry: a new buddy is a new entry here (poses) plus a
// voice entry in buddy-voice.js. Rules:
//  - all poses within a species must have the SAME line count (no layout jump)
//  - required poses: idle, blink, happy, worry; optional: flick (falls back to
//    idle), sleep1/sleep2 (auto-derived: blink + " z"/" zZ" on the face line)
//  - hatCol = column where hat art starts (hats render as one extra top line)
// The "soul" (name, species, rarity, shiny, stats, hat) is rolled once at
// hatch and persisted — never regenerate it.

import { VOICE } from './buddy-voice.js';

const BUDDY_KEY = 'todo-app:buddy:v1';

const SPECIES = {
  cat: {
    names: ['mochi', 'soba', 'beans', 'miso', 'pixel', 'noodle', 'olive', 'biscuit'],
    hatCol: 2,
    poses: {
      idle:   [' /\\_/\\', '( o.o )', ' > ^ <'],
      blink:  [' /\\_/\\', '( -.- )', ' > ^ <'],
      flick:  [' /\\_/\\', '( o.o )', ' > ^ <~'],
      happy:  [' /\\_/\\', '( ^.^ )', ' > ^ <'],
      worry:  [' /\\_/\\', '( o.o;)', ' > ^ <'],
    },
  },
  duck: {
    names: ['quincy', 'puddle', 'waddles', 'bill', 'pip'],
    hatCol: 3,
    poses: {
      idle:   ['   __', ' <(o )___', '  ( ._> /', '   `---\''],
      blink:  ['   __', ' <(- )___', '  ( ._> /', '   `---\''],
      flick:  ['   __', ' <(o )___', '  ( ._> /', '   `--~\''],
      happy:  ['   __', ' <(^ )___', '  ( ._> /', '   `---\''],
      worry:  ['   __', ' <(o;)___', '  ( ._> /', '   `---\''],
    },
  },
  penguin: {
    names: ['tux', 'pebble', 'flipper', 'gus', 'wobble'],
    hatCol: 2,
    poses: {
      idle:   ['  (o>', '  //\\', '  V_/'],
      blink:  ['  (->', '  //\\', '  V_/'],
      happy:  ['  (^>', '  //\\', '  V_/'],
      worry:  ['  (o;>', '  //\\', '  V_/'],
    },
  },
  octopus: {
    names: ['inky', 'squiggle', 'otto', 'kelp', 'bubbles'],
    hatCol: 3,
    poses: {
      idle:   ['  ,---.', ' ( o o )', ' ~^~^~^~'],
      blink:  ['  ,---.', ' ( - - )', ' ~^~^~^~'],
      flick:  ['  ,---.', ' ( o o )', ' ^~^~^~^'],
      happy:  ['  ,---.', ' ( ^ ^ )', ' ~^~^~^~'],
      worry:  ['  ,---.', ' ( o o;)', ' ~^~^~^~'],
    },
  },
  ghost: {                            // art: ours-v1 (docs/buddy-art/ours-v1.md)
    names: ['boo', 'wisp', 'echo', 'mist', 'shade'],
    hatCol: 1,
    poses: {
      idle:   [' .---.', '| o o |', '|~^~^~|'],
      blink:  [' .---.', '| - - |', '|~^~^~|'],
      flick:  [' .---.', '| o o |', '|^~^~^|'],
      happy:  [' .---.', '| ^ ^ |', '|~^~^~|'],
      worry:  [' .---.', '| o o;|', '|~^~^~|'],
    },
  },
  blob: {                             // art: ours-v1 (docs/buddy-art/ours-v1.md)
    names: ['gloop', 'jelly', 'bloop', 'squish', 'dot'],
    hatCol: 2,
    poses: {
      idle:   ['  .-.', ' (o o)', '(_____)'],
      blink:  ['  .-.', ' (- -)', '(_____)'],
      happy:  ['  .-.', ' (^ ^)', '(_____)'],
      worry:  ['  .-.', ' (o o;', '(_____)'],
    },
  },
  robot: {
    names: ['beep', 'clank', 'volt', 'gizmo', 'rusty'],
    hatCol: 2,
    poses: {
      idle:   [' [o_o]', ' /|__|\\', '  d  b'],
      blink:  [' [-_-]', ' /|__|\\', '  d  b'],
      happy:  [' [^_^]', ' /|__|\\', '  d  b'],
      worry:  [' [o_o];', ' /|__|\\', '  d  b'],
    },
  },
  mushroom: {
    names: ['morel', 'shroomy', 'button', 'porcini', 'spore'],
    hatCol: 3,
    poses: {
      idle:   ['  .---.', ' (_o.o_)', '   |_|'],
      blink:  ['  .---.', ' (_-.-_)', '   |_|'],
      happy:  ['  .---.', ' (_^.^_)', '   |_|'],
      worry:  ['  .---.', ' (_o.o;)', '   |_|'],
    },
  },
  goose: {                            // art: ours-v1 (docs/buddy-art/ours-v1.md)
    names: ['henk', 'gander', 'agatha', 'menace', 'honk'],
    hatCol: 1,
    poses: {
      idle:   [' <(o )', '   \\ \\_', '   (___)', '    ^ ^'],
      blink:  [' <(- )', '   \\ \\_', '   (___)', '    ^ ^'],
      flick:  [' <(o )', '   \\ \\_', '   (~__)', '    ^ ^'],
      happy:  [' <(^ )', '   \\ \\_', '   (___)', '    ^ ^'],
      worry:  [' <(o;)', '   \\ \\_', '   (___)', '    ^ ^'],
    },
  },
  rabbit: {
    names: ['clover', 'binky', 'hazel', 'pepper', 'flopsy'],
    hatCol: 2,
    poses: {
      idle:   [' (\\_/)', ' ( o.o)', ' c(")(")'],
      blink:  [' (\\_/)', ' ( -.-)', ' c(")(")'],
      happy:  [' (\\_/)', ' ( ^.^)', ' c(")(")'],
      worry:  [' (\\_/)', ' ( o.o;)', ' c(")(")'],
    },
  },
  owl: {
    names: ['archie', 'minerva', 'sage', 'newton', 'hoots'],
    hatCol: 2,
    poses: {
      idle:   ['  {o,o}', '  /)_)', '   " "'],
      blink:  ['  {-,-}', '  /)_)', '   " "'],
      flick:  ['  }o,o{', '  /)_)', '   " "'],
      happy:  ['  {^,^}', '  /)_)', '   " "'],
      worry:  ['  {o,o};', '  /)_)', '   " "'],
    },
  },
  turtle: {
    names: ['sheldon', 'myrtle', 'tank', 'pokey', 'moss'],
    hatCol: 4,
    poses: {
      idle:   ['    ____', '  (o ____)', '    v  v'],
      blink:  ['    ____', '  (- ____)', '    v  v'],
      flick:  ['    ____', '  ( _____)', '    v  v'],
      happy:  ['    ____', '  (^ ____)', '    v  v'],
      worry:  ['    ____', '  (o;____)', '    v  v'],
    },
  },
  snail: {                            // art: ours-v1 (docs/buddy-art/ours-v1.md)
    names: ['turbo', 'gary', 'sluggo', 'shelby', 'drizzle'],
    hatCol: 3,
    poses: {
      idle:   ['   . .', '   \\ /', '   (_)==@'],
      blink:  ['   - -', '   \\ /', '   (_)==@'],
      happy:  ['   ^ ^', '   \\ /', '   (_)==@'],
      worry:  ['   , ,', '   \\ /', '   (_)==@'],
    },
  },
  dragon: {                           // art: redrawn v2 (v1 in docs/buddy-art/ours-v1.md)
    names: ['ember', 'puff', 'cinder', 'wyrm', 'toast'],
    hatCol: 3,
    poses: {
      idle:   ['  <\\  />', '  ( o,o )', '   (===)~', '    v v'],
      blink:  ['  <\\  />', '  ( -,- )', '   (===)~', '    v v'],
      flick:  ['  <\\  />', '  ( o,o )=~', '   (===)~', '    v v'],
      happy:  ['  <\\  />', '  ( ^,^ )', '   (===)~', '    v v'],
      worry:  ['  <\\  />', '  ( o,o;)', '   (===)~', '    v v'],
    },
  },
  axolotl: {
    names: ['axel', 'lottie', 'gillbert', 'mango', 'newt'],
    hatCol: 3,
    poses: {
      idle:   ['  >(o.o)<', '   (___)', '    " "'],
      blink:  ['  >(-.-)<', '   (___)', '    " "'],
      flick:  ['  ~(o.o)~', '   (___)', '    " "'],
      happy:  ['  >(^.^)<', '   (___)', '    " "'],
      worry:  ['  >(o.o;)<', '   (___)', '    " "'],
    },
  },
  cactus: {                           // art: ours-v1 (docs/buddy-art/ours-v1.md)
    names: ['spike', 'prickles', 'perky', 'sandy', 'bristle'],
    hatCol: 3,
    poses: {
      idle:   ['   .|.', '  -(o.o)-', '   \\_v_/'],
      blink:  ['   .|.', '  -(-.-)-', '   \\_v_/'],
      happy:  ['   .|.', '  -(^.^)-', '   \\_v_/'],
      worry:  ['   .|.', '  -(o.o;)-', '   \\_v_/'],
    },
  },
  chonk: {
    names: ['chonk', 'biggie', 'orb', 'pudge', 'bun'],
    hatCol: 4,
    poses: {
      idle:   ['  .------.', ' ( o    o )', '  \'~~~~~~\''],
      blink:  ['  .------.', ' ( -    - )', '  \'~~~~~~\''],
      happy:  ['  .------.', ' ( ^    ^ )', '  \'~~~~~~\''],
      worry:  ['  .------.', ' ( o    o;)', '  \'~~~~~~\''],
    },
  },
  capybara: {                         // art: redrawn v2 (v1 in docs/buddy-art/ours-v1.md)
    names: ['capy', 'barry', 'okra', 'suds', 'melon'],
    hatCol: 2,
    poses: {
      idle:   ['  ,______,', ' /. o     \\', '  U U   U U'],
      blink:  ['  ,______,', ' /. -     \\', '  U U   U U'],
      flick:  ['  ,_@____,', ' /. o     \\', '  U U   U U'],
      happy:  ['  ,______,', ' /. ^     \\', '  U U   U U'],
      worry:  ['  ,______,', ' /. o;    \\', '  U U   U U'],
    },
  },
  frog: {
    names: ['jeremiah', 'hopkins', 'kero', 'lily', 'bud'],
    hatCol: 2,
    poses: {
      idle:   ['  @..@', ' (----)', '(>____<)'],
      blink:  ['  =..=', ' (----)', '(>____<)'],
      flick:  ['  @..@', ' (----)==o', '(>____<)'],
      happy:  ['  @..@', ' (\\__/)', '(>____<)'],
      worry:  ['  @..@', ' (----);', '(>____<)'],
    },
  },
  moth: {
    names: ['luna', 'dusty', 'flicker', 'fuzz', 'lampert'],
    hatCol: 3,
    poses: {
      idle:   ['\\\\ .. //', ' \\(::)/', '  ´||`'],
      blink:  ['\\\\ .. //', ' \\(--)/', '  ´||`'],
      flick:  ['<< .. >>', ' \\(::)/', '  ´||`'],
      happy:  ['\\\\ .. //', ' \\(^^)/', '  ´||`'],
      worry:  ['// .. \\\\', ' /(::)\\', '  ´||`'],
    },
  },
  spider: {
    names: ['webster', 'charlotte', 'silk', 'itsy', 'weaver'],
    hatCol: 3,
    poses: {
      idle:   ['    |', ' (\\(oo)/)', '  //)(\\\\'],
      blink:  ['    |', ' (\\(--)/)', '  //)(\\\\'],
      flick:  ['     \\', ' (\\(oo)/)', '  //)(\\\\'],
      happy:  ['    |', ' (\\(^^)/)', '  //)(\\\\'],
      worry:  ['    |', ' (\\(oo;)/)', '  //)(\\\\'],
    },
  },
  bat: {                              // nocturnal: sleeps 10:00–18:00 instead of 23–6
    names: ['sonar', 'dusk', 'vlad', 'flap', 'noct'],
    hatCol: 3,
    sleepHours: [10, 18],
    poses: {
      idle:   ['/\\,___,/\\', ' \\(o.o)/', '   `v´'],
      blink:  ['/\\,___,/\\', ' \\(-.-)/', '   `v´'],
      flick:  ['v\\,___,/v', ' \\(o.o)/', '   `v´'],
      happy:  ['/\\,___,/\\', ' \\(^.^)/', '   `v´'],
      worry:  ['/\\,___,/\\', ' \\(o.o;)/', '   `v´'],
    },
  },
  trex: {
    names: ['rex', 'tiny', 'chompsky', 'sue', 'bronte'],
    hatCol: 5,
    poses: {
      idle:   ['      __', '     ( o)', ' ,-^^-/ /', '/  ,,  /', ' \'|_|-|_|'],
      blink:  ['      __', '     ( -)', ' ,-^^-/ /', '/  ,,  /', ' \'|_|-|_|'],
      flick:  ['      __', '     ( o)', ' ,-^^-/ /', '/  \'\'  /', ' \'|_|-|_|'],
      happy:  ['      __', '     ( ^)', ' ,-^^-/ /', '/  ,,  /', ' \'|_|-|_|'],
      worry:  ['      __', '     ( o;)', ' ,-^^-/ /', '/  ,,  /', ' \'|_|-|_|'],
    },
  },
  watcher: {                          // secret: never in the normal hatch roll (1% side-roll)
    names: ['iris', 'argus', 'omen', 'scry', 'orb'],
    hatCol: 2,
    secret: true,
    poses: {
      idle:   ['  .---.', ' ( (o) )', '  `---´'],
      blink:  ['  .---.', ' ( (-) )', '  `---´'],
      flick:  ['  .---.', ' ((o)  )', '  `---´'],
      happy:  ['  .---.', ' ( (*) )', '  `---´'],
      worry:  ['  .---.', ' ( (o);)', '  `---´'],
    },
  },
};

// Rarity table (same odds as the original): tier → weight %, star count,
// stat floor, hat pool. Shiny is an independent 1% roll on top.
const RARITIES = [
  { key: 'common',    w: 60, stars: 1, floor: 5,  hats: [] },
  { key: 'uncommon',  w: 25, stars: 2, floor: 15, hats: ['beanie', 'propeller'] },
  { key: 'rare',      w: 10, stars: 3, floor: 25, hats: ['top hat', 'wizard'] },
  { key: 'epic',      w: 4,  stars: 4, floor: 35, hats: ['halo', 'tiny duck'] },
  { key: 'legendary', w: 1,  stars: 5, floor: 50, hats: ['crown'] },
];
const HAT_ART = {
  'beanie': '_n_', 'propeller': '~o~', 'top hat': '[=]', 'wizard': '/^\\',
  'halo': '.o.', 'tiny duck': "<')", 'crown': '\\^/',
};

// Personality stats (todo-flavored take on the original's five). The peak
// stat biases which completion lines the buddy reaches for.
const STAT_KEYS = ['focus', 'chaos', 'cheer', 'wisdom', 'snark'];

// Topic regexes compiled once from buddy-voice.js. Case-insensitive; a bad
// pattern is dropped rather than crashing the pet.
const TOPICS = (VOICE.topics || []).map(t => {
  try { return { re: new RegExp(t.pattern, 'i'), lines: t.lines }; }
  catch { return null; }
}).filter(Boolean);

// Hatch sequence shared by all species — everyone starts as an egg.
const EGG = {
  rest:  ['', '  /``\\', '  \\__/'],
  left:  ['', ' /``\\', ' \\__/'],
  right: ['', '   /``\\', '   \\__/'],
  crack: ['', '  /`,\\', '  \\__/'],
};

const TICK_MS = 700;                 // idle animation cadence
const SLEEP_AFTER_MS = 4 * 60_000;   // no input for 4 min → nap
const BUBBLE_MS = 3500;
const NIGHT = (h) => h >= 23 || h < 6;   // 11pm–6am: the zZ window
// When does THIS species sleep? Default: NIGHT. A species may set
// sleepHours: [start, end) instead (the bat sleeps 10:00–18:00).
// Note: lateNight LINES still key off global NIGHT — the bat's own
// lateNight pool is written as celebration, so that stays correct.
function _sleepyNow() {
  const h = new Date().getHours();
  const w = _sp().sleepHours;
  return w ? (h >= w[0] && h < w[1]) : NIGHT(h);
}

let st = _load();
let ui = null;            // { root, stage, sprite, bubble }
let timer = null;
let tickN = 0;
let override = null;      // { pose?, until } — temporary pose; hold-only during hatch
let lastActivity = Date.now();
let bubbleTimer = null;
let rehatchArmedAt = 0;   // double-invoke confirm for "new egg"
let hatOn = false;        // is the hat currently worn? transient, fluctuates per tick
let petTimes = [];        // recent pet timestamps → overload detection
let reduceMotion = false;
try { reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}

// ----- state & rolls -----
function _load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(BUDDY_KEY) || 'null'); } catch {}
  if (!s || typeof s !== 'object' || !SPECIES[s.species]) {
    return { v: 2, on: true, species: 'cat', name: null, hatched: false, hatchedAt: null };
  }
  if (s.v === 1) {                       // v1 → v2: roll the fields v1 didn't have
    s.v = 2;
    if (s.hatched) Object.assign(s, _rollBones());
    try { localStorage.setItem(BUDDY_KEY, JSON.stringify(s)); } catch {}
  }
  return s;
}
function _save() { try { localStorage.setItem(BUDDY_KEY, JSON.stringify(st)); } catch {} }

function _rollRarity() {
  let r = Math.random() * 100;
  for (const t of RARITIES) { if ((r -= t.w) < 0) return t; }
  return RARITIES[0];
}
// Rarity + shiny + stats + hat. One peak stat (near max), one dump (near floor).
function _rollBones() {
  const tier = _rollRarity();
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = Math.round(tier.floor + Math.random() * (95 - tier.floor));
  const idx = STAT_KEYS.map((_, i) => i).sort(() => Math.random() - 0.5);
  stats[STAT_KEYS[idx[0]]] = Math.round(88 + Math.random() * 12);            // peak
  stats[STAT_KEYS[idx[1]]] = Math.round(tier.floor + Math.random() * 5);     // dump
  return {
    rarity: tier.key,
    shiny: Math.random() < 0.01,
    stats,
    hat: tier.hats.length ? tier.hats[Math.floor(Math.random() * tier.hats.length)] : null,
  };
}
function _peakStat() {
  if (!st.stats) return null;
  return STAT_KEYS.reduce((a, b) => (st.stats[a] >= st.stats[b] ? a : b));
}

// ----- voice selection -----
function _vsp() { return VOICE.species[st.species] || VOICE.species.cat; }
function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Pick from a pool while avoiding the last few spoken lines — the cheap half
// of the "feels alive" illusion (the other half is topic matching).
const _recent = [];
function _say(pool) {
  if (!pool || !pool.length) return null;
  const fresh = pool.filter(l => !_recent.includes(l));
  const line = _pick(fresh.length ? fresh : pool);
  _recent.push(line);
  if (_recent.length > 10) _recent.shift();
  return line;
}

// Species-flavored pool for an event, with the generic pool mixed in so even
// one buddy doesn't exhaust its repertoire too fast.
function _eventPool(kind) {
  const s = _vsp()[kind] || [];
  const g = (VOICE.events || {})[kind] || [];
  if (!s.length) return g;
  if (!g.length) return s;
  return Math.random() < 0.75 ? s : g;
}

// ----- rendering -----
function _sp() { return SPECIES[st.species] || SPECIES.cat; }
function _activity() { lastActivity = Date.now(); }

function _pose(name) {
  const p = _sp().poses;
  if (p[name]) return p[name];
  if (name === 'flick') return p.idle;
  if (name === 'sleep1' || name === 'sleep2') {           // derive: closed eyes + z's
    const base = (p.blink || p.idle).slice();
    base[1] = base[1] + (name === 'sleep1' ? ' z' : ' zZ');
    return base;
  }
  return p.idle;
}
function _hatWorn() { return hatOn && st.hat && HAT_ART[st.hat]; }
// Asleep = scheduled night window OR napping after idle. Used to freeze the hat
// roll (a sleeping buddy doesn't fuss with its hat) and to gate frames in _tick.
function _asleepNow() {
  return _sleepyNow() || Date.now() - lastActivity > SLEEP_AFTER_MS;
}
// Roll the on/off transition once per tick. Hat is mostly off: tiny chance to
// put it on, larger chance to take it off → it shows up briefly, now and then.
// Frozen while asleep — no hats donned or doffed mid-nap.
function _rollHat() {
  if (!st.hat || !HAT_ART[st.hat]) { hatOn = false; return; }
  if (_asleepNow()) return;
  if (hatOn) { if (Math.random() < 1 / 100) hatOn = false; }
  else       { if (Math.random() < 1 / 500) hatOn = true;  }
}
function _setFrame(lines) {
  if (!ui) return;
  if (_hatWorn()) {
    lines = [' '.repeat(_sp().hatCol) + HAT_ART[st.hat], ...lines];
  }
  ui.sprite.textContent = lines.join('\n');
}
function _setRawFrame(lines) { if (ui) ui.sprite.textContent = lines.join('\n'); }  // egg: no hat

function _tick() {
  tickN++;
  _rollHat();
  if (override) {
    if (Date.now() < override.until) {
      if (override.pose) _setFrame(_pose(override.pose));
      return;                        // hold-only override: frames driven elsewhere
    }
    override = null;
  }
  // Scheduled sleep window (species can override — the bat sleeps by day):
  // full closed-eye + animated zZ's.
  if (_sleepyNow()) {
    _setFrame(_pose(tickN % 2 ? 'sleep1' : 'sleep2'));
    return;
  }
  // Daytime idle → nap, but static eyes-closed with NO z's. The drifting zZ's
  // during waking hours read as distracting, so hold a calm closed-eye frame.
  if (Date.now() - lastActivity > SLEEP_AFTER_MS) {
    _setFrame(_pose('blink'));
    return;
  }
  const r = Math.random();
  _setFrame(r < 0.12 ? _pose('blink') : r < 0.22 ? _pose('flick') : _pose('idle'));
}

function _startTicker() { if (!timer) timer = setInterval(_tick, TICK_MS); }
function _stopTicker()  { if (timer) { clearInterval(timer); timer = null; } }

function _bubble(text) {
  if (!ui || !text) return;
  ui.bubble.textContent = text;
  ui.bubble.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => ui.bubble.classList.add('hidden'), BUBBLE_MS);
}

// Staggered floating hearts (4 hearts ≈ the original's 2.5s).
function _hearts(n) {
  if (!ui || reduceMotion) return;
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      if (!st.on || !ui) return;
      const h = document.createElement('span');
      h.className = 'buddy-heart';
      h.textContent = '♥';
      h.style.left = (15 + Math.random() * 55) + '%';
      ui.stage.appendChild(h);
      setTimeout(() => h.remove(), 1600);
    }, i * 380);
  }
}

// ----- lifecycle -----
function _hatch() {
  // Secret species never join the normal roll — a 1% side-roll only
  // (rarer than shiny; nobody knows until an egg opens and it's an eye).
  const normal = Object.keys(SPECIES).filter(k => !SPECIES[k].secret);
  const secret = Object.keys(SPECIES).filter(k => SPECIES[k].secret);
  st.species = (secret.length && Math.random() < 0.01) ? _pick(secret) : _pick(normal);
  st.name = _pick(SPECIES[st.species].names);
  st.hatched = true;
  st.hatchedAt = new Date().toISOString();
  Object.assign(st, _rollBones());
  _save();
  _applyShiny();
  const steps = [EGG.rest, EGG.left, EGG.right, EGG.left, EGG.right, EGG.rest, EGG.crack, EGG.crack];
  const wobbleMs = steps.length * 320;
  override = { until: Date.now() + wobbleMs + 2200 };   // hold the tick loop off
  steps.forEach((f, i) => setTimeout(() => _setRawFrame(f), i * 320));
  setTimeout(() => {
    if (!st.on) return;
    _setFrame(_pose('happy'));
    const fancy = st.shiny ? ' ✦' : '';
    _bubble(_say(VOICE.hatch).replace('{name}', st.name) + fancy);
    _hearts(3);
  }, wobbleMs);
}

function _applyShiny() { if (ui) ui.sprite.classList.toggle('shiny', !!st.shiny); }

function _react(pose, ms, heartN, line) {
  _activity();
  override = { pose, until: Date.now() + ms };
  _setFrame(_pose(pose));
  if (heartN) _hearts(heartN);
  if (line) _bubble(line);
}

function _pet() {
  if (!st.on) return;
  const now = Date.now();
  petTimes = petTimes.filter(t => now - t < 30_000);
  petTimes.push(now);
  if (petTimes.length >= 4) {        // overload: the joke pays off more often
    _react('happy', 2500, 4, Math.random() < 0.8 ? _say(_vsp().petOverload) : null);
    return;
  }
  _react('happy', 2500, 4, Math.random() < 0.5 ? _say(_vsp().pet) : null);
}

// ----- event reactions (called from app.js; all no-op when off) -----
// taskName is regex-matched against topic categories and then discarded —
// never rendered, never stored.
function onTaskCompleted(taskName) {
  if (!st.on || !ui) return;
  let line = null;
  const topic = (typeof taskName === 'string' && taskName)
    ? TOPICS.find(t => t.re.test(taskName)) : null;
  if (Math.random() < (topic ? 0.45 : 0.35)) {
    if (NIGHT(new Date().getHours()) && Math.random() < 0.5) {
      line = _say(_eventPool('lateNight'));
    } else if (topic && Math.random() < 0.5) {
      line = _say(topic.lines);
    } else {
      const peak = _peakStat();
      line = (peak && Math.random() < 0.5) ? _say(VOICE.stats[peak]) : _say(_vsp().complete);
    }
  }
  _react('happy', 1800, 1, line);
}

function onTodayCleared() {
  if (!st.on || !ui) return;
  _react('happy', 3000, 3, _say(_eventPool('todayCleared')));
}

function onOverduePile(n) {
  if (!st.on || !ui) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const stamp = today.toISOString().slice(0, 10);
  if (st.lastOverdueNag === stamp) return;       // at most one nag per day
  st.lastOverdueNag = stamp;
  _save();
  _react('worry', 4000, 0, Math.random() < 0.6 ? `${n} overdue… ${_say(_eventPool('overdue'))}` : null);
}

function onSnoozed() {
  if (!st.on || !ui) return;
  _react('blink', 2000, 0, Math.random() < 0.2 ? _say(_eventPool('snooze')) : null);
}

// ----- stat card (⌘K "Buddy: card") -----
function _starText() {
  const tier = RARITIES.find(r => r.key === st.rarity) || RARITIES[0];
  return '★'.repeat(tier.stars) + '☆'.repeat(5 - tier.stars);
}
function showCard() {
  const overlay = document.getElementById('buddyCard');
  if (!overlay || !st.hatched) return;
  overlay.replaceChildren();                      // rebuild fresh each open
  const card = document.createElement('div');
  card.className = 'overlay-card narrow bcard';

  const sprite = document.createElement('pre');
  sprite.className = 'buddy-sprite bcard-sprite' + (st.shiny ? ' shiny' : '');
  let lines = _pose('happy');
  if (st.hat && HAT_ART[st.hat]) lines = [' '.repeat(_sp().hatCol) + HAT_ART[st.hat], ...lines];
  sprite.textContent = lines.join('\n');

  const name = document.createElement('h2');
  name.textContent = st.name;
  const sub = document.createElement('p');
  sub.className = 'bcard-sub';
  sub.textContent = `${st.shiny ? 'shiny ' : ''}${st.species} · ${st.rarity} ${_starText()}`
    + (st.hat ? ` · ${st.hat}` : '');

  const statsBox = document.createElement('div');
  statsBox.className = 'bcard-stats';
  for (const k of STAT_KEYS) {
    const v = (st.stats || {})[k] ?? 0;
    const row = document.createElement('div'); row.className = 'bcard-stat';
    const lab = document.createElement('span'); lab.className = 'bcard-label'; lab.textContent = k;
    const bar = document.createElement('div'); bar.className = 'bcard-bar';
    const fill = document.createElement('div'); fill.className = 'bcard-fill'; fill.style.width = v + '%';
    bar.appendChild(fill);
    const num = document.createElement('span'); num.className = 'bcard-num'; num.textContent = v;
    row.append(lab, bar, num);
    statsBox.appendChild(row);
  }

  const foot = document.createElement('p');
  foot.className = 'hint';
  const d = st.hatchedAt ? new Date(st.hatchedAt) : null;
  foot.textContent = (d ? `hatched ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase()} · ` : '') + 'esc to close';

  card.append(sprite, name, sub, statsBox, foot);
  overlay.appendChild(card);
  overlay.classList.remove('hidden');

  const close = () => {
    overlay.classList.add('hidden');
    overlay.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey, true);
  };
  const onClick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  overlay.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
}

// "New egg" — destructive (discards the soul), so it requires two palette
// invocations within 8s. Returns a status string for app.js to show.
function rehatchRequest() {
  if (!st.on) return 'buddy is off — toggle it on first';
  if (Date.now() - rehatchArmedAt < 8000) {
    rehatchArmedAt = 0;
    const old = st.name;
    st.hatched = false; st.name = null;
    delete st.rarity; delete st.shiny; delete st.stats; delete st.hat;
    _save();
    _applyShiny();
    _hatch();
    return `goodbye ${old} — a new egg appears`;
  }
  rehatchArmedAt = Date.now();
  _bubble(`a new egg says goodbye to ${st.name} — run again to confirm.`);
  return 'run "new egg" again within 8s to confirm';
}

// ----- show/hide/init -----
function _show() {
  ui.root.classList.remove('hidden');
  _applyShiny();
  _setFrame(_pose('idle'));
  _startTicker();
  if (!st.hatched) _hatch();
}

function _hide() {
  ui.root.classList.add('hidden');
  _stopTicker();
  clearTimeout(bubbleTimer);
  ui.bubble.classList.add('hidden');
}

function init() {
  const root = document.getElementById('buddy');
  if (!root) return;
  const bubble = document.createElement('div');
  bubble.className = 'buddy-bubble hidden';
  const stage = document.createElement('div');
  stage.className = 'buddy-stage';
  const sprite = document.createElement('pre');
  sprite.className = 'buddy-sprite';
  stage.appendChild(sprite);
  root.append(bubble, stage);
  ui = { root, stage, sprite, bubble };

  root.addEventListener('click', _pet);
  document.addEventListener('pointerdown', _activity, { passive: true });
  document.addEventListener('keydown', _activity, { passive: true });
  // The app keeps running after the window closes — don't animate unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _stopTicker();
    else if (st.on) { _startTicker(); }
  });

  if (st.on) _show();
}

function toggle() {
  st.on = !st.on;
  _save();
  if (ui) (st.on ? _show : _hide)();
  return st.on;
}

function enabled() { return st.on; }
function name() { return st.hatched ? st.name : null; }

export const Buddy = {
  init, toggle, enabled, name,
  onTaskCompleted, onTodayCleared, onOverduePile, onSnoozed,
  showCard, rehatchRequest,
};
