// M3 focused tests (design revision 3.4). Synthetic only: a synthetic Ed25519 key, a synthetic passphrase for the
// key-format check, the simulated disk, and the real-filesystem backend in TEMPORARY folders. Nothing elevated,
// installed or real; the protected authority folder is never referenced.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash, generateKeyPairSync, randomBytes, sign, verify, createPublicKey } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskStoredText } from '../../_shared/common.mjs';
import { generateAuthorityKey } from '../authority_core.mjs';
import { receiveRequest } from '../g0a/request_pipe.mjs';
import { canonical, verifyLedger } from '../m1/ledger.mjs';
import * as E from '../m1/engine.mjs';
import { approveChange, approveRestore } from '../m2/commands.mjs';
import { createProductionDeps, createReadOnlyDiagnosticDeps, diagnosticMain, main } from './cli.mjs';
import { assessOfflineLayout } from './offline_readiness.mjs';
import { buildRequest, exportRequest, readRequestFolder, writeRequestFolder } from './exporter.mjs';
import { FileLedgerStore, RealDisk } from './fs_backend.mjs';
import { createPassphraseSigner } from './signer.mjs';
import { cancelKey, finalKey, tmpKey, validateTreeFiles } from './tree.mjs';

const WIN = process.platform === 'win32';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // synthetic test key only
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const signer = (bytes) => sign(null, bytes, privateKey).toString('base64');
const ROOT = mkdtempSync(join(tmpdir(), 'm3-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const SERVICES = 'registers/services.json';
const SERVICE = { id: 'domain_main', service: 'domain_registrar', provider: 'Example Registrar', domain_or_account: 'example-rescue.org', account_owner_role: 'board_secretary',
  renews_on: '2027-03-01', auto_renew: true, mfa_enabled: null, recovery_contact_reviewed: null, review_date: null, evidence: null, status: 'unresolved' };
const REG = Buffer.from(`${JSON.stringify({ schema_version: 1, records: [SERVICE], history: [] }, null, 2)}\n`);
const FILES = new Map([['index.html', Buffer.from('<h1>Adopt</h1>\n')], ['css/site.css', Buffer.from('h1 { color: teal; }\n')], ['notes/readme.txt', Buffer.from('restored copy\tline 2\n')]]);

function simEnv() {
  const disk = { files: new Map(), dirs: new Map(), nextId: 1, staging: new Map(), journal: new Map(), evidence: [] };
  let fault = null;
  const env = { store: { bytes: Buffer.alloc(0) }, disk, boot: 'boot-1', publicKeyPem: PUB, now: () => new Date('2026-10-18T12:00:00Z'),
    fault: (p) => { if (p === fault) { fault = null; throw new E.Crash(p); } } };
  E.init(env, { targets: [[SERVICES, { bytes: REG, id: disk.nextId++ }]] });
  E.commitScope(env, { incident: 'inc-1', serial: 1, expires_at: '2099-01-01T00:00:00Z', permits: ['update_records', 'stage_restore'] });
  return { env, setFault: (p) => { fault = p; } };
}
const typed = (shown) => /confirmation code to approve: (\S+)/.exec(shown.at(-1))[1];
function con() { const shown = []; return { shown, display: (t) => shown.push(t), confirm: () => typed(shown) }; }
const restoreEntries = (files = FILES, extra = {}) => buildRequest({ operation: 'restore.stage', incident_id: 'inc-1', files, ...extra });
const st = (env) => E.replay(verifyLedger(env.store.bytes).records);
const crashes = (fn) => { try { fn(); } catch (e) { if (e.crash) return e.crash; throw e; } assert.fail('expected a simulated crash'); };

// --------------------------------------------------------------------------------------------- restore trees

test('M3: a restore tree is reviewed in full, published by one rename with its manifest, and recorded applied', () => {
  const { env } = simEnv();
  const c = con();
  const r = approveRestore(env, { entries: restoreEntries(), signer, maskStoredText, ...c, apply: true });
  assert.equal(r.result, 'applied');
  const key = finalKey(r.approvalId);
  for (const [rel, bytes] of FILES) assert.deepEqual(env.disk.files.get(`${key}/${rel}`).bytes, bytes);
  assert.ok(env.disk.files.has(`${key}/RESTORE_MANIFEST.json`), 'manifest present');
  assert.ok(!env.disk.dirs.has(tmpKey(r.approvalId)), 'temporary folder gone (renamed)');
  for (const rel of FILES.keys()) assert.ok(c.shown[0].includes(`File: ${rel}`), `the review shows ${rel}`);
  assert.ok(!c.shown[0].includes('\t'), 'tab shown escaped');
  assert.equal(st(env).targets[key].sha, r.review.match(/proposed: +([0-9a-f]{64})/)[1]);
});

test('M3: unsafe membership, paths, binary, sizes and masked content are refused before anything is signed or staged', () => {
  const bad = [
    [new Map([['Upper.txt', Buffer.from('x')]]), /segment not allowed/],
    [new Map([['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]), /collides|colliding/],
    [new Map([['restore_manifest.json', Buffer.from('x')]]), /reserved/],
    [new Map([['con.txt', Buffer.from('x')]]), /segment not allowed/],
    [new Map([['bin.dat', Buffer.from([0, 1, 2])]]), /binary/],
    [new Map([['bad.txt', Buffer.from([0xc3, 0x28])]]), /not UTF-8/],
    [new Map([['big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)]]), /larger than/],
    [new Map([['key.txt', Buffer.from('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')]]), /masked storage would change/],
  ];
  for (const [files, re] of bad) {
    const { env } = simEnv();
    assert.throws(() => approveRestore(env, { entries: restoreEntries(files), signer, maskStoredText, ...con() }), re);
    assert.equal(Object.keys(st(env).approvals).length, 0);
    assert.equal(env.disk.staging.size, 0);
  }
  assert.throws(() => validateTreeFiles(new Map()), /at least one file/);
});

test('M3: interruption at each tree step recovers forward; a decided cancellation removes only owned, listed files', () => {
  for (const point of ['after_tree_dir:0', 'after_tree_file:0:1', 'after_tree_manifest:0', 'after_tree_rename:0']) {
    const { env, setFault } = simEnv();
    const r = approveRestore(env, { entries: restoreEntries(), signer, maskStoredText, ...con() });
    setFault(point);
    assert.equal(crashes(() => E.apply(env, r.approvalId)), point);
    assert.equal(E.recover(env), 'applied', `${point}: completed forward`);
    assert.ok(env.disk.dirs.has(finalKey(r.approvalId)) && !env.disk.dirs.has(tmpKey(r.approvalId)));
  }
  // Cancellation after publication, interrupted midway, then resumed: only listed files at their hash are deleted.
  const { env, setFault } = simEnv();
  const r = approveRestore(env, { entries: restoreEntries(), signer, maskStoredText, ...con() });
  setFault('after_tree_rename:0'); crashes(() => E.apply(env, r.approvalId));
  const a = st(env).approvals[r.approvalId];
  // The owner's cancel decision binds the observed state: the published tree (its tree hash and folder id).
  const key = finalKey(r.approvalId);
  const p = { kind: 'recovery-decision', policy_version: 2, authority_epoch: 1, key_epoch: 1, decision_id: randomBytes(16).toString('hex'),
    approval_id: r.approvalId, tx_seq: a.consumingSeq, recovery_revision: 0, direction: 'cancel', overrides: [],
    observed: [{ target_key: key, sha: a.doc.payload.targets[0].proposed_sha256, file_id: env.disk.dirs.get(key).id }], incident_id: 'inc-1',
    issued_at: '2026-10-18T12:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' };
  E.issueDecision(env, { payload: p, signature: signer(Buffer.from(canonical(p))) });
  setFault('after_cancel_delete:0:1'); crashes(() => E.recover(env, { decisionId: p.decision_id }));
  assert.ok(env.disk.dirs.has(cancelKey(r.approvalId)), 'renamed aside, partially deleted');
  assert.equal(E.recover(env), 'cancelled', 'resumed: missing listed files are progress');
  assert.ok(!env.disk.dirs.has(cancelKey(r.approvalId)) && !env.disk.dirs.has(key));
  assert.equal(st(env).targets[key].tombstone, true);
});

test('M3: an unlisted entry in a temporary tree is a conflict (nothing deleted, evidence kept); new work is blocked globally', () => {
  const { env, setFault } = simEnv();
  const r = approveRestore(env, { entries: restoreEntries(), signer, maskStoredText, ...con() });
  setFault('after_tree_file:0:0'); crashes(() => E.apply(env, r.approvalId));
  env.disk.files.set(`${tmpKey(r.approvalId)}/planted.txt`, { bytes: Buffer.from('not listed'), id: 999 });
  assert.equal(E.recover(env), 'conflict');
  assert.ok(env.disk.files.has(`${tmpKey(r.approvalId)}/planted.txt`), 'nothing deleted');
  assert.throws(() => approveChange(env, { entries: buildRequest({ operation: 'register.replace', incident_id: 'inc-1', register_key: SERVICES, record: SERVICE }), signer, maskStoredText, ...con() }),
    /unresolved transaction/);
});

test('M3: a restore needs the stage_restore permission', () => {
  const { env } = simEnv();
  E.commitScope(env, { incident: 'inc-2', serial: 1, expires_at: '2099-01-01T00:00:00Z', permits: ['update_records'] });
  assert.throws(() => approveRestore(env, { entries: buildRequest({ operation: 'restore.stage', incident_id: 'inc-2', files: FILES }), signer, maskStoredText, ...con() }),
    /cannot authorize/);
});

// ---------------------------------------------------------------------------------- real filesystem backend

test('M3: read-only diagnostic filesystem view never creates or mutates paths', () => {
  const absent = join(ROOT, 'absent-diagnostic-root');
  const disk = new RealDisk(absent, { readOnly: true });
  assert.equal(existsSync(absent), false, 'opening the diagnostic view must not create the root');
  assert.equal(disk.files.get('registers/services.json'), undefined);
  assert.equal(disk.staging.size, 0);
  assert.equal(disk.journal.size, 0);
  assert.equal(disk.evidence.length, 0);
  assert.deepEqual([...disk.files], []);
  assert.throws(() => disk.writeTemp(Buffer.from('x')), /read-only diagnostics/);
  assert.throws(() => disk.files.delete('registers/services.json'), /read-only diagnostics/);
  assert.throws(() => disk.files.set('registers/services.json', {}), /read-only diagnostics/);
  assert.throws(() => disk.dirs.set('restores/id'), /read-only diagnostics/);
  assert.throws(() => disk.staging.set('0'.repeat(32), new Map()), /read-only diagnostics/);
  assert.throws(() => disk.journal.delete('0'.repeat(32)), /read-only diagnostics/);
  assert.throws(() => disk.evidence.push({ kind: 'diagnostic' }), /read-only diagnostics/);
  assert.equal(existsSync(absent), false, 'attempted writes did not create the root');
});


test('M3 genesis preflight: never creates a ledger over v7 or unknown state', () => {
  for (const kind of ['legacy', 'unknown-file', 'work-remnant', 'staging-remnant']) {
    const root = join(ROOT, `genesis-refusal-${kind}`);
    mkdirSync(root);
    if (kind === 'legacy') writeFileSync(join(root, 'private_key.enc.json'), 'SYNTHETIC LEGACY MARKER');
    if (kind === 'unknown-file') writeFileSync(join(root, 'unexpected.txt'), 'SYNTHETIC STATE');
    if (kind === 'work-remnant') {
      mkdirSync(join(root, 'data', '.work'), { recursive: true });
      writeFileSync(join(root, 'data', '.work', 'pending'), 'SYNTHETIC TEMP');
    }
    if (kind === 'staging-remnant') {
      mkdirSync(join(root, 'staging'));
      writeFileSync(join(root, 'staging', 'pending.json'), '{}');
    }
    const before = readdirSync(root).sort();
    assert.throws(() => FileLedgerStore.createNew(join(root, 'ledger', 'ledger.log')), /first-time initialization refused/, kind);
    assert.deepEqual(readdirSync(root).sort(), before, 'genesis preflight creates no directory');
    assert.equal(existsSync(join(root, 'ledger')), false, 'genesis never initialized the root');
  }
  const root = join(ROOT, 'genesis-fresh-layout');
  mkdirSync(join(root, 'data', '.work'), { recursive: true });
  mkdirSync(join(root, 'staging')); mkdirSync(join(root, 'journal')); mkdirSync(join(root, 'evidence'));
  const ledger = join(root, 'ledger', 'ledger.log');
  assert.equal(FileLedgerStore.createNew(ledger).bytes.length, 0, 'only a fresh explicitly initiated layout qualifies');
  assert.throws(() => FileLedgerStore.createNew(ledger), /first-time initialization refused/);
});


test('M3 real disk offline integration: explicit genesis, synthetic scope, diagnostic does not append', () => {
  const root = join(ROOT, 'real-backend-offline-integration');
  const disk = new RealDisk(root);
  const store = FileLedgerStore.createNew(join(root, 'ledger', 'ledger.log'));
  const env = { store, disk, boot: 'test-boot-only', publicKeyPem: PUB,
    now: () => new Date('2026-10-18T12:00:00Z') };
  E.init(env, { targets: [[SERVICES, disk.writeTemp(REG)]] });
  E.commitScope(env, { incident: 'synthetic-test', serial: 1,
    expires_at: '2099-01-01T00:00:00Z', permits: ['update_records'] });
  const ledgerPath = join(root, 'ledger', 'ledger.log');
  const original = readFileSync(ledgerPath);
  const entries = readdirSync(root).sort();
  const diagnostic = diagnosticMain(['diagnose'], { root });
  assert.equal(diagnostic.ledger, 'intact');
  assert.equal(diagnostic.pending, null);
  assert.ok(diagnosticMain(['head'], { root }).seq > 0);
  assert.deepEqual(readFileSync(ledgerPath), original);
  assert.deepEqual(readdirSync(root).sort(), entries);
  assert.equal(existsSync(join(root, 'data', 'registers', 'services.json')), true);
});


test('M3 offline diagnostic: explicitly read-only RealDisk, no authority mutation, and narrow dispatch', () => {
  const root = join(ROOT, 'read-only-diagnostic');
  mkdirSync(join(root, 'ledger'), { recursive: true });
  const { env } = simEnv();
  const ledgerPath = join(root, 'ledger', 'ledger.log');
  writeFileSync(ledgerPath, env.store.bytes);
  const original = readFileSync(ledgerPath);
  const before = readdirSync(root).sort();
  const deps = createReadOnlyDiagnosticDeps({ root });
  assert.equal(deps.env.disk.readOnly, true);
  assert.equal(diagnosticMain(['diagnose'], { root }).ledger, 'intact');
  assert.equal(diagnosticMain(['head'], { root }).ledger, 'intact');
  assert.deepEqual(readFileSync(ledgerPath), original);
  assert.deepEqual(readdirSync(root).sort(), before, 'no diagnostic work/staging folder');
  assert.throws(() => { deps.env.store.bytes = Buffer.from('corrupt'); }, /read-only diagnostics/);
  assert.throws(() => deps.env.disk.writeTemp(Buffer.from('bad')), /read-only diagnostics/);
  for (const name of ['apply', 'stop', 'recover', 'approve-change', 'adopt', 'reconcile', 'revoke-change', 'init']) {
    assert.throws(() => diagnosticMain([name], { root }), /only diagnose or head/, `${name} must be refused`);
  }
  assert.throws(() => diagnosticMain(['diagnose', 'junk'], { root }), /only diagnose or head/);
  assert.deepEqual(readFileSync(ledgerPath), original, 'no command changed ledger history');
  assert.equal(existsSync(join(root, 'data')), false);
  assert.equal(existsSync(join(root, 'staging')), false);
  assert.equal(existsSync(join(root, 'journal')), false);
  assert.equal(existsSync(join(root, 'evidence')), false);
});

test('M3 offline diagnostic refuses missing/empty ledger and unsafe symlinked data base', { skip: WIN }, () => {
  const root = join(ROOT, 'diagnostic-refuse');
  mkdirSync(join(root, 'ledger'), { recursive: true });
  assert.throws(() => diagnosticMain(['diagnose'], { root }), /ledger.*missing/);
  assert.equal(existsSync(join(root, 'ledger', 'ledger.log')), false);
  writeFileSync(join(root, 'ledger', 'ledger.log'), Buffer.alloc(0));
  assert.throws(() => diagnosticMain(['diagnose'], { root }), /no genesis/);
  const outside = join(ROOT, 'unrelated-diagnostic-target');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'data'));
  const disk = new RealDisk(root, { readOnly: true });
  assert.throws(() => disk.files.get('registers/item.json'), /ordinary directory/);
  assert.throws(() => [...disk.files], /ordinary directory/);
  assert.equal(readdirSync(outside).length, 0, 'unrelated path untouched');
});

test('M3 read-only map inspections refuse symlinked staging, journal and evidence folders', { skip: WIN }, () => {
  const root = join(ROOT, 'map-inspection-links');
  const outside = join(ROOT, 'map-inspection-outside');
  mkdirSync(root); mkdirSync(outside);
  for (const sub of ['staging', 'journal', 'evidence']) symlinkSync(outside, join(root, sub));
  const disk = new RealDisk(root, { readOnly: true });
  const id = '1'.repeat(32);
  assert.throws(() => disk.staging.get(id), /unsafe folder/);
  assert.throws(() => disk.staging.has(id), /unsafe folder/);
  assert.throws(() => disk.staging.size, /unsafe folder/);
  assert.throws(() => disk.journal.size, /unsafe folder/);
  assert.throws(() => disk.evidence.length, /unsafe folder/);
  assert.equal(readdirSync(outside).length, 0);
});


test('M3 offline migration inventory: legacy, predeployment, mixed and unsafe shapes never trigger changes', { skip: WIN }, () => {
  const missing = join(ROOT, 'assessment-missing');
  assert.equal(assessOfflineLayout(missing).classification, 'absent');
  assert.equal(existsSync(missing), false);
  const legacy = join(ROOT, 'legacy-inventory');
  mkdirSync(join(legacy, 'authorizations'), { recursive: true });
  for (const name of ['authority_cli.mjs', 'state.json', 'private_key.enc.json', 'public_key.pem']) writeFileSync(join(legacy, name), 'DUMMY SYNTHETIC NO SECRET');
  const keyBefore = readFileSync(join(legacy, 'private_key.enc.json'));
  const old = assessOfflineLayout(legacy);
  assert.equal(old.classification, 'legacy_v7_shape_requires_owner_review');
  assert.equal(old.migration, 'owner_review_required');
  assert.deepEqual(readFileSync(join(legacy, 'private_key.enc.json')), keyBefore);
  const modern = join(ROOT, 'predeploy-inventory');
  mkdirSync(join(modern, 'ledger'), { recursive: true });
  for (const name of ['installed_manifest.json','bootstrap.mjs','authority.cmd','ledger/authority.lock']) writeFileSync(join(modern, name), 'SYNTHETIC');
  assert.equal(assessOfflineLayout(modern).classification, 'predeployment_shape_inactive_unverified');
  assert.equal(existsSync(join(modern, 'ledger', 'ledger.log')), false);
  writeFileSync(join(modern, 'private_key.enc.json'), 'SYNTHETIC');
  assert.equal(assessOfflineLayout(modern).classification, 'mixed_existing_preserve');
  const outside = join(ROOT, 'inventory-outside'); mkdirSync(outside);
  const linked = join(ROOT, 'linked-inventory'); mkdirSync(linked);
  symlinkSync(outside, join(linked, 'staging'));
  assert.equal(assessOfflineLayout(linked).classification, 'unsafe_existing_preserve');
  assert.equal(readdirSync(outside).length, 0);
});


function realEnv(name) {
  const root = join(ROOT, name);
  const disk = new RealDisk(root);
  let fault = null;
  const env = { store: FileLedgerStore.createNew(join(root, 'ledger', 'ledger.log')), disk, boot: 'boot-1', publicKeyPem: PUB, now: () => new Date('2026-10-18T12:00:00Z'),
    fault: (p) => { if (p === fault) { fault = null; throw new E.Crash(p); } } };
  E.init(env, { targets: [[SERVICES, disk.writeTemp(REG)]] });
  E.commitScope(env, { incident: 'inc-1', serial: 1, expires_at: '2099-01-01T00:00:00Z', permits: ['update_records', 'stage_restore'] });
  return { env, root, setFault: (p) => { fault = p; } };
}

test('M3 (real files, temp folder): register replace and a restore tree end to end, with crash and recovery', { skip: !WIN }, () => {
  const { env, root, setFault } = realEnv('e2e');
  const rr = approveChange(env, { entries: buildRequest({ operation: 'register.replace', incident_id: 'inc-1', register_key: SERVICES, record: { ...SERVICE, mfa_enabled: true } }),
    signer, maskStoredText, ...con(), apply: true });
  assert.equal(rr.result, 'applied');
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'registers', 'services.json'), 'utf8')).records[0].mfa_enabled, true);
  const r = approveRestore(env, { entries: restoreEntries(), signer, maskStoredText, ...con() });
  setFault('after_tree_file:0:1'); crashes(() => E.apply(env, r.approvalId));
  // A "new process": reopen the ledger and disk from the files only.
  const env2 = { ...env, store: new FileLedgerStore(join(root, 'ledger', 'ledger.log')), disk: new RealDisk(root) };
  assert.equal(E.recover(env2), 'applied');
  for (const [rel, bytes] of FILES) assert.deepEqual(readFileSync(join(root, 'data', 'restores', r.approvalId, ...rel.split('/'))), bytes);
  assert.equal(verifyLedger(readFileSync(join(root, 'ledger', 'ledger.log'))).status, 'intact', 'the ledger file verifies');
  assert.deepEqual(readdirSync(join(root, 'data', '.work')), [], 'no temporary files left');
});

test('M3 (real files, temp folder): a hard-linked register is refused; a same-content replacement is refused at issuance', { skip: !WIN }, () => {
  const { env, root } = realEnv('links');
  const p = join(root, 'data', 'registers', 'services.json');
  linkSync(p, join(root, 'second-name.json')); // a second name for the register
  assert.throws(() => approveChange(env, { entries: buildRequest({ operation: 'register.replace', incident_id: 'inc-1', register_key: SERVICES, record: SERVICE }),
    signer, maskStoredText, ...con() }), /more than one name/);
  rmSync(join(root, 'second-name.json'));
  // Same bytes, new file (new OS identity): refused (M2-F1 on real files).
  const bytes = readFileSync(p); rmSync(p); env.disk.files.set(SERVICES, env.disk.writeTemp(bytes));
  assert.throws(() => approveChange(env, { entries: buildRequest({ operation: 'register.replace', incident_id: 'inc-1', register_key: SERVICES, record: SERVICE }),
    signer, maskStoredText, ...con() }), /file identity/);
});

test('M3 (real files, temp folder): a missing ledger is refused on open; only explicit first-time creation makes one', { skip: !WIN }, () => {
  const { env, root } = realEnv('missing-ledger'); // created through createNew, then initialized
  const ledger = join(root, 'ledger', 'ledger.log');
  assert.throws(() => FileLedgerStore.createNew(ledger), /first-time initialization refused/, 'never over an existing ledger');
  const before = readFileSync(ledger);
  rmSync(ledger); // history lost
  assert.throws(() => new FileLedgerStore(ledger), /is missing: its history may be lost/);
  assert.equal(existsSync(ledger), false, 'opening did not re-create it');
  assert.throws(() => FileLedgerStore.createNew(ledger), /already holds state/, 'existing registers mean a ledger existed');
  assert.equal(existsSync(ledger), false);
  // A genuinely fresh authority root: allowed exactly once, and it starts empty.
  const fresh = join(ROOT, 'fresh-root', 'ledger', 'ledger.log');
  assert.equal(FileLedgerStore.createNew(fresh).bytes.length, 0);
  assert.throws(() => FileLedgerStore.createNew(fresh), /first-time initialization refused/);
  assert.ok(before.length > 0 && env.store.bytes.equals(before));
});

// --------------------------------------------------------------------------------- exporter, signer, CLI

test('M3: builder -> request folder -> exporter -> local pipe -> authority staging round-trips exactly', { skip: !WIN }, async () => {
  const entries = restoreEntries(FILES, { reason: 'restore after\tdefacement' });
  const dir = join(ROOT, 'request-1');
  writeRequestFolder(dir, entries);
  const read = readRequestFolder(dir);
  assert.deepEqual(read.map((e) => e.name), entries.map((e) => e.name));
  const pipe = `\\\\.\\pipe\\gb2l-${randomBytes(16).toString('hex')}`, code = randomBytes(16);
  const stagingDir = join(ROOT, 'staging-1'); (await import('node:fs')).mkdirSync(stagingDir);
  const server = receiveRequest({ pipe, code, stagingDir });
  await new Promise((r) => setTimeout(r, 30));
  await exportRequest(read, { pipe, code });
  const got = await server;
  got.entries.forEach((e, i) => assert.deepEqual(readFileSync(join(got.incoming, `entry-${String(e.index).padStart(4, '0')}`)), read[i].data, e.name));
  assert.throws(() => readRequestFolder(join(ROOT, 'missing')), /ENOENT|no request/);
});

test('M3: the signer reads the EXISTING protected key format (synthetic passphrase); wrong passphrase and foreign key refused', () => {
  const pass = 'synthetic test passphrase only';
  const k = generateAuthorityKey(pass);
  let reads = 0;
  const s = createPassphraseSigner({ encryptedPrivateKey: k.encryptedPrivateKey, publicKeyPem: k.publicKeyPem, readPassphrase: () => { reads++; return pass; } });
  const sig = s(Buffer.from('payload'));
  assert.ok(verify(null, Buffer.from('payload'), createPublicKey(k.publicKeyPem), Buffer.from(sig, 'base64')));
  assert.equal(reads, 1, 'the passphrase is read at signing time, once');
  const wrong = createPassphraseSigner({ encryptedPrivateKey: k.encryptedPrivateKey, publicKeyPem: k.publicKeyPem, readPassphrase: () => 'not the passphrase!!' });
  assert.throws(() => wrong(Buffer.from('x')), /wrong passphrase/);
  assert.throws(() => createPassphraseSigner({ encryptedPrivateKey: k.encryptedPrivateKey, publicKeyPem: PUB, readPassphrase: () => pass }), /does not belong/);
});

test('M3: command entry: safe arguments only; diagnose is read-only; production wiring refuses outside an installed folder', () => {
  const { env } = simEnv();
  const before = Buffer.from(env.store.bytes);
  assert.equal(main(['diagnose'], { env }).ledger, 'intact');
  assert.deepEqual(env.store.bytes, before, 'diagnose wrote nothing');
  assert.equal(main(['head'], { env }).ledger, 'intact');
  for (const argv of [['apply'], ['apply', 'A&B'], ['apply', 'a', 'b'], ['approve-change', 'now'], ['unknown'], ['stop', '../x']]) {
    assert.throws(() => main(argv, { env }), /invalid arguments|unknown command|optional word/, JSON.stringify(argv));
  }
  const c = con();
  const deps = { env, signer, maskStoredText, ...c, receive: () => buildRequest({ operation: 'register.replace', incident_id: 'inc-1', register_key: SERVICES, record: SERVICE }) };
  assert.equal(main(['approve-change', 'apply'], deps).result, 'applied', 'dispatch to approve-change with apply');
  assert.throws(() => createProductionDeps({ root: join(ROOT, 'not-installed') }), /not installed here/);
  assert.ok(!existsSync(join(ROOT, 'not-installed')), 'the refusal created nothing');
});

// Ledger identity is pinned at open. A disappearing/replaced ledger cannot be
// recreated, redirected through a symlink, or overwritten via a second name.
test('M3 file-ledger append refuses a vanished file without recreating history', () => {
  const root = join(ROOT, 'ledger-vanished-synthetic');
  const path = join(root, 'ledger', 'ledger.log');
  const store = FileLedgerStore.createNew(path);
  rmSync(path);
  assert.throws(() => { store.bytes = Buffer.from('synthetic append'); }, /ENOENT|ledger pathname/);
  assert.equal(existsSync(path), false);
});

test('M3 file-ledger append refuses a replaced inode and preserves the replacement', () => {
  const root = join(ROOT, 'ledger-replaced-synthetic');
  const path = join(root, 'ledger', 'ledger.log');
  const store = FileLedgerStore.createNew(path);
  const replacement = Buffer.from('preserve synthetic other file');
  rmSync(path);
  writeFileSync(path, replacement);
  assert.throws(() => { store.bytes = Buffer.from('append not permitted'); }, /ledger pathname identity changed/);
  assert.deepEqual(readFileSync(path), replacement);
});

test('M3 file-ledger append refuses a new hardlink and never modifies either name', () => {
  const root = join(ROOT, 'ledger-hardlink-synthetic');
  const path = join(root, 'ledger', 'ledger.log');
  const store = FileLedgerStore.createNew(path);
  const secondName = join(root, 'ledger', 'alias.log');
  linkSync(path, secondName);
  assert.throws(() => { store.bytes = Buffer.from('append not permitted'); }, /ordinary file/);
  assert.equal(readFileSync(path).length, 0);
  assert.equal(readFileSync(secondName).length, 0);
});
