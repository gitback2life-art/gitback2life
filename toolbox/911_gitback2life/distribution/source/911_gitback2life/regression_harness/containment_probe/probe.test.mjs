// Containment probe: run ONLY inside the tests-mode Windows Sandbox, through run_offline (`npm test`).
// It behaves like untrusted project code and tries to get out. Every test PASSES when the attempt is STOPPED.
// The only destination ever attempted is https://example.com/ (reserved for examples), with one HEAD request,
// and only if containment has already failed. This file is two folders deep, so the toolbox's own suite
// ("*/*.test.mjs") never runs it on a normal computer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('Node code cannot reach the internet (run_offline network guard)', async () => {
  await assert.rejects(fetch('https://example.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }));
});

// V4-06: this child inherits run_offline's dead proxy settings, so its failure does NOT show what stopped it.
// OS-level containment is tested separately, without guard or proxy, by os_egress_probe.mjs.
test('a separate program started by the tests did not reach the internet (cause not isolated here: see os_egress_probe)', (t) => {
  const curl = 'C:\\Windows\\System32\\curl.exe';
  if (!existsSync(curl)) return t.skip('curl.exe not present');
  const r = spawnSync(curl, ['-sS', '-I', '--connect-timeout', '5', '--max-time', '8', 'https://example.com/'], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(r.status, 0, `curl reached the internet: ${(r.stdout || '').split('\n')[0]}`);
});

test('secret-looking environment variables were removed and the network guard is preloaded', () => {
  assert.deepEqual(Object.keys(process.env).filter((k) => /TOKEN|SECRET|PASSWORD|API_?KEY|COOKIE|SESSION/i.test(k)), []);
  assert.match(process.env.NODE_OPTIONS ?? '', /network_guard\.mjs/);
});

// npm runs "pretest" (if at all) before node --test loads this file. run_offline passes --ignore-scripts, so it must
// not run. The first sandbox run, before that fix, showed it DID run. The answer is also in the test NAME, so it is on
// the line the person reads. If an older marker file is ever present in the sandbox copy, this fails visibly.
const pretestRan = existsSync('PRETEST_RAN.txt');
test(`LIFECYCLE: npm's pretest script ${pretestRan ? 'DID run' : 'did NOT run'} (must not run)`, () => {
  assert.equal(pretestRan, false, 'npm ran a project lifecycle script; run_offline must pass --ignore-scripts');
});
