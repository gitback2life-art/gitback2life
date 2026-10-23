// #10 (owner's decision, option b): synthetic secrets never reach any storage path. Every test writes them through a
// real storage path, then scans EVERY file on disk for the raw values. Offline; all secrets are synthetic.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { MASKED_NOTICE, maskForStorage, prepareForStorage, safeWrite, TOOLBOX_ROOT } from './common.mjs';
import { cached, configurePolite, readCache, resetPolite, writeCache } from './polite.mjs';
import { clearActiveScope, requireScope, template } from './scope.mjs';
import { writeSnapshot } from '../github_evidence/github_evidence.mjs';
import { buildPacket, zipStore } from '../case_packet/case_packet.mjs';
import { createLedger } from '../evidence_ledger/ledger.mjs';

const TMP = join(TOOLBOX_ROOT, '.test_tmp', `masked-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
after(() => { clearActiveScope(); rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });
const GUARD = pathToFileURL(join(TOOLBOX_ROOT, 'regression_harness', 'network_guard.mjs')).href;

// Synthetic secrets of every kind the masks cover. None is real.
const SECRETS = {
  github_classic: 'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01',
  github_fine: 'github_pat_SYNTHETIC_abcdefghijklmnopqrstuvwxyz0123456789',
  aws: 'AKIASYNTHETIC0000001',
  slack: 'xoxb-SYNTHETIC-123456789012',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljc2lnbmF0dXJl',
  private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYMATERIAL\n-----END PRIVATE KEY-----',
  bearer_value: 'SYNTHETICbearertoken0123456789',
  url_password: 'SYNTHETICurlPassw0rd',
  url_token: 'SYNTHETICquerytoken42',
  fragment_token: 'SYNTHETICfragmenttoken7',
  email: 'synthetic.person@example-rescue.org',
  phone: '212-555-0100',
};
const CARRIER = [
  `token ${SECRETS.github_classic} and ${SECRETS.github_fine}`, `aws ${SECRETS.aws}`, `slack ${SECRETS.slack}`, `jwt ${SECRETS.jwt}`,
  SECRETS.private_key, `Authorization: Bearer ${SECRETS.bearer_value}`, `https://admin:${SECRETS.url_password}@alpha.org/x`,
  `https://alpha.org/cb?token=${SECRETS.url_token}`, `https://alpha.org/#access_token=${SECRETS.fragment_token}`,
  `contact ${SECRETS.email} or ${SECRETS.phone}`,
].join('\n');
// What must never appear on disk: each raw value (the private key's inner material stands for the whole block).
const NEEDLES = Object.entries(SECRETS).map(([k, v]) => [k, k === 'private_key' ? 'SYNTHETICKEYMATERIAL' : v]);

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}
function assertNoSecretsOnDisk(dir, label) {
  const files = filesUnder(dir);
  assert.ok(files.length > 0, `${label}: something was written`);
  for (const f of files) {
    const text = readFileSync(f).toString('latin1');
    for (const [kind, needle] of NEEDLES) assert.equal(text.includes(needle), false, `${label}: ${kind} reached ${f}`);
  }
}
function scopeIn(dir, over = {}) {
  const p = join(dir, 'scope.json');
  writeFileSync(p, JSON.stringify({ ...template(), incident_id: 'incident-alpha', targets: ['alpha.org', 'owner/repo'], disclosures: ['rdap', 'github'],
    persistence: 'local', permissions: { ...template().permissions, save_local: true }, ...over }));
  return p;
}
const fresh = (name) => { const d = join(TMP, name); mkdirSync(d); return d; };

test('the storage mask removes every synthetic secret kind (the mask itself)', () => {
  const masked = maskForStorage(CARRIER);
  for (const [kind, needle] of NEEDLES) assert.equal(masked.includes(needle), false, kind);
  assert.match(masked, /alpha\.org/, 'ordinary content survives');
});

test('safeWrite: text, JSON, Buffer text, new files and overwrites (temp file included) are all masked', () => {
  const dir = fresh('safewrite');
  safeWrite(join(dir, 'a.txt'), CARRIER, { root: dir });
  safeWrite(join(dir, 'b.json'), JSON.stringify({ note: CARRIER }), { root: dir });
  safeWrite(join(dir, 'c.log'), Buffer.from(CARRIER, 'utf8'), { root: dir });
  safeWrite(join(dir, 'a.txt'), `${CARRIER}\nsecond version`, { root: dir, overwrite: true }); // the temp-file path
  assertNoSecretsOnDisk(dir, 'safeWrite');
  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.json', 'c.log'], 'no temporary file left behind');
});

test('opaque or binary content is refused before anything is written', () => {
  const dir = fresh('binary');
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), deflateRawSync(Buffer.from(CARRIER))]);
  const pngWithText = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 4]), Buffer.from('tEXtabcd'), Buffer.from([0, 0, 0, 0])]);
  for (const [label, buf, opts] of [['compressed archive', zip, {}], ['unknown binary', Buffer.from([0, 1, 2, 3, 255]), {}],
    ['image with metadata', pngWithText, { binary: 'image' }], ['archive claimed as image', zip, { binary: 'image' }]]) {
    assert.throws(() => safeWrite(join(dir, `${label}.bin`), buf, { root: dir, ...opts }), /refusing to save/i, label);
  }
  assert.deepEqual(readdirSync(dir), [], 'nothing reached disk');
});

test('caches: lookup results and safety state are masked on disk, and labelled', async () => {
  const dir = fresh('cache');
  configurePolite({ dir, resultCaching: true }); resetPolite(); clearActiveScope();
  await cached('lookup:alpha', async () => ({ answer: CARRIER }));
  writeCache('robots:https://alpha.org', { policy: { groups: [] }, basis: CARRIER });
  assertNoSecretsOnDisk(dir, 'cache');
  const entry = readCache('lookup:alpha', { dir });
  assert.equal(entry.masked_for_storage, true);
  configurePolite(); // back to defaults
});

test('snapshots: masked copies, labelled MODIFIED EVIDENCE, with the original identified by its blob SHA', () => {
  const dir = fresh('snapshot');
  configurePolite({ dir: join(dir, 'state') }); resetPolite(); clearActiveScope();
  const p = scopeIn(dir);
  requireScope(p, { action: 'read_public_github', target: 'owner/repo', services: ['github'] });
  requireScope(p, { action: 'save_local' });
  const out = join(dir, 'snap');
  const manifest = writeSnapshot({ repo: 'owner/repo', ref: 'main', commit: { sha: 'a'.repeat(40), date: '2026-10-09T00:00:00Z' }, outDir: out,
    files: [{ path: 'src/config.js', text: CARRIER, blob_sha: 'b'.repeat(40), size: CARRIER.length, permalink: 'https://github.com/owner/repo/blob/x/src/config.js' }] });
  clearActiveScope();
  assertNoSecretsOnDisk(out, 'snapshot');
  assert.equal(manifest.raw_evidence, false); assert.equal(manifest.masked, true);
  assert.match(manifest.evidence_status, /MODIFIED EVIDENCE/);
  assert.equal(manifest.files[0].blob_sha, 'b'.repeat(40), 'the original is identified');
  assert.equal(manifest.files[0].changed_by_masking, true);
  assert.match(readFileSync(join(out, 'MODIFIED_EVIDENCE.txt'), 'utf8'), /not the originals/);
  assert.match(manifest.provenance.stored_as, /MODIFIED EVIDENCE/);
  configurePolite();
});

test('exports: a case packet holds only masked entries, is labelled, and an unmasked zip is refused', () => {
  const ledger = createLedger('incident-alpha');
  const r = buildPacket(ledger, [{ name: 'notes.txt', data: Buffer.from('ordinary synthetic notes') }], { humanReviewed: true });
  assert.ok(r.zip, JSON.stringify(r.refused));
  const dir = fresh('packet');
  safeWrite(join(dir, 'packet.zip'), r.zip, { root: dir, binary: 'case-packet' });
  assert.match(readFileSync(join(dir, 'packet.zip')).toString('latin1'), /MODIFIED EVIDENCE/);
  assert.match(JSON.stringify(r.manifest), /original_sha256/);
  // A packet-shaped zip whose entry is NOT masked is refused at the storage layer.
  const sneaky = zipStore([{ name: 'evidence/x.txt', data: Buffer.from(CARRIER) }]);
  assert.throws(() => safeWrite(join(dir, 'sneaky.zip'), sneaky, { root: dir, binary: 'case-packet' }), /not masked/);
  assertNoSecretsOnDisk(dir, 'packet');
  // Evidence that carries secrets is refused by the packet itself (never masked silently into a packet).
  assert.ok(buildPacket(ledger, [{ name: 'leak.txt', data: Buffer.from(CARRIER) }], { humanReviewed: true }).refused);
});

test('exports and logs via the real command line: ledger render and github_evidence --save paths are masked', () => {
  const dir = fresh('cli');
  const p = scopeIn(dir);
  const ledger = { ...createLedger('incident-alpha'), risk: CARRIER, next_step: { action: CARRIER, permission_needed: 'none' } };
  const lf = join(dir, 'ledger.json'); writeFileSync(lf, JSON.stringify(ledger));
  const out = join(dir, 'out'); mkdirSync(out);
  const r = spawnSync(process.execPath, ['--import', GUARD, join(TOOLBOX_ROOT, 'evidence_ledger/ledger.mjs'), 'render', lf, '--scope', p, '--save', join(out, 'ledger.md')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assertNoSecretsOnDisk(out, 'ledger export');
  // The archive command refuses before any authorization or request.
  const a = spawnSync(process.execPath, ['--import', GUARD, join(TOOLBOX_ROOT, 'github_evidence/github_evidence.mjs'), 'archive', 'owner/repo', '--ref', 'main', '--scope', p], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /archive is disabled/);
  assert.doesNotMatch(a.stderr, /OFFLINE_NETWORK_BLOCKED/);
});

test('the storage rule cannot be skipped: safeWrite prepares content before any disk access', () => {
  const src = readFileSync(join(TOOLBOX_ROOT, '_shared/common.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export function safeWrite('));
  assert.ok(body.indexOf('prepareForStorage(') < body.indexOf('writeFileSync('), 'masking happens before the first write');
  assert.ok(MASKED_NOTICE.includes('not the original'));
  assert.equal(prepareForStorage('plain words'), 'plain words', 'ordinary text unchanged');
});
