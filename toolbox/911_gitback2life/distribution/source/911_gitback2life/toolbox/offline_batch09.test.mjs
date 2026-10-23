// Regression checks for the approved offline toolbox. Synthetic local records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as tb from './toolbox.mjs';

const root = resolve(import.meta.dirname, '..');
function fixture() {
  const id = `offline9_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const caseDir = join(root, 'Cases', id);
  return { id, caseDir, clear: () => rmSync(caseDir, { recursive: true, force: true }) };
}
test('timeline tracks multiple valid event and decision revisions without changing history', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic history check');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    tb.createCaseTimeline(f.id, 'website_redirect', 'real');
    tb.addTimelineEvent(f.id, 'recognize', 'reported', 'E1');
    tb.recordTimelineDecision(f.id, 'recognize', 'case_owner', 'E1', false);
    tb.recordTimelineDecision(f.id, 'recognize', 'case_owner', 'E1', true);
    tb.addTimelineEvent(f.id, 'preserve', 'unknown', 'E1');
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'verified');
    const status = JSON.parse(tb.caseTimelineReport(f.id));
    assert.equal(status.tool, 'incident_timeline');
  } finally { f.clear(); }
});
test('timeline blocks valid-looking earlier revisions whose history is inconsistent', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic history integrity');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    tb.createCaseTimeline(f.id, 'website_redirect', 'exercise');
    tb.addTimelineEvent(f.id, 'recognize', 'reported', 'E1');
    tb.addTimelineEvent(f.id, 'preserve', 'simulated', 'E1');
    const initial = join(f.caseDir, 'timeline_0001.json');
    const value = JSON.parse(readFileSync(initial, 'utf8'));
    value.events[0].reference = 'synthetic-other-reference'; // valid format, but breaks prefix history
    writeFileSync(initial, JSON.stringify(value));
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => tb.recordTimelineDecision(f.id, 'recognize', 'operator', 'E1'), /changed or removed previously recorded events/);
    assert.equal(existsSync(join(f.caseDir, 'timeline_0003.json')), false);
  } finally { f.clear(); }
});
test('timeline refuses silently removed stage decisions and changed scenario', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic preserved decision');
    tb.createCaseTimeline(f.id, 'website_redirect', 'real');
    tb.recordTimelineDecision(f.id, 'recognize', 'case_owner', 'local-reference', false);
    tb.recordTimelineDecision(f.id, 'recognize', 'case_owner', 'local-reference', true);
    const file = join(f.caseDir, 'timeline_0002.json');
    const original = readFileSync(file, 'utf8');
    const tampered = JSON.parse(original);
    tampered.decisions = {};
    writeFileSync(file, JSON.stringify(tampered));
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'invalid_or_incomplete');
    assert.throws(() => tb.addTimelineEvent(f.id, 'preserve', 'unknown', 'local-reference'), /removed a stage decision/);
    writeFileSync(file, original);
    const changed = JSON.parse(original);
    changed.scenario = 'account_takeover'; // may be an invalid scenario; test mismatch in any case
    writeFileSync(file, JSON.stringify(changed));
    assert.equal(tb.caseOverview(f.id).timelineIntegrity, 'invalid_or_incomplete');
  } finally { f.clear(); }
});
test('register reports reject impossible calendar dates before any report process', () => {
  assert.throws(() => tb.registerReport('access', 'unused.json', '2026-02-30'), /real YYYY-MM-DD/);
  assert.throws(() => tb.registerReport('service', 'unused.json', '2026-13-01'), /real YYYY-MM-DD/);
});
test('guided project-root backup candidates exclude case, temporary, and protected internals', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic private case data');
    assert.throws(() => tb.discoverBackupCandidates(f.caseDir), /outside internal case/);
    assert.throws(() => tb.discoverBackupCandidates(join(root, 'Temp', 'Logs')), /outside internal case/);
    assert.throws(() => tb.discoverBackupCandidates(join(root, 'authority')), /outside internal case/);
    const candidates = tb.discoverBackupCandidates(join(root, 'toolbox'));
    assert.ok(candidates.some(c => c.relativePath === 'toolbox.mjs'));
  } finally { f.clear(); }
});
test('ledger history accepts independent evidence, review, risk, and next-step revisions', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic review progression');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    tb.recordReviewCheck(f.id, 'checked', 'Viewed public metadata offline');
    tb.recordRisk(f.id, 'Impact uncertain pending verification');
    tb.recordNextStep(f.id, 'Ask authorized owner to review', 'Written permission');
    tb.recordHypothesis(f.id, 'Possible account issue', 'E1');
    tb.recordAnalysis(f.id, 'inference', 'Further evidence is needed', 'E1');
    const view = tb.caseOverview(f.id);
    assert.equal(view.latestRevision, 6);
    assert.equal(view.review.nextStepRecorded, true);
    assert.equal(view.review.riskRecorded, true);
    assert.equal(tb.reports(f.id).length, 2);
  } finally { f.clear(); }
});
test('ledger consistency blocks further saves when an older plausible revision was modified', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic immutable history');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    tb.recordRisk(f.id, 'Impact uncertain');
    const earlier = join(f.caseDir, 'ledger_0001.json');
    const modified = JSON.parse(readFileSync(earlier, 'utf8'));
    modified.items[0].text = 'Rewritten old evidence';
    writeFileSync(earlier, JSON.stringify(modified));
    assert.throws(() => tb.caseOverview(f.id), /edited or removed previous items/);
    assert.throws(() => tb.appendEvidence(f.id, 'New evidence', 'public-source-2'), /edited or removed previous items/);
    assert.equal(existsSync(join(f.caseDir, 'ledger_0003.json')), false);
  } finally { f.clear(); }
});
test('ledger consistency rejects multiple simultaneous retroactive changes', () => {
  const f = fixture();
  try {
    tb.newCase(f.id, 'example.org', 'Synthetic single-change revision');
    tb.appendEvidence(f.id, 'Reported issue', 'public-source-1');
    const later = join(f.caseDir, 'ledger_0001.json');
    const changed = JSON.parse(readFileSync(later, 'utf8'));
    changed.checked.push('Reviewed');
    writeFileSync(later, JSON.stringify(changed));
    assert.throws(() => tb.caseOverview(f.id), /combined unrelated edits/);
    assert.throws(() => tb.reports(f.id), /combined unrelated edits/);
    assert.equal(existsSync(join(f.caseDir, 'reports', 'decision_0001.md')), false);
  } finally { f.clear(); }
});
