// Shared helpers for every tool in this toolbox. Importing this file has no side effects and makes no network calls.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { activeScope } from './active_scope.mjs';
import { looksLikeImage, sanitizeImage } from './image_policy.mjs';

export const TOOLBOX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every statement in a ledger or report carries exactly one of these labels.
export const LABELS = Object.freeze([
  'confirmed_observation', // you saw it yourself, with a source and a UTC time
  'source_report',         // someone else reported it (issue text, handoff, CI summary)
  'inference',             // reasoned from evidence, not directly observed
  'hypothesis',            // a candidate explanation still being tested
  'recommendation',        // a suggested action
  'decision',              // an action the user actually chose
]);

export const VERDICTS = Object.freeze([
  'no evidence found',
  'needs review',
  'suspicious indicators',
  'independent evidence of compromise',
]);

export const PAGE_ROLES = Object.freeze(['primary', 'intake', 'source', 'contact']);

export const nowUtc = () => new Date().toISOString();

const SECRET_PATTERNS = [
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Secret-looking URL query parameters and fragments (F07), wherever they appear in text.
  [/([?&](?:[^=&#\s]*(?:token|secret|passw|session|auth)[^=&#\s]*|key|api[-_]?key|apikey|sig|signature|code|otp|x-amz-[^=&#\s]*)=)[^&#\s]*/gi, '$1REDACTED'],
  [/#[^\s#]*?(?:access_token|id_token|token|code|secret)=[^\s]*/gi, '#REDACTED'],
];

/** Mask token-, cookie- and key-shaped strings. A safety net, not a guarantee: still avoid fetching secret-bearing output. */
export function redact(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// Owner's decision (#10, option b): NOTHING is stored unmasked. Same patterns as the output guard, plus credentials
// written into URLs (scheme://user:password@host).
const STORE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const STORE_PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g;
const STORE_URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
export const MASKED_NOTICE = 'MODIFIED EVIDENCE: masked before saving (secrets, credentials and contact details removed). This is not the original.';

/** Mask text for storage: secrets, credentials in URLs, secret URL parameters, email addresses and phone numbers. */
export function maskForStorage(text) {
  return redact(String(text ?? ''))
    .replace(STORE_URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(STORE_EMAIL, '[contact detail removed]')
    .replace(STORE_PHONE, '[contact detail removed]');
}

/** Is this buffer text (strict UTF-8, no NUL bytes)? Anything else is treated as binary. */
export function asText(buf) {
  if (buf.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

/** Metadata blocks still present in a PNG/JPEG (empty array = clean); null when it is not a PNG/JPEG at all. */
export function imageMetadata(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const found = [];
    for (let i = 8; i + 8 <= buf.length;) {
      const len = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString('latin1');
      if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) found.push(type);
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return found;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const found = [];
    for (let i = 2; i + 4 <= buf.length && buf[i] === 0xff;) {
      const m = buf[i + 1];
      if (m === 0xda || m === 0xd9) break;
      if ((m >= 0xe1 && m <= 0xef && m !== 0xe2 && m !== 0xee) || m === 0xfe) found.push(m === 0xfe ? 'COM' : `APP${m - 0xe0}`);
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return found;
  }
  return null;
}

// V6-06: JSON is masked by VALUE after parsing (never by line), so the result stays valid JSON. Values under clearly
// sensitive key names are replaced whole. If nothing needed masking, the original bytes are kept exactly.
const SENSITIVE_KEY = /^(?:[\w-]*[_-])?(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|credentials?)$/i;
function maskJsonValue(v, key) {
  const sensitive = typeof key === 'string' && SENSITIVE_KEY.test(key);
  // v7 review: under a sensitive key EVERYTHING is replaced whole (strings, numbers, objects, arrays); only null and
  // booleans, which cannot carry a secret, are kept.
  if (sensitive && v !== null && typeof v !== 'boolean') return '[REDACTED]';
  if (typeof v === 'string') return maskForStorage(v);
  if (Array.isArray(v)) return v.map((x) => maskJsonValue(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [maskForStorage(k), maskJsonValue(x, k)]));
  return v;
}

/** Mask text for storage: JSON structurally (V6-06), anything else line by line. */
export function maskStoredText(text) {
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      const masked = maskJsonValue(parsed);
      if (JSON.stringify(masked) === JSON.stringify(parsed)) return text; // nothing to mask: keep the exact bytes
      const indent = /\n( +)\S/.exec(text)?.[1].length ?? 0;
      return JSON.stringify(masked, null, indent) + (text.endsWith('\n') ? '\n' : '');
    }
  }
  return maskForStorage(text);
}

/**
 * Prepare content for disk (#10). Text is masked. Binary is refused unless `binary` names a kind the toolbox can
 * actually make safe, and then the stored bytes are REBUILT, never passed through:
 *   'image'       a PNG/JPEG rebuilt by image_policy.sanitizeImage (V6-02: no hidden chunks, segments or trailers)
 *   'case-packet' a stored zip; strictly parsed, every entry validated (text already masked, images already in
 *                 rebuilt form, nothing else), then a FRESH zip is built from those entries (V6-04: comments, extra
 *                 fields, gaps and trailing bytes cannot persist)
 * Archives and every other binary are refused: they cannot be sanitized.
 */
export function prepareForStorage(content, { binary = null } = {}) {
  if (typeof content === 'string') return maskStoredText(content);
  const buf = Buffer.from(content);
  const text = asText(buf);
  if (text !== null) return Buffer.from(maskStoredText(text), 'utf8');
  if (binary === 'image') {
    // Known metadata is still refused outright (the person runs metadata_scrub and sees what was removed); anything
    // else hidden is removed by the strict rebuild.
    const meta = imageMetadata(buf);
    if (meta?.length) throw new Error(`refusing to save: the image still has metadata (${meta.join(', ')}); run metadata_scrub first`);
    try { return sanitizeImage(buf); } catch (e) { throw new Error(`refusing to save: ${e.message}`); }
  }
  if (binary === 'case-packet') {
    const { entries, when } = readStoredZip(buf);
    for (const e of entries) {
      // v7 review: entry NAMES are stored too. A name that masking would change is refused (renaming it would no
      // longer match the packet's manifest).
      if (maskForStorage(e.name) !== e.name) throw new Error(`refusing to save the packet: an entry name contains secret- or contact-shaped text (${maskForStorage(e.name)})`);
      const entryText = asText(e.data);
      let ok;
      if (entryText !== null) ok = maskStoredText(entryText) === entryText;
      else if (looksLikeImage(e.data)) { try { ok = sanitizeImage(e.data).equals(e.data); } catch { ok = false; } }
      else ok = false;
      if (!ok) throw new Error(`refusing to save the packet: entry ${e.name} is not masked (or is an image not in rebuilt form, or other binary)`);
    }
    return zipStore(entries, when); // rebuilt from validated entries only
  }
  throw new Error('refusing to save binary content: it cannot be masked (owner rule: masked copies only; archives and other opaque files are not kept)');
}

function dosTime(d) {
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/** Minimal ZIP writer (stored, no compression, UTF-8 names, no comments or extra fields). */
export function zipStore(entries, when = new Date()) {
  const { time, date } = when instanceof Date ? dosTime(when) : when;
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlibCrc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * STRICT reader for a stored zip such as zipStore's output (V6-04). The structure must be exact: local entries back
 * to back from offset 0, then the central directory, then the end record, and nothing after its comment. Local and
 * central records must agree; no encryption, data descriptors, compression, duplicate or unsafe names; CRCs must
 * match. An archive comment, entry comments and extra fields are allowed only because they are DROPPED: callers
 * rebuild a fresh zip from `entries` (names and data), so no byte outside validated entry data can persist.
 * Returns { entries, when } (when = the first entry's DOS time/date).
 */
export function readStoredZip(buf) {
  const bad = (why) => { throw new Error(`zip refused: ${why}`); };
  if (buf.length < 22) bad('too short');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) bad('no end record that ends exactly at the end of the file (trailing bytes)');
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6)) bad('multi-disk zip');
  const count = buf.readUInt16LE(eocd + 8);
  if (buf.readUInt16LE(eocd + 10) !== count) bad('inconsistent entry counts');
  const cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize !== eocd) bad('central directory does not end at the end record');
  const entries = []; const names = new Set();
  let p = cdOff, expectedLocal = 0, when = null;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) bad('bad central directory record');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if ((flags & ~0x0800) !== 0) bad('unsupported flags (encryption or data descriptor)');
    if (method !== 0 || csize !== usize) bad('compressed entries are not accepted');
    if (off !== expectedLocal) bad('gap or overlap before an entry');
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '') || /[\x00-\x1f]/.test(name)) bad(`unsafe entry name ${JSON.stringify(name)}`);
    if (names.has(name)) bad(`duplicate entry ${name}`);
    names.add(name);
    if (buf.readUInt32LE(off) !== 0x04034b50) bad('bad local header');
    if (buf.readUInt16LE(off + 6) !== flags || buf.readUInt16LE(off + 8) !== 0 || buf.readUInt32LE(off + 14) !== crc
      || buf.readUInt32LE(off + 18) !== csize || buf.readUInt32LE(off + 22) !== usize || buf.readUInt16LE(off + 26) !== nlen
      || !buf.subarray(off + 30, off + 30 + nlen).equals(buf.subarray(p + 46, p + 46 + nlen))) bad('local and central records disagree');
    const start = off + 30 + nlen + buf.readUInt16LE(off + 28); // after the local extra field (dropped)
    if (start + usize > cdOff) bad('entry runs into the central directory');
    const data = buf.subarray(start, start + usize);
    if ((zlibCrc32(data) >>> 0) !== crc) bad(`checksum mismatch in ${name}`);
    entries.push({ name, data });
    when ??= { time, date };
    expectedLocal = start + usize;
    p += 46 + nlen + elen + clen; // central extra field and entry comment: dropped
  }
  if (expectedLocal !== cdOff) bad('bytes between the entries and the central directory');
  if (p !== eocd) bad('bytes inside the central directory');
  return { entries, when: when ?? dosTime(new Date(0)) };
}
const isInside = (root, p) => {
  const rel = relative(root, p);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Refuse if any EXISTING path component between `root` and `abs` (inclusive of abs) is a symlink or junction. */
function assertNoLinks(root, abs) {
  for (let p = abs; p !== root; p = dirname(p)) {
    let st;
    try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) throw new Error(`refusing to write through a link (symlink or junction): ${p}`);
    if (dirname(p) === p) break;
  }
}

/**
 * Write a file, but only inside this toolbox folder, and never silently overwrite.
 * Guards against escaping the folder via "..", absolute paths, and symlinks/junctions inside the folder:
 * link components are refused, the real (link-resolved) parent folder must still be inside the real toolbox
 * folder, and new files are created exclusively ('wx'), so a file cannot be swapped in between check and write.
 * Overwrites (F05) refuse a destination with more than one name (a hardlink can share its contents with a file
 * outside the folder), and never truncate in place: the content goes to a new exclusive temp file beside the
 * destination, which then replaces it by rename. A rename changes only this name, so any other name of the old
 * file keeps its contents, even if a hardlink appeared after the check.
 * `root` exists for tests; tools always use the default.
 */
export function safeWrite(target, rawContent, { overwrite = false, root = TOOLBOX_ROOT, purpose = 'incident', binary = null } = {}) {
  // #10: every write is masked (text) or refused (binary that cannot be made safe) BEFORE anything touches disk,
  // including the temporary file used for overwrites.
  const content = prepareForStorage(rawContent, { binary });
  // F12/V4-02: with an active scope, every write re-reads the scope file first. Incident data needs save_local
  // authorized NOW; safety state (polite counters, robots policies, cool-downs) needs the command's own
  // authorization to still hold. A stop, expiry or revoked save permission blocks the write.
  const ctx = activeScope();
  if (ctx) (purpose === 'safety-state' ? ctx.recheck : (ctx.authorizeSave ?? ctx.recheck))?.();
  const abs = resolve(target);
  if (!isInside(root, abs)) throw new Error(`refusing to write outside the toolbox folder (${root}): ${abs}`);
  assertNoLinks(root, abs);
  if (!overwrite && existsSync(abs)) throw new Error(`refusing to overwrite existing file (pass --overwrite): ${abs}`);
  mkdirSync(dirname(abs), { recursive: true });
  const realRoot = realpathSync.native(root);
  const realParent = realpathSync.native(dirname(abs));
  if (realParent !== realRoot && !isInside(realRoot, realParent)) {
    throw new Error(`refusing to write: the folder really points outside the toolbox (${realParent})`);
  }
  assertNoLinks(root, abs); // re-check immediately before writing to narrow the time-of-check window
  if (!overwrite) { writeFileSync(abs, content, { flag: 'wx' }); verifyWritten(root, abs); return abs; }
  let st = null;
  try { st = lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isFile()) throw new Error(`refusing to overwrite something that is not a regular file: ${abs}`);
  if (st && st.nlink > 1) throw new Error(`refusing to overwrite a file with ${st.nlink} names (hardlinked; another name may be outside the toolbox): ${abs}`);
  const tmp = `${abs}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try { renameSync(tmp, abs); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  verifyWritten(root, abs);
  return abs;
}

/**
 * After-the-fact check for the race the checks above can only narrow: a folder swapped for a link between the check
 * and the write. Confirms where the file REALLY landed (inside the real root, not a link, one name, no link on the
 * path). If not, the file just written is removed and the write is reported as failed. A brief escape is still
 * possible; it can no longer persist or pass silently.
 */
export function verifyWritten(root, abs) {
  const problems = [];
  let real = null;
  try { real = realpathSync.native(abs); } catch (e) { problems.push(`the written file cannot be resolved (${e.code ?? e.message})`); }
  const realRoot = realpathSync.native(root);
  if (real && real !== realRoot && !isInside(realRoot, real)) problems.push(`it really landed at ${real}, outside the toolbox`);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) problems.push('it is a link');
    else if (st.nlink > 1) problems.push(`it has ${st.nlink} names (hardlinked)`);
  } catch { /* already reported as unresolvable */ }
  try { assertNoLinks(root, abs); } catch (e) { problems.push(e.message); }
  if (problems.length) {
    try { rmSync(real ?? abs, { force: true }); } catch { /* reported below either way */ }
    throw new Error(`write verification failed, so the file was removed: ${problems.join('; ')}`);
  }
}

export function fail(message, code = 2) {
  console.error(`error: ${redact(message)}`); // error text can quote URLs and inputs: mask secrets (F07)
  process.exit(code);
}

/** True when the importing module is the script node was launched with. */
export function isMain(meta) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(meta.url);
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
