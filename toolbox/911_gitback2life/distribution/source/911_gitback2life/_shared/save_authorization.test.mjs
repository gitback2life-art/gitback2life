// V4-02: incident writes need save_local authorized at the moment of writing; safety state keeps working.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeWrite, TOOLBOX_ROOT } from './common.mjs';
import { acquire, configurePolite, LIMITS, resetPolite, runReport } from './polite.mjs';
import { clearActiveScope, requireScope, template } from './scope.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `save-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { clearActiveScope(); rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });

test('after save_local is revoked mid-command: incident writes are refused, safety counters still work', async () => {
  const dir = join(TMP, 'a'); mkdirSync(dir);
  let t = Date.parse('2026-10-09T00:00:00Z');
  configurePolite({ dir, clock: () => t, wait: async (ms) => { t += ms; } }); resetPolite(); clearActiveScope();
  const p = join(dir, 'scope.json');
  const s = { ...template(), targets: ['alpha.org'], disclosures: ['rdap'], persistence: 'local', permissions: { ...template().permissions, save_local: true } };
  writeFileSync(p, JSON.stringify(s));
  requireScope(p, { action: 'passive_lookup', target: 'alpha.org', services: ['rdap'] });
  requireScope(p, { action: 'save_local' });
  assert.ok(existsSync(safeWrite(join(dir, 'before.json'), '{}')), 'allowed while permitted');
  writeFileSync(p, JSON.stringify({ ...s, persistence: 'transient', permissions: { ...s.permissions, save_local: false } }));
  assert.throws(() => safeWrite(join(dir, 'after.json'), '{}'), /nothing is saved/);
  assert.equal(existsSync(join(dir, 'after.json')), false);
  await acquire('rdap.org', { limits: LIMITS }); // writes the daily counter (safety state)
  assert.equal(runReport().total, 1, 'the request budget still counts');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('daily-')), 'the daily counter was written');
  // A stop blocks safety writes too (and therefore the request), not just incident writes.
  writeFileSync(p, JSON.stringify({ ...s, status: 'stopped' }));
  await assert.rejects(acquire('rdap.org', { limits: LIMITS }), /no longer allows|stopped/);
});
