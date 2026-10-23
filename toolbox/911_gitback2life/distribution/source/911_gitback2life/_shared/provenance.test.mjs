// Saved outputs carry a provenance stamp (incident + exact scope file); snapshot manifests are reused only by their own incident.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TOOLBOX_ROOT } from './common.mjs';
import { clearActiveScope, provenance, requireScope, template } from './scope.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `prov-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { clearActiveScope(); rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });
const GUARD = pathToFileURL(join(TOOLBOX_ROOT, 'regression_harness', 'network_guard.mjs')).href;
const scopeFile = join(TMP, 'scope.json');
writeFileSync(scopeFile, JSON.stringify({ ...template(), incident_id: 'incident-alpha', targets: ['owner/repo', 'alpha.org'], disclosures: ['github'],
  persistence: 'local', permissions: { ...template().permissions, save_local: true } }));

test('provenance names the incident and the exact scope file bytes; it refuses without a scope', () => {
  clearActiveScope();
  assert.throws(() => provenance(), /no incident scope is active/);
  requireScope(scopeFile, { action: 'read_public_github', target: 'owner/repo', services: ['github'] });
  const p = provenance();
  assert.equal(p.incident_id, 'incident-alpha');
  assert.equal(p.scope_sha256, createHash('sha256').update(readFileSync(scopeFile)).digest('hex'));
  assert.equal(p.authorized_action, 'read_public_github');
  assert.deepEqual(p.targets, ['owner/repo']);
  clearActiveScope();
});

test('github_evidence status reuses a snapshot only under its own incident, refusing before any request', () => {
  const manifest = (prov) => { const f = join(TMP, `m-${randomUUID()}.json`); writeFileSync(f, JSON.stringify({ repo: 'owner/repo', ref: 'main', commit_sha: 'a'.repeat(40), files: [], ...(prov ? { provenance: prov } : {}) })); return f; };
  for (const [label, file] of [['another incident', manifest({ incident_id: 'incident-beta' })], ['unstamped', manifest(null)]]) {
    const r = spawnSync(process.execPath, ['--import', GUARD, join(TOOLBOX_ROOT, 'github_evidence/github_evidence.mjs'), 'status', file, '--scope', scopeFile], { encoding: 'utf8', timeout: 20000 });
    assert.notEqual(r.status, 0, label);
    assert.match(r.stderr, /belongs to incident/, label);
    assert.doesNotMatch(r.stderr, /OFFLINE_NETWORK_BLOCKED/, `${label}: refused before any request was attempted`);
  }
});

test('every save path for lookup and evidence results stamps provenance', () => {
  const src = (f) => readFileSync(join(TOOLBOX_ROOT, f), 'utf8');
  assert.match(src('redirect_inspector/redirect_inspector.mjs'), /safeWrite\(o\.save, JSON\.stringify\(\{ \.\.\.result, provenance: provenance\(\) \}/);
  assert.match(src('domain_research/domain_research.mjs'), /safeWrite\(o\.save, JSON\.stringify\(\{ \.\.\.result, provenance: provenance\(\) \}/);
  assert.match(src('domain_watch/domain_watch.mjs'), /JSON\.stringify\(\{ \.\.\.current, provenance: provenance\(\) \}/);
  const gh = src('github_evidence/github_evidence.mjs');
  assert.match(gh, /evidence_status: MASKED_EVIDENCE_HANDLING, provenance: provenance\(\)/, 'snapshot manifest (masked copies, labelled)');
  assert.match(gh, /provenance: provenance\(\) \};\s*\n\s*console\.log\(`saved \$\{safeWrite\(o\.save, JSON\.stringify\(stamped/, 'issue/run/file --save');
});
