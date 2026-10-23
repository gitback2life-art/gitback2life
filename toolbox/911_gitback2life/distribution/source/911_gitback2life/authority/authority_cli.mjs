#!/usr/bin/env node
// gitback2life protected authority: run by the OWNER, from the admin-only install folder (see install.ps1).
//
//   init                      create the signing key (asks for a new passphrase twice)          [elevated]
//   approve <scope.json>      sign the scope's complete authorization (asks to confirm, then the passphrase)  [elevated]
//   stop <incident_id>        record a protected stop: no edit of the scope can undo it          [elevated]
//   baseline <toolbox folder> record SHA-256 of the toolbox's source files                       [elevated]
//   verify <scope.json>       check a scope against its signed authorization and the protected state
//   verify -                  the same, for the exact scope BYTES given on standard input (used by the Python tools)
//   check-integrity <toolbox folder>   compare the toolbox's files with the protected baseline
//   check-protection          is this folder really admin-only?
//
// The passphrase is read ONLY from an interactive console, without echo. It is never accepted as an argument,
// an environment variable or a file, and never written anywhere. Changing commands refuse to run unless elevated
// AND running from a folder that only administrators can modify.
//
// v6 review: signed authorizations are stored INSIDE this protected folder (authorizations\<incident>.json), never
// written by this elevated process into a user-writable folder; initialization is exclusive and all-or-nothing;
// PowerShell is launched from its fixed system path with a constructed environment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthorityKey, integrityDiff, nextSerial, recordApproval, recordStop, signAuthorization, verifyAuthorization, emptyState, authorizationPayload,
} from './authority_core.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FILES = Object.freeze({ publicKey: 'public_key.pem', privateKey: 'private_key.enc.json', state: 'state.json', authorizations: 'authorizations' });

// ---- Pinned system PowerShell (V6-03). Same rules as the toolbox's _shared/system_exec.mjs. ----
const WINDOWS_DIR = 'C:\\Windows';
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const trustedEnv = () => ({
  SystemRoot: WINDOWS_DIR, windir: WINDOWS_DIR, SystemDrive: 'C:',
  PATH: `${WINDOWS_DIR}\\System32;${WINDOWS_DIR};${WINDOWS_DIR}\\System32\\WindowsPowerShell\\v1.0`,
  PSModulePath: `${WINDOWS_DIR}\\System32\\WindowsPowerShell\\v1.0\\Modules`, TEMP: `${WINDOWS_DIR}\\Temp`, TMP: `${WINDOWS_DIR}\\Temp`,
});
function runPowerShell(script, { run = execFileSync } = {}) {
  if (run === execFileSync && !existsSync(POWERSHELL)) throw new Error(`the system PowerShell was not found at ${POWERSHELL}`);
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000, env: trustedEnv(), cwd: `${WINDOWS_DIR}\\System32`, windowsHide: true });
}

// ---- Protection rules: the same as the toolbox's _shared/acl_check.mjs (a test proves both agree). This file cannot
// import toolbox code: the toolbox is editable by the normal account, this folder is not. ----
const ADMIN_OWNERS = ['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM'];
const TRUSTED_WRITERS = ['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM', 'NT SERVICE\\TrustedInstaller'];
const READ_ONLY_RIGHTS = ['ReadData', 'ListDirectory', 'ReadExtendedAttributes', 'ExecuteFile', 'Traverse', 'ReadAttributes', 'ReadPermissions', 'Synchronize', 'Read', 'ReadAndExecute'];
const READ_BITS = 0x1 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000 | 0x20000000 | 0x80000000;

export function rightsAreReadOnly(rights, mask) {
  if (typeof rights !== 'string') return false;
  const tokens = rights.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => READ_ONLY_RIGHTS.includes(t))) return false;
  if (mask !== undefined && mask !== null) {
    if (!Number.isInteger(mask) || mask < 0) return false;
    if (Number(BigInt(mask) & ~BigInt(READ_BITS) & 0xffffffffn) !== 0) return false;
  }
  return true;
}

/** Pure: why one location's permission record is NOT admin-only. Empty array = protected. Missing data fails closed. */
export function protectionProblems(acl, label = 'location') {
  if (!acl || typeof acl !== 'object') return [`${label}: permission details could not be read`];
  const p = [];
  if (acl.exists !== true) return [`${label}: missing`];
  if (acl.reparse !== false) p.push(`${label}: ${acl.reparse === true ? 'is a link (reparse point)' : 'link status could not be read'}`);
  if (typeof acl.owner !== 'string' || !acl.owner) p.push(`${label}: owner could not be read`);
  else if (!ADMIN_OWNERS.includes(acl.owner)) p.push(`${label}: owner is ${acl.owner}, not Administrators or SYSTEM`);
  if (!Array.isArray(acl.aces) || acl.aces.length === 0) p.push(`${label}: no permission entries could be read`);
  else {
    for (const ace of acl.aces) {
      if (!ace || typeof ace.identity !== 'string' || !ace.identity || typeof ace.rights !== 'string' || !['Allow', 'Deny'].includes(ace.type)) {
        p.push(`${label}: a permission entry could not be read`); continue;
      }
      if (ace.type === 'Allow' && !TRUSTED_WRITERS.includes(ace.identity) && !rightsAreReadOnly(ace.rights, ace.mask)) {
        p.push(`${label}: ${ace.identity} has rights that are not provably read-only (${ace.rights || 'empty'}${ace.mask !== undefined ? `, mask ${ace.mask}` : ''})`);
      }
    }
  }
  return p;
}

const ACL_SCRIPT = (paths) => [
  "$ErrorActionPreference = 'Stop'",
  `$paths = @(${paths.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ')})`,
  '$out = @{}',
  'foreach ($p in $paths) {',
  '  if (-not (Test-Path -LiteralPath $p)) { $out[$p] = @{ exists = $false }; continue }',
  '  $i = Get-Item -LiteralPath $p -Force; $a = Get-Acl -LiteralPath $p',
  '  $out[$p] = @{ exists = $true; reparse = [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); owner = [string]$a.Owner',
  '    aces = @($a.Access | ForEach-Object { @{ identity = [string]$_.IdentityReference; rights = [string]$_.FileSystemRights; mask = [int64]$_.FileSystemRights.value__; type = [string]$_.AccessControlType } }) }',
  '}',
  '$out | ConvertTo-Json -Depth 5',
].join('\n');

export function readAcls(paths, { run } = {}) { return JSON.parse(runPowerShell(ACL_SCRIPT(paths), run ? { run } : {})); }

/** Problems with this folder and each listed item (items that do not exist yet are skipped only when `optional`). */
export function folderProblems(dir, items, { optional = [], read = readAcls } = {}) {
  const targets = [dir, ...items.map((f) => join(dir, f))];
  let acls;
  try { acls = read(targets); } catch (e) { return [`permission details could not be read: ${e.message}`]; }
  return targets.flatMap((t) => (optional.includes(t.slice(dir.length + 1)) && acls?.[t]?.exists === false ? [] : protectionProblems(acls?.[t], t)));
}

function isElevated() {
  try {
    return runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)').trim() === 'True';
  } catch { return false; }
}

const ALL_ITEMS = ['authority_core.mjs', 'authority_cli.mjs', FILES.publicKey, FILES.privateKey, FILES.state, FILES.authorizations];
function requireProtectedElevated({ beforeInit = false } = {}) {
  if (process.platform !== 'win32') throw new Error('the protected authority runs on Windows only');
  if (!isElevated()) throw new Error('this command changes protected data: run it from an Administrator terminal (UAC)');
  const problems = folderProblems(HERE, ALL_ITEMS, { optional: beforeInit ? [FILES.publicKey, FILES.privateKey, FILES.state, FILES.authorizations] : [] });
  if (problems.length) throw new Error(`refusing: this folder is not admin-only (${problems.join('; ')}). Install with install.ps1.`);
}

/** Read a secret from the console without echo. Interactive consoles only; nothing is logged or stored. */
function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('the passphrase can only be typed at an interactive console');
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); if (err) reject(err); else resolvePromise(value); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function readLine(prompt) {
  if (!process.stdin.isTTY) throw new Error('confirmation must be typed at an interactive console');
  process.stdout.write(prompt);
  return new Promise((r) => { process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.once('data', (d) => { process.stdin.pause(); r(String(d).trim()); }); });
}

/** Write a file inside `dir` atomically: exclusive temp file, then rename over the target (both inside the folder). */
function writeInside(dir, name, text) {
  const target = join(dir, name), tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx' });
  try { renameSync(tmp, target); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Where an incident's signed authorization lives: inside the protected folder. Unsafe incident ids are refused. */
export function authorizationFile(dir, incidentId) {
  if (typeof incidentId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(incidentId) || /^\.+$/.test(incidentId)) {
    throw new Error(`incident id "${incidentId}" cannot be used as a file name (letters, digits, . _ - only)`);
  }
  return join(dir, FILES.authorizations, `${incidentId}.json`);
}

/**
 * Initialize (review: provisioning lifecycle). Exclusive: an init lock is created first, and if ANY of the key, the
 * state or the authorizations folder already exists (an earlier init, or a crashed one), nothing is written. Each
 * file is written atomically; the state is written last, so a crash leaves no state file and init can be redone
 * only after the owner removes the partial files.
 */
export function initializeAuthority(dir, passphrase) {
  const lock = join(dir, 'init.lock');
  try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`another initialization is in progress (or one crashed): ${lock} exists. Check, then delete it as Administrator.`);
    throw e;
  }
  try {
    const present = [FILES.publicKey, FILES.privateKey, FILES.state, FILES.authorizations].filter((f) => existsSync(join(dir, f)));
    if (present.length) throw new Error(`already initialised, or an earlier initialization did not finish (present: ${present.join(', ')}). Nothing was changed; inspect and remove partial files as Administrator.`);
    const k = generateAuthorityKey(passphrase);
    writeInside(dir, FILES.privateKey, JSON.stringify(k.encryptedPrivateKey, null, 2) + '\n');
    writeInside(dir, FILES.publicKey, k.publicKeyPem);
    mkdirSync(join(dir, FILES.authorizations));
    writeInside(dir, FILES.state, JSON.stringify(emptyState(), null, 2) + '\n');
    return k.encryptedPrivateKey.fingerprint;
  } finally { rmSync(lock, { force: true }); }
}

/**
 * Pre-install review, finding 4: every change to the protected state happens under ONE lock, reads the state FRESH
 * inside the lock, and writes it back before releasing. `mutate(fresh)` returns the new state or throws (nothing is
 * written). `afterCommit(next)` runs while the lock is still held. A second change while one is in progress is
 * refused, never interleaved. A leftover lock (a crashed session) is not taken over automatically.
 */
export function transactState(dir, mutate, afterCommit = null) {
  const lock = join(dir, 'state.lock');
  try { writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`another authority change is in progress (or a previous one crashed): ${lock} exists. Check, then delete it as Administrator.`);
    throw e;
  }
  try {
    const fresh = JSON.parse(readFileSync(join(dir, FILES.state), 'utf8'));
    const next = mutate(fresh);
    writeInside(dir, FILES.state, JSON.stringify(next, null, 2) + '\n');
    afterCommit?.(next);
    return next;
  } finally { rmSync(lock, { force: true }); }
}

/**
 * Commit an approval. Inside the state lock: the FRESH state must show the incident not stopped and the same next
 * serial the owner was shown; then sign, commit the state, and write the signed authorization INSIDE the protected
 * folder (never to a user-writable path). If anything changed while the owner was typing, nothing is signed.
 */
export function commitApproval(dir, scope, { expectedSerial, keys, passphrase }) {
  const file = authorizationFile(dir, scope.incident_id);
  let signed = null;
  transactState(dir, (fresh) => {
    if (fresh.incidents?.[scope.incident_id]?.revoked) throw new Error(`incident "${scope.incident_id}" was stopped while you were approving; nothing was signed`);
    const serial = nextSerial(fresh, scope.incident_id);
    if (serial !== expectedSerial) throw new Error(`the protected state changed while you were approving (next serial is now ${serial}, you were shown ${expectedSerial}); nothing was signed. Run approve again.`);
    signed = signAuthorization(scope, { ...keys, passphrase, serial });
    return recordApproval(fresh, scope.incident_id, serial);
  }, () => {
    const folder = join(dir, FILES.authorizations);
    if (lstatSync(folder).isSymbolicLink()) throw new Error('the authorizations folder is a link; refusing');
    writeInside(folder, `${scope.incident_id}.json`, JSON.stringify(signed, null, 2) + '\n');
  });
  return { signed, file };
}

/** Commit a stop: applied to the FRESH state inside the lock, so it cannot be lost to a stale writer. */
export const commitStop = (dir, incidentId) => transactState(dir, (fresh) => recordStop(fresh, incidentId));

/** Verify scope BYTES (exactly the bytes the caller decided on) against the protected key, authorization and state. */
export function verifyScopeBytes(dir, bytes, { now = new Date() } = {}) {
  let scope;
  try { scope = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return { valid: false, reasons: ['the scope is not valid JSON'] }; }
  let signed = null;
  try { signed = JSON.parse(readFileSync(authorizationFile(dir, scope?.incident_id), 'utf8')); } catch { /* reported as missing */ }
  let publicKeyPem, state;
  try { publicKeyPem = readFileSync(join(dir, FILES.publicKey), 'utf8'); state = JSON.parse(readFileSync(join(dir, FILES.state), 'utf8')); }
  catch (e) { return { valid: false, reasons: [`the protected authority is not initialised (${e.code ?? e.message})`] }; }
  return verifyAuthorization(scope, signed, { publicKeyPem, state, now });
}

const SOURCE = /\.(mjs|py|json|ps1|md)$/;
const SKIP = new Set(['.test_tmp', '.polite_cache', 'generated', '_review_bundles', 'node_modules', '__pycache__', 'packets', 'snapshots', 'cleaned', 'baselines']);
/** SHA-256 of every toolbox source file (relative path → hash). */
export function hashToolbox(root) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const abs = join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs); } else if (SOURCE.test(e.name)) out[relative(root, abs).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  } };
  walk(resolve(root));
  return out;
}

const readStdin = () => new Promise((r) => { const parts = []; process.stdin.on('data', (c) => parts.push(c)).on('end', () => r(Buffer.concat(parts))); });

export async function main(argv) {
  const [cmd, arg] = argv;
  if (argv.some((a) => /pass(word|phrase)/i.test(a))) throw new Error('the passphrase is never accepted on the command line; it is typed at the prompt');
  if (cmd === 'check-protection') {
    const problems = folderProblems(HERE, ALL_ITEMS);
    console.log(problems.length ? `NOT protected:\n  - ${problems.join('\n  - ')}` : `protected: ${HERE} is admin-only`);
    process.exitCode = problems.length ? 1 : 0;
  } else if (cmd === 'init') {
    requireProtectedElevated({ beforeInit: true });
    const a = await readHidden('New passphrase (at least 12 characters, not shown): ');
    const b = await readHidden('Type it again: ');
    if (a !== b) throw new Error('the two passphrases differ; nothing was created');
    const fp = initializeAuthority(HERE, a);
    console.log(`authority key created (fingerprint ${fp.slice(0, 16)}…). Keep the passphrase safe: it cannot be recovered.`);
  } else if (cmd === 'approve') {
    requireProtectedElevated();
    const scope = JSON.parse(readFileSync(resolve(arg ?? ''), 'utf8'));
    authorizationFile(HERE, scope.incident_id); // refuse unsafe ids before asking anything
    const serial = nextSerial(JSON.parse(readFileSync(join(HERE, FILES.state), 'utf8')), scope.incident_id);
    console.log('You are approving EXACTLY this authorization:\n' + JSON.stringify(authorizationPayload(scope, serial), null, 2));
    if ((await readLine(`Type the incident id (${scope.incident_id}) to approve it: `)) !== scope.incident_id) throw new Error('not confirmed; nothing was signed');
    const passphrase = await readHidden('Passphrase (not shown): ');
    const keys = { publicKeyPem: readFileSync(join(HERE, FILES.publicKey), 'utf8'), encryptedPrivateKey: JSON.parse(readFileSync(join(HERE, FILES.privateKey), 'utf8')) };
    const { file } = commitApproval(HERE, scope, { expectedSerial: serial, keys, passphrase });
    console.log(`signed serial ${serial} for incident "${scope.incident_id}"; stored in the protected folder: ${file}`);
  } else if (cmd === 'stop') {
    requireProtectedElevated();
    if (!arg) throw new Error('usage: stop <incident_id>');
    if ((await readLine(`Type the incident id (${arg}) again to stop it permanently: `)) !== arg) throw new Error('not confirmed; nothing was stopped');
    commitStop(HERE, arg);
    console.log(`incident "${arg}" is stopped in the protected state. Editing the scope file cannot undo this.`);
  } else if (cmd === 'baseline') {
    requireProtectedElevated();
    const files = hashToolbox(arg ?? '.');
    transactState(HERE, (fresh) => ({ ...fresh, baseline: { created_at: new Date().toISOString(), root: resolve(arg ?? '.'), files } }));
    console.log(`baseline recorded: ${Object.keys(files).length} files`);
  } else if (cmd === 'check-integrity') {
    const changed = integrityDiff(JSON.parse(readFileSync(join(HERE, FILES.state), 'utf8')).baseline, hashToolbox(arg ?? '.'));
    console.log(changed.length ? `CHANGED since the protected baseline:\n  - ${changed.join('\n  - ')}` : 'unchanged since the protected baseline');
    process.exitCode = changed.length ? 1 : 0;
  } else if (cmd === 'verify') {
    const bytes = arg === '-' ? await readStdin() : readFileSync(resolve(arg ?? ''));
    const r = verifyScopeBytes(HERE, bytes);
    console.log(r.valid ? `VALID (serial ${r.serial})` : `NOT VALID:\n  - ${r.reasons.join('\n  - ')}`);
    process.exitCode = r.valid ? 0 : 1;
  } else {
    console.log('usage: authority_cli.mjs init | approve <scope.json> | stop <incident_id> | baseline <toolbox> | verify <scope.json>|- | check-integrity <toolbox> | check-protection');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(2); });
}
