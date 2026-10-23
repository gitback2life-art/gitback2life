// F06 stress: many SEPARATE processes share one daily counter. Exactly the daily cap may be granted, never more.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TOOLBOX_ROOT } from './common.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `stress-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });

const POLITE = pathToFileURL(join(TOOLBOX_ROOT, '_shared', 'polite.mjs')).href;
const CHILD = join(TMP, 'child.mjs');
// Each child is a separate "command": it tries `attempts` requests against the shared counter and reports how many it got.
writeFileSync(CHILD, `
import { acquire, configurePolite, LIMITS } from ${JSON.stringify(POLITE)};
const [dir, attempts, cap] = process.argv.slice(2);
configurePolite({ dir, wait: async () => {} });
const limits = { ...LIMITS, maxPerRun: 1000, maxPerServicePerRun: 1000, maxPerServicePerDay: Number(cap), minIntervalMs: 0, lockWaitMs: 20000 };
let granted = 0, budget = 0, other = 0;
for (let i = 0; i < Number(attempts); i++) {
  try { await acquire('stress.example', { limits }); granted++; } catch (e) { if (e.code === 'POLITE_BUDGET' && /daily budget/.test(e.message)) budget++; else { other++; console.error(e.message); } }
}
console.log(JSON.stringify({ granted, budget, other }));
`);

function runChild(dir, attempts, cap) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, dir, String(attempts), String(cap)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err, ...JSON.parse(out.trim().split('\n').pop() || '{}') }));
  });
}

test('12 processes at once: exactly the daily cap is granted and the counter matches', { timeout: 120000 }, async () => {
  const dir = join(TMP, 'shared'); mkdirSync(dir);
  const CAP = 50, PROCS = 12, EACH = 10; // 120 attempts for 50 slots
  const results = await Promise.all(Array.from({ length: PROCS }, () => runChild(dir, EACH, CAP)));
  for (const r of results) assert.equal(r.other, 0, `unexpected error in a child: ${r.err}`);
  const granted = results.reduce((n, r) => n + r.granted, 0);
  const refused = results.reduce((n, r) => n + r.budget, 0);
  assert.equal(granted, CAP, `granted ${granted}, cap ${CAP}`);
  assert.equal(granted + refused, PROCS * EACH);
  const daily = readdirSync(dir).find((f) => f.startsWith('daily-'));
  assert.equal(JSON.parse(readFileSync(join(dir, daily), 'utf8'))['stress.example'], CAP, 'the stored counter equals what was granted');
  assert.equal(readdirSync(dir).some((f) => f.includes('lock')), false, 'no lock or takeover file left behind');
});

test('an abandoned lock is taken over once, and contending processes still never exceed the cap', { timeout: 120000 }, async () => {
  const dir = join(TMP, 'stale'); mkdirSync(dir);
  const lock = join(dir, 'daily.lock');
  writeFileSync(lock, '99999\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // left behind by a crashed command
  const CAP = 20;
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(dir, 5, CAP)));
  for (const r of results) assert.equal(r.other, 0, `unexpected error in a child: ${r.err}`);
  assert.equal(results.reduce((n, r) => n + r.granted, 0), CAP);
  assert.equal(readdirSync(dir).some((f) => f.includes('lock')), false, 'no lock or takeover file left behind');
});
