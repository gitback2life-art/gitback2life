// V4-03: authorization is re-checked AFTER every wait, immediately before a request is sent.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOLBOX_ROOT } from './common.mjs';
import { acquire, configurePolite, politeFetch, resetPolite } from './polite.mjs';
import { clearActiveScope, requireScope, template } from './scope.mjs';
import { liveTransport } from '../redirect_inspector/redirect_inspector.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `dispatch-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { clearActiveScope(); rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });

/** A scope file plus a fake clock whose waits apply `change` to the scope file (simulating an edit during the wait). */
function setup(name, change, over = {}) {
  const dir = join(TMP, name); mkdirSync(dir);
  const p = join(dir, 'scope.json');
  const s = { ...template(), targets: ['alpha.org'], disclosures: ['rdap', 'dns', 'target_website'], ...over };
  writeFileSync(p, JSON.stringify(s));
  let t = Date.parse('2026-10-09T00:00:00Z');
  configurePolite({ dir, clock: () => t, wait: async (ms) => { t += ms; writeFileSync(p, JSON.stringify(change(s))); } });
  resetPolite(); clearActiveScope();
  return p;
}

for (const [label, change] of [
  ['stopped', (s) => ({ ...s, status: 'stopped' })],
  ['expired', (s) => ({ ...s, expires_at: '2000-01-01T00:00:00Z' })],
  ['permission removed', (s) => ({ ...s, permissions: { ...s.permissions, passive_lookup: false } })],
  ['target narrowed', (s) => ({ ...s, targets: ['other.org'] })],
  ['disclosure removed', (s) => ({ ...s, disclosures: [] })],
]) {
  test(`lookup: scope ${label} during the rate wait → the waiting request is not sent`, async () => {
    const p = setup(label.replace(/\W/g, '-'), change);
    requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
    const sent = [];
    await politeFetch('https://rdap.org/domain/alpha.org', {}, { fetchImpl: async (u) => { sent.push(u.href); return new Response(u.pathname === '/robots.txt' ? '' : '{}', { status: u.pathname === '/robots.txt' ? 404 : 200 }); } })
      .catch(() => {});
    assert.deepEqual(sent, ['https://rdap.org/robots.txt'], `only robots.txt went out before the change: ${JSON.stringify(sent)}`);
  });
}

test('DNS and other acquire() callers: a stop during the wait throws before the query', async () => {
  const p = setup('dns', (s) => ({ ...s, status: 'stopped' }));
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['dns'] });
  await acquire('dns:system'); // first: no wait
  await assert.rejects(acquire('dns:system'), /no longer allows|stopped/); // second waits 1 s, scope stops meanwhile
});

test('live: an attestation withdrawn during the wait stops the hop before it is sent', async () => {
  const url = 'https://alpha.org/';
  const att = { action: 'live_http_inspection', target: url, attested_at: new Date().toISOString(), attested_by: 'operator' };
  const p = setup('live', (s) => ({ ...s, approvals: [] }), { permissions: { ...template().permissions, live_http_inspection: true }, approvals: [att] });
  const scope = requireScope(p, { action: 'live_http_inspection', target: url, services: ['target_website'] });
  const sent = [];
  let waited = false;
  const transport = liveTransport(scope, {
    acquireFn: async () => { waited = true; writeFileSync(p, JSON.stringify({ ...scope, approvals: [] })); },
    send: async (u) => { sent.push(u.href); return { status: 200 }; },
  });
  // Refused either by the scope re-check ("no longer allows this") or the exact-URL check ("no longer authorized").
  await assert.rejects(transport(new URL(url), {}), /no longer (allows this|authorized)/);
  assert.ok(waited);
  assert.deepEqual(sent, []);
});

// F12 in-flight: a request that is already being sent is aborted when the scope stops while it is in flight.
const slowReply = (signal, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

test('in flight: a lookup already being sent is aborted when the scope is stopped', async () => {
  const p = setup('inflight', (s) => s);
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  const t0 = Date.now();
  setTimeout(() => writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), status: 'stopped' })), 150);
  await assert.rejects(politeFetch('https://rdap.org/domain/alpha.org', {}, { fetchImpl: async (u, init) => (u.pathname === '/robots.txt' ? new Response('', { status: 404 }) : slowReply(init.signal)) }), /no longer allows|stopped/);
  assert.ok(Date.now() - t0 < 2500, 'aborted well before the slow reply would have arrived');
});

test('in flight: a live hop already being sent is aborted when its attestation is withdrawn', async () => {
  const url = 'https://alpha.org/';
  const att = { action: 'live_http_inspection', target: url, attested_at: new Date().toISOString(), attested_by: 'operator' };
  const p = setup('inflight-live', (s) => s, { permissions: { ...template().permissions, live_http_inspection: true }, approvals: [att] });
  const scope = requireScope(p, { action: 'live_http_inspection', target: url, services: ['target_website'] });
  setTimeout(() => writeFileSync(p, JSON.stringify({ ...scope, approvals: [] })), 150);
  const transport = liveTransport(scope, { acquireFn: async () => {}, send: (u, opts) => slowReply(opts.signal) });
  await assert.rejects(transport(new URL(url), {}), /no longer (allows this|authorized)/);
});

test('in flight: without a change, the request completes normally', async () => {
  const p = setup('inflight-ok', (s) => s);
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  const res = await politeFetch('https://rdap.org/domain/alpha.org', {}, { fetchImpl: async (u, init) => (u.pathname === '/robots.txt' ? new Response('', { status: 404 }) : slowReply(init.signal, 800)) });
  assert.equal(res.status, 200);
});