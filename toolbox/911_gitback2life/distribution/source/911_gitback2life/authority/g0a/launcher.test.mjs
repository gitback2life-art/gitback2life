// G0a: trusted launch canaries (design revision 3.1, §14.1; test groups C and I-21). Every run uses a THROWAWAY COPY
// of the launcher in a temporary folder, non-elevated. Nothing is installed; the production authority is not touched.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const SRC = join(import.meta.dirname, 'launcher');
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const ROOT = mkdtempSync(join(tmpdir(), 'g0a-launch-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let n = 0;

/** A throwaway authority folder: the four prototype files plus a manifest of their hashes. */
function copy() {
  const dir = join(ROOT, `a${n++}`);
  rmSync(dir, { recursive: true, force: true });
  (spawnSync(CMD, ['/d', '/c', 'mkdir', dir]).status === 0) || assert.fail('mkdir');
  for (const f of ['authority.cmd', 'bootstrap.mjs', 'prototype_module.mjs', 'helper_env.ps1']) copyFileSync(join(SRC, f), join(dir, f));
  const files = Object.fromEntries(['prototype_module.mjs', 'helper_env.ps1'].map((f) => [f, sha(readFileSync(join(dir, f)))]));
  writeFileSync(join(dir, 'installed_manifest.json'), JSON.stringify({ files }));
  return dir;
}

/** Launch exactly as the owner would: cmd /d /s /c ""<dir>\authority.cmd" <args>", with `env` as the parent environment. */
function launch(dir, argText, env = process.env) {
  const r = spawnSync(CMD, ['/d', '/s', '/c', `""${dir}\\authority.cmd"${argText ? ` ${argText}` : ''}"`],
    { encoding: 'utf8', env, windowsVerbatimArguments: true, timeout: 60_000 });
  const line = String(r.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  let json = null; try { json = JSON.parse(line); } catch { /* the launcher refused before Node ran */ }
  return { status: r.status, json, stderr: String(r.stderr) };
}

/** Inert canaries: when executed they only write a marker file. */
function canaries(dir) {
  const marker = join(dir, 'CANARY_RAN');
  const cjs = join(dir, 'canary.cjs'), mjs = join(dir, 'canary.mjs');
  writeFileSync(cjs, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  writeFileSync(mjs, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  return { marker, cjs, mjs };
}

test('C: a normal launch loads the verified module; one argument stays ONE argument (condition 1: absent optional omitted)', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const one = launch(dir, 'selftest');
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(one.json.args, ['selftest'], 'no empty second argument is forwarded');
  assert.equal(one.json.module, 'prototype module loaded after verification');
  const two = launch(dir, 'apply 0123abcd');
  assert.deepEqual(two.json.args, ['apply', '0123abcd']);
});

test('C7: NODE_OPTIONS preload canaries (--require and --import) never execute under the launcher; the control shows they would', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const { marker, cjs, mjs } = canaries(dir);
  // NODE_OPTIONS treats a backslash inside double quotes as an escape, so the --require path is given with forward
  // slashes and unquoted (the temporary folder has no spaces; asserted).
  assert.ok(!/\s/.test(cjs), 'temporary path without spaces');
  for (const opt of [`--require ${cjs.replace(/\\/g, '/')}`, `--import "${pathToFileURL(mjs).href}"`]) {
    const env = { ...process.env, NODE_OPTIONS: opt, NODE_PATH: dir };
    const r = launch(dir, 'selftest', env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.ok(!existsSync(marker), `launcher: ${opt} did not run`);
    // Control: the same environment WITHOUT the launcher does run the canary, so the test can detect it.
    spawnSync(NODE, ['-e', '0'], { env, timeout: 60_000 });
    assert.ok(existsSync(marker), `control: ${opt} runs when Node is started directly`);
    rmSync(marker);
  }
});

/** Start a launch WITHOUT waiting, so two can run at the same time. Resolves like launch(). */
function launchAsync(dir, argText, env) {
  return new Promise((resolve) => {
    const child = spawn(CMD, ['/d', '/s', '/c', `""${dir}\\authority.cmd" ${argText}"`], { env, windowsVerbatimArguments: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (status) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let json = null; try { json = JSON.parse(line); } catch { /* refused before Node */ }
      resolve({ status, json, stderr: err });
    });
  });
}

test('G0a-F1: concurrent launches with different hostile NODE_OPTIONS: no canary ever runs; each gets the fixed environment or fails closed', { skip: !WIN || !existsSync(NODE) }, async () => {
  const dir = copy();
  const a = canaries(join(dir)), markerA = a.marker;
  const bDir = join(dir, 'b'); spawnSync(CMD, ['/d', '/c', 'mkdir', bDir]);
  const b = canaries(bDir);
  const envA = { ...process.env, NODE_OPTIONS: `--require ${a.cjs.replace(/\\/g, '/')}`, G0A_SIDE: 'A' };
  const envB = { ...process.env, NODE_OPTIONS: `--import "${pathToFileURL(b.mjs).href}"`, G0A_SIDE: 'B', G0A_EXTRA: 'only-in-B' };
  // Positive controls: each environment DOES run its canary when Node is started directly.
  spawnSync(NODE, ['-e', '0'], { env: envA }); assert.ok(existsSync(markerA), 'control A'); rmSync(markerA);
  spawnSync(NODE, ['-e', '0'], { env: envB }); assert.ok(existsSync(b.marker), 'control B'); rmSync(b.marker);
  let ran = 0;
  for (let round = 0; round < 8; round++) {
    const results = await Promise.all([launchAsync(dir, 'selftest', envA), launchAsync(dir, 'selftest', envB)]);
    for (const r of results) {
      const passed = r.status === 0 && r.json?.ok === true;
      const failedClosed = r.status === 2 && r.json === null;
      assert.ok(passed || failedClosed, `round ${round}: either the fixed environment (bootstrap ok) or a closed failure; got ${r.status} ${r.stderr.trim()}`);
      if (passed) ran++;
    }
    assert.ok(!existsSync(markerA) && !existsSync(b.marker), `round ${round}: no canary ran`);
  }
  // Not vacuous: the bootstrap's exact-environment check accepted these launches, i.e. both hostile environments were
  // fully cleared while another launch ran at the same time.
  assert.ok(ran >= 8, `at least half of the 16 concurrent launches completed with the fixed environment (got ${ran})`);
  const left = existsSync(join(dir, 'launch_scratch')) ? readdirSync(join(dir, 'launch_scratch')) : [];
  assert.deepEqual(left, [], 'every per-launch scratch folder was removed');
});

test('G0a-F1: if the private scratch folder cannot be created, Node is never started', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const { marker, cjs } = canaries(dir);
  writeFileSync(join(dir, 'launch_scratch'), 'a FILE where the scratch folder must go'); // injected creation failure
  const r = launch(dir, 'selftest', { ...process.env, NODE_OPTIONS: `--require ${cjs.replace(/\\/g, '/')}` });
  assert.equal(r.status, 2);
  assert.equal(r.json, null, 'no bootstrap output: Node did not start');
  assert.match(r.stderr, /could not create a private scratch folder; Node was not started/);
  assert.ok(!existsSync(marker), 'the preload canary did not run (Node never started)');
});

test('C8: a protected module with a wrong hash is refused BEFORE it runs (its canary never fires)', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const marker = join(dir, 'MODULE_RAN');
  appendFileSync(join(dir, 'prototype_module.mjs'), `\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const r = launch(dir, 'selftest');
  assert.equal(r.status, 3);
  assert.match(r.json.refused, /prototype_module\.mjs does not match/);
  assert.ok(!existsSync(marker), 'the tampered module never executed');
});

test('C8: running the bootstrap without the launcher (wrong flags or inherited environment) is refused; the testkit is refused', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const direct = spawnSync(NODE, [join(dir, 'bootstrap.mjs'), 'selftest'], { encoding: 'utf8', timeout: 60_000 });
  assert.match(JSON.parse(direct.stdout.trim()).refused, /unexpected node options/);
  const flags = spawnSync(NODE, ['--no-addons', '--no-global-search-paths', join(dir, 'bootstrap.mjs'), 'selftest'], { encoding: 'utf8', timeout: 60_000 });
  assert.match(JSON.parse(flags.stdout.trim()).refused, /unexpected environment variables/);
  writeFileSync(join(dir, 'authority_testkit.mjs'), '// present');
  assert.match(launch(dir, 'selftest').json.refused, /authority_testkit\.mjs is present/);
});

test('C9: COR_* and COMPlus_* profiler variables in the caller never reach the PowerShell helper', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const env = { ...process.env, COR_ENABLE_PROFILING: '1', COR_PROFILER: '{00000000-0000-0000-0000-000000000000}', COR_PROFILER_PATH: join(dir, 'none.dll'), COMPlus_G0aCanary: '1' };
  const r = launch(dir, 'helper-env', env);
  assert.equal(r.status, 0, r.stderr);
  const names = r.json.helper_env_names.map((x) => x.toUpperCase());
  assert.ok(names.length > 0, 'the helper ran and reported its environment');
  assert.deepEqual(names.filter((x) => x.startsWith('COR_') || x.startsWith('COMPLUS_')), []);
  assert.ok(!names.includes('NODE_OPTIONS'));
});

test('I-21: launcher arguments: metacharacters, length, emptiness and count are refused before Node; uppercase by the bootstrap', { skip: !WIN || !existsSync(NODE) }, () => {
  const dir = copy();
  const refusedByCmd = ['"a&b"', '"a|b"', '"a b"', '"a%b"', '"a!b"', '"a^b"', '"a(b)"', '"a<b"', '"a>b"', `"${'a'.repeat(65)}"`, '""', 'a b c', 'ok ""', '"é"'];
  for (const a of refusedByCmd) {
    const r = launch(dir, a);
    assert.equal(r.status, 2, `${a}: refused by the launcher (stderr: ${r.stderr.trim()})`);
    assert.equal(r.json, null, `${a}: Node never produced output`);
  }
  const upper = launch(dir, 'ABC');
  assert.equal(upper.status, 3, 'uppercase passes cmd, then the bootstrap\'s exact check refuses it');
  assert.match(upper.json.refused, /invalid arguments/);
  const max = launch(dir, 'a'.repeat(64));
  assert.deepEqual(max.json?.args, ['a'.repeat(64)], '64 characters pass unchanged');
});
