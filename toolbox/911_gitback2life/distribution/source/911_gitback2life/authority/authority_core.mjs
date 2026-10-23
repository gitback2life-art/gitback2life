// F01 protected authority: signing and verification of COMPLETE incident authorizations.
//
// What it does:
//  - An Ed25519 key pair. The private key is stored only encrypted (scrypt + AES-256-GCM) under the owner's passphrase.
//  - `approve` signs the whole authorization: incident, exact targets, permitted and denied actions, disclosures,
//    persistence, expiry, derived-lookalike opt-in, always-ask grants, policy version, and a SERIAL number.
//  - Verification checks the signature with the PUBLIC key, that the scope file in use still says exactly what was
//    signed, the expiry, and the PROTECTED state: a stopped incident and serials older than the latest are refused.
//
// Where the protection comes from: the key, this verifier and the state live in an admin-only folder (see
// install.ps1). That is an operating-system boundary only while the AI or script runs WITHOUT administrator rights.
// This module is pure: every location is passed in, so the offline tests use a temporary folder instead.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, verify } from 'node:crypto';

export const AUTH_POLICY_VERSION = 1;
const KDF = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 });

/** Stable JSON: object keys sorted at every level, so the same authorization always signs the same bytes. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** The part of a scope that is authorized (status is NOT here: stops are protected state, see verifyAuthorization). */
export function authorizationPayload(scope, serial) {
  const sorted = (a) => [...(a ?? [])].map(String).sort();
  return {
    policy_version: AUTH_POLICY_VERSION,
    scope_schema: scope.scope_schema ?? 1,
    incident_id: String(scope.incident_id ?? ''),
    targets: sorted(scope.targets),
    permitted_actions: sorted(Object.entries(scope.permissions ?? {}).filter(([, v]) => v === true).map(([k]) => k)),
    deny_actions: sorted(scope.deny_actions),
    disclosures: sorted(scope.disclosures),
    persistence: scope.persistence ?? null,
    expires_at: scope.expires_at ?? null,
    allow_derived_lookalikes: scope.allow_derived_lookalikes === true,
    grants: (scope.approvals ?? []).map((a) => ({ action: a.action, target: a.target, attested_at: a.attested_at }))
      .sort((x, y) => canonical(x).localeCompare(canonical(y))),
    serial,
  };
}

export const keyFingerprint = (publicKeyPem) => createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');

/** New key pair; the private key leaves this function only encrypted under the passphrase. */
export function generateAuthorityKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('the passphrase must be at least 12 characters');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, KDF.keyLen, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })), cipher.final()]);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    publicKeyPem,
    encryptedPrivateKey: { kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), cipher: 'aes-256-gcm', iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), fingerprint: keyFingerprint(publicKeyPem) },
  };
}

function unlock(encrypted, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(encrypted.salt, 'base64'), encrypted.keyLen, encrypted);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  d.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  try { return createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(encrypted.ciphertext, 'base64')), d.final()]), format: 'der', type: 'pkcs8' }); }
  catch { throw new Error('wrong passphrase (or the key file was altered)'); }
}

/** Sign a scope's complete authorization with the next serial. Returns the signed document (no secrets inside). */
export function signAuthorization(scope, { encryptedPrivateKey, publicKeyPem, passphrase, serial, signedAt = new Date().toISOString() }) {
  if (!Number.isInteger(serial) || serial < 1) throw new Error('serial must be a positive integer');
  const payload = authorizationPayload(scope, serial);
  const signature = sign(null, Buffer.from(canonical(payload)), unlock(encryptedPrivateKey, passphrase)).toString('base64');
  return { payload, signature, key_fingerprint: keyFingerprint(publicKeyPem), signed_at: signedAt };
}

/** A fresh, empty protected state. */
export const emptyState = () => ({ state_version: 1, incidents: {}, baseline: null });

/**
 * Verify a scope against its signed authorization and the protected state. Returns { valid, reasons[], serial }.
 *   publicKeyPem  from the protected folder (a different key → refused)
 *   state         from the protected folder: { incidents: { [id]: { latest_serial, revoked, revoked_at } } }
 */
export function verifyAuthorization(scope, signed, { publicKeyPem, state, now = new Date() }) {
  const reasons = [];
  if (!signed?.payload || typeof signed.signature !== 'string') return { valid: false, reasons: ['no signed authorization for this scope'] };
  const p = signed.payload;
  if (signed.key_fingerprint !== keyFingerprint(publicKeyPem)) reasons.push('signed with a different key than the protected authority key');
  let sigOk = false;
  try { sigOk = verify(null, Buffer.from(canonical(p)), createPublicKey(publicKeyPem), Buffer.from(signed.signature, 'base64')); } catch { sigOk = false; }
  if (!sigOk) reasons.push('the signature does not match the authorization (forged, altered, or a different key)');
  if (p.policy_version !== AUTH_POLICY_VERSION) reasons.push(`authorization policy version ${p.policy_version} is not ${AUTH_POLICY_VERSION}`);
  if (canonical(authorizationPayload(scope, p.serial)) !== canonical(p)) reasons.push('the scope file no longer says what was signed (targets, actions, disclosures, persistence, expiry or grants were edited)');
  if (!p.expires_at || Number.isNaN(Date.parse(p.expires_at)) || Date.parse(p.expires_at) <= now.getTime()) reasons.push(`the signed authorization expired at ${p.expires_at}`);
  const rec = state?.incidents?.[p.incident_id];
  if (!rec) reasons.push(`the protected state has no record of incident "${p.incident_id}" (it was never approved through the authority)`);
  else {
    if (rec.revoked) reasons.push(`incident "${p.incident_id}" was STOPPED through the protected authority at ${rec.revoked_at}; editing the scope cannot undo that`);
    // Finding 4: the signed serial must EQUAL the committed latest serial. Older = replayed or rolled back; newer = a
    // signature whose state commit never happened (or a forged serial), which must not count either.
    if (!Number.isInteger(rec.latest_serial) || p.serial < rec.latest_serial) reasons.push(`this is an older authorization (serial ${p.serial}; the latest approved is ${rec.latest_serial}): replayed or rolled back`);
    else if (p.serial !== rec.latest_serial) reasons.push(`serial ${p.serial} was never committed to the protected state (latest is ${rec.latest_serial})`);
  }
  return { valid: reasons.length === 0, reasons, serial: p.serial };
}

/** State transitions, applied by the elevated CLI to the protected state file. Pure: they return a new state. */
export function recordApproval(state, incidentId, serial, at = new Date().toISOString()) {
  const rec = state.incidents[incidentId] ?? { latest_serial: 0, revoked: false };
  if (rec.revoked) throw new Error(`incident "${incidentId}" was stopped; start a new incident instead of re-approving it`);
  if (serial <= rec.latest_serial) throw new Error(`serial ${serial} is not newer than ${rec.latest_serial}`);
  return { ...state, incidents: { ...state.incidents, [incidentId]: { ...rec, latest_serial: serial, approved_at: at } } };
}
export function recordStop(state, incidentId, at = new Date().toISOString()) {
  const rec = state.incidents[incidentId] ?? { latest_serial: 0 };
  return { ...state, incidents: { ...state.incidents, [incidentId]: { ...rec, revoked: true, revoked_at: at } } };
}
export const nextSerial = (state, incidentId) => (state.incidents[incidentId]?.latest_serial ?? 0) + 1;

/** Integrity baseline: SHA-256 of each listed toolbox file. Compare later to detect edits (detection, not prevention). */
export function integrityDiff(baseline, current) {
  const changed = [];
  for (const [file, sha] of Object.entries(baseline?.files ?? {})) if (current[file] !== sha) changed.push(current[file] === undefined ? `${file} (missing)` : file);
  for (const file of Object.keys(current)) if (!(file in (baseline?.files ?? {}))) changed.push(`${file} (not in baseline)`);
  return changed;
}
