// Protection check for the authority folder, done by the TOOLBOX before any code from that folder is loaded
// (pre-install review, finding 1: the candidate must never decide its own trust). Read-only Windows queries.
//
// A location counts as protected only if ALL of these were actually read and hold, for the folder AND every file in it
// that the toolbox relies on (finding 2: missing or malformed permission data fails closed):
//   - it exists and is not a link (no reparse point / junction / symlink), and C:\ProgramData is not a link either;
//   - its owner is BUILTIN\Administrators or NT AUTHORITY\SYSTEM;
//   - at least one permission entry was read, every entry is well-formed, and every Allow entry for anyone other than
//     Administrators, SYSTEM or TrustedInstaller is PROVABLY read-only (V6-05: a closed list of read-only rights, and,
//     when the numeric access mask was read, no bit outside the known read bits; empty, numeric or unknown = refused).
// V6-03: the query runs through the pinned PowerShell (system_exec.mjs), never a "powershell.exe" found on PATH.
import { dirname, join } from 'node:path';
import { runPowerShell } from './system_exec.mjs';

export const ADMIN_OWNERS = Object.freeze(['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM']);
export const TRUSTED_WRITERS = Object.freeze(['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM', 'NT SERVICE\\TrustedInstaller']);
export const READ_ONLY_RIGHTS = Object.freeze(['ReadData', 'ListDirectory', 'ReadExtendedAttributes', 'ExecuteFile', 'Traverse',
  'ReadAttributes', 'ReadPermissions', 'Synchronize', 'Read', 'ReadAndExecute']);
// FILE_READ_DATA 0x1, FILE_READ_EA 0x8, FILE_EXECUTE 0x20, FILE_READ_ATTRIBUTES 0x80, READ_CONTROL 0x20000,
// SYNCHRONIZE 0x100000, GENERIC_EXECUTE 0x20000000, GENERIC_READ 0x80000000. Anything else counts as write-capable.
const READ_BITS = 0x1 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000 | 0x20000000 | 0x80000000;

/** Pure: is this rights record provably read-only? Fails closed on anything empty, numeric, unknown or inconsistent. */
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

/** Pure: why one location's permission record is NOT admin-only. Empty array = protected. Fails closed. */
export function aclProblems(acl, label = 'location') {
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

const SCRIPT = (paths) => [
  "$ErrorActionPreference = 'Stop'",
  `$paths = @(${paths.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ')})`,
  '$out = @{}',
  'foreach ($p in $paths) {',
  '  if (-not (Test-Path -LiteralPath $p)) { $out[$p] = @{ exists = $false }; continue }',
  '  $i = Get-Item -LiteralPath $p -Force',
  '  $a = Get-Acl -LiteralPath $p',
  '  $out[$p] = @{ exists = $true; reparse = [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); owner = [string]$a.Owner',
  '    aces = @($a.Access | ForEach-Object { @{ identity = [string]$_.IdentityReference; rights = [string]$_.FileSystemRights; mask = [int64]$_.FileSystemRights.value__; type = [string]$_.AccessControlType } }) }',
  '}',
  '$out | ConvertTo-Json -Depth 5',
].join('\n');

/** Read owner, permissions (names and numeric mask) and link status for each path, with the pinned PowerShell. */
export function readAcls(paths, { run } = {}) {
  return JSON.parse(runPowerShell(SCRIPT(paths), run ? { run } : {}));
}

/** Everything that must be protected for the authority at `dir`: C:\ProgramData's link status, the folder, each file. */
export function authorityProtection(dir, files, { read = readAcls } = {}) {
  const parent = dirname(dir);
  const targets = [dir, ...files.map((f) => join(dir, f))];
  let acls;
  try { acls = read([parent, ...targets]); } catch (e) { return [`permission details could not be read: ${e.message}`]; }
  const problems = [];
  const parentRec = acls?.[parent];
  if (!parentRec || parentRec.exists !== true || parentRec.reparse !== false) problems.push(`${parent}: missing, a link, or unreadable`);
  for (const t of targets) problems.push(...aclProblems(acls?.[t], t));
  return problems;
}
