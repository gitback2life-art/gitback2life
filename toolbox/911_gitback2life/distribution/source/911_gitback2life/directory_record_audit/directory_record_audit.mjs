#!/usr/bin/env node
// directory_record_audit: offline data-quality check of a downloaded copy of a resource directory
// (for example a folder of organization JSON records). Finds malformed phone numbers, broken or non-https web
// addresses, stale "last checked" dates, missing fields and duplicates. It NEVER calls, emails or visits anything
// to "verify" a record. Phone numbers and email addresses are partly masked unless --show-values is given.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, printJson } from '../_shared/common.mjs';

const MAX_RECORDS = 5000;
const MAX_FILE = 20 * 1024 * 1024;
const KIND = [
  ['phone', /(phone|tel|hotline|fax|mobile|sms)/i],
  ['email', /e-?mail/i],
  ['url', /(url|website|site|homepage|link|href)$/i],
  ['date', /(last_?(checked|verified|updated|reviewed)|checked_?at|verified_?at|updated_?at)/i],
];

/** Every leaf value with its dotted path, e.g. ["intake.phone", "212-555-0100"]. */
export function leaves(obj, prefix = '') {
  const out = [];
  if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...leaves(v, `${prefix}[${i}]`)));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) out.push(...leaves(v, prefix ? `${prefix}.${k}` : k));
  else if (obj !== null && obj !== undefined) out.push([prefix, String(obj)]);
  return out;
}

const lastKey = (path) => path.replace(/\[\d+\]$/, '').split('.').pop();
export const kindOf = (path) => KIND.find(([, re]) => re.test(lastKey(path)))?.[0] ?? null;

export function phoneProblem(value, country = 'US') {
  const main = value.replace(/\s*(x|ext\.?|extension)\s*\d+$/i, '');
  const digits = main.replace(/\D/g, '');
  if (/[a-wyz]/i.test(main.replace(/^tel:/i, ''))) return 'contains letters';
  if (country === 'US') {
    if (digits.length === 10 || (digits.length === 11 && digits[0] === '1')) return null;
    return `has ${digits.length} digits (expected 10 for a US number)`;
  }
  return digits.length >= 7 && digits.length <= 15 ? null : `has ${digits.length} digits`;
}

export function urlProblem(value) {
  if (/\s/.test(value.trim())) return { level: 'review', message: 'contains spaces' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`); } catch { return { level: 'review', message: 'is not a valid web address' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { level: 'review', message: `uses ${u.protocol} instead of a web address` };
  if (!u.hostname.includes('.')) return { level: 'review', message: 'has no proper domain name' };
  if (u.protocol === 'http:') return { level: 'info', message: 'uses http:// rather than https://' };
  return null;
}

export const mask = (kind, v) => (kind === 'phone' ? v.replace(/\d(?=(?:\D*\d){4})/g, '•')
  : kind === 'email' ? v.replace(/^([^@])[^@]*@/, '$1***@') : v);

export function auditRecords(records, { require = [], staleDays = 180, now = Date.now(), country = 'US' } = {}) {
  const findings = [];
  const seen = { phone: new Map(), url: new Map(), name: new Map() };
  const add = (rec, level, check, field, message, value = null) => findings.push({ record: rec.id, level, check, field, message, value });
  for (const rec of records) {
    const flat = leaves(rec.data);
    const byPath = new Map(flat);
    for (const field of require) {
      const v = byPath.get(field);
      if (v === undefined || !String(v).trim()) add(rec, 'review', 'missing', field, 'required field is missing or empty');
    }
    const name = (rec.data.name ?? rec.data.title ?? rec.data.org_name ?? '').toString().trim().toLowerCase();
    if (name) seen.name.set(name, [...(seen.name.get(name) ?? []), rec.id]);
    for (const [path, value] of flat) {
      const kind = kindOf(path);
      if (!kind || !value.trim()) continue;
      if (kind === 'phone') {
        const p = phoneProblem(value, country);
        if (p) add(rec, 'review', 'phone_format', path, `phone number ${p}`, value);
        else {
          const key = value.replace(/\s*(x|ext\.?|extension)\s*\d+$/i, '').replace(/\D/g, '').slice(-10);
          seen.phone.set(key, [...(seen.phone.get(key) ?? []), rec.id]);
        }
      } else if (kind === 'url') {
        const p = urlProblem(value);
        if (p) add(rec, p.level, 'web_address', path, `web address ${p.message}`, value);
        if (!p || p.level === 'info') { // still a usable address (e.g. http://), so it counts for duplicates
          const host = new URL(/^https?:/i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, '');
          seen.url.set(host, [...(seen.url.get(host) ?? []), rec.id]);
        }
      } else if (kind === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.replace(/^mailto:/i, ''))) add(rec, 'review', 'email_format', path, 'email address looks malformed', value);
      } else if (kind === 'date') {
        const t = Date.parse(value);
        if (Number.isNaN(t)) add(rec, 'review', 'date', path, 'date is not readable');
        else if (t > now + 864e5) add(rec, 'review', 'date', path, `date ${value} is in the future`);
        else if ((now - t) / 864e5 > staleDays) add(rec, 'review', 'stale', path, `last checked ${Math.floor((now - t) / 864e5)} days ago (over ${staleDays})`);
      }
    }
  }
  const dupes = (map, check, level, what) => {
    for (const [key, ids] of map) {
      const unique = [...new Set(ids)];
      if (unique.length > 1) findings.push({ record: unique.join(', '), level, check, field: null, message: `${unique.length} records share the same ${what}${check === 'duplicate_phone' ? ' (shared hotlines are normal; worth a look)' : ''}`, value: key });
    }
  };
  dupes(seen.name, 'duplicate_name', 'review', 'name');
  dupes(seen.phone, 'duplicate_phone', 'info', 'phone number');
  dupes(seen.url, 'duplicate_website', 'info', 'website');
  return findings;
}

/** Load records from a folder of .json files (one record each) or one .json file holding an array. */
export function loadRecords(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    const files = readdirSync(path).filter((f) => extname(f).toLowerCase() === '.json').sort();
    if (files.length > MAX_RECORDS) throw new Error(`more than ${MAX_RECORDS} records`);
    return files.map((f) => {
      const p = join(path, f);
      if (statSync(p).size > MAX_FILE) throw new Error(`${f} is too large`);
      return { id: basename(f, '.json'), data: JSON.parse(readFileSync(p, 'utf8')) };
    });
  }
  if (st.size > MAX_FILE) throw new Error('file is larger than 20 MB');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(data) ? data : Object.values(data).find(Array.isArray);
  if (!list) throw new Error('expected a JSON array of records (or an object containing one)');
  if (list.length > MAX_RECORDS) throw new Error(`more than ${MAX_RECORDS} records`);
  return list.map((d, i) => ({ id: d.id ?? d.slug ?? `#${i + 1}`, data: d }));
}

const ICON = { review: '🟡', info: '🔵' };

const HELP = `directory_record_audit: offline data-quality check of a downloaded directory. Never calls, emails or visits.

  node directory_record_audit.mjs <folder-of-json | records.json> [--require name,phone] [--stale-days 180]
       [--country US|other] [--show-values] [--max N] [--json]

Fields are recognized by name (phone, email, url/website, last_checked...). Phone numbers and emails are
partly masked unless --show-values is given. Findings are things to review, not proof a record is wrong.`;

export function main(argv) {
  const { values: o, positionals: [path] } = parseArgs({ args: argv, allowPositionals: true, options: {
    require: { type: 'string' }, 'stale-days': { type: 'string' }, country: { type: 'string' }, 'show-values': { type: 'boolean' },
    max: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!path || o.help) return console.log(HELP);
  const records = loadRecords(path);
  const findings = auditRecords(records, {
    require: (o.require ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    staleDays: Number(o['stale-days'] ?? 180), country: o.country ?? 'US',
  }).map((f) => ({ ...f, value: f.value && !o['show-values'] ? mask(kindOf(f.field ?? '') ?? (f.check === 'duplicate_phone' ? 'phone' : null), f.value) : f.value }));
  if (o.json) return printJson({ records: records.length, findings });
  const counts = findings.reduce((m, f) => ({ ...m, [f.check]: (m[f.check] ?? 0) + 1 }), {});
  console.log(`${records.length} records checked offline. Findings by type:`);
  for (const [k, n] of Object.entries(counts).sort()) console.log(`  ${String(n).padStart(5)}  ${k}`);
  const max = Number(o.max ?? 100);
  console.log('');
  for (const f of findings.slice(0, max)) console.log(`  ${ICON[f.level]} ${f.record}${f.field ? ` · ${f.field}` : ''}: ${f.message}${f.value ? ` [${f.value}]` : ''}`);
  if (findings.length > max) console.log(`  … ${findings.length - max} more (use --max or --json)`);
  console.log('\nNothing was contacted. Confirm any correction with the organization itself before changing a listing.');
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
