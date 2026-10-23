// Adapted copy of the second-round audit's adversarial suite
// (original: D:\CRTS apps\MY_tools\gitback2life_audit_v2\audit_adversarial.mjs, preserved unchanged).
// Adaptations, all documented in README.md in this folder:
//   * imports point at the working toolbox instead of the extracted audit copy;
//   * fixtures live in a throwaway folder under .test_tmp that is removed afterwards;
//   * "outside the toolbox" is simulated with a stand-in root (safeWrite's `root` option) inside that throwaway
//     folder, so no test ever creates files outside the toolbox (the session's folder rule);
//   * where a fix changed a test interface (F01, F02-live, F04), the ORIGINAL test is kept as test.skip with the
//     reason, next to a replacement that checks the same boundary.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TOOLBOX_ROOT as root, safeWrite } from '../_shared/common.mjs';
import { template, authorize, approvalCheck, inScope, requireScope, clearActiveScope } from '../_shared/scope.mjs';
import { configurePolite, resetPolite, politeFetch, fetchRobotsPolicy, cached, readCache, markContacted, acquire, LIMITS, runReport } from '../_shared/polite.mjs';
import { validateTarget, makePinnedLookup } from '../_shared/guards.mjs';
import { checkIsolation, verifyIsolation } from '../_shared/isolation.mjs';
import { buildInsideScript, sandboxStatus } from '../sandbox_setup/sandbox_setup.mjs';
import { inspectChain, liveGate, liveHopAuthorizer } from '../redirect_inspector/redirect_inspector.mjs';
import { createLedger, addItem, setVerdict, suggestVerdict, validateLedger, toMarkdown } from '../evidence_ledger/ledger.mjs';
import { sanitizeText, mdUrl } from '../_shared/output.mjs';
import { excerpt } from '../github_evidence/github_evidence.mjs';
import { fileProblems, buildPacket } from '../case_packet/case_packet.mjs';

const TMP = join(root, '.test_tmp');
const dir = join(TMP, `audit-${randomUUID()}`); fs.mkdirSync(dir, { recursive: true });
const runDir = fs.mkdtempSync(join(dir, 'run-'));
after(() => { clearActiveScope(); fs.rmSync(dir, { recursive: true, force: true }); try { fs.rmdirSync(TMP); } catch { /* in use */ } });
const now = new Date();
const scope = () => ({ ...template(now), targets: ['alpha.example', 'owner/fake'], disclosures: ['github', 'rdap', 'dns', 'target_website'], persistence: 'local', permissions: { ...template(now).permissions, save_local: true, live_http_inspection: true, run_project_tests: true } });
function setup(name, persist = false) { let t = now.getTime(); configurePolite({ dir: join(runDir, name), clock: () => t, wait: async (ms) => { t += ms; }, resultCaching: persist }); resetPolite(); clearActiveScope(); }
const response = (status = 200, body = '', location) => new Response(body, { status, headers: location ? { location } : undefined });
// Stand-in toolbox root with a sibling "outside" folder, both inside the throwaway folder.
const box = join(dir, 'box'); const outside = join(dir, 'outside');
fs.mkdirSync(box, { recursive: true }); fs.mkdirSync(outside, { recursive: true });

test('PASS scope negative matrix', () => { for (const change of [{ status: 'stopped' }, { expires_at: '2000-01-01T00:00:00Z' }, { permissions: {} }, { targets: ['other.example'] }, { disclosures: [] }]) assert.equal(authorize({ ...scope(), ...change }, { action: 'passive_lookup', target: 'alpha.example', services: ['dns'] }).allowed, false); assert.equal(authorize({ ...scope(), persistence: 'transient' }, { action: 'save_local' }).allowed, false); });

// F01 ORIGINAL (kept): asserts a manufactured approval is refused. Under the attestation model chosen for F01 this
// cannot hold: any process that can write the scope can write an attestation. Replacement below.
test.skip('F01 approval cannot be manufactured without human interaction [ORIGINAL; superseded by attestation model, see replacement]', () => { const s = scope(); const a = { action: 'live_http_inspection', target: 'https://alpha.example/', approved_at: now.toISOString(), approved_via: 'interactive_terminal' }; a.check = approvalCheck(s, a); s.approvals = [a]; assert.equal(authorize(s, { action: a.action, target: a.target }).allowed, false); });
test('F01 replacement: approvals are operator attestations, never presented as proof of a human; old "human-only" records are not honored', () => {
  const s = scope();
  const legacy = { action: 'live_http_inspection', target: 'https://alpha.example/', approved_at: now.toISOString(), approved_via: 'interactive_terminal' }; legacy.check = approvalCheck(s, legacy);
  assert.equal(authorize({ ...s, approvals: [legacy] }, { action: legacy.action, target: legacy.target, services: ['target_website'] }).allowed, false, 'records claiming human-only approval are not accepted');
  const att = { action: 'live_http_inspection', target: 'https://alpha.example/', attested_at: now.toISOString(), attested_by: 'operator' };
  const r = authorize({ ...s, approvals: [att] }, { action: att.action, target: att.target, services: ['target_website'] });
  assert.equal(r.allowed, true); assert.match(r.basis, /operator attestation/); assert.match(r.basis, /not proof/);
  for (const f of ['TOOLKIT_RULES.md', 'CLAUDE.md', '_shared/scope.mjs', 'incident_intake/incident_intake.mjs']) {
    assert.doesNotMatch(fs.readFileSync(join(root, f), 'utf8'), /cannot create approvals|Automated processes[^.]*cannot (create|approve)|real barrier/i, f);
  }
});

// F02 live ORIGINAL (kept): injects a domain-only allowHop and expects the second URL not to be sent. The CLI no
// longer uses a domain-only check: it uses liveHopAuthorizer (exact-URL attestation per hop). Replacement below.
test.skip('F02 live redirect requires approval for each exact destination [ORIGINAL; injects the old domain-only allowHop]', async () => { setup('live'); const s = scope(); const sent = []; await inspectChain('https://alpha.example/', { allowHop: (u) => inScope(s, u.href), robots: async () => ({ allowed: true }), transport: async (u) => { sent.push(u.href); return sent.length === 1 ? { status: 302, location: '/unapproved' } : { status: 200 }; } }); assert.deepEqual(sent, ['https://alpha.example/']); });
test('F02 live replacement: the CLI hop authorizer requires an exact-URL attestation for each destination', async () => {
  setup('live2');
  const s = { ...scope(), approvals: [{ action: 'live_http_inspection', target: 'https://alpha.example/', attested_at: now.toISOString(), attested_by: 'operator' }] };
  const sent = [];
  await inspectChain('https://alpha.example/', { allowHop: liveHopAuthorizer(s), robots: async () => ({ allowed: true, basis: 't' }), transport: async (u) => { sent.push(u.href); return sent.length === 1 ? { status: 302, location: '/unapproved' } : { status: 200 }; } });
  assert.deepEqual(sent, ['https://alpha.example/']);
  s.approvals.push({ action: 'live_http_inspection', target: 'https://alpha.example/unapproved', attested_at: now.toISOString(), attested_by: 'operator' });
  const sent2 = [];
  await inspectChain('https://alpha.example/', { allowHop: liveHopAuthorizer(s), robots: async () => ({ allowed: true, basis: 't' }), transport: async (u) => { sent2.push(u.href); return sent2.length === 1 ? { status: 302, location: '/unapproved' } : { status: 200 }; } });
  assert.deepEqual(sent2, ['https://alpha.example/', 'https://alpha.example/unapproved'], 'an attested second URL is allowed');
});
test('F02 passive redirect must not contact undeclared service', async () => { setup('passive'); const sent = []; await politeFetch('https://api.github.com/repos/owner/fake', {}, { fetchImpl: async (u) => { sent.push(u.href); return u.pathname === '/robots.txt' ? response() : u.hostname === 'api.github.com' ? response(302, '', 'https://outside.example/private-case') : response(); } }).catch(() => {}); assert.equal(sent.some((u) => u.includes('outside.example')), false); });
test('F02 robots redirect must not contact out-of-scope destination', async () => { const sent = []; await fetchRobotsPolicy('https://alpha.example/', { gate: async () => {}, fetchImpl: async (u) => { sent.push(u.href); return sent.length === 1 ? response(302, '', 'https://outside.example/policy') : response(); } }); assert.deepEqual(sent, ['https://alpha.example/robots.txt']); });
test('F03 isolation checks actual firewall filters, not counts', () => { const state = { platform: 'win32', username: 'WDAGUtilityAccount', profiles: [{ enabled: true, defaultOutbound: 'Block' }], gb2lAllow: 3, gb2lBlock: 1, otherAllow: 0, adaptersUp: 1, rules: [{ name: 'gb2l allow anything', action: 'Allow', ports: 'Any', addresses: 'Any' }, { name: 'gb2l irrelevant block', action: 'Block', addresses: '203.0.113.1' }] }; assert.equal(checkIsolation('inspect', { env: { GITBACK2LIFE_ISOLATED: 'inspect' }, state }).isolated, false); });
test('PASS real host isolation rejected (read-only OS query)', () => { const results = { sandbox: sandboxStatus(), inspect: verifyIsolation('inspect'), tests: verifyIsolation('tests') }; fs.writeFileSync(join(dir, 'real_isolation.json'), JSON.stringify(results, null, 2)); assert.equal(results.inspect.isolated, false); assert.equal(results.tests.isolated, false); assert.equal(liveGate({ url: 'https://alpha.example/', approve: 'https://alpha.example/', live: true, env: {}, isolation: results.inspect }).allowed, false); });

// F04 ORIGINAL (kept): asserts the generated script makes a junction AND that safeWrite writes through a junction.
// Making that pass would require disabling junction protection, which the task forbids. Replacement below.
test.skip('F04 sandbox cache junction is compatible with safe writes [ORIGINAL; would require weakening the junction guard]', () => { assert.match(buildInsideScript('inspect'), /ItemType Junction/); });
test('F04 replacement: the inspect sandbox addresses its state folder directly (no junction) and state writes keep containment', async () => {
  const ps1 = buildInsideScript('inspect');
  assert.doesNotMatch(ps1, /ItemType Junction/);
  assert.match(ps1, /GITBACK2LIFE_STATE_ROOT = 'C:\\gb2l-state'/);
  const { resolveStateDir, SANDBOX_STATE_ROOT } = await import('../_shared/polite.mjs');
  assert.equal(SANDBOX_STATE_ROOT, 'C:\\gb2l-state');
  assert.throws(() => resolveStateDir({ GITBACK2LIFE_STATE_ROOT: 'D:\\elsewhere' }), /only .*C:\\gb2l-state/);
  // A directly addressed state root works with safeWrite (root = that folder); a junction inside it is still refused.
  const stateRoot = join(dir, 'state-root'); fs.mkdirSync(stateRoot, { recursive: true });
  assert.doesNotThrow(() => safeWrite(join(stateRoot, 'state.json'), '{}', { root: stateRoot, overwrite: true }));
  const link = join(stateRoot, 'link'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => safeWrite(join(link, 'x.json'), '{}', { root: stateRoot }), /link/);
});
test('PASS junction escape is rejected', () => { const link = join(box, 'escape'); if (!fs.existsSync(link)) fs.symlinkSync(outside, link, 'junction'); assert.throws(() => safeWrite(join(link, 'escape.txt'), 'bad', { root: box }), /link|outside/); assert.equal(fs.existsSync(join(outside, 'escape.txt')), false); });
test('F05 hardlink overwrite cannot change file outside toolbox', () => { const out = join(outside, 'hardlink.txt'); fs.writeFileSync(out, 'unchanged'); const link = join(box, 'hardlink.txt'); if (!fs.existsSync(link)) fs.linkSync(out, link); try { safeWrite(link, 'modified', { overwrite: true, root: box }); } catch { /* refusal is acceptable */ } assert.equal(fs.readFileSync(out, 'utf8'), 'unchanged'); });
test('PASS private IPv4 and IPv6 URL matrix', () => { for (const host of ['127.0.0.1', '2130706433', '0x7f000001', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]']) assert.throws(() => validateTarget(`http://${host}/`)); });
test('PASS mixed public/private DNS answers rejected without connection', async () => { await assert.rejects(new Promise((resolve, reject) => makePinnedLookup(async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }])('alpha.example', { all: true }, (e, a) => (e ? reject(e) : resolve(a)))), /non-public/); });
test('PASS loop downgrade private redirect and redirect limit matrix', async () => { for (const [name, location] of [['loop', 'https://alpha.example/'], ['downgrade', 'http://alpha.example/'], ['private', 'http://[::1]/']]) { setup(name); await assert.rejects(politeFetch('https://alpha.example/', {}, { fetchImpl: async (u) => (u.pathname === '/robots.txt' ? response() : response(302, '', location)) }), /loop|https to http|non-public/); } setup('long'); let n = 0; await assert.rejects(politeFetch('https://alpha.example/0', {}, { fetchImpl: async (u) => (u.pathname === '/robots.txt' ? response() : response(302, '', `/${++n}`)) }), /more than/); assert.equal(n, 6); assert.equal(runReport().total, 7); });
test('PASS cross-origin authorization and cookies stripped', async () => { setup('headers'); const sent = []; await politeFetch('https://alpha.example/', { headers: { Authorization: 'synthetic', Cookie: 'synthetic' } }, { fetchImpl: async (u, init) => { if (u.pathname === '/robots.txt') return response(); sent.push(new Headers(init.headers)); return sent.length === 1 ? response(302, '', 'https://beta.example/') : response(); } }); assert.equal(sent[1].has('authorization'), false); assert.equal(sent[1].has('cookie'), false); });
test('PASS robots unsafe/overlong redirect fails closed', async () => { for (const location of ['http://[fe80::1]/', 'http://alpha.example/robots.txt', 'https://alpha.example/robots.txt']) { let n = 0; const r = await fetchRobotsPolicy('https://alpha.example/', { gate: async () => {}, fetchImpl: async () => { n++; return response(302, '', location); } }); assert.match(r.basis, /off-limits/); assert.ok(n <= 6); } });
test('F06 concurrent acquires must enforce per-run cap', async () => { setup('parallel'); const limits = { ...LIMITS, maxPerRun: 2, maxPerServicePerRun: 2 }; await acquire('alpha.example', { limits }); const r = await Promise.allSettled([acquire('alpha.example', { limits }), acquire('alpha.example', { limits })]); assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1); });
test('F06 transient lookup must retain rate-limit reuse without storing result', async () => { setup('transient'); let requests = 0; await cached('lookup:alpha', async () => ({ n: ++requests })); await cached('lookup:alpha', async () => ({ n: ++requests })); assert.equal(readCache('lookup:alpha'), null); assert.equal(requests, 1); });
test('PASS transient result not persisted; local result is persisted', async () => { setup('noresult'); await cached('lookup', async () => ({ data: 'synthetic' })); assert.equal(readCache('lookup'), null); setup('localresult', true); await cached('lookup', async () => ({ data: 'synthetic' })); assert.equal(readCache('lookup').value.data, 'synthetic'); });
test('F07 safety cooldown must not store secret-bearing URLs', () => { setup('secretcooldown'); markContacted('redirect_inspector:https://alpha.example/?token=SYNTHETIC_SECRET'); const text = fs.readdirSync(join(runDir, 'secretcooldown')).map((f) => fs.readFileSync(join(runDir, 'secretcooldown', f), 'utf8')).join(''); assert.equal(text.includes('SYNTHETIC_SECRET'), false); });
test('F07 GitHub evidence excerpt masks contacts and URL secrets', () => { const text = JSON.stringify(excerpt('jane@example.org https://alpha.example/?token=SYNTHETIC_SECRET')); assert.doesNotMatch(text, /jane@example.org|SYNTHETIC_SECRET/); });
test('F07 Markdown URL hides token in path and code in fragment', () => { assert.doesNotMatch(mdUrl('https://alpha.example/ghp_abcdefghijklmnopqrstuvwxyz0123456789#code=SYNTHETIC_SECRET'), /ghp_|SYNTHETIC_SECRET/); });
test('F08 malformed evidence URL must not crash sanitizer', () => { assert.doesNotThrow(() => sanitizeText('https://[')); });
test('F09 attached Markdown must not retain executable rendering markup', () => { assert.notDeepEqual(fileProblems('hostile.md', Buffer.from('<img src="https://tracking.example/pixel">\n[run](javascript:alert(1))')), []); });
const item = (changes = {}) => ({ label: 'confirmed_observation', text: 'Synthetic observation', source_url: 'https://source.example/evidence', retrieved_at: now.toISOString(), org: 'Alpha', signal: 'compromise_confirmed', asset: { kind: 'website', id: 'alpha.example', controlled_by: 'organization' }, ...changes });
test('PASS cross-org, unknown ownership, unconfirmed compromise and unknown role', () => { const l = createLedger('audit'); const i = addItem(l, item()); assert.throws(() => setVerdict(l, 'Beta', 'independent evidence of compromise', [i.id]), /not/); for (const controlled_by of ['third_party', 'unknown']) assert.equal(suggestVerdict([item({ asset: { kind: 'website', id: 'elsewhere.example', controlled_by } })], { subject: 'Alpha' }).verdict, 'needs review'); assert.equal(suggestVerdict([item({ label: 'source_report' })], { subject: 'Alpha' }).verdict, 'needs review'); assert.throws(() => addItem(l, item({ page_role: 'unknown', requested_url: 'https://alpha.example/' })), /page_role/); });
test('F10 unrelated third-party reputation cannot corroborate redirect', () => { const items = [item({ id: 'A', signal: 'redirect_off_domain', page_role: 'primary', requested_url: 'https://alpha.example/', final_url: 'https://benign.example/' }), item({ id: 'B', signal: 'reputation_flag', asset: { kind: 'website', id: 'unrelated.example', controlled_by: 'third_party' } })]; assert.equal(suggestVerdict(items, { subject: 'Alpha' }).verdict, 'needs review'); });
test('PASS hostile ledger text escaped and common secrets masked', () => { const l = createLedger('audit'); addItem(l, item({ text: '# Fake\n<img src=x> [click](javascript:alert(1)) jane@example.org https://alpha.example/?token=SYNTHETIC_SECRET' })); const out = toMarkdown(l); assert.doesNotMatch(out, /<img|jane@example.org|SYNTHETIC_SECRET/); assert.deepEqual(validateLedger(l), []); assert.throws(() => buildPacket(l), /review/); });
const guard = pathToFileURL(join(root, 'regression_harness', 'network_guard.mjs')).href;
const entries = [['github_evidence/github_evidence.mjs', ['issue', 'owner/fake', '1']], ['domain_research/domain_research.mjs', ['rdap', 'alpha.example']], ['domain_watch/domain_watch.mjs', ['check', 'alpha.example']], ['email_spoof_check/email_spoof_check.mjs', ['check', 'alpha.example']], ['lookalike_domain_check/lookalike_domain_check.mjs', ['check', 'alpha.example']], ['redirect_inspector/redirect_inspector.mjs', ['inspect', 'https://alpha.example/']]];
for (const [file, args] of entries) test(`PASS CLI scope refusals ${file}`, () => { for (const variant of ['missing', 'stopped', 'expired', 'permission', 'target', 'disclosure']) { const s = scope(); if (variant === 'stopped') s.status = 'stopped'; if (variant === 'expired') s.expires_at = '2000-01-01T00:00:00Z'; if (variant === 'permission') s.permissions = {}; if (variant === 'target') s.targets = ['outside.example']; if (variant === 'disclosure') s.disclosures = []; const path = join(dir, 'cli-scope.json'); fs.writeFileSync(path, JSON.stringify(s)); const r = spawnSync(process.execPath, ['--import', guard, join(root, file), ...args, ...(variant === 'missing' ? [] : ['--scope', path])], { encoding: 'utf8', timeout: 10000 }); assert.match(r.stderr, /scope|SCOPE/); assert.notEqual(r.status, 0); assert.doesNotMatch(r.stderr, /OFFLINE_NETWORK_BLOCKED/); } });
test('F07 email CLI output sanitizes hostile subject by default', () => { const p = join(dir, 'mail.eml'); fs.writeFileSync(p, 'From: sender@example.org\r\nSubject: jane@example.org https://alpha.example/?token=SYNTHETIC_SECRET\r\n\r\nSynthetic'); const r = spawnSync(process.execPath, ['--import', guard, join(root, 'email_header_triage/email_header_triage.mjs'), p, '--json'], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.doesNotMatch(r.stdout, /jane@example.org|SYNTHETIC_SECRET/); });
test('F12 stopping scope halts an already authorized operation', async () => { setup('stop'); const s = scope(), p = join(dir, 'stop-scope.json'); fs.writeFileSync(p, JSON.stringify(s)); requireScope(p, { action: 'passive_lookup', target: 'alpha.example', services: ['rdap'] }); fs.writeFileSync(p, JSON.stringify({ ...s, status: 'stopped' })); let n = 0; try { await politeFetch('https://alpha.example/', {}, { fetchImpl: async () => { n++; return response(); } }); } catch { /* refusal expected */ } assert.equal(n, 0); clearActiveScope(); });
test('DOCUMENTED LIMIT prohibited text and stopping condition are not executable policy', () => { const s = { ...scope(), prohibited: ['passive_lookup'], stopping_condition: 'Stop immediately; condition has been met' }; assert.equal(authorize(s, { action: 'passive_lookup', target: 'alpha.example' }).allowed, true); });
test('PASS offline writer CLIs refuse missing stopped transient and denied scope', () => { const ledger = join(dir, 'writer-ledger.json'); fs.writeFileSync(ledger, JSON.stringify(createLedger('synthetic'))); for (const [file, args, flag] of [['evidence_ledger/ledger.mjs', ['render', ledger], '--save'], ['decision_summary/decision_summary.mjs', [ledger], '--save'], ['notice_drafter/notice_drafter.mjs', [ledger], '--save'], ['case_packet/case_packet.mjs', ['build', ledger, '--reviewed-for-personal-info'], '--out']]) for (const change of [null, { status: 'stopped' }, { persistence: 'transient' }, { permissions: {} }]) { const p = join(dir, 'writer-scope.json'), out = join(dir, `must-not-exist-${Math.random()}.txt`); fs.writeFileSync(p, JSON.stringify({ ...scope(), ...change })); const r = spawnSync(process.execPath, ['--import', guard, join(root, file), ...args, flag, out, ...(change ? ['--scope', p] : [])], { encoding: 'utf8' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /scope/); assert.equal(fs.existsSync(out), false); } });
test('PASS runner CLI refuses real unisolated host without executing child payload', () => { const p = join(dir, 'runner-scope.json'); fs.writeFileSync(p, JSON.stringify(scope())); const r = spawnSync(process.execPath, ['--import', guard, join(root, 'regression_harness/run_offline.mjs'), '--cwd', dir, '--reviewed', '--scope', p, '--', 'node', '--version'], { encoding: 'utf8', timeout: 40000 }); assert.notEqual(r.status, 0); assert.match(r.stderr, /outside the verified tests-mode sandbox/); assert.doesNotMatch(r.stdout, /v24/); });
