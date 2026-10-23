// Existing approved-case integrity regressions. Synthetic, offline, no network or owner data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as tb from './toolbox.mjs';
const root = resolve(import.meta.dirname, '..');
function scratch() {
  const id = `offline8_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const caseDir = join(root, 'Cases', id);
  return { id, caseDir, clear: () => rmSync(caseDir, { recursive: true, force: true }) };
}
test('overview distinguishes current verified reports from missing, edited and unreadable reports', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic case to review');
    tb.appendEvidence(f.id, 'Reported issue', 'public source 1');
    let view = tb.caseOverview(f.id);
    assert.deepEqual(Object.values(view.reportIntegrity), ['missing', 'missing']);
    const [evidence, decision] = tb.reports(f.id);
    view = tb.caseOverview(f.id);
    assert.deepEqual(Object.values(view.reportIntegrity), ['verified', 'verified']);
    writeFileSync(decision, readFileSync(decision, 'utf8') + '\nAltered synthetic report\n');
    view = tb.caseOverview(f.id);
    assert.equal(view.reportIntegrity['decision_0001.md'], 'changed');
    assert.match(view.notes.join(' '), /missing, unreadable, or changed/);
    assert.throws(() => tb.reports(f.id), /differs from this revision/);
    assert.ok(existsSync(evidence));
  } finally { f.clear(); }
});
test('reports reject an altered existing output before creating the other output', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic case to review');
    const reportDir = join(f.caseDir, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const decision = join(reportDir, 'decision_0000.md');
    const evidence = join(reportDir, 'evidence_0000.md');
    writeFileSync(decision, 'manually altered synthetic report');
    assert.throws(() => tb.reports(f.id), /differs from this revision/);
    assert.equal(existsSync(evidence), false, 'no misleading partial report should be created');
    assert.equal(readFileSync(decision, 'utf8'), 'manually altered synthetic report');
  } finally { f.clear(); }
});
test('missing ledger revision blocks subsequent incident writes and keeps originals intact', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic case to review');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    renameSync(join(f.caseDir, 'ledger_0000.json'), join(f.caseDir, 'old-ledger-held-for-review.json'));
    assert.throws(() => tb.caseOverview(f.id), /missing number/);
    assert.throws(() => tb.appendEvidence(f.id, 'Further report', 'public-source-2'), /missing number/);
    assert.equal(existsSync(join(f.caseDir, 'ledger_0002.json')), false);
  } finally { f.clear(); }
});
test('timeline refuses forged evidence references in previously saved revisions', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic timeline');
    tb.appendEvidence(f.id, 'Reported issue', 'public source 1');
    tb.createCaseTimeline(f.id, 'website_redirect', 'real');
    tb.addTimelineEvent(f.id, 'recognize', 'reported', 'E1');
    const file = join(f.caseDir, 'timeline_0001.json');
    const forged = JSON.parse(readFileSync(file, 'utf8'));
    forged.events[0].reference = 'E999';
    writeFileSync(file, JSON.stringify(forged));
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => tb.addTimelineEvent(f.id, 'contain', 'reported', 'E1'), /missing incident evidence/);
    assert.equal(existsSync(join(f.caseDir, 'timeline_0002.json')), false);
  } finally { f.clear(); }
});
test('timeline revision gaps block further changes without auto-repair', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic timeline');
    tb.createCaseTimeline(f.id, 'website_redirect', 'real');
    tb.addTimelineEvent(f.id, 'recognize', 'reported', 'public-report-1');
    renameSync(join(f.caseDir, 'timeline_0000.json'), join(f.caseDir, 'old-timeline-held-for-review.json'));
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => tb.caseTimelineReport(f.id), /missing number/);
    assert.equal(existsSync(join(f.caseDir, 'timeline_0002.json')), false);
  } finally { f.clear(); }
});

test('case overview verifies the current packet manifest and detects later packet damage', () => {
  const f = scratch();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic reviewed packet');
    tb.appendEvidence(f.id, 'Reported concern', 'public source reference');
    assert.equal(tb.caseOverview(f.id).packetIntegrity,'not_created');
    const preview = tb.previewCasePacket(f.id);
    const packet = tb.exportCasePacket(f.id, true, [], preview);
    assert.equal(tb.caseOverview(f.id).packetIntegrity,
      'manifest_matches_current_case_privacy_review_still_required');
    const changed = readFileSync(packet.file);
    changed[Math.floor(changed.length / 2)] ^= 0x40;
    writeFileSync(packet.file,changed);
    const status = tb.caseOverview(f.id);
    assert.equal(status.packetIntegrity,'invalid_or_changed');
    assert.match(status.notes.join(' '), /do not share it/);
  } finally { f.clear(); }
});
