#!/usr/bin/env node
// Review a unified diff for changes outside the intended scope (data, contacts, thresholds, workflows, generated output).
import { readFileSync } from 'node:fs';
import { isMain, fail } from '../_shared/common.mjs';

export const OUT_OF_SCOPE_PATHS = [
  [/^data\//, 'directory data'],
  [/^\.github\/workflows\//, 'CI workflow'],
  [/(^|\/)(dist|build|public|generated|site|docs)\//, 'generated or published output'],
  [/(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)yarn\.lock$/, 'dependency lockfile'],
];
export const OUT_OF_SCOPE_CONTENT = [
  [/threshold|safety[_ -]?valve|max[_ ]?flag|MAX_FLAG/i, 'safety threshold'],
  [/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/, 'phone number'],
  [/"(phone|intake|clinic|email|address)"\s*:/i, 'contact/intake field'],
];

export function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { cur = { path: m[2], changed: [] }; files.push(cur); continue; }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) cur.changed.push(line);
  }
  return files;
}

export function reviewDiff(text) {
  const flags = [];
  for (const f of parseDiff(text)) {
    for (const [re, why] of OUT_OF_SCOPE_PATHS) if (re.test(f.path)) flags.push({ path: f.path, reason: why });
    for (const line of f.changed) {
      for (const [re, why] of OUT_OF_SCOPE_CONTENT) if (re.test(line)) flags.push({ path: f.path, reason: why, line: line.slice(0, 160) });
    }
  }
  return { files: parseDiff(text).map((f) => f.path), flags, in_scope: flags.length === 0 };
}

if (isMain(import.meta)) {
  const file = process.argv[2] ?? fail('usage: node diff_scope_check.mjs <patch.diff>');
  const r = reviewDiff(readFileSync(file, 'utf8'));
  console.log(`files changed: ${r.files.join(', ') || 'none'}`);
  if (r.in_scope) console.log('no out-of-scope changes detected (still review the diff yourself)');
  else for (const f of r.flags) console.log(`OUT OF SCOPE [${f.reason}] ${f.path}${f.line ? `: ${f.line}` : ''}`);
  process.exitCode = r.in_scope ? 0 : 1;
}
