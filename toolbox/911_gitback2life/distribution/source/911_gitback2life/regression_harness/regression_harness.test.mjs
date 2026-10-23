import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLBOX_ROOT } from '../_shared/common.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reviewDiff } from './diff_scope_check.mjs';
import { commandProblems, main as runOfflineMain, offlineEnv, parseTestSummary, resolveRunner, splitCommand } from './run_offline.mjs';

test('run_offline accepts plain Node test commands only', () => {
  for (const ok of ['npx tsx --test tests/*.test.ts', 'npm test', 'node --test', 'npm.cmd test']) {
    assert.deepEqual(commandProblems(ok), [], ok);
  }
  for (const bad of ['python -m pytest', 'curl https://x', 'npm test && curl x', 'npm test | tee out', 'npm test > out.txt',
    'npm install', 'npm ci', 'npx some-tool', 'npm exec foo', 'node -e "$(curl x)"']) {
    assert.ok(commandProblems(bad).length > 0, bad);
  }
});

const GUARD = pathToFileURL(fileURLToPath(new URL('./network_guard.mjs', import.meta.url))).href;

test('network guard blocks fetch, http, raw TCP, DNS (both import styles) and UDP in a child process', () => {
  const probe = `
    import http from 'node:http'; import net from 'node:net'; import dns from 'node:dns'; import dgram from 'node:dgram';
    import { lookup } from 'node:dns/promises';
    const ok = (e) => String(e?.message).includes('OFFLINE_NETWORK_BLOCKED') ? 'blocked' : 'other:' + e?.message;
    const r = {};
    r.fetch = await fetch('http://127.0.0.1:9/').then(() => 'allowed', ok);
    r.http = await new Promise((res) => { try { http.get('http://127.0.0.1:9/', () => res('allowed')).on('error', (e) => res(ok(e))); } catch (e) { res(ok(e)); } });
    r.tcp = await new Promise((res) => { try { net.connect(9, '127.0.0.1').on('error', (e) => res(ok(e))).on('connect', () => res('allowed')); } catch (e) { res(ok(e)); } });
    r.dns_named = await lookup('example.com').then(() => 'allowed', ok);
    r.dns_cb = await new Promise((res) => dns.resolve4('example.com', (e) => res(e ? ok(e) : 'allowed')));
    try { dgram.createSocket('udp4'); r.udp = 'allowed'; } catch (e) { r.udp = ok(e); }
    console.log(JSON.stringify(r));`;
  const out = execFileSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', probe], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  for (const [k, v] of Object.entries(r)) assert.equal(v, 'blocked', `${k}: ${v}`);
});

test('offlineEnv strips secret-looking variables and preloads the guard', () => {
  const env = offlineEnv({ PATH: 'x', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', MY_API_KEY: 'k', NODE_OPTIONS: '--max-old-space-size=512' });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.PATH, 'x');
  assert.match(env.NODE_OPTIONS, /^--max-old-space-size=512 --import=file:/);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
});

test('parseTestSummary reads both TAP and spec reporter summaries', () => {
  assert.deepEqual(parseTestSummary('# tests 144\n# pass 144\n# fail 0\n# skipped 0'), { tests: 144, pass: 144, fail: 0, skipped: 0 });
  assert.deepEqual(parseTestSummary('ℹ tests 3\nℹ pass 2\nℹ fail 1'), { tests: 3, pass: 2, fail: 1 });
});

test('diff scope check passes a rules+test change and flags data, workflow and threshold edits', () => {
  const good = 'diff --git a/scripts/agent/rules.ts b/scripts/agent/rules.ts\n--- a/x\n+++ b/x\n-  const moved = pages.find((p) => p.offDomain);\n+  const moved = pages.find((p) => p.role === "primary" && p.offDomain);\n';
  assert.equal(reviewDiff(good).in_scope, true);
  const bad = [
    'diff --git a/data/orgs/x.json b/data/orgs/x.json', '+++ b/data/orgs/x.json', '+  "phone": "212-555-0100",',
    'diff --git a/.github/workflows/weekly.yml b/.github/workflows/weekly.yml', '+++ b/.github/workflows/weekly.yml', '+  MAX_FLAGGED: 100',
  ].join('\n');
  const reasons = reviewDiff(bad).flags.map((f) => f.reason);
  for (const r of ['directory data', 'CI workflow', 'phone number', 'safety threshold']) assert.ok(reasons.includes(r), r);
});

test('commands become fixed argument lists, run by Node itself, with no shell', () => {
  assert.deepEqual(splitCommand('npx tsx --test "tests/a b.test.ts"'), ['npx', 'tsx', '--test', 'tests/a b.test.ts']);
  const exec = 'C:\\nodejs\\node.exe';
  const [file, args] = resolveRunner(['npx', 'tsx', '--test'], { execPath: exec });
  assert.equal(file, exec);
  assert.ok(args[0].endsWith('npx-cli.js'));
  assert.equal(args[1], '--no', 'npx can never download a package');
  assert.deepEqual(resolveRunner(['node', '--test'], { execPath: exec }), [exec, ['--test']]);
  const npm = resolveRunner(['npm.cmd', 'test'], { execPath: exec })[1];
  assert.ok(npm[0].endsWith('npm-cli.js'));
  // Real-sandbox finding: npm ran the project's pretest script. npm must never run pre/post lifecycle scripts here.
  assert.equal(npm[1], '--ignore-scripts');
  assert.deepEqual(npm.slice(2), ['test']);
  assert.throws(() => resolveRunner(['python', 'x.py']), /unsupported runner/);
  const src = readFileSync(new URL('./run_offline.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /shell:\s*true/);
});

test('project tests are refused outside the verified tests-mode sandbox (this computer is not one)', async () => {
  const dir = join(TOOLBOX_ROOT, '.test_tmp', `rh-${Date.now()}`);
  mkdirSync(join(dir, 'proj'), { recursive: true });
  try {
    const scope = join(dir, 'scope.json');
    const permissions = { read_public_github: false, passive_lookup: false, save_local: false, local_patch: false, run_project_tests: true,
      live_http_inspection: false, third_party_submission: false, external_write: false, contact_third_party: false, publish: false };
    writeFileSync(scope, JSON.stringify({ incident_id: 'rh-test', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(),
      status: 'open', question: 'q', targets: ['owner/repo'], scope: 's', urgency: 'normal', confidence: 'low', permissions, disclosures: [],
      approvals: [], prohibited: ['p'], stopping_condition: 'c', persistence: 'transient' }));
    await assert.rejects(runOfflineMain(['--cwd', join(dir, 'proj'), '--reviewed', '--scope', scope, '--', 'npm', 'test']), /outside the verified tests-mode sandbox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ }
  }
});
test('V4-05: the caller cannot undo --ignore-scripts or run lifecycle scripts by name', () => {
  for (const bad of ['npm test --ignore-scripts=false', 'npm test --no-ignore-scripts', 'npm --ignore-scripts=false test', 'npm test --ignore-scripts false',
    'npm -ddd test', 'npm test --script-shell=x', 'npm test --node-options=--require=x', 'npm run pretest', 'npm run postinstall', 'npm run prepare',
    'npm run', 'npm test extra', 'npm run test:unit more']) {
    assert.notEqual(commandProblems(bad).length, 0, bad);
  }
  for (const ok of ['npm test', 'npm t', 'npm run test:unit', 'npm test -- --grep fast', 'npm run test:unit -- --verbose']) {
    assert.deepEqual(commandProblems(ok), [], ok);
  }
  // Whatever is accepted, npm's own options come from run_offline, first, and the caller adds none before "--".
  const args = resolveRunner(splitCommand('npm test -- --ignore-scripts=false'), { execPath: 'C:\\node\\node.exe' })[1];
  assert.equal(args[1], '--ignore-scripts');
  assert.deepEqual(args.slice(2), ['test', '--', '--ignore-scripts=false'], 'after "--" it is an argument to the test script, not to npm');
  // npm settings inherited from the environment are dropped; the safe ones are set.
  const env = offlineEnv({ PATH: 'x', npm_config_ignore_scripts: 'false', NPM_CONFIG_SCRIPT_SHELL: 'evil.exe' });
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.NPM_CONFIG_SCRIPT_SHELL, undefined);
});
test('V4-06: the OS egress probe only calls containment proven when every alternative cause is ruled out', async () => {
  const { classify, TARGET } = await import('./containment_probe/os_egress_probe.mjs');
  assert.equal(TARGET.host, '192.0.2.1', 'TEST-NET-1: documentation address, no real host');
  const ok = { guardLoaded: false, proxyVarsPresent: [], curlVersion: { status: 0 }, loopback: 'connected', config: { adaptersUp: 0, defaultRoutes: 0 },
    tcp: { result: 'error', code: 'ENETUNREACH', ms: 3 }, curl: { status: 7 }, dns: { result: 'error', code: 'ECONNREFUSED' } };
  assert.equal(classify(ok).contained, true);
  const not = (change, why) => assert.equal(classify({ ...ok, ...change }).contained, false, why);
  not({ guardLoaded: true }, 'Node guard present: result would not isolate the OS');
  not({ proxyVarsPresent: ['HTTPS_PROXY'] }, 'a proxy variable present');
  not({ curlVersion: { status: null } }, 'curl did not even start');
  not({ loopback: 'error EACCES' }, 'socket stack broken: failure would not be about egress');
  not({ tcp: { result: 'connected', ms: 40 } }, 'TCP connected');
  not({ tcp: { result: 'error', code: 'ECONNREFUSED', ms: 5 } }, 'something answered: a path exists');
  not({ tcp: { result: 'timeout', ms: 8000 }, config: { adaptersUp: 1, defaultRoutes: 1 } }, 'a timeout WITH a route is inconclusive');
  assert.equal(classify({ ...ok, tcp: { result: 'timeout', ms: 8000 } }).contained, true, 'a timeout with no adapter and no route is the OS');
  not({ curl: { status: 0 } }, 'curl connected');
  not({ curl: { status: 5 } }, 'curl proxy failure is not OS containment');
  not({ curl: { status: 2 } }, 'curl failed to initialize');
  not({ dns: { result: 'error', code: 'ENOTFOUND' } }, 'a DNS server answered "no such name"');
  not({ dns: { result: 'answer', addresses: ['1.2.3.4'] } }, 'DNS answered');
});

test('V4-06: the OS egress probe refuses to run outside the verified tests-mode sandbox (this computer)', async () => {
  const { main } = await import('./containment_probe/os_egress_probe.mjs');
  await assert.rejects(main({ env: {} }), /only runs inside the verified tests-mode sandbox/);
});