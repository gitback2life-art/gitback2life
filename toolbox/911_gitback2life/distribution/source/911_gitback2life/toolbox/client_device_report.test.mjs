import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TOOL_GROUPS, reviewClientDeviceReport } from './toolbox.mjs';

const ROOT = new URL('../device_check/', import.meta.url);

test('client-first computer check stays inside existing thirteenth tool', () => {
  assert.equal(TOOL_GROUPS.length, 14);
  assert.deepEqual(TOOL_GROUPS[12].actions.map(a => a.code), ['CLIENT_DEVICE', 'DEVICE']);
  for (const file of ['CLIENT_DEVICE_CHECK.cmd', 'Client_Device_Collector.ps1', 'check_device.ps1', 'review_client_report.py'])
    assert.ok(existsSync(new URL(file, ROOT)));
});

test('client report reader rejects untrusted invalid zip without extraction', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gb2l-client-'));
  try {
    const filename = join(folder, 'bad.zip');
    writeFileSync(filename, 'not an archive');
    assert.throws(() => reviewClientDeviceReport(filename), /refused/);
    assert.equal(readFileSync(filename, 'utf8'), 'not an archive');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('client collector cannot make remote connections or change registry/security settings', () => {
  const ps = readFileSync(new URL('Client_Device_Collector.ps1', ROOT), 'utf8');
  const code = ps.split(/\r?\n/).map(l => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(code, /Invoke-(WebRequest|RestMethod|Expression)|\biex\b|New-PSSession|Enter-PSSession|\bSet-(MpPreference|NetFirewallProfile|ItemProperty)\b/i);
  assert.match(code, /Read-Host 'If you own or administer this computer and agree, type YES'/);
  assert.match(code, /GB2L_CLIENT_DEVICE_REPORT_/);
  assert.match(code, /Get-GB2LDownloads/);
  assert.match(code, /374DE290-123F-4565-9164-39C4925E467B/);
});
