import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOLBOX_ROOT } from './common.mjs';
import {
  acquire, BudgetError, cached, configurePolite, cooldown, LIMITS, markContacted, politeFetch, pruneState, resetPolite, robotsFor, runReport, stateSummary,
} from './polite.mjs';

// Test files run in parallel: each one cleans up only its own subfolder, then the shared parent if empty.
const TMP_ROOT = join(TOOLBOX_ROOT, '.test_tmp');
const TMP = join(TMP_ROOT, `polite-${randomUUID()}`);
let t = Date.parse('2026-10-09T00:00:00Z');
const clock = () => t;
const wait = async (ms) => { t += ms; };

beforeEach(() => {
  resetPolite();
  configurePolite({ dir: join(TMP, randomUUID()), clock, wait, resultCaching: true });
});
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  try { rmdirSync(TMP_ROOT); } catch { /* another test file is still using it */ }
});

test('acquire spaces requests to the same service at least 1 second apart', async () => {
  const waits = [];
  const w = async (ms) => { waits.push(ms); t += ms; };
  await acquire('rdap.org', { wait: w });
  t += 200;
  await acquire('rdap.org', { wait: w });
  await acquire('crt.sh', { wait: w });
  assert.deepEqual(waits, [800], 'second rdap call waited; first call to another service did not');
  assert.deepEqual(runReport().per_service, { 'rdap.org': 2, 'crt.sh': 1 });
});

test('acquire stops at the per-service and per-run caps instead of sending more', async () => {
  const limits = { ...LIMITS, minIntervalMs: 0, maxPerServicePerRun: 2, maxPerRun: 3 };
  await acquire('a', { limits }); await acquire('a', { limits });
  await assert.rejects(acquire('a', { limits }), BudgetError);
  await acquire('b', { limits });
  await assert.rejects(acquire('c', { limits }), /run budget reached/);
  assert.equal(runReport().total, 3);
});

test('the daily cap holds across separate runs and resets the next UTC day', async () => {
  const limits = { ...LIMITS, minIntervalMs: 0, maxPerServicePerDay: 2 };
  await acquire('crt.sh', { limits });
  resetPolite(); // a new command
  await acquire('crt.sh', { limits });
  resetPolite();
  await assert.rejects(acquire('crt.sh', { limits }), /daily budget/);
  t += 24 * 3600e3;
  await acquire('crt.sh', { limits });
});

test('cached reuses an answer within 12 hours, and --refresh still waits at least 1 hour', async () => {
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  assert.deepEqual(await cached('k', fn), { n: 1 });
  t += 30 * 60e3;
  assert.equal((await cached('k', fn, { refresh: true })).from_cache, true, 'refresh inside 1 hour is refused');
  t += 60 * 60e3;
  assert.equal((await cached('k', fn)).from_cache, true, 'normal call inside 12 hours reuses');
  assert.deepEqual(await cached('k', fn, { refresh: true }), { n: 2 }, 'refresh after 1 hour fetches again');
  t += 13 * 3600e3;
  assert.deepEqual(await cached('k', fn), { n: 3 }, 'expired after 12 hours');
  assert.equal(runReport().cache_hits, 2);
});

test('live-check cool-down blocks the same target for 24 hours', () => {
  assert.equal(cooldown('u').allowed, true);
  markContacted('u');
  t += 23 * 3600e3;
  assert.equal(cooldown('u').allowed, false);
  t += 2 * 3600e3;
  assert.equal(cooldown('u').allowed, true);
});

// A fake internet: map of URL → { status, body, headers }.
function fakeNet(routes) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    log.push({ href, auth: new Headers(init?.headers).get('authorization') });
    const r = routes[href] ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  };
  return { fetchImpl, log };
}

test('politeFetch reads robots.txt first and refuses disallowed paths without requesting them', async () => {
  const net = fakeNet({ 'https://svc.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private' } });
  await assert.rejects(politeFetch('https://svc.example/private/x', {}, net), { code: 'ROBOTS_DISALLOWED' });
  assert.deepEqual(net.log.map((l) => l.href), ['https://svc.example/robots.txt']);
  const ok = await politeFetch('https://svc.example/public', {}, net);
  assert.equal(ok.status, 404);
  assert.equal(net.log.filter((l) => l.href.endsWith('robots.txt')).length, 1, 'robots.txt read once per site');
});

test('a missing robots.txt allows; an erroring one blocks for 1 hour, then is re-read', async () => {
  const missing = fakeNet({});
  assert.equal((await robotsFor(new URL('https://a.example/x'), missing)).allowed, true);
  const down = fakeNet({ 'https://crt.example/robots.txt': { status: 502 } });
  await assert.rejects(politeFetch('https://crt.example/?q=x', {}, down), /off-limits/);
  resetPolite();
  t += 30 * 60e3;
  await assert.rejects(politeFetch('https://crt.example/?q=x', {}, down));
  assert.equal(down.log.length, 1, 'still blocked from cache; robots.txt not re-requested within the hour');
  resetPolite();
  t += 31 * 60e3;
  const recovered = fakeNet({ 'https://crt.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' } });
  assert.equal((await politeFetch('https://crt.example/?q=x', {}, recovered)).status, 404);
});

test('politeFetch follows redirects hop by hop, checking each new site and dropping credentials', async () => {
  const net = fakeNet({
    'https://api.example/logs': { status: 302, headers: { location: 'https://blob.example/file' } },
    'https://blob.example/file': { status: 200, body: 'log text' },
  });
  const res = await politeFetch('https://api.example/logs', { headers: { Authorization: 'Bearer secret' } }, net);
  assert.equal(await res.text(), 'log text');
  const hrefs = net.log.map((l) => l.href);
  assert.deepEqual(hrefs, ['https://api.example/robots.txt', 'https://api.example/logs', 'https://blob.example/robots.txt', 'https://blob.example/file']);
  assert.equal(net.log[1].auth, 'Bearer secret');
  assert.equal(net.log[3].auth, null, 'credentials never sent to the second site');
});

test('a redirect to a site whose robots.txt disallows us stops before contacting it', async () => {
  const net = fakeNet({
    'https://a.example/x': { status: 301, headers: { location: 'https://b.example/y' } },
    'https://b.example/robots.txt': { status: 200, body: 'User-agent: gitback2life\nDisallow: /' },
  });
  await assert.rejects(politeFetch('https://a.example/x', {}, net), { code: 'ROBOTS_DISALLOWED' });
  assert.ok(!net.log.some((l) => l.href === 'https://b.example/y'));
});

// ---- Redirect safety (review finding B): every hop checked, nothing automatic, fail closed ----
function net2(routes) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    const h = new Headers(init?.headers);
    log.push({ href, redirect: init?.redirect, auth: h.get('authorization'), cookie: h.get('cookie') });
    const r = routes[href] ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  };
  return { fetchImpl, log };
}
const go = (location, status = 302) => ({ status, headers: { location } });

test('a private or internal starting URL is refused before anything is sent', async () => {
  const net = net2({});
  for (const u of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'https://u:p@a.example/']) {
    await assert.rejects(politeFetch(u, {}, net), { code: 'GUARD_BLOCKED' }, u);
  }
  assert.equal(net.log.length, 0);
});

test('a redirect into a private address is refused, and the private address is never contacted', async () => {
  const net = net2({ 'https://a.example/x': go('http://169.254.169.254/latest/meta-data/') });
  await assert.rejects(politeFetch('https://a.example/x', {}, net), { code: 'GUARD_BLOCKED' });
  assert.ok(!net.log.some((l) => l.href.includes('169.254')));
});

test('a redirect from https down to http is refused', async () => {
  const net = net2({ 'https://a.example/x': go('http://a.example/x') });
  await assert.rejects(politeFetch('https://a.example/x', {}, net), /https to http refused/);
  assert.ok(!net.log.some((l) => l.href.startsWith('http://')));
});

test('redirect loops and over-long chains stop (fail closed), and every hop is counted', async () => {
  const loop = net2({ 'https://a.example/1': go('/2'), 'https://a.example/2': go('/1') });
  await assert.rejects(politeFetch('https://a.example/1', {}, loop), /redirect loop/);
  resetPolite();
  const chain = {};
  for (let i = 0; i < 10; i++) chain[`https://c.example/${i}`] = go(`/${i + 1}`); // fresh site: no saved robots.txt answer
  const long = net2(chain);
  await assert.rejects(politeFetch('https://c.example/0', {}, long), /more than 5 redirects/);
  const pageRequests = long.log.filter((l) => !l.href.endsWith('robots.txt')).length;
  assert.equal(pageRequests, 6, 'the first request plus 5 redirects, then stop');
  assert.equal(runReport().per_service['c.example'], 7, 'robots.txt read + 6 page requests, all counted');
});

test('every request asks the transport for manual redirects only', async () => {
  const net = net2({ 'https://a.example/x': go('https://b.example/y'), 'https://b.example/y': { status: 200, body: 'ok' } });
  await politeFetch('https://a.example/x', {}, net);
  assert.ok(net.log.length >= 4);
  assert.ok(net.log.every((l) => l.redirect === 'manual'), JSON.stringify(net.log.map((l) => l.redirect)));
});

test('cookies and credentials are dropped when a redirect leaves the site', async () => {
  const net = net2({ 'https://a.example/x': go('https://b.example/y'), 'https://b.example/y': { status: 200 } });
  await politeFetch('https://a.example/x', { headers: { Authorization: 'Bearer t', Cookie: 's=1' } }, net);
  const toB = net.log.find((l) => l.href === 'https://b.example/y');
  assert.equal(toB.auth, null);
  assert.equal(toB.cookie, null);
});

test('robots.txt redirects: followed by hand and counted; over 5, private, or downgraded → site off-limits', async () => {
  const many = {};
  many['https://r.example/robots.txt'] = go('/r1');
  for (let i = 1; i <= 6; i++) many[`https://r.example/r${i}`] = go(`/r${i + 1}`);
  const tooMany = net2(many);
  await assert.rejects(politeFetch('https://r.example/page', {}, tooMany), /redirected more than 5 times; treating the site as off-limits/);
  assert.ok(!tooMany.log.some((l) => l.href === 'https://r.example/page'), 'the page itself was never requested');
  resetPolite();
  const priv = net2({ 'https://p.example/robots.txt': go('http://10.0.0.1/robots.txt') });
  await assert.rejects(politeFetch('https://p.example/page', {}, priv), /robots\.txt redirect refused/);
  assert.ok(!priv.log.some((l) => l.href.includes('10.0.0.1')));
  resetPolite();
  const down = net2({ 'https://d.example/robots.txt': go('http://d.example/robots.txt') });
  await assert.rejects(politeFetch('https://d.example/page', {}, down), /https to http refused/);
  resetPolite();
  // F02: a robots.txt redirect to ANOTHER site is not followed (the site is treated as off-limits) ...
  const elsewhere = net2({ 'https://k.example/robots.txt': go('https://cdn.example/robots.txt'), 'https://cdn.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' } });
  await assert.rejects(politeFetch('https://k.example/page', {}, elsewhere), /redirected to another site/);
  assert.ok(!elsewhere.log.some((l) => l.href.startsWith('https://cdn.example/')), 'the other site was never contacted');
  resetPolite();
  // ... while a same-site robots.txt redirect is still followed by hand and every hop is counted.
  const same = net2({ 'https://s.example/robots.txt': go('/policy/robots.txt'), 'https://s.example/policy/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' } });
  assert.equal((await politeFetch('https://s.example/page', {}, same)).status, 404);
  assert.equal(runReport().per_service['s.example'], 3, 'two robots.txt hops plus the page, all counted');
});

// ---- Stored data (review section 4: persistence) ----
test('with result caching off (the default, and any "transient" scope) lookup results are never written', async () => {
  const dir = join(TMP, randomUUID());
  configurePolite({ dir, clock, wait }); // resultCaching defaults to false
  let calls = 0;
  await cached('domain_research:rdap:x.org', async () => ({ n: ++calls }));
  const again = await cached('domain_research:rdap:x.org', async () => ({ n: ++calls }));
  // F06 (reverses this test's earlier `calls === 2`, which encoded the defect): reused in memory, not asked again.
  assert.equal(calls, 1, 'reused within this command');
  assert.equal(again.kept, 'in memory for this command only');
  assert.equal(stateSummary({ dir }).results, 0, 'nothing stored');
  assert.equal(stateSummary({ dir }).repeat, 1, 'only a repeat timestamp is kept');
  const files = readdirSync(dir).filter((f) => !f.startsWith('daily'));
  assert.ok(files.every((f) => !readFileSync(join(dir, f), 'utf8').includes('"n"')), 'no result value on disk');
  assert.ok(files.every((f) => !readFileSync(join(dir, f), 'utf8').includes('x.org')), 'no lookup key on disk');
  resetPolite(); // a new command: no memory, so the repeat window applies
  await assert.rejects(cached('domain_research:rdap:x.org', async () => ({ n: ++calls })), /keeps no results/);
  assert.equal(calls, 1);
  await cached('robots:https://x.org', async () => ({ policy: { groups: [] }, basis: 'test' }));
  assert.equal(stateSummary({ dir }).robots, 1, 'robots.txt policy (safety state) is still kept');
});

test('F06: the shared daily counter is locked across commands; a held lock stops the request, a stale one is cleared', async () => {
  const dir = join(TMP, randomUUID());
  configurePolite({ dir, clock, wait });
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'daily.lock');
  writeFileSync(lock, '99999\n'); // another command holds it
  await assert.rejects(acquire('a.example', { limits: { ...LIMITS, lockWaitMs: 60 } }), /locked by another command/);
  assert.equal(runReport().total, 0, 'nothing was counted or sent');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // left behind by a crashed command
  await acquire('a.example', { limits: { ...LIMITS, lockWaitMs: 60 } });
  assert.equal(runReport().total, 1);
  assert.equal(readdirSync(dir).includes('daily.lock'), false, 'the lock is released');
});

test('pruneState removes expired state, keeps fresh state, and never clears safety limits early', async () => {
  const dir = join(TMP, randomUUID());
  configurePolite({ dir, clock, wait, resultCaching: true });
  const saved = t;
  t = Date.parse('2026-10-20T01:00:00Z'); // early in a UTC day, so +13 h is still the same day
  const start = t;
  await acquire('a.example'); // writes today's daily counter
  markContacted('https://a.example/');
  await cached('lookup:old', async () => ({ v: 1 }));
  t += 13 * 3600e3; // the cached result is now past its 12 h window; the cool-down is not past 24 h
  await cached('lookup:new', async () => ({ v: 2 }));
  const r1 = pruneState({ dir });
  assert.equal(r1.results, 1, 'only the expired result was removed');
  assert.equal(stateSummary({ dir }).cooldown, 1);
  const cleared = pruneState({ dir, results: true });
  assert.equal(cleared.results, 1, '--clear-results removes the remaining cached result');
  assert.equal(stateSummary({ dir }).cooldown, 1, 'but the cool-down (a safety limit) stays');
  assert.equal(stateSummary({ dir }).daily, 1, 'and so does the daily counter');
  t = start + 2 * 864e5; // two days later
  const r2 = pruneState({ dir });
  assert.equal(r2.daily, 1, "yesterday's daily counter is removed");
  assert.equal(r2.cooldown, 1, 'the cool-down has expired');
  t = saved;
});