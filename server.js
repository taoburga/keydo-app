import { watch } from 'node:fs';
import { runOperation } from './lib/operations.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import { release, arch } from 'node:os';
import {
  listLists,
  listCounts,
  getReminders,
  getAllReminders,
  addReminder,
  updateReminder,
  getReminder,
  deleteReminder,
  createList,
  renameList,
  deleteList,
  getCalendarEvents,
  warmup,
  onChange,
} from './lib/reminders.js';
import { parseQuickAdd, setDefaultDueTime } from './public/parse.js';
import { trashAdd, trashAddMany, trashList, trashGet, trashRemove, trashRemoveMany, briefingRead, feedbackAppend, feedbackList, historyAppend, historyList, prepList, prepFeedbackAppend, prepFeedbackList, settingsRead, settingsWrite, habitsRead, habitAdd, habitUpdate, habitDelete, habitToggle, onDataChange, notifyDataChange, APP_DATA_DIR } from './lib/app-data.js';
import { snapshotFromTasks, diffSnapshots } from './lib/task-history.js';
import { habitBridgeSync, habitBridgeDisable } from './lib/habit-bridge.js';
import { reconcileDeleteFailure } from './lib/delete-safety.js';
import { publicHttpFetch } from './lib/safe-url.js';
import { buildReportExport } from './lib/report-export.js';

// Node 18 fails later with obscure ESM/API errors — fail fast with a clear ask.
const _nodeMajor = Number(process.versions.node.split('.')[0]);
if (_nodeMajor < 20) {
  console.error(`todo-app needs Node 20+ (you have ${process.versions.node}). Upgrade via https://nodejs.org or \`brew install node\`.`);
  process.exit(1);
}

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4321);
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — task notes can be sizable but never this big in practice.

// ---- Issue reports ("Report a bug / feature request", ⌘K) -----------------
// LOCAL-ONLY for now: the frontend POSTs a content-free diagnostic envelope +
// the user's text, and we write a gitignored markdown file under reports/. A
// Claude session running in this repo can then read the latest report and fix
// it. The envelope never carries task names/notes/urls (the frontend builds it
// that way) — that invariant is what would let a future "send to the maintainer"
// transport reuse this exact shape without leaking task data. To add a remote sink later, give
// saveReport() a second sink (e.g. forward to a remote endpoint) keyed off a
// `source` other than 'local'; the schema below already maps to a GH issue row.
// Tests/previews can redirect reports away from the checkout. Production uses
// the gitignored reports/ folder beside server.js.
const REPORTS_DIR = process.env.TODO_REPORTS_DIR || join(__dirname, 'reports');
const REPORT_TEXT_MAX = 8000;            // generous for a description; rejects pasted dumps
const VALID_REPORT_TYPES = new Set(['bug', 'feature']);

// Short commit the server is running, for "which build was this?". Not cached —
// a `git` call is cheap and stays accurate if the user commits without a restart.
async function gitShortSha() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, timeout: 3000 });
    return stdout.trim() || 'unknown';
  } catch { return 'unknown'; }
}

// Authoritative runtime/build facts the BROWSER can't see (or only sees a
// frozen/spoofed value of — WKWebView's userAgent reports macOS 10_15_7). All
// structural: versions, arch, a binary mtime. No task content can reach here.
// Best-effort throughout — a report must never fail because an env read did.
async function serverEnv() {
  const env = {
    node: process.versions.node,
    arch: arch(),
    darwin: release(),               // kernel ver, e.g. "25.5.0"; maps to macOS release
    serverUptimeSec: Math.round(process.uptime()),
    shellManaged: process.env.TODO_SHELL_MANAGED === '1',
  };
  // macOS product version (e.g. "15.5") — friendlier than the Darwin kernel ver.
  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], { timeout: 3000 });
    const v = stdout.trim();
    if (v) env.macos = v;
  } catch { /* non-macOS or sw_vers missing — Darwin ver above still answers */ }
  // Daemon binary mtime — catches "running a stale build" (source rebuilt but
  // the binary wasn't, or vice-versa).
  try {
    const st = await stat(join(__dirname, 'bin', 'reminders-daemon'));
    env.daemonBuilt = st.mtime.toISOString();
  } catch { /* binary absent — surfaced elsewhere as a connect failure */ }
  return env;
}

// Local date/time parts for the id + filename, so a report's stamp matches the
// user's calendar day (UTC slice would shift evening reports to "tomorrow").
function _localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

function _yamlEscape(s) {
  // Frontmatter values are single-line; collapse newlines and quote.
  return JSON.stringify(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
}

// Build the markdown a report file holds AND that we hand back for clipboard.
// The ## Resolution block is filled in by whoever fixes the report (see reports/README.md).
function buildReportMarkdown({ id, type, text, sha, diagnostics, created }) {
  const firstLine = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '(no description)';
  const title = firstLine.slice(0, 80);
  const diagJson = JSON.stringify(diagnostics ?? {}, null, 2);
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    'status: open',          // open | fixed | wontfix — flip to fixed when resolved
    `created: ${created}`,
    'fixed:',                // FUTURE CLAUDE: set to the resolution date when you fix this
    `app_version: ${_yamlEscape(sha)}`,
    'source: local',         // 'local' = this machine; a future beta build could set a tester id
    '---',
    '',
    `# ${type === 'feature' ? 'Feature request' : 'Bug'}: ${title}`,
    '',
    '## Report',
    '',
    String(text || '').trim() || '(no description)',
    '',
    '## Diagnostics (captured automatically — content-free: counts & settings, never task text)',
    '',
    '```json',
    diagJson,
    '```',
    '',
    '## Resolution',
    '',
    '<!-- FUTURE CLAUDE: when you fix this, set `status: fixed` and `fixed: <date>` in the',
    '     frontmatter above, then replace this comment with what changed + the commit sha,',
    '     so later sessions don\'t re-investigate an already-fixed report. -->',
    '_open — not yet addressed_',
    '',
  ].join('\n');
}

// The one sink today: write to the local gitignored reports/ dir.
async function saveReport({ type, text, diagnostics }) {
  const now = new Date();
  const { date, time } = _localStamp(now);
  // 4 hex chars of disambiguation so two reports in the same second don't collide.
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const id = `${date}-${time}-${rand}`;
  const sha = await gitShortSha();
  // Augment the client envelope with authoritative server-side runtime facts.
  // Keyed under `serverEnv` and set here (not client-supplied) so it can't be
  // spoofed; still content-free. Guarded so a bad read never blocks the report.
  if (diagnostics && typeof diagnostics === 'object') {
    try { diagnostics.serverEnv = await serverEnv(); } catch { /* skip */ }
  }
  const markdown = buildReportMarkdown({ id, type, text, sha, diagnostics, created: now.toISOString() });
  await mkdir(REPORTS_DIR, { recursive: true });
  const filename = `report-${id}.md`;
  await writeFile(join(REPORTS_DIR, filename), markdown, 'utf8');
  return { id, file: `reports/${filename}`, markdown };
}

async function exportOpenReports() {
  await mkdir(REPORTS_DIR, { recursive: true });
  const names = (await readdir(REPORTS_DIR))
    .filter(name => /^report-[\w.-]+\.md$/.test(name))
    .sort()
    .slice(0, 200);
  const entries = [];
  for (const name of names) {
    try {
      entries.push({ name, markdown: await readFile(join(REPORTS_DIR, name), 'utf8') });
    } catch { /* one unreadable report must not block the rest */ }
  }
  return buildReportExport(entries);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Sentinel used so handleApi() can map "bad JSON" to 400 rather than the generic 500.
class BadRequestError extends Error {
  constructor(msg) { super(msg); this.name = 'BadRequestError'; }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating; destroy the request so the client gets a clean error.
        reject(new BadRequestError('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      const buf = Buffer.concat(chunks, size).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(buf); }
      catch { return reject(new BadRequestError('invalid JSON body')); }
      // Routes index into the body (body.listId, body.type, …); a bare null /
      // string / array would throw a TypeError deeper in and surface as a 500.
      // Reject it here as the caller error it is.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new BadRequestError('request body must be a JSON object'));
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

const VALID_PRIORITIES = new Set(['none', 'high', 'medium', 'low']);

// Validate fields *before* forwarding to the daemon so EventKit never sees junk types.
// Allowed-list approach: anything not recognized just isn't checked here, daemon handles rest.
function validateReminderFields(body) {
  if (body.name != null && typeof body.name !== 'string') throw new BadRequestError('name must be a string');
  if (body.body != null && typeof body.body !== 'string') throw new BadRequestError('body must be a string');
  if (body.url != null && body.url !== '' && typeof body.url !== 'string') throw new BadRequestError('url must be a string');
  if (body.completed != null && typeof body.completed !== 'boolean') throw new BadRequestError('completed must be a boolean');
  if (body.priority != null && !VALID_PRIORITIES.has(body.priority)) {
    throw new BadRequestError(`priority must be one of ${[...VALID_PRIORITIES].join(', ')}`);
  }
  if (body.dueDate != null && body.dueDate !== '') {
    if (typeof body.dueDate !== 'string' || Number.isNaN(Date.parse(body.dueDate))) {
      throw new BadRequestError('dueDate must be an ISO date string or null');
    }
  }
  if (body.listId != null && typeof body.listId !== 'string') throw new BadRequestError('listId must be a string');
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed' }, { 'Allow': 'GET, HEAD' });
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  if (urlPath === '/') urlPath = '/index.html';
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  // Append separator so e.g. PUBLIC_DIR=/x/public can't accidentally match /x/public_other.
  const publicDirWithSep = PUBLIC_DIR.endsWith('/') ? PUBLIC_DIR : PUBLIC_DIR + '/';
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicDirWithSep)) {
    return send(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// ---- Reading-list page-title fetch ----------------------------------------
// Derives a readable name for a saved link from its page <title> / og:title,
// falling back to the bare domain. NOTE: this is the ONE place the server makes
// outbound network requests, and only to URLs the user explicitly saves to
// their reading list. Every initial/redirect URL and its current DNS answers
// are checked against private/non-routable ranges; reads are size-capped
// (~256KB), redirect-capped, and time-bounded (6s).
function _domainOf(host) { return String(host || '').replace(/^www\./i, ''); }
const _NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};
function _decodeEntities(s) {
  return String(s)
    // numeric: decimal (&#39; &#8217;) and hex (&#x27; &#x2019;) — Substack & friends use hex
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    // named entities (decode last so e.g. &amp;#x27; isn't mangled)
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name.toLowerCase() in _NAMED_ENTITIES ? _NAMED_ENTITIES[name.toLowerCase()] : m));
}
// Read a <meta property|name="key" content="…"> value. Quote-aware (captures
// up to the MATCHING quote via a backreference) so a literal apostrophe inside
// a double-quoted value — content="Bentham's Bulldog" — parses correctly.
function _metaContent(head, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = head.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*content=(["\'])([\\s\\S]*?)\\1', 'i'))
         || head.match(new RegExp('<meta[^>]+content=(["\'])([\\s\\S]*?)\\1[^>]*(?:property|name)=["\']' + k + '["\']', 'i'));
  return m && m[2].trim() ? _decodeEntities(m[2]).replace(/\s+/g, ' ').trim() : null;
}
function _titleTag(head) {
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m && m[1].trim() ? _decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
}
// Derive a publication/author name from the <title> when og:site_name is absent.
// Handles "Article — by Author" (Substack & blogs) and "Article | Publication".
function _siteFromTitle(titleTag, ogTitle) {
  if (!titleTag) return null;
  let rest = null;
  if (ogTitle && titleTag.toLowerCase().startsWith(ogTitle.toLowerCase())) rest = titleTag.slice(ogTitle.length);
  if (rest) {
    rest = rest.replace(/^\s*[-|—–·:]+\s*/, '').trim();
    const by = rest.match(/^by\s+(.+)$/i);
    if (by) return by[1].trim();
    if (rest && rest.length <= 60 && !/\s[-|—–·]\s/.test(rest)) return rest;
  }
  const segs = titleTag.split(/\s[-|—–·]\s/);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1].replace(/^by\s+/i, '').trim();
    if (last && last.length <= 60 && (!ogTitle || last.toLowerCase() !== ogTitle.toLowerCase())) return last;
  }
  return null;
}
// schema.org JSON-LD publisher name (Substack/news platforms set this).
function _extractSiteNameLD(head) {
  const blocks = head.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const json = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '').trim();
    let data; try { data = JSON.parse(json); } catch { continue; }
    for (const d of (Array.isArray(data) ? data : [data])) {
      const name = d && ((d.publisher && d.publisher.name) || (d.isPartOf && d.isPartOf.name));
      if (typeof name === 'string' && name.trim()) return _decodeEntities(name).trim();
    }
  }
  return null;
}
let _titleFetchActive = 0;
async function fetchPageTitle(rawUrl) {
  if (_titleFetchActive >= 4) return { domain: 'link' };
  _titleFetchActive++;
  try { return await _fetchPageTitle(rawUrl); }
  finally { _titleFetchActive--; }
}
async function _fetchPageTitle(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new BadRequestError('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequestError('only http(s) URLs');
  const domain = _domainOf(u.hostname);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    // Validate the initial host AND every redirect. `redirect: follow` would let
    // a public URL bounce the local-only server into localhost / LAN services.
    let current = u;
    let res = null;
    for (let redirects = 0; redirects <= 5; redirects++) {
      res = await Promise.race([publicHttpFetch(current.href, {
        signal: ac.signal,
        headers: { 'User-Agent': 'todo-app-reading-list/1.0', 'Accept': 'text/html,application/xhtml+xml' },
      }), new Promise((_, reject) => {
        if (ac.signal.aborted) reject(new Error('title fetch timed out'));
        else ac.signal.addEventListener('abort', () => reject(new Error('title fetch timed out')), { once: true });
      })]);
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      try { if (res.body) await res.body.cancel(); } catch {}
      if (!location || redirects === 5) throw new Error('too many redirects');
      current = new URL(location, current);
    }
    if (!res) return { domain };
    const ct = res.headers.get('content-type') || '';
    const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    if (!/text\/html|application\/xhtml/i.test(ct) || len > 4_000_000) {
      try { if (res.body) await res.body.cancel(); } catch {}
      return { domain };
    }
    if (!res.body) return { domain };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '', received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += dec.decode(value, { stream: true });
      if (received >= 262144 || /<\/head>/i.test(html)) { try { reader.cancel(); } catch {} break; }
    }
    const ogTitle = _metaContent(html, 'og:title') || _metaContent(html, 'twitter:title');
    const titleTag = _titleTag(html);
    const siteName = _metaContent(html, 'og:site_name') || _metaContent(html, 'application-name')
      || _siteFromTitle(titleTag, ogTitle) || _extractSiteNameLD(html);
    return { title: (ogTitle || titleTag) || null, siteName: siteName || null, domain };
  } catch {
    return { domain };   // network error / timeout — fall back to the domain
  } finally {
    clearTimeout(timer);
  }
}

// Restore a trashed task by re-creating it from its snapshot. The task gets a
// NEW EventKit id (EventKit has no true undelete), but name / notes / url /
// priority / due / recurrence / alarms all come back. All-day tasks go back as
// a bare YYYY-MM-DD built from LOCAL components, so they don't become
// timed-midnight (the same rule the rest of the app follows).
function _localYMD(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function restoreFromTrash(trashId) {
  const entry = await trashGet(trashId);
  if (!entry) return runOperation(`restore:${trashId}`, { trashId }, async () => {
    throw Object.assign(new BadRequestError('trash item not found or expired'), { userError: true });
  });
  const t = entry.task || {};
  if (!t.listId || !t.name) throw new BadRequestError('trashed item is missing its list or name');
  let dueDate;
  if (t.dueDate) dueDate = t.allDay ? _localYMD(new Date(t.dueDate)) : t.dueDate;
  // If the task's home list no longer exists (deleted lists send their tasks
  // here), restore into the first available list rather than failing.
  let listId = t.listId;
  const lists = await listLists();
  if (!lists.some(l => l.id === listId)) {
    if (!lists.length) throw new BadRequestError('no list available to restore into');
    listId = lists[0].id;
  }
  const restored = await runOperation(`restore:${trashId}`, { trashId }, async () => {
    const created = await addReminder({
    listId,
    name: t.name,
    body: t.body || undefined,
    url: t.url || undefined,
    priority: (t.priority && t.priority !== 'none') ? t.priority : undefined,
    dueDate,
    recurrence: Array.isArray(t.recurrenceRules) ? undefined : (t.recurrence || undefined),
    recurrenceRules: t.recurrenceRules,
    completed: !!t.completed,
    completionDate: t.completionDate,
    alarms: (Array.isArray(t.alarms) && t.alarms.length) ? t.alarms : undefined,
  });
    return { ok: true, restored: created };
  });
  // The receipt is durable before consuming the snapshot. A purge failure
  // leaves a harmless retryable entry, never a second creation.
  await trashRemove(trashId).catch(() => {});
  return restored;
}

// Query string for the access log, with VALUES stripped. `?url=…` on
// /api/page-title carries a link the user saved to a task — that is task data,
// and the log is a file we invite people to paste into a bug report. Keys are
// structure and stay; values never reach the log.
function _logQuery(url) {
  const keys = [...url.searchParams.keys()];
  return keys.length ? `?${keys.map(k => `${k}=…`).join('&')}` : '';
}

function _serverErrorCategory(e, status) {
  if (status === 400) return e?.userError ? 'eventkit_user_error' : 'bad_request';
  const code = String(e?.code || '').toUpperCase();
  if (/^(EADDRINUSE|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOENT|EACCES|EPERM)$/.test(code)) {
    return code.toLowerCase();
  }
  const s = String(e?.message || '').toLowerCase();
  if (/timed out|timeout/.test(s)) return 'timeout';
  if (/permission|access denied|not authorized/.test(s)) return 'permission';
  if (/daemon|not ready|exited|cooldown/.test(s)) return 'daemon_unavailable';
  return 'internal_error';
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;
  const t0 = Date.now();

  // Server-sent events: pushes a `changed` event whenever the daemon reports
  // an EventKit store change (including iCloud pushes from other devices).
  // The frontend listens and refreshes — this is what makes iPhone edits
  // appear without pressing r.
  if (path === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const changed = () => { try { res.write('data: changed\n\n'); } catch {} };
    const unsubscribe = onChange(changed);
    const unsubscribeData = onDataChange(changed);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 30_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); unsubscribeData(); });
    return;
  }

  try {
    let result, status = 200;
    if (path === '/ping' && method === 'GET') {
      // The native shell compares this launch token before trusting a listener.
      // A generic 200 response on the preferred port must never be mistaken
      // for this app (or opened inside its WKWebView).
      result = { ok: true, app: 'todo-app', launchToken: process.env.TODO_SERVER_TOKEN || null, at: Date.now() };
    } else if (path === '/reports/export' && method === 'GET') {
      result = await exportOpenReports();
    } else if (path === '/lists' && method === 'GET') {
      result = await listLists();
    } else if (path === '/lists/counts' && method === 'GET') {
      result = await listCounts();
    } else if (path === '/lists' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequestError('name (string) required');
      }
      result = await createList(body.name);
    } else if (path.match(/^\/lists\/(.+)$/) && method === 'DELETE') {
      // Delete a list. Every task inside is trashed BEFORE the calendar goes —
      // removing a calendar takes its reminders with it and EventKit has no
      // undelete, so this is the one path where a failed trash write would
      // destroy many tasks at once. Same contract as the single-task delete:
      // persist first, and roll the entries back only when a fresh read proves
      // the delete did not commit.
      const id = decodeURIComponent(path.match(/^\/lists\/(.+)$/)[1]);
      const doomed = await getReminders(id, { includeCompleted: true });
      // One locked batch: either every snapshot is durable or none is.
      const entries = await trashAddMany({ tasks: doomed, source: 'app', deletedBy: 'delete_list' });
      let gone;
      try {
        gone = await deleteList(id);
      } catch (e) {
        // A timeout/crash can happen AFTER EventKit committed the irreversible
        // calendar removal. Only roll back the recovery copies when a fresh
        // EventKit read positively proves the list still exists. Unknown state
        // keeps the trash: a stale copy is safer than permanent data loss.
        try {
          const committed = await reconcileDeleteFailure({
            verifyExists: async () => (await listLists()).some(l => l.id === id),
            rollback: async () => trashRemoveMany(entries.map(entry => entry.trashId)),
          });
          if (!committed) throw e;
        } catch (verifyErr) {
          if (verifyErr === e) throw e;
          console.error('[trash] list delete outcome unknown; keeping snapshots');
          throw e;
        }
        gone = { name: doomed[0]?.listName, reconciledAfterError: true };
      }
      result = { ok: true, name: gone?.name, trashed: entries.length };
    } else if (path.match(/^\/lists\/(.+)$/) && method === 'PATCH') {
      const id = decodeURIComponent(path.match(/^\/lists\/(.+)$/)[1]);
      const body = await readBody(req);
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequestError('name (string) required');
      }
      result = await renameList(id, body.name);
    } else if (path === '/reminders' && method === 'GET') {
      const listId = url.searchParams.get('list');
      const includeCompleted = url.searchParams.get('completed') === '1';
      result = listId
        ? await getReminders(listId, { includeCompleted })
        : await getAllReminders({ includeCompleted });
    } else if (path === '/page-title' && method === 'GET') {
      // Reading list: derive a readable name for a saved link.
      result = await fetchPageTitle(url.searchParams.get('url'));
    } else if (path === '/quickadd' && method === 'POST') {
      // One-shot natural-syntax add ("Buy milk !high ?friday 3pm ls:todos").
      // Used by the global-hotkey capture panel (and handy for Shortcuts/
      // scripts). Parses with the same shared module as the web UI.
      const body = await readBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new BadRequestError('text (string) required');
      }
      const lists = await listLists();
      const parsed = parseQuickAdd(body.text, lists);
      if (!parsed.name) throw new BadRequestError('no task name left after parsing tokens');
      const listId = parsed.listId
        || (typeof body.listId === 'string' && body.listId) || lists[0]?.id;
      if (!listId) throw new BadRequestError('no list available');
      const payload = {
        listId,
        name: parsed.name,
        priority: parsed.priority,
        dueDate: parsed.dueDate,
        recurrence: parsed.recurrence,
        url: parsed.url,
      };
      const operationId = body.operationId || req.headers['idempotency-key'] || randomUUID();
      const created = await runOperation(`quickadd:${operationId}`, { text: body.text, listId: body.listId || null }, () => addReminder(payload));
      result = {
        created,
        // Echo what was understood so the capture panel can show it.
        parsed: {
          name: parsed.name,
          priority: parsed.priority || null,
          dueDate: parsed.dueDate || null,
          recurrence: parsed.recurrence || null,
          url: parsed.url || null,
          listName: (lists.find(l => l.id === listId) || {}).name || '',
          unparsedDate: parsed.unparsedDate || null,
        },
      };
    } else if (path === '/report' && method === 'POST') {
      // Issue report (bug / feature request) → gitignored reports/ markdown file.
      const body = await readBody(req);
      const type = body.type;
      if (!VALID_REPORT_TYPES.has(type)) {
        throw new BadRequestError(`type must be one of ${[...VALID_REPORT_TYPES].join(', ')}`);
      }
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new BadRequestError('text (string) required');
      }
      if (body.text.length > REPORT_TEXT_MAX) {
        throw new BadRequestError(`text too long (max ${REPORT_TEXT_MAX} chars)`);
      }
      if (body.diagnostics != null && typeof body.diagnostics !== 'object') {
        throw new BadRequestError('diagnostics must be an object');
      }
      result = await saveReport({ type, text: body.text, diagnostics: body.diagnostics });
    } else if (path === '/calendar' && method === 'GET') {
      // Calendar-pane data: events for one LOCAL day. ?date=YYYY-MM-DD
      // (defaults to today). Server and daemon share the machine's timezone.
      const dateStr = url.searchParams.get('date') || _localYMD(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new BadRequestError('date must be YYYY-MM-DD');
      }
      const [y, mo, da] = dateStr.split('-').map(Number);
      const start = new Date(y, mo - 1, da, 0, 0, 0, 0);
      if (isNaN(start) || start.getDate() !== da) throw new BadRequestError('invalid date');
      const end = new Date(y, mo - 1, da + 1, 0, 0, 0, 0);
      result = { date: dateStr, events: await getCalendarEvents(start.toISOString(), end.toISOString()) };
    } else if (path === '/settings' && method === 'GET') {
      // Shared app settings (settings.json in app data). Only preferences that
      // BOTH the frontend and the server need live here — today defaultDueTime,
      // which the server-side quick-add parse (global capture panel) must honor.
      result = { settings: await settingsRead() };
    } else if (path === '/settings' && method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if ('defaultDueTime' in body) {
        if (typeof body.defaultDueTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.defaultDueTime)) {
          throw new BadRequestError('defaultDueTime must be "HH:MM" (24h)');
        }
        patch.defaultDueTime = body.defaultDueTime;
      }
      if ('habitSync' in body) {
        if (typeof body.habitSync !== 'boolean') throw new BadRequestError('habitSync must be a boolean');
        patch.habitSync = body.habitSync;
      }
      if (!Object.keys(patch).length) throw new BadRequestError('no known settings in patch');
      result = { settings: await settingsWrite(patch) };
      if (patch.defaultDueTime) setDefaultDueTime(patch.defaultDueTime);
      // Phone habit sync (lib/habit-bridge.js): flipping it on builds the
      // "Habit tracker" list in Reminders; off removes it. Disable is awaited
      // so a failure surfaces in the UI; enable is fire-and-forget (list
      // creation can take a moment and the toggle shouldn't hang on it).
      if (patch.habitSync === true) habitBridgeSync();
      else if (patch.habitSync === false) await habitBridgeDisable();
    } else if (path === '/habits' && method === 'GET') {
      // Habit definitions + checkmarks (habits.json in app data). Habits are
      // NOT tasks — habits.json stays canonical; the optional habit-bridge
      // projects them into a managed Reminders list for the phone.
      result = await habitsRead();
    } else if (path === '/habits' && method === 'POST') {
      const body = await readBody(req);
      try { result = { habit: await habitAdd({ name: body.name, target: body.target, kinds: body.kinds }) }; }
      catch (e) { throw new BadRequestError(e.message); }
      _scheduleBridgeSync();
    } else if (path.match(/^\/habits\/([^/]+)\/toggle$/) && method === 'POST') {
      const id = decodeURIComponent(path.match(/^\/habits\/([^/]+)\/toggle$/)[1]);
      const body = await readBody(req);
      try { result = await habitToggle(id, body.date, body.today, body.kind); }
      catch (e) { throw new BadRequestError(e.message); }
      _scheduleBridgeSync();   // "(next: …)" hint may change
    } else if (path.match(/^\/habits\/([^/]+)$/) && method === 'PATCH') {
      const id = decodeURIComponent(path.match(/^\/habits\/([^/]+)$/)[1]);
      const body = await readBody(req);
      const patch = {};
      if ('name' in body) patch.name = body.name;
      if ('target' in body) patch.target = body.target;
      if ('archived' in body) patch.archived = !!body.archived;
      if ('kinds' in body) patch.kinds = body.kinds;
      try { result = { habit: await habitUpdate(id, patch) }; }
      catch (e) { throw new BadRequestError(e.message); }
      _scheduleBridgeSync();
    } else if (path.match(/^\/habits\/([^/]+)$/) && method === 'DELETE') {
      // Hard delete (definition + all checkmarks). The UI confirms first.
      const id = decodeURIComponent(path.match(/^\/habits\/([^/]+)$/)[1]);
      try { await habitDelete(id); result = { ok: true }; }
      catch (e) { throw new BadRequestError(e.message); }
      _scheduleBridgeSync();
    } else if (path === '/briefing' && method === 'GET') {
      // Latest chief-of-staff briefing, published via the MCP (briefing_set),
      // plus recent user feedback (done-marks + notes) so the pop-up can render
      // already-handled plan items as done. The daily-briefing skill writes the
      // briefing; the app writes the feedback.
      result = { briefing: await briefingRead(), feedback: await feedbackList() };
    } else if (path === '/briefing/feedback' && method === 'POST') {
      // Feedback from the briefing pop-up:
      // {type:'done'|'dismissed'|'needs_done'|'comment', ...}.
      // 'needs_done' = a needs-answer row marked handled (email/Slack, not a
      // task). 'dismissed' = a plan row rejected ("not a real task / already
      // done / doing something else") — feedback only, the task itself is
      // untouched. The daily-briefing skill reads these back via the MCP.
      const body = await readBody(req);
      if (!['done', 'dismissed', 'needs_done', 'comment'].includes(body.type)) {
        throw new BadRequestError('type must be "done", "dismissed", "needs_done" or "comment"');
      }
      const entry = { type: body.type, source: 'app' };
      if (typeof body.briefing_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.briefing_date)) entry.briefing_date = body.briefing_date;
      if (Number.isInteger(body.plan_index) && body.plan_index >= 0 && body.plan_index < 50) entry.plan_index = body.plan_index;
      if (Number.isInteger(body.needs_index) && body.needs_index >= 0 && body.needs_index < 50) entry.needs_index = body.needs_index;
      if (typeof body.task_id === 'string' && body.task_id) entry.task_id = body.task_id.slice(0, 120);
      if (typeof body.title === 'string' && body.title.trim()) entry.title = body.title.trim().slice(0, 200);
      if (typeof body.text === 'string' && body.text.trim()) entry.text = body.text.trim().slice(0, 500);
      if (body.type === 'comment' && !entry.text) throw new BadRequestError('a comment needs text');
      await feedbackAppend(entry);
      result = { ok: true };
    } else if (path === '/prep' && method === 'GET') {
      // Meeting-prep briefs for one local day (published via the MCP,
      // meeting_prep_set), plus recent done/dismiss feedback so the calendar
      // pane can render handled open-loop items as such.
      const dateStr = url.searchParams.get('date') || _localYMD(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new BadRequestError('date must be YYYY-MM-DD');
      }
      result = { date: dateStr, preps: await prepList({ date: dateStr }), feedback: await prepFeedbackList() };
    } else if (path === '/prep/feedback' && method === 'POST') {
      // Reactions from the prep card: done/dismiss marks on open-loop items,
      // free-text notes. Read back by the skills via meeting_prep_get.
      const body = await readBody(req);
      if (body.type !== 'done' && body.type !== 'dismiss' && body.type !== 'comment') {
        throw new BadRequestError('type must be "done", "dismiss" or "comment"');
      }
      const entry = { type: body.type, source: 'app' };
      if (typeof body.prep_key === 'string' && body.prep_key) entry.prep_key = body.prep_key.slice(0, 200);
      if (typeof body.item_text === 'string' && body.item_text.trim()) entry.item_text = body.item_text.trim().slice(0, 300);
      if (typeof body.text === 'string' && body.text.trim()) entry.text = body.text.trim().slice(0, 500);
      if (body.type === 'comment' && !entry.text) throw new BadRequestError('a comment needs text');
      if (body.type !== 'comment' && !entry.item_text) throw new BadRequestError('done/dismiss needs item_text');
      await prepFeedbackAppend(entry);
      result = { ok: true };
    } else if (path === '/history' && method === 'GET') {
      // Task lifecycle events (added/completed/uncompleted/deleted), newest
      // first, from the snapshot-diff recorder. ?since=<epoch-ms|ISO>&limit=N
      const sinceRaw = url.searchParams.get('since');
      let sinceMs = 0;
      if (sinceRaw) {
        const n = Number(sinceRaw);
        sinceMs = Number.isFinite(n) && n > 0 ? n : Date.parse(sinceRaw);
        if (!Number.isFinite(sinceMs)) throw new BadRequestError('since must be epoch ms or an ISO date');
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      result = { events: await historyList({ sinceMs, limit }) };
    } else if (path === '/trash' && method === 'GET') {
      // Recently-deleted bin (deleted tasks from the app OR the MCP), 7-day window.
      result = await trashList();
    } else if (path.match(/^\/trash\/([^/]+)\/restore$/) && method === 'POST') {
      const trashId = decodeURIComponent(path.match(/^\/trash\/([^/]+)\/restore$/)[1]);
      result = await restoreFromTrash(trashId);
    } else if (path.match(/^\/trash\/([^/]+)$/) && method === 'DELETE') {
      // Purge one item from the bin permanently ("delete forever").
      const trashId = decodeURIComponent(path.match(/^\/trash\/([^/]+)$/)[1]);
      await trashRemove(trashId);
      result = { ok: true };
    } else if (path === '/reminders' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.listId !== 'string' || !body.listId ||
          typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequestError('listId + name (strings) required');
      }
      validateReminderFields(body);
      const { operationId = req.headers['idempotency-key'] || randomUUID(), ...payload } = body;
      result = await runOperation(`add:${operationId}`, payload, () => addReminder(payload));
    } else {
      const match = path.match(/^\/reminders\/(.+)$/);
      if (match && method === 'PATCH') {
        const id = decodeURIComponent(match[1]);
        const body = await readBody(req);
        validateReminderFields(body);
        result = await updateReminder(id, body);
      } else if (match && method === 'DELETE') {
        const id = decodeURIComponent(match[1]);
        // TRASH FIRST, THEN DELETE. EventKit deletion is irreversible, so the
        // recoverable copy has to be on disk before we ask for it. The old
        // order (delete → best-effort trash write) meant a failed write lost
        // the task permanently while still reporting success — which broke the
        // app's loudest safety promise. After a failed reply, a fresh read
        // decides whether rollback is safe; unknown outcomes keep the copy.
        const snapshot = await getReminder(id);
        const entry = await trashAdd({ task: snapshot, source: 'app' });
        try {
          result = await deleteReminder(id);
        } catch (e) {
          try {
            const committed = await reconcileDeleteFailure({
              verifyExists: async () => {
                try {
                  await getReminder(id);
                  return true;
                } catch (verifyErr) {
                  if (verifyErr.userError && /reminder not found/i.test(verifyErr.message || '')) return false;
                  throw verifyErr;
                }
              },
              rollback: async () => {
                if (entry) await trashRemove(entry.trashId);
              },
            });
            if (!committed) throw e;
          } catch (verifyErr) {
            if (verifyErr === e) throw e;
            console.error('[trash] task delete outcome unknown; keeping snapshot');
            throw e;
          }
          // The delete committed but its reply was lost. Report success and
          // retain the already-durable recovery copy.
          result = { ok: true, deleted: snapshot, reconciledAfterError: true };
        }
        // Echo the trash id so the frontend's undo can purge the entry when it
        // re-creates the task (restoring a stale entry after an undo would
        // duplicate the task).
        if (entry) result = { ...result, trashId: entry.trashId };
      } else {
        status = 404;
        result = { error: 'not found' };
      }
    }
    const dur = Date.now() - t0;
    console.log(`[${dur}ms] ${status} ${method} ${url.pathname}${_logQuery(url)}`);
    return send(res, status, result);
  } catch (e) {
    const dur = Date.now() - t0;
    // Daemon-flagged user errors (bad date, list not found, …) are the
    // caller's mistake → 400. Everything else (daemon crash, timeout) → 500
    // with code 'unavailable' so the frontend can show an actionable message.
    const status = (e instanceof BadRequestError || e.userError) ? 400 : 500;
    const code = status === 400 ? 'bad_request' : 'unavailable';
    // Never persist free-form daemon/validation messages here: several include
    // user-entered URL/date/recurrence text. The response still carries the
    // friendly detail to the local UI; the pasteable server log gets a fixed
    // structural category only.
    console.error(`[${dur}ms] ${status} ${method} ${url.pathname}${_logQuery(url)} error=${_serverErrorCategory(e, status)}`);
    return send(res, status, { error: e.message, code });
  }
}

// ----- task history recorder -----
// On every daemon change notification (debounced), fetch the full task set and
// diff it against the last snapshot; the resulting added/completed/uncompleted/
// deleted events go to history.jsonl. This catches changes from EVERY surface
// (app, MCP, iPhone, Siri) because they all flow through EventKit — but only
// while this server is running. The first fetch after boot is a silent
// baseline, so a restart never logs phantom events.
let _histSnapshot = null;
let _histTimer = null;
let _histSuspectIds = null;
let _histRunning = false;
async function _histSync() {
  _histTimer = null;
  if (_histRunning) { _scheduleHistSync(); return; }
  _histRunning = true;
  try {
    const tasks = await getAllReminders({ includeCompleted: true });
    if (_histSnapshot === null) { _histSnapshot = snapshotFromTasks(tasks); return; }
    const { events, next } = diffSnapshots(_histSnapshot, tasks);
    // Mass-extinction guard (2026-07-08): a partial daemon response reads as
    // hundreds of tasks vanishing at once and once poisoned the log with 520
    // phantom "deleted" events. If a single diff wipes out >25 tasks AND >30%
    // of the snapshot, distrust the fetch: keep the old baseline and let the
    // next change event retry. Two consecutive identical readings are accepted
    // as real (a deliberate mass cleanup shouldn't stall the recorder forever).
    const deletions = events.filter(e => e.action === 'deleted').length;
    const ids = tasks.map(t => t.id).sort().join('|');
    if (deletions > 25 && deletions > _histSnapshot.size * 0.3 && _histSuspectIds !== ids) {
      _histSuspectIds = ids;
      _scheduleHistSync();
      console.error(`history: suspect fetch (${deletions}/${_histSnapshot.size} tasks vanished at once) — diff skipped, will re-check`);
      return;
    }
    _histSuspectIds = null;
    _histSnapshot = next;
    if (events.length) await historyAppend(events);
  } catch { /* keep the old snapshot; the next change retries */ }
  finally { _histRunning = false; }
}
function _scheduleHistSync() {
  if (_histTimer) clearTimeout(_histTimer);
  _histTimer = setTimeout(_histSync, 2500);
}
onChange(_scheduleHistSync);


// ----- habit → Reminders bridge (phone habit sync) -----
// Debounced on the same daemon change events: a check-off on the iPhone
// arrives as an EventKit change, and habitBridgeSync ingests + resets it.
// No-op unless the habitSync setting is on (it checks internally). Also
// kicked after habit CRUD below so renames/adds project out promptly.
let _bridgeTimer = null;
function _scheduleBridgeSync() {
  if (_bridgeTimer) clearTimeout(_bridgeTimer);
  _bridgeTimer = setTimeout(() => { _bridgeTimer = null; habitBridgeSync(); }, 2000);
}
onChange(_scheduleBridgeSync);


// DNS-rebinding defense: the server is loopback-only, but a malicious webpage
// can rebind its own hostname to 127.0.0.1 and then drive this API as if
// same-origin. Requests must carry the Host header a local client would send.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1', 'localhost',
]);

// CSRF defense. The Host allowlist above stops DNS rebinding but not a plain
// cross-site POST: a page on evil.example can fire a "simple" request (form
// with enctype=text/plain, or fetch with a non-preflighted content-type) whose
// Host header is still 127.0.0.1:4321. Same-origin requests from our own UI
// carry an Origin of http(s)://127.0.0.1:4321 (or localhost); a cross-site
// request carries the attacker's Origin. So: any state-changing request that
// presents an Origin we don't recognize is rejected. Requests with no Origin
// header at all (some same-origin GETs, curl, native clients) are allowed —
// the browser attack surface always includes an Origin.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
]);

const server = createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) {
      return send(res, 403, { error: 'forbidden host' });
    }
    // Applies to EVERY method, not just the mutating ones. A cross-site page
    // can't read our responses, but it CAN fire a blind GET — and
    // /api/page-title makes an outbound request on our behalf, so a foreign
    // Origin must not reach it either. Requests with NO Origin still pass:
    // that's the native ⌥⇧T capture panel (and curl), and the browser attack
    // surface always sends one. Don't turn this into "require an Origin".
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin.toLowerCase())) {
      return send(res, 403, { error: 'forbidden origin' });
    }
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res);
  } catch (e) {
    console.error(`[server] unhandled error=${_serverErrorCategory(e, 500)}`);
    send(res, 500, { error: 'internal error' });
  }
});

// Don't let an aborted client connection take down the process.
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

// A listen failure (almost always: the port is already taken) used to be an
// UNCAUGHT exception — the shell reported a bare "Process exited early" and
// the log held a raw Node stack. Say what happened and what to do instead.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use.\n` +
      `  Todo App may already be running (check the Dock — closing the window does not quit; ⌘Q does).\n` +
      `  Otherwise start on another port:  PORT=5000 ./start.sh\n`
    );
  } else {
    console.error(`\n  Server failed to start (error=${_serverErrorCategory(err, 500)}).\n`);
  }
  process.exit(1);
});

// Rebuild the daemon if its source is newer than the binary (or the binary is
// missing). start.sh does this for terminal launches, but Todo.app spawns
// `node server.js` directly — without this check, Spotlight launches silently
// run a stale daemon after any edit to daemon/Reminders.swift.
async function ensureDaemonBuilt() {
  const src = join(__dirname, 'daemon', 'Reminders.swift');
  const bin = join(__dirname, 'bin', 'reminders-daemon');
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat) return; // no source checkout — nothing to do
  const binStat = await stat(bin).catch(() => null);
  if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return;
  const reason = binStat ? 'source newer than binary' : 'binary missing';
  console.log(`  rebuilding reminders-daemon (${reason})…`);
  try {
    await execFileAsync('bash', [join(__dirname, 'daemon', 'build.sh')], { timeout: 120_000 });
    console.log('  daemon rebuilt.');
  } catch (e) {
    throw new Error('Daemon rebuild failed. No API requests accepted; fix the build and restart.');
  }
}

// Never accept a recovery request using a daemon older than this source.
await ensureDaemonBuilt();
server.listen(PORT, '127.0.0.1', () => {
  setTimeout(_histSync, 5000);
  setTimeout(_scheduleBridgeSync, 7000);
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  todo-app  →  ${url}\n`);

  // Apply persisted settings to the shared parser (the PATCH route re-applies
  // on change; this covers restarts). Missing/invalid → parser keeps 9:00.
  settingsRead()
    .then(s => { if (typeof s.defaultDueTime === 'string') setDefaultDueTime(s.defaultDueTime); })
    .catch(() => {});
  console.log('  First run: macOS will ask permission to control Reminders. Click "OK".');
  console.log('  Press Ctrl+C to stop.\n');

  // Pre-warm Reminders.app so the first user-facing call isn't slow.
  warmup()
    .then(r => console.log(`  warmup ok (${r?.lists ?? 0} lists)\n`))
    .catch(e => console.warn(`  warmup failed error=${_serverErrorCategory(e, 500)}\n`));
});

// When the Swift shell spawned us (TODO_SHELL_MANAGED=1) and then dies without
// a clean quit (force-quit, crash), we get reparented to launchd (ppid 1).
// Exit instead of lingering: an orphan that keeps port 4321 would be silently
// adopted by the next launch — running stale code forever and never being
// killed by anyone. Terminal launches (`npm start`) don't set the env var and
// keep the old behavior.
if (process.env.TODO_SHELL_MANAGED === '1') {
  setInterval(() => {
    if (process.ppid === 1) {
      console.log('[server] parent shell is gone — exiting');
      process.exit(0);
    }
  }, 10_000).unref();
}

// MCP is a separate process; file notifications bridge its app-data writes
// into the same SSE refresh channel without polling the Reminders database.
mkdir(APP_DATA_DIR, { recursive: true }).then(() => {
  const names = new Set(['habits.json', 'settings.json', 'briefing.json', 'prep.json', 'checkin-feedback.jsonl', 'prep-feedback.jsonl']);
  const watcher = watch(APP_DATA_DIR, { persistent: false }, (_event, name) => {
    if (names.has(String(name))) notifyDataChange();
  });
  watcher.on('error', () => {});
}).catch(() => {});
