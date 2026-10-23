// V4-07: everything saved from a ledger is bound to the incident that authorized the save.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TOOLBOX_ROOT } from './common.mjs';
import { requireSameIncident, template } from './scope.mjs';
import { createLedger } from '../evidence_ledger/ledger.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `binding-art-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });
const GUARD = pathToFileURL(join(TOOLBOX_ROOT, 'regression_harness', 'network_guard.mjs')).href;

const scopeFile = join(TMP, 'scope.json');
writeFileSync(scopeFile, JSON.stringify({ ...template(), incident_id: 'incident-alpha', targets: ['alpha.org'], persistence: 'local', permissions: { ...template().permissions, save_local: true } }));
const ledgerFile = (id) => { const f = join(TMP, `${id}-${randomUUID()}.json`); writeFileSync(f, JSON.stringify(createLedger(id))); return f; };
const run = (tool, args) => spawnSync(process.execPath, ['--import', GUARD, join(TOOLBOX_ROOT, tool), ...args], { encoding: 'utf8', timeout: 20000 });

const TOOLS = [
  ['evidence_ledger/ledger.mjs', (l, out) => ['render', l, '--scope', scopeFile, '--save', out]],
  ['decision_summary/decision_summary.mjs', (l, out) => [l, '--scope', scopeFile, '--save', out]],
  ['notice_drafter/notice_drafter.mjs', (l, out) => [l, '--scope', scopeFile, '--save', out]],
  ['case_packet/case_packet.mjs', (l, out) => ['build', l, '--reviewed-for-personal-info', '--scope', scopeFile, '--out', out]],
];

for (const [tool, args] of TOOLS) {
  test(`${tool}: another incident's ledger is refused and nothing is written; the scope's own incident still saves`, () => {
    const outBad = join(TMP, `bad-${randomUUID()}.out`);
    const bad = run(tool, args(ledgerFile('unrelated-incident-beta'), outBad));
    assert.notEqual(bad.status, 0, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /belongs to incident "unrelated-incident-beta".*authorizes incident "incident-alpha"/s);
    assert.equal(existsSync(outBad), false);
    const outGood = join(TMP, `good-${randomUUID()}.out`);
    const good = run(tool, args(ledgerFile('incident-alpha'), outGood));
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(existsSync(outGood), true);
  });
}

test('ledger new: a ledger can only be created under its own incident\'s scope', () => {
  const out = join(TMP, `new-${randomUUID()}.json`);
  const r = run('evidence_ledger/ledger.mjs', ['new', 'unrelated-incident-beta', '--scope', scopeFile, '--save', out]);
  assert.notEqual(r.status, 0); assert.equal(existsSync(out), false);
});

test('requireSameIncident: missing or mismatched incident ids are refused; nothing is checked when not saving', () => {
  const s = { incident_id: 'a' };
  assert.doesNotThrow(() => requireSameIncident(s, 'a'));
  for (const id of ['b', '', undefined, null, 7]) assert.throws(() => requireSameIncident(s, id), /belongs to incident/);
  assert.doesNotThrow(() => requireSameIncident(null, 'anything'));
});
