// F01 protected authority: offline tests. A temporary folder stands in for the admin-only install folder; the
// real ACL check is exercised separately (a normal-user folder must be REFUSED). Passphrases here are synthetic.
import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizationPayload, canonical, emptyState, generateAuthorityKey, integrityDiff, keyFingerprint, nextSerial, recordApproval, recordStop,
  signAuthorization, verifyAuthorization,
} from './authority_core.mjs';
import { commitApproval, commitStop, main as cli, protectionProblems, transactState } from './authority_cli.mjs';
import { safeWrite, TOOLBOX_ROOT } from '../_shared/common.mjs';
import { _resetAuthority, _setAuthorityForTests } from '../_shared/authority_link.mjs';
import { clearActiveScope, requireScope, template } from '../_shared/scope.mjs';
import { configurePolite, resetPolite } from '../_shared/polite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(TOOLBOX_ROOT, '.test_tmp', `authority-${randomUUID()}`);
mkdirSync(TMP, { recursive: true });
afterEach(() => { _resetAuthority(); clearActiveScope(); });
after(() => { rmSync(TMP, { recursive: true, force: true }); try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ } });

const PASS = 'synthetic passphrase for tests only';
const KEY = generateAuthorityKey(PASS);            // the protected authority's key
const OTHER = generateAuthorityKey('another synthetic passphrase'); // an attacker's key
const future = () => new Date(Date.now() + 3 * 864e5).toISOString();
const baseScope = (over = {}) => ({ ...template(), incident_id: 'incident-alpha', targets: ['alpha.org'], disclosures: ['rdap'], expires_at: future(),
  persistence: 'local', permissions: { ...template().permissions, save_local: true }, ...over });
function approve(scope, state, key = KEY, passphrase = PASS) {
  const serial = nextSerial(state, scope.incident_id);
  return { signed: signAuthorization(scope, { ...key, passphrase, serial }), state: recordApproval(state, scope.incident_id, serial) };
}
const check = (scope, signed, state, publicKeyPem = KEY.publicKeyPem) => verifyAuthorization(scope, signed, { publicKeyPem, state });

test('the private key is stored only encrypted, and only the right passphrase unlocks it', () => {
  const stored = JSON.stringify(KEY.encryptedPrivateKey);
  assert.doesNotMatch(stored, /PRIVATE KEY|BEGIN/);
  assert.equal(stored.includes(PASS), false);
  assert.throws(() => signAuthorization(baseScope(), { ...KEY, passphrase: 'wrong passphrase!!', serial: 1 }), /wrong passphrase/);
  assert.throws(() => generateAuthorityKey('short'), /at least 12/);
});

test('a correctly signed, unexpired, latest authorization is valid', () => {
  const scope = baseScope();
  const { signed, state } = approve(scope, emptyState());
  assert.deepEqual(check(scope, signed, state), { valid: true, reasons: [], serial: 1 });
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}', 'signing input is canonical');
});

test('EDITED PERMISSIONS: any change to what was signed is refused', () => {
  const scope = baseScope();
  const { signed, state } = approve(scope, emptyState());
  const edits = {
    'permission added': { permissions: { ...scope.permissions, live_http_inspection: true } },
    'target added': { targets: ['alpha.org', 'other.org'] },
    'disclosure added': { disclosures: ['rdap', 'target_website'] },
    'persistence changed': { persistence: 'transient' },
    'expiry extended': { expires_at: new Date(Date.now() + 30 * 864e5).toISOString() },
    'deny_actions removed': { deny_actions: [] },
    'grant added': { approvals: [{ action: 'live_http_inspection', target: 'https://alpha.org/', attested_at: new Date().toISOString(), attested_by: 'operator' }] },
    'lookalikes enabled': { allow_derived_lookalikes: true },
    'incident renamed': { incident_id: 'incident-beta' },
  };
  for (const [label, change] of Object.entries(edits)) {
    const r = check({ ...scope, ...change }, signed, state);
    assert.equal(r.valid, false, label);
  }
  // Editing the SIGNED document instead (to match the edit) breaks the signature.
  const tampered = { ...signed, payload: authorizationPayload({ ...scope, ...edits['permission added'] }, signed.payload.serial) };
  assert.match(check({ ...scope, ...edits['permission added'] }, tampered, state).reasons.join(), /signature does not match/);
});

test('SUBSTITUTED KEYS: a signature by any other key is refused, even with a forged fingerprint', () => {
  const scope = baseScope();
  const { state } = approve(scope, emptyState());
  const forged = signAuthorization(scope, { ...OTHER, passphrase: 'another synthetic passphrase', serial: 1 });
  assert.match(check(scope, forged, state).reasons.join(), /different key/);
  const relabelled = { ...forged, key_fingerprint: keyFingerprint(KEY.publicKeyPem) };
  assert.match(check(scope, relabelled, state).reasons.join(), /signature does not match/);
  // A key swapped in next to the scope changes nothing: verification uses the PROTECTED public key.
  assert.equal(check(scope, forged, state, KEY.publicKeyPem).valid, false);
});

test('EXPIRED SIGNATURES: a signed authorization past its expiry is refused', () => {
  const scope = baseScope({ expires_at: new Date(Date.now() + 60_000).toISOString() });
  const { signed, state } = approve(scope, emptyState());
  assert.equal(check(scope, signed, state).valid, true);
  const later = verifyAuthorization(scope, signed, { publicKeyPem: KEY.publicKeyPem, state, now: new Date(Date.now() + 120_000) });
  assert.match(later.reasons.join(), /expired/);
});

test('REVOKED APPROVALS: a protected stop cannot be undone by editing the scope, and a stopped incident cannot be re-approved', () => {
  const scope = baseScope();
  let { signed, state } = approve(scope, emptyState());
  state = recordStop(state, 'incident-alpha');
  assert.match(check(scope, signed, state).reasons.join(), /STOPPED through the protected authority/);
  assert.match(check({ ...scope, status: 'open' }, signed, state).reasons.join(), /STOPPED/, 'status edited back to open');
  assert.throws(() => recordApproval(state, 'incident-alpha', 2), /was stopped/);
});

test('REPLAYED SCOPES: an older signed authorization is refused once a newer one exists (rollback prevention)', () => {
  const v1 = baseScope();
  let { signed: s1, state } = approve(v1, emptyState());
  const v2 = baseScope({ targets: ['alpha.org', 'beta.org'] });
  const r2 = approve(v2, state);
  state = r2.state;
  assert.equal(check(v2, r2.signed, state).valid, true);
  assert.match(check(v1, s1, state).reasons.join(), /older authorization \(serial 1; the latest approved is 2\)/);
  assert.throws(() => recordApproval(state, 'incident-alpha', 2), /not newer/);
});

test('an authorization the protected state has never seen is refused', () => {
  const scope = baseScope();
  const { signed } = approve(scope, emptyState());
  assert.match(check(scope, signed, emptyState()).reasons.join(), /no record/);
});

// ---- Integration with the toolbox (requireScope), using a temporary folder as the authority ----
function installTempAuthority(state) {
  const dir = join(TMP, `auth-${randomUUID()}`); mkdirSync(dir);
  copyFileSync(join(HERE, 'authority_core.mjs'), join(dir, 'authority_core.mjs'));
  writeFileSync(join(dir, 'public_key.pem'), KEY.publicKeyPem);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  mkdirSync(join(dir, 'authorizations'));
  _setAuthorityForTests(dir);
  return dir;
}
// v6 review: signed authorizations live INSIDE the protected folder, never as a sidecar beside the scope.
const storeSigned = (authDir, signed) => writeFileSync(join(authDir, 'authorizations', `${signed.payload.incident_id}.json`), JSON.stringify(signed));
function scopeFile(scope) {
  const dir = join(TMP, `scope-${randomUUID()}`); mkdirSync(dir);
  configurePolite({ dir: join(dir, 'state') }); resetPolite();
  const p = join(dir, 'scope.json'); writeFileSync(p, JSON.stringify(scope)); return p;
}

test('installed authority: tools refuse an unsigned scope, accept a signed one, and a protected stop blocks the next save', () => {
  const scope = baseScope();
  const { signed, state } = approve(scope, emptyState());
  const authDir = installTempAuthority(state);
  const p = scopeFile(scope);
  writeFileSync(`${p}.authorization.json`, JSON.stringify(signed)); // a sidecar beside the scope is IGNORED
  assert.throws(() => requireScope(p, { action: 'save_local' }), /no signed authorization/);
  storeSigned(authDir, signed);
  clearActiveScope();
  requireScope(p, { action: 'save_local' });
  const out = join(dirname(p), 'report.json');
  safeWrite(out, '{"ok":1}', { root: dirname(p) }); // allowed while the authority allows it
  writeFileSync(join(authDir, 'state.json'), JSON.stringify(recordStop(state, 'incident-alpha'))); // the owner stops it, protected
  assert.throws(() => safeWrite(join(dirname(p), 'second.json'), '{}', { root: dirname(p) }), /STOPPED/, 'the next save in the SAME command is blocked');
  assert.equal(existsSync(join(dirname(p), 'second.json')), false);
  clearActiveScope();
  assert.throws(() => requireScope(p, { action: 'save_local' }), /STOPPED/, 'and so is any new command');
});

test('installed authority: editing permissions in the scope file after signing blocks the command', () => {
  const scope = baseScope();
  const { signed, state } = approve(scope, emptyState());
  storeSigned(installTempAuthority(state), signed);
  const p = scopeFile({ ...scope, permissions: { ...scope.permissions, passive_lookup: true, live_http_inspection: true } });
  assert.throws(() => requireScope(p, { action: 'save_local' }), /no longer says what was signed/);
});

test('a planted authority folder (owned by the normal account) is NOT trusted: every scoped command is refused', { skip: process.platform !== 'win32' }, () => {
  const scope = baseScope();
  const { signed, state } = approve(scope, emptyState());
  const dir = installTempAuthority(state);
  copyFileSync(join(HERE, 'authority_cli.mjs'), join(dir, 'authority_cli.mjs'));
  _setAuthorityForTests(dir, { checkAcl: true }); // the real Windows ACL query, on a folder this account owns
  const p = scopeFile(scope);
  storeSigned(dir, signed);
  assert.throws(() => requireScope(p, { action: 'save_local' }), /not trustworthy/);
});

const OK_ACL = { exists: true, reparse: false, owner: 'BUILTIN\\Administrators', aces: [{ identity: 'BUILTIN\\Administrators', rights: 'FullControl', type: 'Allow' }, { identity: 'NT AUTHORITY\\SYSTEM', rights: 'FullControl', type: 'Allow' }, { identity: 'BUILTIN\\Users', rights: 'ReadAndExecute, Synchronize', type: 'Allow' }] };
const BAD_ACLS = {
  'other owner': { ...OK_ACL, owner: 'PC\\someone' },
  'Users can modify': { ...OK_ACL, aces: [...OK_ACL.aces, { identity: 'BUILTIN\\Users', rights: 'Modify, Synchronize', type: 'Allow' }] },
  'Authenticated Users can write': { ...OK_ACL, aces: [...OK_ACL.aces, { identity: 'NT AUTHORITY\\Authenticated Users', rights: 'Write', type: 'Allow' }] },
  'Everyone full control': { ...OK_ACL, aces: [...OK_ACL.aces, { identity: 'Everyone', rights: 'FullControl', type: 'Allow' }] },
  'a user can create files': { ...OK_ACL, aces: [...OK_ACL.aces, { identity: 'PC\\someone', rights: 'CreateFiles', type: 'Allow' }] },
  'no permission entries (review finding 2)': { exists: true, reparse: false, owner: 'BUILTIN\\Administrators' },
  'empty permission list': { ...OK_ACL, aces: [] },
  'malformed entry': { ...OK_ACL, aces: [...OK_ACL.aces, { identity: 'BUILTIN\\Users' }] },
  'owner unreadable': { ...OK_ACL, owner: '' },
  'is a link': { ...OK_ACL, reparse: true },
  'link status unknown': { ...OK_ACL, reparse: undefined },
  'missing': { exists: false },
  'nothing at all': null,
};

test('folder and file protection rules: fail closed on anything missing, malformed, linked or writable', () => {
  assert.deepEqual(protectionProblems(OK_ACL), []);
  for (const [label, acl] of Object.entries(BAD_ACLS)) assert.notEqual(protectionProblems(acl).length, 0, label);
});

test('the toolbox and the authority apply IDENTICAL protection rules', async () => {
  const { aclProblems } = await import('../_shared/acl_check.mjs');
  for (const [label, acl] of Object.entries({ ok: OK_ACL, ...BAD_ACLS })) assert.deepEqual(aclProblems(acl, 'x'), protectionProblems(acl, 'x'), label);
});

test('the toolbox checks every authority file BEFORE loading any of its code (review finding 1)', async () => {
  const { authorityStatus } = await import('../_shared/authority_link.mjs');
  const dir = join(TMP, `candidate-${randomUUID()}`); mkdirSync(dir);
  writeFileSync(join(dir, 'authority_core.mjs'), 'globalThis.__candidateRan = true; export const verifyAuthorization = () => ({ valid: true, reasons: [] });');
  for (const f of ['authority_cli.mjs', 'public_key.pem', 'state.json']) writeFileSync(join(dir, f), '');
  const asked = [];
  const record = (paths, bad) => { asked.push(paths); return Object.fromEntries(paths.map((p) => [p, p.endsWith('state.json') && bad ? { ...OK_ACL, owner: 'PC\\someone' } : OK_ACL])); };
  // One unprotected FILE inside an otherwise protected folder is enough to refuse, and nothing from the folder runs.
  _setAuthorityForTests(dir, { checkAcl: true, readAcls: (paths) => record(paths, true) });
  const s = authorityStatus();
  assert.equal(s.trusted, false);
  assert.match(s.problems.join(), /state\.json: owner is PC\\someone/);
  assert.equal(globalThis.__candidateRan, undefined, 'the candidate code did not run');
  assert.ok(['authority_core.mjs', 'authority_cli.mjs', 'public_key.pem', 'state.json'].every((f) => asked[0].some((p) => p.endsWith(f))), 'every file was checked');
  // When everything really is protected, then (and only then) the verifier is loaded.
  _setAuthorityForTests(dir, { checkAcl: true, readAcls: (paths) => record(paths, false) });
  assert.equal(authorityStatus().trusted, true);
  assert.equal(globalThis.__candidateRan, true);
  delete globalThis.__candidateRan;
});

test('a signed serial NEWER than the committed one is refused (its commit never happened)', () => {
  const scope = baseScope();
  const { state } = approve(scope, emptyState()); // committed serial 1
  const ahead = signAuthorization(scope, { ...KEY, passphrase: PASS, serial: 2 });
  assert.match(check(scope, ahead, state).reasons.join(), /never committed/);
});

// ---- Review finding 4: protected-state changes are serialized and re-validated ----
function stateDir(state = emptyState()) {
  const dir = join(TMP, `state-${randomUUID()}`); mkdirSync(dir); mkdirSync(join(dir, 'authorizations'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return dir;
}
const readState = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

test('CONCURRENCY: an approval begun before a stop cannot overwrite that stop', () => {
  const scope = baseScope();
  const dir = stateDir();
  const shown = nextSerial(readState(dir), scope.incident_id); // session A shows serial 1, then waits for the owner
  commitStop(dir, scope.incident_id);                          // session B stops the incident meanwhile
  assert.throws(() => commitApproval(dir, scope, { expectedSerial: shown, keys: KEY, passphrase: PASS }), /stopped while you were approving/);
  assert.equal(readState(dir).incidents[scope.incident_id].revoked, true, 'the stop survived');
});

test('CONCURRENCY: two approvals shown the same serial cannot both commit', () => {
  const scope = baseScope();
  const dir = stateDir();
  const shown = nextSerial(readState(dir), scope.incident_id);
  commitApproval(dir, scope, { expectedSerial: shown, keys: KEY, passphrase: PASS });
  assert.throws(() => commitApproval(dir, baseScope({ targets: ['alpha.org', 'other.org'] }), { expectedSerial: shown, keys: KEY, passphrase: PASS }), /state changed while you were approving/);
  assert.equal(readState(dir).incidents[scope.incident_id].latest_serial, 1);
});

test('CONCURRENCY: state changes never interleave; a change while one is in progress is refused, and a failed change writes nothing', () => {
  const dir = stateDir();
  assert.throws(() => transactState(dir, (fresh) => { transactState(dir, (f2) => recordStop(f2, 'x')); return fresh; }), /in progress/);
  assert.deepEqual(readState(dir), emptyState(), 'neither change was written');
  assert.throws(() => transactState(dir, () => { throw new Error('mutation failed'); }), /mutation failed/);
  assert.equal(existsSync(join(dir, 'state.lock')), false, 'the lock is released after a failure');
  // stop and baseline go through the same lock and keep each other's changes.
  commitStop(dir, 'incident-alpha');
  transactState(dir, (fresh) => ({ ...fresh, baseline: { files: { 'a.mjs': '1' } } }));
  const s = readState(dir);
  assert.equal(s.incidents['incident-alpha'].revoked, true);
  assert.deepEqual(s.baseline.files, { 'a.mjs': '1' });
});

test('the passphrase is never accepted on the command line; changing commands need an elevated, protected run', async () => {
  for (const args of [['init', '--passphrase', 'x'], ['approve', 's.json', '--password=x'], ['init', 'PASSPHRASE=x']]) {
    await assert.rejects(cli(args), /never accepted on the command line/, args.join(' '));
  }
  if (process.platform === 'win32') {
    for (const cmd of [['init'], ['approve', join(TMP, 'none.json')], ['stop', 'incident-alpha'], ['baseline', TMP]]) {
      await assert.rejects(cli(cmd), /Administrator terminal|not admin-only/, cmd[0]); // this test process is not elevated
    }
  }
});

test('integrity baseline: any edited, removed or added toolbox file is reported', () => {
  const base = { files: { 'a.mjs': '1', 'b.mjs': '2' } };
  assert.deepEqual(integrityDiff(base, { 'a.mjs': '1', 'b.mjs': '2' }), []);
  assert.deepEqual(integrityDiff(base, { 'a.mjs': 'X', 'c.mjs': '3' }).sort(), ['a.mjs', 'b.mjs (missing)', 'c.mjs (not in baseline)']);
  assert.equal(existsSync('C:\\ProgramData\\gitback2life-authority'), false, 'nothing was installed on this computer by the tests');
  assert.equal(readFileSync(join(HERE, 'authority_core.mjs'), 'utf8').includes('PASSPHRASE'), false);
});
