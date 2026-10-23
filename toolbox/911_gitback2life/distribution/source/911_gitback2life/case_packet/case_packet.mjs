#!/usr/bin/env node
// case_packet: bundle the decision summary, the evidence ledger and chosen evidence files into ONE zip with a
// SHA-256 manifest, ready to hand to an organization. Offline; never uploads or sends anything.
// Refuses images that still carry hidden metadata, and any file containing secrets or contact details.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { asText, fail, isMain, maskForStorage, maskStoredText, MASKED_NOTICE, nowUtc, redact, safeWrite, TOOLBOX_ROOT, zipStore } from '../_shared/common.mjs';
import { sanitizeImage } from '../_shared/image_policy.mjs';
import { sanitizeUrl, SHARING_CHECKLIST } from '../_shared/output.mjs';
import { requireSameIncident, requireScope } from '../_shared/scope.mjs';
import { renderSummary } from '../decision_summary/decision_summary.mjs';
import { validateLedger } from '../evidence_ledger/ledger.mjs';

export const OUT_DIR = join(TOOLBOX_ROOT, 'case_packet', 'packets');
const ALLOWED = new Set(['.md', '.txt', '.json', '.csv', '.png', '.jpg', '.jpeg']);
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE = /(?<!\d)(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/;

/** Does this image still carry metadata metadata_scrub would remove? (JPEG APP1/APP3-13/APP15/COM; PNG text/EXIF/time) */
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
  return null; // not an image we understand
}

// F09: content that becomes ACTIVE when a viewer renders the file. Markdown: HTML, images (a remote image is a
// tracking request), and link targets other than http(s)/mailto/#. CSV: cells a spreadsheet runs as formulas.
const ACTIVE_MARKDOWN = [
  [/<\/?[a-z][a-z0-9-]*(?=[\s>/])|<!--/i, 'HTML tags or comments'],
  [/!\[[^\]]*\]\s*[[(]/, 'an image (a remote image is fetched by the viewer and can track who opened it)'],
  [/\]\s*\(\s*<?\s*(?!https?:|mailto:|#)[a-z][a-z0-9+.-]*:/i, 'a link that is not an ordinary web address (javascript:, data:, file: ...)'],
  [/^\s{0,3}\[[^\]]+\]:\s*<?\s*(?!https?:|mailto:|#)[a-z][a-z0-9+.-]*:/im, 'a link definition that is not an ordinary web address'],
  [/<(?!https?:|mailto:)[a-z][a-z0-9+.-]*:[^>\s]*>/i, 'an autolink that is not an ordinary web address'],
];
const CSV_FORMULA = /(^|[,;\t\n])[ \t]*"?(?:[=+@]|-(?![\d.,;\s]|$))/m;

/** Active-content problems for a rendered text format (empty array = inert). */
export function activeContent(ext, text) {
  if (ext === '.md') return ACTIVE_MARKDOWN.filter(([re]) => re.test(text)).map(([, what]) => what);
  if (ext === '.csv') return CSV_FORMULA.test(text) ? ['cells starting with = + - or @, which spreadsheet apps run as formulas'] : [];
  return [];
}

/** Reasons a file may not go into a packet (empty array = OK). */
export function fileProblems(name, buf) {
  const ext = extname(name).toLowerCase();
  const problems = [];
  if (!ALLOWED.has(ext)) problems.push(`file type ${ext || '(none)'} is not allowed (${[...ALLOWED].join(' ')})`);
  if (maskForStorage(name) !== name) problems.push('the file NAME contains something that looks like a secret or contact detail; rename it');
  if (buf.length > MAX_FILE) problems.push('larger than 10 MB');
  if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const meta = imageMetadata(buf);
    if (meta === null) problems.push('not a readable PNG/JPEG');
    else if (meta.length) problems.push(`image still contains hidden metadata (${meta.join(', ')}); run metadata_scrub first`);
    else { try { sanitizeImage(buf); } catch (e) { problems.push(`${e.message} (strict image check: no unknown chunks, trailers or malformed data)`); } }
  } else if (ALLOWED.has(ext)) {
    const text = buf.toString('utf8');
    if (redact(text) !== text) problems.push('contains something that looks like a secret (token, key, cookie)');
    if (EMAIL.test(text) || PHONE.test(text)) problems.push('contains an email address or phone number; record roles instead');
    const secretLinks = [...text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)].filter((m) => { try { return sanitizeUrl(m[0]) !== new URL(m[0]).href; } catch { return false; } });
    if (secretLinks.length) problems.push('contains a link with credentials or a secret-looking parameter (token, key, session, signature...)');
    const active = activeContent(ext, text);
    if (active.length) problems.push(`contains content that becomes active when the file is viewed: ${active.join('; ')}. To keep it as evidence, rename it to .txt (same bytes and SHA-256, shown as plain text)`);
  }
  return problems;
}

// The zip writer now lives in _shared/common.mjs (V6-04: the storage check rebuilds packets with it).
export { zipStore };

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function buildPacket(ledger, includes = [], { now = nowUtc(), humanReviewed = false } = {}) {
  // Patterns cannot find names, home addresses or text visible inside images. A person must confirm they checked.
  if (!humanReviewed) throw new Error('a person must review the packet contents for personal information first (names, addresses, faces or readable text in images), then pass --reviewed-for-personal-info');
  const errors = validateLedger(ledger);
  if (errors.length) throw new Error(`ledger is invalid:\n  ${errors.join('\n  ')}`);
  const entries = [
    { name: 'summary.md', data: Buffer.from(renderSummary(ledger), 'utf8') },
    { name: 'ledger.json', data: Buffer.from(JSON.stringify(ledger, null, 2) + '\n', 'utf8') },
  ];
  const refused = [];
  for (const { name, data } of [...entries.splice(0), ...includes.map((f) => ({ name: `evidence/${f.name}`, data: f.data }))]) {
    const problems = fileProblems(name, data);
    if (problems.length) { refused.push({ name, problems }); continue; }
    // #10/V6-02/V6-06: text is stored masked (JSON by value); images are REBUILT by the strict image policy.
    const text = asText(data);
    const stored = text === null ? sanitizeImage(data) : Buffer.from(maskStoredText(text), 'utf8');
    entries.push({ name, data: stored, original_sha256: sha256(data), changed_by_masking: !stored.equals(data) });
  }
  if (refused.length) return { refused };
  if (new Set(entries.map((e) => e.name)).size !== entries.length) throw new Error('two evidence files have the same name');
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > MAX_TOTAL) throw new Error('packet would be larger than 50 MB');
  const manifest = { incident_id: ledger.incident_id, created_at: now, evidence_status: MASKED_NOTICE,
    files: entries.map((e) => ({ path: e.name, bytes: e.data.length, sha256: sha256(e.data), original_sha256: e.original_sha256, changed_by_masking: e.changed_by_masking })) };
  const readme = [
    `Case packet: ${ledger.incident_id}`, `Created: ${now}`, '',
    'This packet contains a summary of what was checked and found (summary.md), the full evidence record',
    '(ledger.json), and supporting files (evidence/). Reported items are labeled as reports, not confirmed facts.',
    '', 'To check that no file has changed, compare each file\'s SHA-256 fingerprint with MANIFEST.json.',
    'On Windows PowerShell:  Get-FileHash -Algorithm SHA256 <file>', '',
    'Nothing in this packet was sent anywhere by the tool that made it.', '',
    'MODIFIED EVIDENCE: every text file here is a masked copy made before saving (secrets, credentials and contact',
    'details removed), NOT the original. MANIFEST.json lists each file\'s original_sha256 and whether masking changed it.',
    'Images are kept only if they carry no hidden metadata; their visible content was reviewed by a person, not masked.',
    'Markdown and CSV files were checked for content that becomes',
    'active when viewed (HTML, images, script/data links, spreadsheet formulas) and refused if found; .txt and',
    '.json files are plain text. Open evidence in a plain text editor if in doubt.', '',
    'Before this packet was built, a person confirmed they checked:', ...SHARING_CHECKLIST.map((c) => `  [x] ${c}`), '',
  ].join('\r\n');
  entries.push({ name: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
  entries.unshift({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
  return { zip: zipStore(entries, new Date(now)), manifest };
}

const HELP = `case_packet: bundle summary + ledger + evidence into one zip with a SHA-256 manifest. Never sends anything.

  node case_packet.mjs build <ledger.json> --scope FILE --reviewed-for-personal-info [--include FILE ...] [--out FILE.zip]

--reviewed-for-personal-info confirms a person checked every file for names, home addresses, faces and readable
personal text in images: things the automatic checks cannot reliably find.

Allowed evidence: ${[...ALLOWED].join(' ')} (10 MB each, 50 MB total).
Images must be cleaned with metadata_scrub first. Files with secrets, email addresses or phone numbers are refused.
Markdown with HTML, images or non-web links, and CSV with formula cells, are refused: rename such evidence to .txt
to include it as inert plain text (the bytes and SHA-256 do not change).`;

export function main(argv) {
  const { values: o, positionals: [cmd, file] } = parseArgs({ args: argv, allowPositionals: true, options: {
    include: { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean' }, scope: { type: 'string' },
    'reviewed-for-personal-info': { type: 'boolean' },
  } });
  if (cmd !== 'build' || !file || o.help) return console.log(HELP);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const includes = (o.include ?? []).map((p) => {
    if (statSync(p).size > MAX_FILE) throw new Error(`${p} is larger than 10 MB`);
    return { name: basename(p), data: readFileSync(p) };
  });
  const scope = requireScope(o.scope, { action: 'save_local' }); // a packet is always written
  requireSameIncident(scope, ledger?.incident_id, 'the ledger'); // V4-07
  const result = buildPacket(ledger, includes, { humanReviewed: o['reviewed-for-personal-info'] });
  if (result.refused) {
    console.log('Packet NOT built. Fix these files first:');
    for (const r of result.refused) console.log(`  ${r.name}: ${r.problems.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  const stamp = result.manifest.created_at.replace(/[:.]/g, '-');
  const out = o.out ?? join(OUT_DIR, `${ledger.incident_id}-${stamp}.zip`);
  console.log(`saved ${safeWrite(out, result.zip, { binary: 'case-packet' })}`);
  for (const f of result.manifest.files) console.log(`  ${f.sha256}  ${f.path}`);
  console.log('Nothing was sent. Share the zip only with the people it is meant for.');
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
