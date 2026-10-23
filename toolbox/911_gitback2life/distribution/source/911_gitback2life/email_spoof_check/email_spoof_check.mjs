#!/usr/bin/env node
// email_spoof_check: is the organization's domain protected against people sending email in its name?
// Reads public DNS records only (SPF, DMARC, MX, and at most 5 DKIM selectors you name). Never sends email and
// never contacts a mail server. Every DNS query is spaced and capped by polite limits; answers reused 12 hours.
import { Resolver } from 'node:dns/promises';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson } from '../_shared/common.mjs';
import { acquire, cached, printRunReport } from '../_shared/polite.mjs';
import { normalizeDomain } from '../domain_research/domain_research.mjs';
import { requireScope } from '../_shared/scope.mjs';
import { coverage, failureRecord } from '../_shared/assessment_status.mjs';

export const MAX_DKIM_SELECTORS = 5;
const NOT_FOUND = new Set(['ENODATA', 'ENOTFOUND']);

async function query(r, server, fn) {
  await acquire(`dns:${server}`);
  try { return { records: await fn() }; } catch (e) {
    return NOT_FOUND.has(e.code) ? { records: [] } : { records: [], error: e.code ?? e.message };
  }
}

export async function lookupEmailRecords(domain, { selectors = [], resolver } = {}) {
  if (selectors.length > MAX_DKIM_SELECTORS) throw new Error(`at most ${MAX_DKIM_SELECTORS} DKIM selectors`);
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (resolver) r.setServers([resolver]);
  const server = r.getServers().join(',') || 'system';
  const txt = (name) => query(r, server, async () => (await r.resolveTxt(name)).map((chunks) => chunks.join('')));
  const out = { domain, looked_up_at: nowUtc(), resolver: server, errors: {}, dkim_errors: {} };
  const spf = await txt(domain);
  out.spf = spf.records.filter((t) => /^v=spf1(\s|$)/i.test(t));
  const dmarc = await txt(`_dmarc.${domain}`);
  out.dmarc = dmarc.records.filter((t) => /^v=DMARC1\b/i.test(t));
  const mx = await query(r, server, async () => (await r.resolveMx(domain)).map((m) => m.exchange).sort());
  out.mx = mx.records;
  for (const [k, v] of [['spf', spf], ['dmarc', dmarc], ['mx', mx]]) if (v.error) out.errors[k] = v.error;
  out.dkim = {};
  for (const s of selectors) {
    const d = await txt(`${s}._domainkey.${domain}`);
    if (d.error) out.dkim_errors[s] = d.error;
    out.dkim[s] = d.error ? `error: ${d.error}` : d.records.some((t) => /(^|;)\s*p=/.test(t));
  }
  // Failed resolver answers must never be cached as evidence of missing records for 12 hours.
  // The existing shared cache accepts a shorter TTL from the returned value.
  if (Object.keys(out.errors).length || Object.keys(out.dkim_errors).length) out.ttl_hours = 1;
  return out;
}

const DNS_LOOKUP_TERMS = /^(include:|a$|a:|a\/|mx$|mx:|mx\/|ptr|exists:|redirect=)/i;

export function analyzeSpf(spf, { hasMx = true } = {}) {
  const f = [];
  const add = (level, message, fix) => f.push({ level, check: 'spf', message, ...(fix ? { fix } : {}) });
  if (!spf.length) {
    add('review', 'No SPF record: receiving mail servers cannot check which servers may send email for this domain.',
      hasMx ? 'Ask the email provider for its recommended SPF record.' : 'If this domain never sends email, publish "v=spf1 -all".');
    return f;
  }
  if (spf.length > 1) add('review', 'There is more than one SPF record; receiving servers treat that as an error and SPF fails.', 'Merge them into a single record.');
  const terms = spf[0].trim().split(/\s+/).slice(1);
  const all = terms.map((t) => /^([+?~-]?)all$/i.exec(t)).find(Boolean);
  const qualifier = all ? (all[1] || '+') : null;
  if (qualifier === '+') add('urgent', 'SPF ends with "+all", which tells receivers that any server in the world may send as this domain.', 'Change "+all" to "-all" or "~all".');
  else if (qualifier === '?') add('review', 'SPF ends with "?all" (neutral), so mail from other servers is not marked as suspicious.', 'Use "~all" or "-all".');
  else if (qualifier === '~') add('info', 'SPF ends with "~all" (soft fail). Reasonable, especially together with a DMARC policy.');
  else if (qualifier === '-') add('info', 'SPF ends with "-all" (hard fail): only the listed servers may send.');
  else if (!terms.some((t) => /^redirect=/i.test(t))) add('review', 'SPF has no "all" ending, so mail from unlisted servers is not marked.', 'End the record with "~all" or "-all".');
  const lookups = terms.map((t) => t.replace(/^[+?~-]/, '')).filter((t) => DNS_LOOKUP_TERMS.test(t)).length;
  if (lookups > 10) add('review', `SPF needs at least ${lookups} DNS lookups; more than 10 makes SPF fail.`, 'Remove unused include: entries.');
  if (terms.some((t) => /^[+?~-]?ptr/i.test(t))) add('info', 'SPF uses the "ptr" mechanism, which is discouraged and slow.');
  return f;
}

export function parseTags(record) {
  return Object.fromEntries(record.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.toLowerCase(), ''] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
  }));
}

export function analyzeDmarc(dmarc) {
  const f = [];
  const add = (level, message, fix) => f.push({ level, check: 'dmarc', message, ...(fix ? { fix } : {}) });
  if (!dmarc.length) {
    add('review', 'No DMARC record: receivers get no instruction for mail that fails checks, and the organization gets no reports about fake mail.',
      'Start with "v=DMARC1; p=none; rua=mailto:<a role mailbox>" to monitor, then move to p=quarantine or p=reject.');
    return f;
  }
  if (dmarc.length > 1) add('review', 'There is more than one DMARC record; receivers ignore DMARC entirely in that case.', 'Keep exactly one.');
  const tags = parseTags(dmarc[0]);
  const p = (tags.p ?? '').toLowerCase();
  if (p === 'none') add('review', 'DMARC policy is "none" (monitoring only): fake mail is reported but not blocked.', 'Once reports look clean, move to p=quarantine, then p=reject.');
  else if (p === 'quarantine') add('info', 'DMARC policy is "quarantine": mail that fails checks goes to spam.');
  else if (p === 'reject') add('info', 'DMARC policy is "reject": mail that fails checks is refused (strongest).');
  else add('review', `DMARC policy "${tags.p ?? '(missing)'}" is not valid, so receivers may ignore the record.`, 'Set p=none, p=quarantine or p=reject.');
  const pct = Number(tags.pct ?? 100);
  if (pct < 100) add('info', `DMARC applies to only ${pct}% of failing mail.`);
  // Report addresses are not printed (toolkit privacy rule); only whether reports are requested.
  const reportTargets = (tags.rua ?? '').split(',').filter((x) => x.trim()).length;
  if (!reportTargets) add('info', 'DMARC does not request reports, so the organization will not hear about fake mail.', 'Add rua=mailto:<a role mailbox>.');
  return f;
}

/** Plain-language overall rating. Never claims mail is "safe"; this only describes published protections. */
export function overall(spfFindings, dmarcFindings) {
  const all = [...spfFindings, ...dmarcFindings];
  if (all.some((x) => x.level === 'urgent')) return 'weak: a published setting actively helps impersonators';
  const dmarcEnforced = dmarcFindings.some((x) => /"(quarantine|reject)"/.test(x.message));
  const spfOk = spfFindings.length && !spfFindings.some((x) => x.level === 'review');
  if (dmarcEnforced && spfOk) return 'strong: SPF and an enforced DMARC policy are published';
  if (all.some((x) => x.level === 'review')) return 'partial: some protections are missing or only monitoring';
  return 'partial';
}

export function analyze(records) {
  const errors = records.errors ?? {};
  const dkimErrors = records.dkim_errors ?? {};
  const verified = ['spf', 'dmarc', 'mx'].filter((check) => !errors[check]);
  const missing = ['spf', 'dmarc', 'mx'].filter((check) => errors[check]).map((check) => failureRecord(check, errors[check]));
  for (const selector of Object.keys(records.dkim ?? {})) {
    if (dkimErrors[selector] || typeof records.dkim[selector] === 'string')
      missing.push(failureRecord(`dkim:${selector}`, dkimErrors[selector] ?? records.dkim[selector]));
    else verified.push(`dkim:${selector}`);
  }
  // Inability to query a record is not evidence it is absent. Incomplete SPF/DMARC
  // must never cause an incorrect missing-policy recommendation or a 'strong' rating.
  const spf = errors.spf ? [] : analyzeSpf(records.spf, { hasMx: !errors.mx && records.mx.length > 0 });
  const dmarc = errors.dmarc ? [] : analyzeDmarc(records.dmarc);
  const dkim = Object.entries(records.dkim ?? {}).filter(([s]) => !dkimErrors[s] && typeof records.dkim[s] !== 'string').map(([s, found]) => ({
    level: 'info', check: 'dkim',
    message: found === true ? `DKIM key found for selector "${s}".` : `No DKIM key at selector "${s}" (normal if the provider uses a different selector name).`,
  }));
  const verification = coverage(verified, missing);
  return { rating: missing.length ? 'incomplete: some published protections could not be checked' : overall(spf, dmarc),
    verification, findings: [...spf, ...dmarc, ...dkim] };
}

const ICON = { urgent: '🔴 URGENT', review: '🟡 REVIEW', info: '🔵 info  ' };

const HELP = `email_spoof_check: are a domain's anti-impersonation email settings published? (DNS only)

  check <domain> --scope FILE [--dkim selector1,selector2] [--resolver IP] [--refresh] [--json]

Reads SPF, DMARC and MX records, plus up to ${MAX_DKIM_SELECTORS} DKIM selectors you name (ask the email provider which
one it uses, e.g. "google" or "selector1"). Never sends email or contacts a mail server.
This describes published settings only; it cannot tell whether a particular email was fake.`;

export async function main(argv) {
  const { values: o, positionals: [cmd, target] } = parseArgs({ args: argv, allowPositionals: true, options: {
    dkim: { type: 'string' }, resolver: { type: 'string' }, refresh: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' }, scope: { type: 'string' },
  } });
  if (cmd !== 'check' || !target || o.help) return console.log(HELP);
  const domain = normalizeDomain(target).replace(/^www\./, '');
  requireScope(o.scope, { action: 'passive_lookup', target: domain, services: ['dns'] });
  const selectors = (o.dkim ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (selectors.some((s) => !/^[a-z0-9_-]{1,63}$/i.test(s))) throw new Error('DKIM selectors are simple names like "google" or "selector1"');
  const records = await cached(`email_spoof_check:${domain}:${selectors.join(',')}:${o.resolver ?? ''}`,
    () => lookupEmailRecords(domain, { selectors, resolver: o.resolver }), { refresh: o.refresh });
  const result = { domain, looked_up_at: records.looked_up_at, resolver: records.resolver, lookup_errors: records.errors, dkim_lookup_errors: records.dkim_errors, ...analyze(records) };
  if (o.json) { printJson(result); if (result.verification.status !== 'verified') process.exitCode = 3; return; }
  console.log(`== ${domain} (DNS looked up ${records.looked_up_at} via ${records.resolver})`);
  console.log(`Overall: ${result.rating}\n`);
  for (const f of result.findings) console.log(`  ${ICON[f.level]} ${f.message}${f.fix ? `\n             Suggested fix: ${f.fix}` : ''}`);
  for (const missing of result.verification.unverified_checks) console.log(`  NOT VERIFIED: ${missing.check} [${missing.kind}] ${missing.reason}; cannot infer the record is absent.`);
  if (result.verification.status !== 'verified') console.log('ASSESSMENT INCOMPLETE: preserve verified findings; do not infer missing or safe policies from failed queries.');
  process.exitCode = result.verification.status !== 'verified' ? 3 : result.findings.some((f) => f.level === 'urgent') ? 1 : result.findings.some((f) => f.level === 'review') ? 3 : 0;
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
