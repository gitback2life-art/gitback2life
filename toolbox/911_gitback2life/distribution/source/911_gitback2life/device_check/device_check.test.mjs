// Tests device_check's DECIDE step with sample settings (-InputJson), so they never depend on this PC's state.
// Windows only: elsewhere these tests are skipped and say so.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOLBOX_ROOT } from '../_shared/common.mjs';

const SCRIPT = fileURLToPath(new URL('./check_device.ps1', import.meta.url));
const TMP = join(TOOLBOX_ROOT, '.test_tmp', `device-${randomUUID()}`);
const skip = process.platform !== 'win32' && 'Windows only (needs Windows PowerShell)';
// Test files run in parallel: clean up only this file's subfolder, then the shared parent if it is empty.
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* another test file is still using it */ }
});

const HEALTHY = {
  defender: { antivirus_enabled: true, realtime_enabled: true, service_enabled: true, signature_age_days: 0 },
  bitlocker: { protection_status: 1, conversion_status: 1 },
  firewall: { all_enabled: true },
  lock_timeout_secs: 600,
};

function run(status) {
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(status));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-InputJson', file], { encoding: 'utf8', timeout: 60_000 });
  assert.ok(r.stdout, `no output; stderr: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  return { exit: r.status, report, by: Object.fromEntries(report.checks.map((c) => [c.id, c])) };
}

test('healthy sample: automated checks pass; manual checks stay unresolved; marked as a test fixture', { skip }, () => {
  const { exit, report, by } = run(HEALTHY);
  for (const id of ['malware_protection', 'signature_freshness', 'system_disk_encryption', 'firewall', 'machine_lock_policy']) assert.equal(by[id].result, 'pass', id);
  assert.equal(by.effective_screen_lock.result, 'unresolved');
  assert.equal(by.supported_updates.result, 'unresolved');
  assert.equal(report.result, 'unresolved');
  assert.equal(exit, 3);
  assert.equal(report.environment, 'test_fixture', 'test results can never pass as evidence about a real device');
});

test('Defender off, or another antivirus in charge → review, not fail', { skip }, () => {
  const { by } = run({ ...HEALTHY, defender: { ...HEALTHY.defender, realtime_enabled: false } });
  assert.equal(by.malware_protection.result, 'unresolved');
  assert.equal(by.malware_protection.category, 'review_other_provider_or_disabled_protection');
});

test('old or unknown virus definitions → review', { skip }, () => {
  assert.equal(run({ ...HEALTHY, defender: { ...HEALTHY.defender, signature_age_days: 9 } }).by.signature_freshness.result, 'unresolved');
  assert.equal(run({ ...HEALTHY, defender: { ...HEALTHY.defender, signature_age_days: null } }).by.signature_freshness.result, 'unresolved');
});

test('BitLocker off or still encrypting → fail; unreadable without admin → review', { skip }, () => {
  const off = run({ ...HEALTHY, bitlocker: { protection_status: 0, conversion_status: 0 } });
  assert.equal(off.by.system_disk_encryption.result, 'fail');
  assert.equal(off.report.result, 'fail');
  assert.equal(off.exit, 1);
  assert.equal(run({ ...HEALTHY, bitlocker: { protection_status: 1, conversion_status: 2 } }).by.system_disk_encryption.result, 'fail');
  const unread = run({ ...HEALTHY, bitlocker: null });
  assert.equal(unread.by.system_disk_encryption.result, 'unresolved');
  assert.equal(unread.by.system_disk_encryption.category, 'unsupported_or_needs_admin');
});

test('a firewall profile off → fail; unreadable → review', { skip }, () => {
  assert.equal(run({ ...HEALTHY, firewall: { all_enabled: false } }).by.firewall.result, 'fail');
  assert.equal(run({ ...HEALTHY, firewall: null }).by.firewall.result, 'unresolved');
});

test('screen-lock policy: 1-900 seconds passes; missing, zero or too long → review', { skip }, () => {
  for (const [t, want] of [[900, 'pass'], [60, 'pass'], [901, 'unresolved'], [0, 'unresolved'], [null, 'unresolved']]) {
    assert.equal(run({ ...HEALTHY, lock_timeout_secs: t }).by.machine_lock_policy.result, want, String(t));
  }
});

test('nothing readable at all → everything unresolved, nothing fails', { skip }, () => {
  const { report, exit } = run({ defender: null, bitlocker: null, firewall: null, lock_timeout_secs: null });
  assert.ok(report.checks.every((c) => c.result === 'unresolved'));
  assert.equal(exit, 3);
});

test('the script only reads: no setting-changing commands, no key or recovery methods, no dynamic code', () => {
  const code = readFileSync(SCRIPT, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(code, /\b(Set|Enable|Disable|Remove|New|Add|Clear|Stop|Restart|Start|Install|Uninstall|Suspend|Resume|Update|Register|Unregister)-[A-Z]\w*/);
  assert.doesNotMatch(code, /KeyProtector|RecoveryPassword|BackupRecovery|Get-BitLockerVolume|Invoke-Expression|\biex\b|Invoke-WebRequest|Invoke-RestMethod/i);
  const methods = [...code.matchAll(/-MethodName\s+(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)].sort(), ['GetConversionStatus', 'GetProtectionStatus']);
});
