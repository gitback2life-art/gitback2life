import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { authorize, makeApproval, main, template, validateScope } from './incident_intake.mjs';
import { approvalCheck, inScope, requireScope, stopScope, targetKey } from '../_shared/scope.mjs';

const NOW = new Date('2026-10-09T12:00:00Z');
const base = (over = {}) => ({
  ...template(new Date('2026-10-09T00:00:00Z')),
  targets: ['kittensandbarbells.org', 'https://github.com/owner/repo/issues/1'],
  disclosures: ['github', 'rdap', 'dns'],
  ...over,
});
const example = () => JSON.parse(readFileSync(new URL('./examples/nyc-animal-rescue.scope.json', import.meta.url), 'utf8'));

test('the template is valid, open, time-limited, and saves nothing by default', () => {
  const t = template(NOW);
  assert.deepEqual(validateScope(t), []);
  assert.equal(t.status, 'open');
  assert.equal(t.persistence, 'transient');
  assert.ok(Date.parse(t.expires_at) > NOW.getTime());
  assert.ok(validateScope({ ...t, stopping_condition: '' }).some((e) => e.includes('stopping_condition')));
  assert.ok(validateScope({ ...t, expires_at: undefined }).some((e) => e.includes('expires_at')));
  assert.ok(validateScope({ ...t, disclosures: ['carrier pigeon'] }).some((e) => e.includes('unknown disclosure')));
  assert.ok(validateScope({ ...t, targets: ['not a target!'] }).some((e) => e.includes('not a domain')));
});

test('targets: domains cover their subdomains and ignore www; repos match by owner/repo', () => {
  assert.deepEqual(targetKey('https://github.com/Owner/Repo/issues/1'), { type: 'repo', key: 'owner/repo' });
  assert.deepEqual(targetKey('owner/repo'), { type: 'repo', key: 'owner/repo' });
  assert.deepEqual(targetKey('https://www.Example.org/adopt'), { type: 'host', key: 'example.org' });
  const s = base();
  for (const ok of ['kittensandbarbells.org', 'www.kittensandbarbells.org', 'https://kittensandbarbells.org/adopt', 'shop.kittensandbarbells.org', 'owner/repo', 'https://github.com/owner/repo/actions/runs/5']) {
    assert.ok(inScope(s, ok), ok);
  }
  for (const no of ['evilkittensandbarbells.org', 'kittensandbarbells.org.evil.example', 'other/repo', 'owner/repo2', 'talesofhazaribagh.com']) {
    assert.ok(!inScope(s, no), no);
  }
});

test('an allowed passive lookup needs the action, the target and the disclosure service', () => {
  const s = base();
  assert.equal(authorize(s, { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['rdap'], now: NOW }).allowed, true);
  const offTarget = authorize(s, { action: 'passive_lookup', target: 'talesofhazaribagh.com', services: ['rdap'], now: NOW });
  assert.equal(offTarget.allowed, false);
  assert.match(offTarget.reasons.join(), /not listed in the scope's targets/);
  const offService = authorize(s, { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['web_archive'], now: NOW });
  assert.match(offService.reasons.join(), /does not allow sending the target to the Wayback Machine/);
  const notPermitted = authorize({ ...s, permissions: { ...s.permissions, passive_lookup: false } }, { action: 'passive_lookup', target: 'kittensandbarbells.org', now: NOW });
  assert.match(notPermitted.reasons.join(), /not permitted/);
});

test('a stopped or expired scope blocks everything', () => {
  const stopped = stopScope(base(), '2026-10-09T10:00:00Z');
  assert.match(authorize(stopped, { action: 'read_public_github', target: 'owner/repo', now: NOW }).reasons.join(), /stopped at 2026-10-09T10:00:00Z/);
  const expired = base({ expires_at: '2026-10-09T11:00:00Z' });
  assert.match(authorize(expired, { action: 'read_public_github', target: 'owner/repo', now: NOW }).reasons.join(), /expired/);
});

test('saving is blocked when persistence is "transient", even if save_local is permitted', () => {
  const s = base({ permissions: { ...template().permissions, save_local: true } });
  assert.match(authorize(s, { action: 'save_local', now: NOW }).reasons.join(), /transient/);
  assert.equal(authorize({ ...s, persistence: 'local' }, { action: 'save_local', now: NOW }).allowed, true);
});

test('always-ask actions: permission alone is not enough; the attestation must match the exact target and be fresh', () => {
  const s = base({ permissions: { ...template().permissions, live_http_inspection: true }, disclosures: ['target_website'] });
  const req = { action: 'live_http_inspection', target: 'https://kittensandbarbells.org/', services: ['target_website'], now: NOW };
  assert.equal(authorize(s, req).allowed, false);
  const good = makeApproval(s, { action: 'live_http_inspection', target: 'https://kittensandbarbells.org/', now: '2026-10-09T11:00:00Z' });
  const r = authorize({ ...s, approvals: [good] }, req);
  assert.equal(r.allowed, true);
  assert.match(r.basis, /operator attestation .*not proof that a person approved/, 'the result says what an attestation is');
  // An attestation for a different URL on the same site does not count.
  assert.equal(authorize({ ...s, approvals: [good] }, { ...req, target: 'https://kittensandbarbells.org/adopt' }).allowed, false);
  // Stale or future-dated attestations do not count.
  const stale = makeApproval(s, { action: 'live_http_inspection', target: req.target, now: '2026-10-07T11:00:00Z' });
  assert.equal(authorize({ ...s, approvals: [stale] }, req).allowed, false);
  const future = makeApproval(s, { action: 'live_http_inspection', target: req.target, now: '2026-10-10T11:00:00Z' });
  assert.equal(authorize({ ...s, approvals: [future] }, req).allowed, false);
  // Old-style records that claimed "human-only" approval (with or without the old checksum) are refused.
  const legacy = { action: 'live_http_inspection', target: req.target, approved_at: '2026-10-09T11:00:00Z', approved_via: 'interactive_terminal', detail: 'trust me' };
  assert.equal(authorize({ ...s, approvals: [legacy] }, req).allowed, false);
  assert.equal(authorize({ ...s, approvals: [{ ...legacy, check: approvalCheck(s, legacy) }] }, req).allowed, false);
  // KNOWN LIMIT (F01), asserted so it stays documented: an attestation written by hand, without the approve
  // command, is accepted. Attestations are statements, not proof; the toolbox has no protected approval authority.
  const handWritten = { action: 'live_http_inspection', target: req.target, attested_at: '2026-10-09T11:00:00Z', attested_by: 'operator' };
  assert.equal(authorize({ ...s, approvals: [handWritten] }, req).allowed, true);
});

test('approvals cannot be made for targets outside the scope or for actions that do not need them', () => {
  const s = base();
  assert.throws(() => makeApproval(s, { action: 'live_http_inspection', target: 'https://evil.example/' }), /not one of the scope's targets/);
  assert.throws(() => makeApproval(s, { action: 'passive_lookup', target: 'kittensandbarbells.org' }), /does not need approvals/);
});

test('the approve command refuses without an interactive terminal (an accident guard, not a security boundary)', async () => {
  await assert.rejects(main(['approve', 'incident_intake/examples/nyc-animal-rescue.scope.json', '--action', 'live_http_inspection', '--target', 'https://www.kittensandbarbells.org/']),
    /interactive terminal/);
  assert.deepEqual(example().approvals, [], 'nothing was written');
});

test('requireScope keeps lookup results on disk only for scopes that allow saving', async () => {
  const { resultCachingEnabled, setResultCaching } = await import('../_shared/polite.mjs');
  const { writeFileSync, mkdirSync, rmSync, rmdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { TOOLBOX_ROOT } = await import('../_shared/common.mjs');
  const dir = join(TOOLBOX_ROOT, '.test_tmp', `intake-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const future = new Date(Date.now() + 864e5).toISOString();
    const write = (name, over) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(base({ expires_at: future, ...over }))); return f; };
    setResultCaching(true);
    requireScope(write('t.json', { persistence: 'transient' }), { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['dns'] });
    assert.equal(resultCachingEnabled(), false, 'transient scope: results are not kept');
    // V4-02: one command uses one scope file; a second file in the same command is refused.
    assert.throws(() => requireScope(write('other.json', {}), { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['dns'] }), /only one scope file/);
    (await import('../_shared/active_scope.mjs')).clearActiveScope(); // the next line is a separate command
    requireScope(write('l.json', { persistence: 'local', permissions: { ...template().permissions, save_local: true } }), { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['dns'] });
    assert.equal(resultCachingEnabled(), true, 'local scope that permits saving: results may be kept');
  } finally {
    setResultCaching(false);
    (await import('../_shared/active_scope.mjs')).clearActiveScope(); // the scope file is deleted below
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ }
  }
});

test('F12: a stop made while a command runs blocks its next save and its next live hop', async () => {
  const { writeFileSync, mkdirSync, rmSync, rmdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { TOOLBOX_ROOT, safeWrite } = await import('../_shared/common.mjs');
  const { clearActiveScope, activeScope } = await import('../_shared/active_scope.mjs');
  const { inspectChain, liveHopAuthorizer } = await import('../redirect_inspector/redirect_inspector.mjs');
  const dir = join(TOOLBOX_ROOT, '.test_tmp', `intake-stop-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const future = new Date(Date.now() + 864e5).toISOString(), at = new Date().toISOString();
  const file = join(dir, 'scope.json');
  const put = (over) => writeFileSync(file, JSON.stringify(base({ expires_at: future, persistence: 'local', ...over })));
  const stop = () => writeFileSync(file, JSON.stringify(stopScope(JSON.parse(readFileSync(file, 'utf8')))));
  try {
    // Save boundary.
    put({ permissions: { ...template().permissions, save_local: true } });
    requireScope(file, { action: 'save_local' });
    safeWrite(join(dir, 'first.txt'), '1');
    stop();
    assert.throws(() => safeWrite(join(dir, 'second.txt'), '2'), /no longer allows this[\s\S]*stopped/);
    assert.equal(existsSync(join(dir, 'second.txt')), false);
    clearActiveScope();
    // Live-hop boundary: both URLs are attested, the scope is stopped after the first request.
    const urls = ['https://kittensandbarbells.org/', 'https://kittensandbarbells.org/next'];
    put({ permissions: { ...template().permissions, live_http_inspection: true }, disclosures: ['target_website'],
      approvals: urls.map((target) => ({ action: 'live_http_inspection', target, attested_at: at, attested_by: 'operator' })) });
    const scope = requireScope(file, { action: 'live_http_inspection', target: urls[0], services: ['target_website'] });
    const sent = [];
    const result = await inspectChain(urls[0], {
      allowHop: liveHopAuthorizer(scope, () => activeScope().recheck()),
      robots: async () => ({ allowed: true, basis: 'test' }),
      transport: async (u) => { sent.push(u.href); stop(); return { status: 302, location: '/next' }; },
    });
    assert.deepEqual(sent, [urls[0]], 'the second, attested URL was not contacted after the stop');
    assert.equal(result.outcome, 'stopped_by_scope');
  } finally {
    clearActiveScope();
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ }
  }
});

test('requireScope: missing scope, blocked request, and allowed request', () => {
  assert.throws(() => requireScope(undefined, { action: 'passive_lookup' }), /needs --scope/);
  const file = 'incident_intake/examples/nyc-animal-rescue.scope.json';
  assert.throws(() => requireScope(file, { action: 'contact_third_party', target: 'kittensandbarbells.org' }), /blocked by scope/);
});

test('the NYC example scope is valid and allows exactly what it says, until it expires', () => {
  const s = example();
  assert.deepEqual(validateScope(s), []);
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(authorize(s, { action: 'read_public_github', target: 'maintainer-handle-redacted/nyc-animal-rescue'.replace('maintainer-handle-redacted', s.targets[0].split('/')[3]), services: ['github'], now }).allowed, true);
  assert.equal(authorize(s, { action: 'passive_lookup', target: 'talesofhazaribagh.com', services: ['web_archive'], now }).allowed, true);
  assert.equal(authorize(s, { action: 'passive_lookup', target: 'kittensandbarbells.org', services: ['doh'], now }).allowed, false, 'DNS-over-HTTPS not disclosed');
  assert.equal(authorize(s, { action: 'live_http_inspection', target: 'https://www.kittensandbarbells.org/', services: ['target_website'], now }).allowed, false);
  assert.equal(authorize(s, { action: 'contact_third_party', target: 'kittensandbarbells.org', now }).allowed, false);
  assert.equal(authorize(s, { action: 'read_public_github', target: s.targets[0], now: new Date('2026-10-16T00:00:00Z') }).allowed, false, 'expired');
});
