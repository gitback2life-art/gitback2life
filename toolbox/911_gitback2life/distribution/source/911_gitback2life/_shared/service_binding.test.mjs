// V4-01: lookup services are identified by exact hosts, and RDAP requests are bound to authorized domains.
// Positive cases prove genuine registry redirects still work; negative cases are the reviewer's escapes and variants.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOLBOX_ROOT } from './common.mjs';
import { RDAP_REGISTRY_HOSTS, serviceFor } from './guards.mjs';
import { configurePolite, politeFetch, resetPolite } from './polite.mjs';
import { authorizeDerivedTarget, clearActiveScope, requireScope, template } from './scope.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `binding-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { clearActiveScope(); rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });

function scopeFile(name, over = {}) {
  const dir = join(TMP, name); mkdirSync(dir);
  let t = Date.parse('2026-10-09T00:00:00Z');
  configurePolite({ dir, clock: () => t, wait: async (ms) => { t += ms; } }); resetPolite(); clearActiveScope();
  const p = join(dir, 'scope.json');
  writeFileSync(p, JSON.stringify({ ...template(), targets: ['alpha.org'], disclosures: ['rdap'], ...over }));
  return p;
}
const reply = (status = 200, location) => new Response(status === 200 ? '{}' : '', { status, headers: location ? { location } : undefined });
async function follow(start, hops) {
  const sent = [];
  let error = null;
  await politeFetch(start, {}, { fetchImpl: async (u) => { sent.push(u.href); if (u.pathname === '/robots.txt') return reply(404); const next = hops[u.href]; return next ? reply(302, next) : reply(); } })
    .catch((e) => { error = e; });
  return { sent, error };
}

test('service identity is exact: look-alike hosts and paths are ordinary websites', () => {
  for (const u of ['https://rdap.unrelated.example/domain/alpha.org', 'https://unrelated.example/rdap/domain/alpha.org', 'https://rdap.org.evil.example/domain/x',
    'https://anyone.blob.core.windows.net/x', 'https://productionresultssa1.blob.core.windows.net.evil.example/x']) {
    assert.equal(serviceFor(new URL(u)), null, u);
  }
  assert.equal(serviceFor(new URL('https://rdap.org/domain/alpha.org')), 'rdap');
  assert.equal(serviceFor(new URL('https://productionresultssa12.blob.core.windows.net/actions-results/x')), 'github');
  assert.equal(serviceFor(new URL('https://pipelines.actions.githubusercontent.com/x')), 'github');
  for (const h of RDAP_REGISTRY_HOSTS) assert.match(h, /^[a-z0-9.-]+$/, 'exact hostnames only');
});

test('a genuine registry redirect for the authorized domain is still followed', async () => {
  const p = scopeFile('positive');
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  const { sent, error } = await follow('https://rdap.org/domain/alpha.org', { 'https://rdap.org/domain/alpha.org': 'https://rdap.publicinterestregistry.org/rdap/domain/alpha.org' });
  assert.equal(error, null, String(error));
  assert.ok(sent.includes('https://rdap.publicinterestregistry.org/rdap/domain/alpha.org'), JSON.stringify(sent));
});

test('a registry redirect to an unlisted or impersonating host is refused before contact', async () => {
  for (const dest of ['https://rdap.unrelated.example/domain/alpha.org', 'https://unrelated.example/rdap/domain/alpha.org', 'https://rdap.nic.unlisted-registry.example/domain/alpha.org']) {
    const p = scopeFile(`neg-${randomUUID()}`);
    requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
    const { sent, error } = await follow('https://rdap.org/domain/alpha.org', { 'https://rdap.org/domain/alpha.org': dest });
    assert.ok(error, dest);
    assert.equal(sent.some((u) => new URL(u).hostname === new URL(dest).hostname), false, `${dest}: ${JSON.stringify(sent)}`);
  }
});

test('a trusted registry may only be asked about authorized domains (target binding)', async () => {
  const p = scopeFile('bind');
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  for (const dest of ['https://rdap.verisign.com/com/v1/domain/someone-else.com', 'https://rdap.publicinterestregistry.org/rdap/entity/ABC', 'https://rdap.publicinterestregistry.org/rdap/']) {
    const { sent, error } = await follow('https://rdap.org/domain/alpha.org', { 'https://rdap.org/domain/alpha.org': dest });
    assert.ok(error, dest);
    assert.equal(sent.includes(dest), false, dest);
  }
  // Starting directly with an unauthorized name is refused too.
  const direct = await follow('https://rdap.org/domain/someone-else.org', {});
  assert.deepEqual(direct.sent, []);
});

test('generated lookalike names need allow_derived_lookalikes, then are bound like targets', async () => {
  const off = scopeFile('derived-off');
  requireScope(off, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  assert.throws(() => authorizeDerivedTarget('a1pha.org'), /allow_derived_lookalikes/);
  const on = scopeFile('derived-on', { allow_derived_lookalikes: true });
  requireScope(on, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  assert.ok((await follow('https://rdap.org/domain/a1pha.org', {})).error, 'not yet authorized');
  authorizeDerivedTarget('a1pha.org');
  const ok = await follow('https://rdap.org/domain/a1pha.org', {});
  assert.equal(ok.error, null, String(ok.error));
});
