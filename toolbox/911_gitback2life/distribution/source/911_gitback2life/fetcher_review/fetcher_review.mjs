#!/usr/bin/env node
// Static helper for reviewing how a project fetches URLs and handles redirects. Reads files only; runs nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, printJson } from '../_shared/common.mjs';

export const RULES = [
  ['redirect_follow', 'Automatic redirect following', /redirect\s*:\s*['"`]follow['"`]|followRedirects?\s*:\s*true|maxRedirects\s*:\s*[1-9]/],
  ['redirect_manual', 'Manual/blocked redirects', /redirect\s*:\s*['"`](manual|error)['"`]|maxRedirects\s*:\s*0/],
  ['fetch_call', 'Outbound request call', /\bfetch\s*\(|\bhttps?\.(get|request)\s*\(|\baxios\b|\bgot\s*\(|\bundici\b|\brequests\.(get|post|head)\s*\(/],
  ['url_parse', 'URL parsing', /new URL\s*\(|urlsplit\(|urlparse\(/],
  ['scheme_check', 'Scheme check', /\.protocol\s*[!=]==?|['"`]https?:['"`]|scheme\s*[!=]=/],
  ['host_check', 'Host/domain comparison', /offDomain|sameSite|same[-_ ]?origin|\.hostname\b|registrableDomain|psl/i],
  ['ip_check', 'IP/private-range check', /isPrivate|private.?ip|BlockList|ipaddr|169\.254|127\.0\.0\.1|isIP\s*\(/i],
  ['dns', 'DNS resolution', /\bdns\b.*\b(lookup|resolve)|lookup\s*:/],
  ['timeout', 'Timeout', /AbortSignal\.timeout|\btimeout\s*:|setTimeout\s*\(.*abort/i],
  ['size_limit', 'Response size limit', /content-length|maxBytes|maxSize|byteLength|maxContentLength/i],
  ['body_read', 'Response body read', /\.(text|json|arrayBuffer|blob)\s*\(\s*\)|\.read\(\)/],
  ['concurrency', 'Concurrency/retry control', /p-limit|concurren|Promise\.all|retry|retries/i],
];

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);

export function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s || s.isSymbolicLink()) continue;
    if (s.isDirectory()) yield* walk(p);
    else if (CODE_EXT.has(extname(name)) && s.size <= 1_000_000) yield p;
  }
}

export function scanText(text, file) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [id, , re] of RULES) if (re.test(line)) hits.push({ rule: id, file, line: i + 1, code: line.trim().slice(0, 160) });
  });
  return hits;
}

export function scanDir(root) {
  const hits = [];
  for (const file of walk(root)) hits.push(...scanText(readFileSync(file, 'utf8'), relative(root, file).replaceAll('\\', '/')));
  return hits;
}

const HELP = `fetcher_review: map where a project fetches URLs and follows redirects (static, read-only).

  scan <dir> [--json]     list matches per category, and categories with no match at all
  checklist               print the manual review checklist (CHECKLIST.md)

Matches are leads for human review, not findings. Missing matches are not proof a control is absent.`;

export function main(argv) {
  const { values: o, positionals: [cmd, dir] } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (!cmd || o.help) return console.log(HELP);
  if (cmd === 'checklist') return console.log(readFileSync(new URL('./CHECKLIST.md', import.meta.url), 'utf8'));
  if (cmd !== 'scan' || !dir) throw new Error(HELP);
  const hits = scanDir(dir);
  if (o.json) return printJson(hits);
  for (const [id, title] of RULES) {
    const mine = hits.filter((h) => h.rule === id);
    console.log(`\n## ${title} (${id}): ${mine.length ? `${mine.length} match(es)` : 'NO MATCHES (verify manually)'}`);
    for (const h of mine.slice(0, 25)) console.log(`  ${h.file}:${h.line}  ${h.code}`);
    if (mine.length > 25) console.log(`  … ${mine.length - 25} more (use --json)`);
  }
  console.log('\nNext: walk CHECKLIST.md against these locations. Describe risks as conditional unless demonstrated offline.');
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
