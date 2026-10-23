import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLBOX_ROOT } from '../_shared/common.mjs';
import { TOOL_GROUPS } from './toolbox.mjs';

const expected = [
  'Incident Management', 'Evidence Collection', 'Reports & Evidence Packages',
  'Domain Health', 'Website Redirect & Authenticity', 'Email Security',
  'Account Recovery & Access', 'Organization Registers', 'Directory Audit',
  'Website Code Analysis', 'Dependency Analysis', 'File Protection',
  'Computer Security Check', 'Email Communications'
];
const internal = ['sandbox_setup', 'regression_harness', 'authority'];
const approved = ['incident_intake','incident_timeline','github_evidence','evidence_ledger',
  'decision_summary','notice_drafter','case_packet','domain_research','domain_watch',
  'redirect_inspector','lookalike_domain_check','email_spoof_check','email_header_triage',
  'account_recovery_guide','access_offboarding','org_registers','directory_record_audit',
  'fetcher_review','code_flow_scan','dependency_inventory','safe_backup','metadata_scrub','device_check'];

test('original 13 choices plus explicitly owner-approved Email Communications', () => {
  assert.deepEqual(TOOL_GROUPS.map(x => x.name), expected);
  const codes = TOOL_GROUPS.flatMap(g => g.actions.map(a => a.code));
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.length >= 40, 'all earlier actions remain available');
  assert.equal(Object.isFrozen(TOOL_GROUPS),true);
  for (const g of TOOL_GROUPS) {
    assert.ok(g.actions.length);
    assert.equal(Object.isFrozen(g.actions),true);
    assert.ok(g.actions.every(a => a.label.length && a.code.length));
  }
});

test('original approved modules stay present and internal functions are not extra menu tools', () => {
  assert.equal(approved.length + internal.length, 26);
  for (const name of [...approved, ...internal]) assert.ok(existsSync(join(TOOLBOX_ROOT,name)), `${name} must be preserved`);
  const codes = TOOL_GROUPS.flatMap(g => g.actions.map(a => a.code));
  assert.ok(!codes.includes('SANDBOX'));
  assert.ok(!codes.includes('AUTHORITY'));
  assert.ok(!codes.includes('REGRESSION'));
});

test('scoped network specialist actions remain gated, and no direct repair was introduced', () => {
  const source = readFileSync(new URL('./toolbox.mjs',import.meta.url),'utf8');
  assert.match(source, /Type LOOKUP to permit the existing scoped check/);
  assert.match(source, /const scope = await permittedLookup\(\)/);
  assert.match(source, /requireScope\(join\(c\.dir, 'scope\.json'\), \{ action: 'save_local' \}\)/);
  assert.match(source, /No request is made unless the incident scope permits/);
  assert.doesNotMatch(TOOL_GROUPS.map(g=>g.name).join(' '), /Install|Activate|Repair|Authority/i);
});
