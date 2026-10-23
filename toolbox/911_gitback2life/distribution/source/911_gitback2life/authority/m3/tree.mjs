// M3 (design revision 3.4, §§7, 11, 12): restore TREES on the simulated disk. Pure helpers used by the M1 engine's
// state machine (no parallel state machine): validation, the canonical listing and tree hash, the manifest, and the
// folder moves. A tree is create-only: restores/<approval_id>/, published by renaming a temporary folder.
// Prototype only; NOT installed.
import { createHash } from 'node:crypto';
import { checkName } from '../g0a/request_pipe.mjs';
import { canonical } from '../m1/ledger.mjs';

export const MANIFEST = 'RESTORE_MANIFEST.json';
export const TREE_LIMITS = Object.freeze({ files: 1000, file: 10 * 1024 * 1024, total: 100 * 1024 * 1024 });
export class TreeRefused extends Error { constructor(m) { super(`restore refused: ${m}`); this.tree = true; } }
const fail = (m) => { throw new TreeRefused(m); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

export const isTreeKey = (key) => key.startsWith('restores/');
export const finalKey = (id) => `restores/${id}`;
export const tmpKey = (id) => `restores/.tmp-${id}`;
export const cancelKey = (id) => `restores/.cancel-${id}`;

/**
 * Validate the files of a restore (Map relpath → Buffer) and return the canonical listing, sorted by relpath:
 * [{ relpath, sha256, size }]. Text only (strict UTF-8, no NUL), path rules of §14.3 (lowercase ASCII segments,
 * depth, length, device names, trailing dots), no duplicates or file/folder prefix collisions, reserved manifest
 * name, count and size limits.
 */
export function validateTreeFiles(files) {
  if (!(files instanceof Map) || files.size === 0) fail('a restore needs at least one file');
  if (files.size > TREE_LIMITS.files) fail(`more than ${TREE_LIMITS.files} files`);
  let total = 0;
  const names = new Set(), dirs = new Set(), listing = [];
  for (const [rel, bytes] of files) {
    try { checkName(`files/${rel}`); } catch (e) { fail(e.message.replace(/^request refused: /, '')); }
    if (rel === MANIFEST.toLowerCase()) fail(`${MANIFEST} is reserved`);
    if (!Buffer.isBuffer(bytes) || bytes.length > TREE_LIMITS.file) fail(`${rel}: larger than ${TREE_LIMITS.file} bytes`);
    total += bytes.length;
    if (total > TREE_LIMITS.total) fail(`more than ${TREE_LIMITS.total} bytes in total`);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(`${rel}: not UTF-8 text (binary content is not accepted)`); }
    if (bytes.includes(0)) fail(`${rel}: contains NUL (binary content is not accepted)`);
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) { if (names.has(parts.slice(0, i).join('/'))) fail(`${rel} collides with a file used as a folder`); dirs.add(parts.slice(0, i).join('/')); }
    if (names.has(rel) || dirs.has(rel)) fail(`duplicate or colliding entry ${rel}`);
    names.add(rel);
    listing.push({ relpath: rel, sha256: sha(bytes), size: bytes.length });
  }
  for (const rel of names) if (dirs.has(rel)) fail(`${rel} collides with a file used as a folder`);
  return listing.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
}

export const treeHash = (listing) => sha(canonical(listing));
export const listingOf = (files) => validateTreeFiles(files);
export const manifestBytes = (approvalId, listing) => Buffer.from(`${canonical({ approval_id: approvalId, files: listing, tree_sha256: treeHash(listing) })}\n`, 'utf8');

/** Files under a folder key on the simulated disk: Map(relpath → {bytes, id}). */
export function members(disk, dirKey) {
  const out = new Map(), prefix = `${dirKey}/`;
  for (const [k, f] of disk.files) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), f);
  return out;
}

/** The observable state of a tree folder: { sha: tree hash of its members except the manifest, id: folder id }. */
export function treeState(disk, dirKey) {
  const dir = disk.dirs?.get(dirKey);
  if (!dir) return { sha: null, id: null };
  const m = members(disk, dirKey);
  const listing = [...m].filter(([rel]) => rel !== MANIFEST).map(([relpath, f]) => ({ relpath, sha256: sha(f.bytes), size: f.bytes.length }))
    .sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  return { sha: treeHash(listing), id: dir.id };
}

/**
 * Compare a folder's contents with the signed listing. Returns { complete, missing, problem }: `problem` names an
 * unlisted entry or a listed file at the wrong hash (never acceptable); `missing` lists listed files not present.
 */
export function compareMembership(disk, dirKey, listing, approvalId) {
  const m = members(disk, dirKey), want = new Map(listing.map((f) => [f.relpath, f.sha256]));
  const manifest = manifestBytes(approvalId, listing);
  let problem = null;
  for (const [rel, f] of m) {
    if (rel === MANIFEST) { if (!f.bytes.equals(manifest)) problem ??= 'the manifest does not match the signed listing'; continue; }
    if (!want.has(rel)) problem ??= `unlisted entry ${rel}`;
    else if (sha(f.bytes) !== want.get(rel)) problem ??= `${rel} is at the wrong hash`;
  }
  const missing = [...want.keys()].filter((rel) => !m.has(rel));
  return { complete: !problem && missing.length === 0 && m.has(MANIFEST), missing, hasManifest: m.has(MANIFEST), problem };
}

/** Atomic folder move on the simulated disk (one rename): the folder id travels with it. Refuses an existing target. */
export function renameDir(disk, from, to) {
  if (!disk.dirs.has(from)) fail(`no folder ${from}`);
  if (disk.dirs.has(to)) fail(`folder ${to} already exists`);
  if (disk.renameDir) return disk.renameDir(from, to); // real filesystem: one folder rename
  const moved = [...members(disk, from)];
  for (const [rel] of moved) disk.files.delete(`${from}/${rel}`);
  for (const [rel, f] of moved) disk.files.set(`${to}/${rel}`, f);
  disk.dirs.set(to, disk.dirs.get(from));
  disk.dirs.delete(from);
}
