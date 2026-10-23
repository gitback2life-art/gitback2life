// Polite limits: every network-using tool in this toolkit goes through this module (see TOOLKIT_RULES.md).
// It reads and obeys each service's robots.txt, spaces requests out, caps how many one command (and one day)
// may send, reuses recent answers instead of asking again, enforces a cool-down on live checks, and reports
// exactly what was sent.
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { nowUtc, safeWrite, TOOLBOX_ROOT } from './common.mjs';
import { checkHop, GuardError, serviceFor } from './guards.mjs';
import { activeScope } from './active_scope.mjs';
import { DISALLOW_ALL, groupFor, isAllowed, MAX_CRAWL_DELAY_SECONDS, MAX_ROBOTS_BYTES, policyForStatus, userAgent } from './robots.mjs';
import { guardedFetch } from './safe_http.mjs';
import { hasSecretUrlParts } from './output.mjs';

export const LIMITS = Object.freeze({
  minIntervalMs: 1000,          // at most 1 request per second to any one service
  maxPerRun: 60,                // total outbound requests one command may send
  maxPerServicePerRun: 30,      // to any one service, per command
  maxPerServicePerDay: 300,     // to any one service, per UTC day, across all commands
  cacheHours: 12,               // reuse a lookup's answer for this long
  minRefreshHours: 1,           // even with --refresh, never repeat the same lookup within this window
  liveCooldownHours: 24,        // a live check of the same URL at most once a day
  unreachableRobotsHours: 1,    // an unreachable robots.txt blocks that service for 1 hour, then is re-read
  maxRedirects: 5,
});

export const CACHE_DIR = join(TOOLBOX_ROOT, '_shared', '.polite_cache');

/**
 * F04: inside the inspect-mode Windows Sandbox the toolbox is a throwaway copy, and safety state must survive in
 * the folder mapped back to the host. That folder is addressed DIRECTLY (no junction, so the general link guard
 * stays on): GITBACK2LIFE_STATE_ROOT may name exactly SANDBOX_STATE_ROOT and nothing else, and writes there are
 * contained to that folder (safeWrite's root), with the same no-link, no-hardlink and real-path checks.
 */
export const SANDBOX_STATE_ROOT = 'C:\\gb2l-state';
export function resolveStateDir(env = process.env) {
  const wanted = env.GITBACK2LIFE_STATE_ROOT;
  if (wanted === undefined || wanted === '') return { dir: CACHE_DIR, root: TOOLBOX_ROOT };
  if (String(wanted).replace(/[\\/]+$/, '').toLowerCase() !== SANDBOX_STATE_ROOT.toLowerCase()) {
    throw new Error(`GITBACK2LIFE_STATE_ROOT may only be ${SANDBOX_STATE_ROOT} (the inspect sandbox's mapped state folder); got ${wanted}`);
  }
  return { dir: SANDBOX_STATE_ROOT, root: SANDBOX_STATE_ROOT };
}
const STATE = resolveStateDir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// resultCaching: lookup RESULTS (investigation data) are only kept on disk when the incident scope says
// persistence is "local"; it starts OFF and is switched on by requireScope. Safety state (daily counters,
// live-check cool-downs, robots.txt policies) is always kept, and expires on its own (see pruneState).
// root: the containment root for state writes (the toolbox, or the sandbox state folder; see resolveStateDir).
const settings = { dir: STATE.dir, root: STATE.root, clock: Date.now, wait: sleep, resultCaching: false };
// V4-02: every write here says what it is. Lookup RESULTS are incident data (save_local is re-authorized at the
// write); counters, locks, robots policies, cool-downs and repeat marks are safety state.
const stateWrite = (file, content, purpose = 'safety-state') => safeWrite(file, content, { overwrite: true, root: settings.root, purpose });

/** Tests point the cache at a throwaway folder and use a fake clock; tools never call this. */
export function configurePolite({ dir = STATE.dir, root = STATE.root, clock = Date.now, wait = sleep, resultCaching = false } = {}) {
  Object.assign(settings, { dir, root, clock, wait, resultCaching });
}

export function setResultCaching(enabled) { settings.resultCaching = Boolean(enabled); }
export const resultCachingEnabled = () => settings.resultCaching;

export class BudgetError extends Error {
  constructor(message) { super(message); this.code = 'POLITE_BUDGET'; }
}
export class RobotsError extends Error {
  constructor(message) { super(message); this.code = 'ROBOTS_DISALLOWED'; }
}

// next: per service, the earliest time the next request may go (reserved slots, F06).
// memo: transient-mode answers, kept in memory for this command only and never written to disk (F06).
const state = { total: 0, perService: new Map(), next: new Map(), cacheHits: 0, robots: new Map(), memo: new Map(), pruned: false };

export function resetPolite() {
  state.total = 0; state.cacheHits = 0;
  state.perService.clear(); state.next.clear(); state.robots.clear(); state.memo.clear(); state.pruned = false;
}

const SAFETY_PREFIXES = ['robots:', 'cooldown:'];
// F07: stored state never contains the original key (which can hold a URL); only its hash and its kind.
export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');
const kindOf = (key) => (key.startsWith('cooldown:') ? 'cooldown' : key.startsWith('robots:') ? 'robots' : key.startsWith('repeat:') ? 'repeat' : 'results');
const entryWindowHours = (entry) => (entry.kind === 'cooldown' ? LIMITS.liveCooldownHours
  : entry.kind === 'repeat' ? LIMITS.minRefreshHours
    : Math.min(LIMITS.cacheHours, entry.value?.ttl_hours ?? Infinity));

/**
 * Delete stored state that has expired: daily counters from earlier UTC days, cool-downs older than 24 h,
 * robots.txt policies and cached results past their window. With { results: true } it ALSO removes all cached
 * lookup results and robots.txt policies now. Daily counters and cool-downs are never removed early:
 * they are safety limits, and clearing them would reset the limits.
 */
export function pruneState({ dir = settings.dir, now = settings.clock, results = false } = {}) {
  const removed = { daily: 0, cooldown: 0, robots: 0, results: 0, repeat: 0 };
  let names = [];
  try { names = readdirSync(dir); } catch { return removed; }
  const today = new Date(now()).toISOString().slice(0, 10);
  for (const name of names) {
    const file = join(dir, name);
    try {
      const daily = /^daily-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (daily) { if (daily[1] < today) { unlinkSync(file); removed.daily += 1; } continue; }
      if (!name.endsWith('.json')) continue;
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      const kind = entry.kind ?? 'results';
      const expired = ageHours(entry, now) >= entryWindowHours(entry);
      if (expired || (results && (kind === 'results' || kind === 'robots'))) { unlinkSync(file); removed[kind] += 1; }
    } catch { /* unreadable entries are left for a person to inspect */ }
  }
  return removed;
}

/** What is stored right now, by kind (for incident_intake state). */
export function stateSummary({ dir = settings.dir } = {}) {
  const out = { daily: 0, cooldown: 0, robots: 0, results: 0, repeat: 0 };
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (/^daily-/.test(name)) { out.daily += 1; continue; }
    try {
      const { kind } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      out[kind ?? 'results'] += 1;
    } catch { /* ignore */ }
  }
  return out;
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * F06: the daily counter file is shared by every command on this machine, so its read-modify-write runs under a
 * lock file created exclusively. If the lock cannot be taken in time, the command stops (fail closed) rather than
 * risk going over the daily limit. A lock older than 10 s is treated as left behind by a crashed command.
 */
function withDailyLock(fn, { lockWaitMs = LOCK_WAIT_MS } = {}) {
  const lock = join(settings.dir, 'daily.lock');
  const until = Date.now() + lockWaitMs;
  for (;;) {
    try { safeWrite(lock, `${process.pid}\n`, { root: settings.root, purpose: 'safety-state' }); break; } catch (e) {
      // Busy: the lock exists, or (Windows) it is being deleted by its holder right now ("delete pending" shows up
      // as EPERM/EACCES/EBUSY). Found by the multi-process stress test; anything else is a real error.
      if (!/refusing to overwrite|EEXIST/.test(e.message) && !LOCK_BUSY_CODES.has(e.code)) throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { takeOverStaleLock(lock); continue; } } catch { continue; }
      if (Date.now() >= until) throw new BudgetError('the shared daily request counter is locked by another command; stopping rather than risk exceeding the daily limit');
      sleepSync(25);
    }
  }
  try { return fn(); } finally { releaseLock(lock); }
}

const LOCK_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Release the lock, retrying briefly through Windows' transient sharing errors so it is never left behind. */
function releaseLock(lock) {
  for (let i = 0; ; i++) {
    try { rmSync(lock, { force: true }); return; } catch (e) {
      if (!LOCK_BUSY_CODES.has(e.code) || i >= 40) throw e;
      sleepSync(25);
    }
  }
}

/**
 * Remove an abandoned lock so that only ONE process can do it: rename is atomic, so of several processes that saw
 * the same stale lock, one rename succeeds and the rest find nothing to rename. If what was renamed turns out to be
 * fresh (another process re-took the lock in between), it is put back with an exclusive hard link, which fails
 * rather than replace a lock someone else has since created.
 */
function takeOverStaleLock(lock) {
  const moved = `${lock}.${randomUUID()}.stale`;
  try { renameSync(lock, moved); } catch { return; } // someone else got there first
  try {
    if (Date.now() - statSync(moved).mtimeMs <= LOCK_STALE_MS) { try { linkSync(moved, lock); } catch { /* a newer lock exists */ } }
  } finally { rmSync(moved, { force: true }); }
}

function bumpDaily(service, clock, limits) {
  const file = join(settings.dir, `daily-${new Date(clock()).toISOString().slice(0, 10)}.json`);
  withDailyLock(() => {
    let counts = {};
    try { counts = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first request today */ }
    const used = counts[service] ?? 0;
    if (used >= limits.maxPerServicePerDay) {
      throw new BudgetError(`daily budget for ${service} reached (${limits.maxPerServicePerDay} requests today, UTC); stopping until tomorrow`);
    }
    counts[service] = used + 1;
    stateWrite(file, JSON.stringify(counts) + '\n');
  }, limits);
}

/**
 * Call before every outbound request. Waits to respect spacing; throws BudgetError instead of exceeding a cap.
 * F06: every check AND its reservation happen synchronously, before the first await, so concurrent callers cannot
 * all pass the same check; spacing hands out reserved time slots per service instead of reading a "last" time.
 */
export async function acquire(service, { limits = LIMITS, clock = settings.clock, wait = settings.wait } = {}) {
  if (!state.pruned) { state.pruned = true; pruneState({ now: clock }); } // keep stored state bounded
  const used = state.perService.get(service) ?? 0;
  if (state.total >= limits.maxPerRun) throw new BudgetError(`run budget reached (${limits.maxPerRun} requests); stopping instead of sending more`);
  if (used >= limits.maxPerServicePerRun) throw new BudgetError(`budget for ${service} reached (${limits.maxPerServicePerRun} requests this run); stopping`);
  bumpDaily(service, clock, limits);
  state.total += 1;
  state.perService.set(service, used + 1);
  const now = clock();
  const slot = Math.max(now, state.next.get(service) ?? now);
  state.next.set(service, slot + limits.minIntervalMs);
  if (slot > now) await wait(slot - now);
  // V4-03: a stop, expiry or narrowing that happened WHILE waiting blocks this request. acquire() is the last step
  // before every outbound request (lookups, robots.txt, live hops, DNS), so the re-check sits here, after the wait.
  activeScope()?.recheck?.();
}

/**
 * F12 (in-flight): send a request while watching its authorization. `check` re-reads the scope every intervalMs
 * while the request is in flight; if it throws (stopped, expired, narrowed), the request is ABORTED and that refusal
 * is reported. With no check (no active scope), the request is sent as is.
 */
export async function sendWatched(send, { check = null, signal: outer, intervalMs = 500 } = {}) {
  const ctl = new AbortController();
  const signal = outer ? AbortSignal.any([outer, ctl.signal]) : ctl.signal;
  let refusal = null;
  const timer = check ? setInterval(() => { try { check(); } catch (e) { refusal = e; ctl.abort(e); } }, intervalMs) : null;
  timer?.unref?.();
  try { return await send(signal); } catch (e) { throw refusal ?? e; } finally { if (timer) clearInterval(timer); }
}

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const offLimits = (basis) => ({ policy: DISALLOW_ALL, basis: `${basis}; treating the site as off-limits`, ttl_hours: LIMITS.unreachableRobotsHours });

/**
 * Read a site's robots.txt (RFC 9309 status rules) with the same safety as every other request: redirects are
 * followed by hand, each hop is checked (public address, no https→http downgrade) and counted against limits.
 * Anything that stops us learning the policy fails CLOSED: the site is treated as off-limits for 1 hour.
 */
export async function fetchRobotsPolicy(siteUrl, { fetchImpl = guardedFetch, gate = acquire } = {}) {
  let from = null;
  let url = new URL('/robots.txt', siteUrl);
  const site = url.host;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    try { url = checkHop(from, url); } catch (e) { return offLimits(`robots.txt redirect refused (${e.message})`); }
    // F02: a robots.txt read is authorized for this one site only; a redirect elsewhere is never followed.
    if (url.host !== site) return offLimits(`robots.txt redirected to another site (${url.host}); not followed`);
    await gate(url.host); // budget errors propagate: running out of budget stops the command
    let res;
    const ctx = activeScope();
    try {
      res = await sendWatched((signal) => fetchImpl(url, {
        method: 'GET', redirect: 'manual', signal, maxBytes: MAX_ROBOTS_BYTES, truncate: true,
        headers: { 'User-Agent': userAgent('robots-check'), Accept: 'text/plain' },
      }), { check: ctx?.recheck ?? null, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      if (e.code === 'POLITE_BUDGET' || e.code === 'SCOPE_BLOCKED') throw e; // a stop is a stop, not "robots unreachable"
      return offLimits(`robots.txt unreachable (${e.message})`);
    }
    const location = res.headers.get('location');
    if (REDIRECT_STATUSES.has(res.status) && location) { from = url; url = new URL(location, url); continue; }
    const body = res.ok ? (await res.text()).slice(0, MAX_ROBOTS_BYTES) : '';
    const result = policyForStatus(res.status, body);
    return res.status >= 500 ? { ...result, ttl_hours: LIMITS.unreachableRobotsHours } : result;
  }
  return offLimits(`robots.txt redirected more than ${LIMITS.maxRedirects} times`);
}

/** Is this URL allowed by its site's robots.txt? One read per site per run, reused for 12 hours (1 hour if unreachable). */
export async function robotsFor(url, { fetchImpl = guardedFetch } = {}) {
  if (!state.robots.has(url.origin)) state.robots.set(url.origin, cached(`robots:${url.origin}`, () => fetchRobotsPolicy(url, { fetchImpl })));
  const info = await state.robots.get(url.origin);
  return { ...isAllowed(info.policy, url.href), basis: info.basis, crawlDelay: groupFor(info.policy).crawlDelay };
}

/**
 * Drop-in replacement for the built-in fetch function, and the only way toolkit code reaches the network. For EVERY hop, in order:
 *   1. check the URL (public address, scheme, credentials, port; no https→http downgrade; no loops)
 *   2. obey that site's robots.txt, including Crawl-delay
 *   3. respect spacing and the run/service/day budgets
 *   4. send one request through the guarded transport, with automatic redirects off
 * Credentials and cookies are dropped when a redirect leaves the original site. Any failed check stops the request.
 */
/**
 * F02: authorization for one request. With an active scope (every tool sets one through requireScope), the
 * destination must belong to a lookup service the request and scope allow. Without one (direct library use),
 * a request that starts at a lookup service may never leave that service.
 */
function authorizeRequest(url, startService) {
  const ctx = activeScope();
  if (ctx) return ctx.authorizeHop(url);
  if (startService && serviceFor(url) !== startService) {
    throw new GuardError(`redirect from the ${startService} service to ${url.host} refused (outside that service)`);
  }
}

export async function politeFetch(input, init = {}, { fetchImpl = guardedFetch } = {}) {
  let url = checkHop(null, String(input?.href ?? input?.url ?? input));
  // F07: a URL given to us that carries credentials or secret-looking parts is refused before it is sent or stored.
  // (Redirects issued by a service, such as GitHub's signed log links, are followed but never stored or printed.)
  if (hasSecretUrlParts(url.href)) throw new GuardError('refusing a URL that carries credentials or secret-looking parameters');
  const startService = serviceFor(url);
  const headers = new Headers(init.headers);
  const seen = new Set();
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    if (seen.has(url.href)) throw new GuardError(`redirect loop at ${url.href}; stopping`);
    seen.add(url.href);
    authorizeRequest(url, startService); // before robots.txt and before the request itself
    const rb = await robotsFor(url, { fetchImpl });
    if (!rb.allowed) {
      // An unavailable robots.txt is NOT evidence that the provider explicitly disallowed us.
      // Keep the fail-closed rule, but report the real problem so operators do not chase fake permissions.
      if (/unreachable|redirect refused|redirected to another site|redirected more than/i.test(rb.basis)) {
        throw new RobotsError(`${url.host}: robots.txt could not be verified (${rb.basis}); lookup not attempted`);
      }
      throw new RobotsError(`${url.host}'s robots.txt explicitly disallows ${url.pathname} (${rb.rule ? `${rb.rule}; ` : ''}${rb.basis})`);
    }
    if ((rb.crawlDelay ?? 0) > MAX_CRAWL_DELAY_SECONDS) throw new RobotsError(`${url.host} asks for a ${rb.crawlDelay}s Crawl-delay; not proceeding`);
    await acquire(url.host, { limits: { ...LIMITS, minIntervalMs: Math.max(LIMITS.minIntervalMs, (rb.crawlDelay ?? 0) * 1000) } });
    authorizeRequest(url, startService); // V4-03: the destination is re-authorized immediately before sending
    const ctx = activeScope();
    const target = url;
    const res = await sendWatched((signal) => fetchImpl(target, { ...init, headers, redirect: 'manual', signal }),
      { check: ctx ? () => ctx.authorizeHop(target) : null, signal: init.signal });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    const next = checkHop(url, new URL(location, url));
    if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie'); }
    url = next;
  }
  throw new GuardError(`more than ${LIMITS.maxRedirects} redirects; stopping`);
}

const keyFile = (key, dir) => join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);

export function readCache(key, { dir = settings.dir } = {}) {
  try {
    const entry = JSON.parse(readFileSync(keyFile(key, dir), 'utf8'));
    return entry.key_hash === hashKey(key) ? entry : null;
  } catch {
    return null;
  }
}

export function writeCache(key, value, { dir = settings.dir, at = nowUtc() } = {}) {
  const kind = kindOf(key);
  stateWrite(keyFile(key, dir), JSON.stringify({ key_hash: hashKey(key), kind, fetched_at: at, masked_for_storage: true, value }) + '\n', kind === 'results' ? 'incident' : 'safety-state');
}

const ageHours = (entry, now) => (now() - Date.parse(entry.fetched_at)) / 36e5;

/** Reuse a recent answer for `key`; otherwise run `fn` and remember its result. A result may shorten its own life with ttl_hours. */
export async function cached(key, fn, { refresh = false, limits = LIMITS, dir = settings.dir, now = settings.clock } = {}) {
  // Investigation results are only kept on disk when the scope allows persistence; safety state is always kept.
  if (!settings.resultCaching && !SAFETY_PREFIXES.some((p) => key.startsWith(p))) return transientLookup(key, fn, { refresh, limits, dir, now });
  const hit = readCache(key, { dir });
  if (hit) {
    const window = Math.min(refresh ? limits.minRefreshHours : limits.cacheHours, hit.value?.ttl_hours ?? Infinity);
    const age = ageHours(hit, now);
    if (age >= 0 && age < window) {
      state.cacheHits += 1;
      return { ...hit.value, from_cache: true, cached_at: hit.fetched_at };
    }
  }
  const value = await fn();
  // V4-02: persistence is decided at the moment of writing, not when the command started. If the scope no longer
  // allows saving (revoked, transient, stopped, denied), the answer is used but NOT kept, and caching stays off.
  const isResult = kindOf(key) === 'results';
  try { writeCache(key, value, { dir, at: new Date(now()).toISOString() }); } catch (e) {
    if (!isResult || e.code !== 'SCOPE_BLOCKED') throw e;
    settings.resultCaching = false;
  }
  return value;
}

/**
 * F06, transient scopes (nothing may be kept): the answer is reused IN MEMORY for the rest of this command (one
 * shared promise, so even concurrent identical lookups send one request). On disk only a `repeat` entry is kept:
 * the SHA-256 of the lookup key and the time, no result, removed after minRefreshHours. A new command that repeats
 * the same lookup within that window is refused, because there is no kept answer to reuse.
 */
async function transientLookup(key, fn, { refresh, limits, dir, now }) {
  const h = hashKey(key);
  const mem = state.memo.get(h);
  if (mem) {
    const age = (now() - Date.parse(mem.at)) / 36e5;
    if (age >= 0 && age < (refresh ? limits.minRefreshHours : limits.cacheHours)) {
      state.cacheHits += 1;
      return { ...(await mem.promise), from_cache: true, cached_at: mem.at, kept: 'in memory for this command only' };
    }
  } else {
    const rep = readCache(`repeat:${key}`, { dir });
    const age = rep ? ageHours(rep, now) : -1;
    if (age >= 0 && age < limits.minRefreshHours) {
      throw new BudgetError(`the same lookup already ran at ${rep.fetched_at}; this scope keeps no results (persistence "transient"), so it is not repeated within ${limits.minRefreshHours}h. Wait, or use a scope with persistence "local" to reuse answers.`);
    }
  }
  const at = new Date(now()).toISOString();
  const promise = Promise.resolve().then(fn);
  state.memo.set(h, { at, promise });
  try {
    const value = await promise;
    writeCache(`repeat:${key}`, {}, { dir, at });
    return value;
  } catch (e) { state.memo.delete(h); throw e; }
}

/** Live-check cool-down: when was this target last contacted, and may we contact it again? */
export function cooldown(key, { hours = LIMITS.liveCooldownHours, dir = settings.dir, now = settings.clock } = {}) {
  const hit = readCache(`cooldown:${key}`, { dir });
  if (!hit) return { allowed: true, last: null };
  const age = ageHours(hit, now);
  return { allowed: !(age >= 0 && age < hours), last: hit.fetched_at };
}

export function markContacted(key, { dir = settings.dir, now = settings.clock } = {}) {
  writeCache(`cooldown:${key}`, {}, { dir, at: new Date(now()).toISOString() });
}

export function runReport() {
  return { total: state.total, per_service: Object.fromEntries(state.perService), cache_hits: state.cacheHits };
}

/** Every network tool prints this at the end of each command. */
export function printRunReport() {
  const r = runReport();
  const detail = Object.entries(r.per_service).map(([s, n]) => `${s}: ${n}`).join(', ');
  console.error(`\nNetwork use this run: ${r.total} request(s)${detail ? ` (${detail})` : ''}; ${r.cache_hits} answer(s) reused from cache.`);
}
