#!/usr/bin/env node
// Single consolidated, unattended Windows check of the approved offline toolbox.
// Disposable synthetic data only; never opens owner cases, submits requests,
// modifies protected authority, installs software, or performs HTTP/DNS requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '');
if (process.platform !== 'win32' || !root || !existsSync(join(root, 'TOOLBOX.cmd')))
  throw new Error('Windows acceptance requires an extracted, staged offline toolbox');
const t = await import(pathToFileURL(join(root, 'toolbox', 'toolbox.mjs')).href);
const expectedTools = ['Incident Management','Evidence Collection','Reports & Evidence Packages',
  'Domain Health','Website Redirect & Authenticity','Email Security','Account Recovery & Access',
  'Organization Registers','Directory Audit','Website Code Analysis','Dependency Analysis',
  'File Protection','Computer Security Check','Email Communications'];
assert.deepEqual(t.TOOL_GROUPS.map(g => g.name), expectedTools);
assert.equal(new Set(t.TOOL_GROUPS.flatMap(g => g.actions.map(a => a.code))).size,
  t.TOOL_GROUPS.flatMap(g => g.actions).length);
console.log('PASS the original 13 plus Email Communications with unique, existing actions');
// The desktop interface is navigation only. Both mouse and number-key buttons
// must map one-for-one to the fourteen groups and their existing actions.
const gui = readFileSync(join(root, 'toolbox', 'ToolboxUI.ps1'), 'utf8');
const guiGroups = [...gui.matchAll(/^\s*@\{ Name='([^']+)'; Actions=@\((.*)\) \},?\s*$/gm)].map(m => ({
  name: m[1], actions: [...m[2].matchAll(/'([^']+)'/g)].map(v => v[1]),
}));
assert.deepEqual(guiGroups, t.TOOL_GROUPS.map(g => ({name: g.name, actions: g.actions.map(a => a.label)})));
assert.match(readFileSync(join(root, 'TOOLBOX.cmd'), 'utf8'), /if "%~1"=="" goto :SHOW_UI/);
console.log('PASS desktop mouse/number-key buttons match the owner-approved 14 tool actions');

const { parseRecordValue } = await import(pathToFileURL(join(root, 'toolbox', 'register_editor.mjs')).href);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = `offline_${suffix}`;
const caseFolder = join(root, 'Cases', id);
const fixture = join(root, 'Temp', `Acceptance_${suffix}`);
let complete = false;
const syntheticOutputs = []; // exact paths created by this acceptance, never existing project data
try {
  mkdirSync(join(root, 'Temp'), {recursive: true});
  mkdirSync(fixture, {recursive: false});
  const npm = join(fixture, 'npm'); mkdirSync(npm);
  writeFileSync(join(npm, 'package.json'), JSON.stringify({name:'offline-example',version:'1.0.0',dependencies:{example:'1.0.0'}}));
  writeFileSync(join(npm, 'package-lock.json'), JSON.stringify({name:'offline-example',lockfileVersion:3,packages:{'':{name:'offline-example',version:'1.0.0'},'node_modules/example':{version:'1.0.0',license:'MIT'}}}));
  const dep = t.reviewLocalDependencies(npm, 'acceptance-1');
  syntheticOutputs.push(dep.config, dep.reportFile);
  assert.equal(dep.count,1);
  assert.ok(existsSync(dep.reportFile));
  console.log('PASS npm dependency inventory (read-only, guided source selection)');
  const codeFolder = join(fixture, 'src'); mkdirSync(codeFolder);
  writeFileSync(join(codeFolder, 'public.js'), 'console.log("offline synthetic example");\n');
  const proposal = t.discoverScanSelection(codeFolder);
  const scan = t.scanReviewedSelection(proposal, 'acceptance-1');
  syntheticOutputs.push(scan.config);
  assert.equal(scan.sourceFiles,1);
  console.log('PASS static content-flow and disclosure checks (offline)');
  assert.match(t.newCase(id,'example.org','Synthetic offline acceptance only'),/offline_/);
  t.appendEvidence(id,'Reported issue for a synthetic exercise','example-1');
  t.recordReviewCheck(id,'not_checked','External source not contacted');
  t.recordRisk(id,'Impact unknown; do not assume a breach');
  t.recordNextStep(id,'Review verified sources','Human permission required before changes');
  const earlierLedger = join(caseFolder, 'ledger_0001.json');
  const validEarlierLedger = readFileSync(earlierLedger);
  try {
    const altered = JSON.parse(validEarlierLedger.toString('utf8'));
    altered.items[0].text = 'A conflicting but syntactically valid earlier report';
    writeFileSync(earlierLedger, JSON.stringify(altered));
    assert.throws(() => t.caseOverview(id), /edited or removed previous items/);
    assert.throws(() => t.recordRisk(id, 'Synthetic later revision must be refused'), /edited or removed previous items/);
    assert.equal(existsSync(join(caseFolder, 'ledger_0005.json')), false);
  } finally { writeFileSync(earlierLedger, validEarlierLedger); }
  console.log('PASS case ledger history blocks altered earlier evidence without rewriting anything');
  t.createCaseTimeline(id,'website_redirect','exercise');
  assert.throws(() => t.addTimelineEvent(id,'recognize','reported','line\nbreak'),/short nonprivate/);
  t.addTimelineEvent(id,'recognize','reported','E1');
  t.recordTimelineDecision(id, 'recognize', 'case_owner', 'E1', false);
  t.addTimelineEvent(id, 'preserve', 'unknown', 'E1');
  assert.equal(t.caseOverview(id).timelineIntegrity, 'verified');
  const olderTimeline = join(caseFolder, 'timeline_0001.json');
  const validOlderTimeline = readFileSync(olderTimeline);
  try {
    const altered = JSON.parse(validOlderTimeline.toString('utf8'));
    altered.events[0].reference = 'other-safe-reference';
    writeFileSync(olderTimeline, JSON.stringify(altered));
    assert.equal(t.caseOverview(id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => t.recordTimelineDecision(id, 'preserve', 'case_owner', 'E1'), /changed or removed previously recorded events/);
    assert.equal(existsSync(join(caseFolder, 'timeline_0004.json')), false);
  } finally { writeFileSync(olderTimeline, validOlderTimeline); }
  assert.equal(t.caseOverview(id).timelineIntegrity, 'verified');
  console.log('PASS timeline history preserves earlier event and decision revisions (synthetic only)');
  const [evidenceReport, decisionReport] = t.reports(id);
  assert.equal(t.caseOverview(id).review.nextStepRecorded,true);
  assert.deepEqual(Object.values(t.caseOverview(id).reportIntegrity), ['verified', 'verified']);
  const validDecision = readFileSync(decisionReport);
  try {
    writeFileSync(decisionReport, Buffer.concat([validDecision, Buffer.from('Altered synthetic report') ]));
    assert.equal(t.caseOverview(id).reportIntegrity[`decision_${String(t.caseOverview(id).latestRevision).padStart(4,'0')}.md`], 'changed');
    assert.throws(() => t.reports(id), /differs from this revision/);
  } finally { writeFileSync(decisionReport, validDecision); }
  assert.deepEqual(Object.values(t.caseOverview(id).reportIntegrity), ['verified', 'verified']);
  const timelineFile = join(caseFolder, 'timeline_0001.json');
  const validTimeline = readFileSync(timelineFile);
  try {
    const forgedTimeline = JSON.parse(validTimeline.toString('utf8'));
    forgedTimeline.events[0].reference = 'E999';
    writeFileSync(timelineFile, JSON.stringify(forgedTimeline));
    assert.equal(t.caseOverview(id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => t.caseTimelineReport(id), /missing incident evidence/);
  } finally { writeFileSync(timelineFile, validTimeline); }
  assert.equal(t.caseOverview(id).timelineIntegrity, 'verified');
  console.log('PASS exact current report integrity and tampered timeline detection');
  const rows = t.listCases();
  const index = rows.findIndex(r => r.id === id);
  assert.ok(index>=0);
  assert.equal(t.resolveCaseSelection(rows,`id:${id}`),id);
  console.log('PASS synthetic case, review, timeline, reports and case selection');
  // New approved-workflow safety: report filenames do not silently bless
  // changed contents, packet review binds to the exact ledger and exact files.
  const packetEvidence = join(fixture, 'packet-evidence.txt');
  writeFileSync(packetEvidence, 'Synthetic supporting note; no personal content.\n');
  const packetPreview = t.previewCasePacket(id, [packetEvidence]);
  writeFileSync(packetEvidence, 'Replaced supporting note, requiring new review.\n');
  assert.throws(() => t.exportCasePacket(id,true,[packetEvidence],packetPreview),/changed since/);
  const refreshed = t.previewCasePacket(id, [packetEvidence]);
  const packet = t.exportCasePacket(id,true,[packetEvidence],refreshed);
  assert.ok(existsSync(packet.file));
  assert.equal(t.caseOverview(id).packetIntegrity, 'manifest_matches_current_case_privacy_review_still_required');
  console.log('PASS case packet requires exact current reviewed ledger, manifest and supporting file hashes');
  const backups = join(fixture,'backup-files'); mkdirSync(backups);
  writeFileSync(join(backups,'sample.txt'),'Synthetic file for backup preview.\n');
  writeFileSync(join(backups,'.env'),'not eligible for numbered discovery\n');
  const candidates = t.discoverBackupCandidates(backups);
  assert.equal(candidates.length,1);
  assert.throws(() => t.discoverBackupCandidates(caseFolder), /outside internal case/);
  assert.throws(() => t.discoverBackupCandidates(join(root, 'Temp', 'Logs')), /outside internal case/);
  const choice = t.selectBackupCandidateNumbers(candidates,'1');
  const prepared = t.prepareBackupSelection(backups,choice,'acceptance-1');
  syntheticOutputs.push(prepared.selection);
  assert.equal(prepared.preview.files.length,1);
  console.log('PASS numbered, explicit backup choice and existing reviewed SHA256 preview');
  const restore = join(fixture,'restore'); mkdirSync(restore);
  writeFileSync(join(restore,'public.txt'),'Synthetic material, no original user data.\n');
  const preview = t.previewRestoreSelection(id,restore);
  const req = t.prepareRestoreRequest(id,restore,undefined,preview);
  syntheticOutputs.push(req.dir);
  assert.equal(t.inspectRequest(req.dir).files,1);
  console.log('PASS exact reviewed restore-request preparation (NO restore or approval)');
  // Both additional workflows are read-only and operate on synthetic
  // metadata created under this acceptance's own Temp folder.
  const access = join(fixture, 'access.json');
  const roleRecords = {
    schema_version: 1, history: [], records: [
      {id:'a1', system:'sample_site', role:'departing_admin', access_level:'admin',
       mfa_enabled:true, still_needed:true, state:'active', last_reviewed:null, evidence:null, status:'unresolved'},
      {id:'a2', system:'sample_site', role:'observer', access_level:'viewer',
       mfa_enabled:null, still_needed:true, state:'active', last_reviewed:null, evidence:null, status:'unresolved'},
    ]
  };
  writeFileSync(access, JSON.stringify(roleRecords));
  assert.equal(t.listCurrentAccessRoles(access).length, 2);
  const recordList = t.listCurrentRegisterRecords('access', access);
  assert.equal(t.resolveRegisterSelection(recordList, '#2'),'a2');
  assert.equal(t.previousRegisterRecord('access',access,'a1').role,'departing_admin');
  assert.match(t.offboardingChecklist(access, 'departing_admin'), /sample_site: verify an independent owner\/admin/);
  const directory = join(fixture, 'directory.json');
  writeFileSync(directory, JSON.stringify([{id:'a', name:'Synthetic Rescue', website:'https://example.org',
    last_checked:'2025-01-01'},{id:'b', name:'Synthetic Shelter'}]));
  const audit = t.directoryAudit(directory, {required:['name','phone'], staleDays:100, country:'US'});
  assert.match(audit, /2 records checked offline/);
  assert.match(audit, /missing/);
  assert.match(audit, /stale/);
  console.log('PASS guided offboarding and directory audits (read-only, synthetic inputs)');
  assert.throws(() => t.registerReport('access', access, '2026-02-30'), /real YYYY-MM-DD calendar date/);
  assert.throws(() => parseRecordValue('access', 'last_reviewed', '2026-02-30', null), /real calendar date/);
  assert.equal(parseRecordValue('access', 'last_reviewed', '2024-02-29', null), '2024-02-29');
  assert.throws(() => parseRecordValue('access', 'system', '', ''), /enter a value/);
  console.log('PASS guided register entry rejects invalid dates and empty required values');
  const guides = t.listRecoveryProviders();
  assert.ok(guides.length);
  assert.equal(t.selectRecoveryProvider(guides, '1'), guides[0].key);
  assert.match(t.recoveryGuide(guides[0].key), /official help site/);
  assert.equal(t.selectRecoveryProvider(guides, '0'), '');
  console.log('PASS existing account-recovery instructions can be selected by number without contacting providers');
  // This toolbox supports clients remotely; staging must not automatically
  // assess the volunteer/operator's own PC or confuse it with the target.
  assert.equal(t.TOOL_GROUPS.length, 14);
  assert.deepEqual(t.TOOL_GROUPS[12].actions.map(a => a.code), ['CLIENT_DEVICE', 'DEVICE']);
  const collectorScript = readFileSync(join(root,'device_check','Client_Device_Collector.ps1'), 'utf8');
  assert.match(collectorScript, /type YES/);
  const invalidClientZip = join(fixture, 'untrusted_client.zip');
  writeFileSync(invalidClientZip, 'This is not a client ZIP.');
  assert.throws(() => t.reviewClientDeviceReport(invalidClientZip), /refused/);
  console.log('PASS remote-client-first routing, consent collector and unsafe ZIP refusal; operator PC not assessed');
  complete = true;
} finally {
  // A synthetic RESTORE request must never remain in the operator's ordinary
  // recent-requests list. Remove exactly this run's newly generated outputs,
  // not the Requests, Scans or Dependencies folders and never owner data.
  for (const output of syntheticOutputs.reverse()) {
    const rel = output.startsWith(join(root, 'Temp') + sep);
    if (!rel) throw new Error('Synthetic output outside staged Temp; refusing cleanup');
    if (existsSync(output)) rmSync(output,{recursive:true,force:false});
  }
  if (existsSync(fixture)) rmSync(fixture,{recursive:true,force:true});
  if (existsSync(caseFolder)) rmSync(caseFolder,{recursive:true,force:true});
}
if (complete) console.log('ACCEPTANCE PASSED: all checks completed in the separate staged build; production inactive.');
