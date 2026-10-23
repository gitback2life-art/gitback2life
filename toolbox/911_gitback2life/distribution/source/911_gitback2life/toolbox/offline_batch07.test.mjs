// Approved-workflow regressions, entirely offline with synthetic data.
// No production authority, network, owner records or existing cases are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as t from './toolbox.mjs';
const root = resolve(import.meta.dirname, '..');

function synthetic() {
  const id = `offline7_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const tmp = join(root, 'Temp', `OfflineBatch07_${id}`);
  mkdirSync(tmp, { recursive: true });
  return { id, tmp, clean: () => {
    rmSync(join(root, 'Cases', id), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }};
}

test('numbered backup selection is explicit, rejects errors, skips links and private-looking names', () => {
  const f = synthetic();
  try {
    const src = join(f.tmp, 'source');
    mkdirSync(join(src, 'nested'), { recursive: true });
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, 'a.md'), 'Synthetic markdown.\n');
    writeFileSync(join(src, 'nested', 'b.json'), '{}\n');
    writeFileSync(join(src, '.env'), 'SECRET=1\n');
    writeFileSync(join(src, '.git', 'config'), 'private\n');
    const available = t.discoverBackupCandidates(src);
    assert.deepEqual(available.map(e => e.relativePath), ['a.md', 'nested/b.json']);
    assert.deepEqual(t.selectBackupCandidateNumbers(available, '1,2'), available.map(e => e.fullPath));
    for (const bad of ['0', '3', '1,1', '2-1', '1;2', '', '1-3', '1-1,1']) {
      assert.throws(() => t.selectBackupCandidateNumbers(available, bad));
    }
    const prepared = t.prepareBackupSelection(src, t.selectBackupCandidateNumbers(available, '1-2'), 'test-7');
    assert.equal(prepared.preview.files.length, 2);
    assert.ok(existsSync(prepared.selection));
    rmSync(prepared.selection);
  } finally { f.clean(); }
});

test('existing case revision report is checked and not overwritten on mismatch', () => {
  const f = synthetic();
  try {
    t.newCase(f.id, 'example.org', 'Synthetic review');
    t.appendEvidence(f.id, 'Reported problem, not established fact', 'report-1');
    const [report] = t.reports(f.id);
    const original = readFileSync(report, 'utf8');
    assert.equal(t.reports(f.id).length, 2);
    writeFileSync(report, `${original}\nSomeone modified this file.\n`);
    assert.throws(() => t.reports(f.id), /differs from this revision/);
    assert.match(readFileSync(report, 'utf8'), /Someone modified/);
  } finally { f.clean(); }
});

test('case packet binds human review to exact ledger revision and exact selected bytes', () => {
  const f = synthetic();
  try {
    t.newCase(f.id, 'example.org', 'Synthetic review');
    t.appendEvidence(f.id, 'Reported issue', 'public-reference-1');
    const evidence = join(f.tmp, 'support.txt');
    writeFileSync(evidence, 'Synthetic supporting note.\n');
    const preview = t.previewCasePacket(f.id, [evidence]);
    assert.equal(preview.files.length, 1);
    assert.match(preview.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => t.exportCasePacket(f.id, true, [evidence]), /review the exact/);
    writeFileSync(evidence, 'A different synthetic note.\n');
    assert.throws(() => t.exportCasePacket(f.id, true, [evidence], preview), /changed since/);
    const fresh = t.previewCasePacket(f.id, [evidence]);
    t.recordReviewCheck(f.id, 'checked', 'Reviewed current report');
    assert.throws(() => t.exportCasePacket(f.id, true, [evidence], fresh), /changed since/);
    const accepted = t.previewCasePacket(f.id, [evidence]);
    const packet = t.exportCasePacket(f.id, true, [evidence], accepted);
    assert.ok(existsSync(packet.file));
    assert.equal(packet.entries, 3); // summary, ledger and supporting evidence
    assert.throws(() => t.exportCasePacket(f.id, true, [evidence], accepted), /already exists/);
  } finally { f.clean(); }
});

test('packet preflight refuses file over original limit before reading', () => {
  const f = synthetic();
  try {
    t.newCase(f.id, 'example.org', 'Synthetic review');
    const tooBig = join(f.tmp, 'over-limit.txt');
    writeFileSync(tooBig, 'synthetic');
    truncateSync(tooBig, 10 * 1024 * 1024 + 1);
    assert.throws(() => t.previewCasePacket(f.id, [tooBig]), /10 MB/);
  } finally { f.clean(); }
});

test('register edit choices are validated, numbered and unambiguous', () => {
  const f = synthetic();
  try {
    const input = join(f.tmp, 'access.json');
    const records = [
      {id:'1', system:'domain', role:'staff', access_level:'viewer', mfa_enabled:null,
        still_needed:true, state:'active', last_reviewed:null, evidence:null, status:'unresolved'},
      {id:'two', system:'mail', role:'board', access_level:'admin', mfa_enabled:true,
        still_needed:true, state:'active', last_reviewed:null, evidence:null, status:'unresolved'},
    ];
    writeFileSync(input, JSON.stringify({schema_version:1,history:[],records}));
    const listed = t.listCurrentRegisterRecords('access', input);
    assert.deepEqual(listed.map(v => v.id), ['1', 'two']);
    assert.equal(t.resolveRegisterSelection(listed, '#1'), '1');
    assert.equal(t.resolveRegisterSelection(listed, '#2'), 'two');
    assert.equal(t.resolveRegisterSelection(listed, 'id:1'), '1');
    assert.equal(t.resolveRegisterSelection(listed, '1'), '1');
    assert.throws(() => t.resolveRegisterSelection([...listed].reverse(), '1'), /ambiguous/);
    assert.equal(t.previousRegisterRecord('access', input, 'two').role, 'board');
    assert.throws(() => t.resolveRegisterSelection(listed, '#4'), /not in/);
  } finally { f.clean(); }
});

test('guided timeline refuses invalid refs before creating revisions and keeps existing evidence', () => {
  const f = synthetic();
  try {
    t.newCase(f.id, 'example.org', 'Synthetic timeline');
    t.appendEvidence(f.id, 'A source report, not verified', 'report-1');
    t.createCaseTimeline(f.id, 'website_redirect', 'real');
    assert.throws(() => t.addTimelineEvent(f.id,'recognize','reported','a\nnewline'), /short nonprivate/);
    assert.throws(() => t.addTimelineEvent(f.id,'recognize','reported','E999'), /missing case evidence/);
    assert.throws(() => t.addTimelineEvent(f.id,'recognize','simulated','E1'), /exercise/);
    assert.throws(() => t.recordTimelineDecision(f.id,'contain','role\nnewline','E1',false), /short nonprivate/);
    t.addTimelineEvent(f.id,'recognize','reported','E1');
    t.recordTimelineDecision(f.id,'contain','board_owner','E1',false);
    const report = t.caseTimelineReport(f.id);
    assert.match(report,/incident_timeline/);
    assert.equal(t.caseOverview(f.id).timelineRevisions,3); // creation and two valid updates
  } finally { f.clean(); }
});
