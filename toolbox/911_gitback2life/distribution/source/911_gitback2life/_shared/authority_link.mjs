// Link from the toolbox to the PROTECTED authority (F01). When the admin-only authority folder exists, every scoped
// command must have a valid signed authorization; the verifier code, the public key, the signed authorizations and the
// stop/serial state are all read from that folder, not from this (editable) toolbox.
//
// Pre-install review, finding 1: the folder's protection is checked by THIS toolbox (acl_check.mjs) BEFORE any code
// in it is loaded, for the folder and every item used. Nothing from the candidate folder runs until that check passes.
// V6-07: detection never silently downgrades. Only a genuinely ABSENT path (ENOENT) means "not installed", and
// absence is never cached (an authority that appears is noticed at the next check). Anything else at that path (a
// regular file, a link, a dangling link, an unreadable entry) is refused: fail closed. Only a trusted result is cached.
// When nothing exists, the toolbox falls back to operator attestations (F01 PARTIAL) and says so.
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { authorityProtection } from './acl_check.mjs';

export const AUTHORITY_DIR = 'C:\\ProgramData\\gitback2life-authority';
/** Every item the toolbox relies on. Each must itself be admin-only (a protected folder alone is not enough). */
export const AUTHORITY_FILES = Object.freeze(['authority_core.mjs', 'authority_cli.mjs', 'public_key.pem', 'state.json', 'authorizations']);
let config = { dir: AUTHORITY_DIR, checkAcl: true, readAcls: undefined };
let trustedCache = null;

/** Tests only: point at a temporary authority folder; optionally skip or fake the Windows ACL query. Never used by tools. */
export function _setAuthorityForTests(dir, { checkAcl = false, readAcls } = {}) { config = { dir, checkAcl, readAcls }; trustedCache = null; }
export function _resetAuthority() { config = { dir: AUTHORITY_DIR, checkAcl: true, readAcls: undefined }; trustedCache = null; }

/** { installed:false } | { installed:true, trusted:false, problems } | { installed:true, trusted:true, core, dir } */
export function authorityStatus() {
  if (trustedCache) return trustedCache;
  const { dir, checkAcl, readAcls } = config;
  let st;
  try { st = lstatSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return { installed: false }; // genuinely absent; NOT cached
    return { installed: true, trusted: false, problems: [`${dir} could not be examined (${e.code ?? e.message})`] };
  }
  if (st.isSymbolicLink()) return { installed: true, trusted: false, problems: [`${dir} is a link`] };
  if (!st.isDirectory()) return { installed: true, trusted: false, problems: [`${dir} exists but is not a folder`] };
  if (checkAcl) {
    const problems = authorityProtection(dir, AUTHORITY_FILES, readAcls ? { read: readAcls } : undefined);
    if (problems.length) return { installed: true, trusted: false, problems };
  }
  // Only now, after the toolbox's own check passed, is the verifier code loaded.
  try {
    return (trustedCache = { installed: true, trusted: true, core: createRequire(import.meta.url)(join(dir, 'authority_core.mjs')), dir });
  } catch (e) {
    return { installed: true, trusted: false, problems: [`the authority could not be loaded: ${e.message}`] };
  }
}

/** The signed authorization for an incident, from INSIDE the protected folder (never a sidecar beside the scope). */
function readAuthorization(dir, incidentId) {
  if (typeof incidentId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(incidentId) || /^\.+$/.test(incidentId)) return null;
  const file = join(dir, 'authorizations', `${incidentId}.json`);
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

/**
 * Check a scope OBJECT (exactly the one the caller decided on) against the protected authority. Returns
 * { required:false } when nothing is installed; otherwise { required:true, valid, reasons, serial }. Reads the protected
 * state fresh on every call, so a protected stop takes effect at the next request or save.
 */
export function checkAuthority(scopePath, scope) {
  const s = authorityStatus();
  if (!s.installed) return { required: false };
  if (!s.trusted) return { required: true, valid: false, reasons: [`the protected authority folder is not trustworthy: ${s.problems.join('; ')}`] };
  let publicKeyPem, state;
  try {
    publicKeyPem = readFileSync(join(s.dir, 'public_key.pem'), 'utf8');
    state = JSON.parse(readFileSync(join(s.dir, 'state.json'), 'utf8'));
  } catch (e) { return { required: true, valid: false, reasons: [`the protected authority is not initialised (${e.code ?? e.message})`] }; }
  return { required: true, ...s.core.verifyAuthorization(scope, readAuthorization(s.dir, scope?.incident_id), { publicKeyPem, state }) };
}
