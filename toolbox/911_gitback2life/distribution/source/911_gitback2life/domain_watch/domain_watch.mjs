#!/usr/bin/env node
// domain_watch: spot domain trouble early by comparing public registration and DNS records with a saved baseline.
// Passive only: never visits the organization's website. Every lookup goes through domain_research, so polite
// limits, robots.txt checks and 12-hour answer reuse all apply. Runs only when a person runs it (no schedule).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson, safeWrite, TOOLBOX_ROOT } from '../_shared/common.mjs';
import { cached, printRunReport } from '../_shared/polite.mjs';
import { provenance, requireScope } from '../_shared/scope.mjs';
import { certTransparency, dnsLookup, normalizeDomain, rdap } from '../domain_research/domain_research.mjs';
import { coverage, failureRecord } from '../_shared/assessment_status.mjs';

export const BASELINE_DIR = join(TOOLBOX_ROOT, 'domain_watch', 'baselines');
export const MAX_DOMAINS_PER_RUN = 5;
const RISKY_STATUS = /redemption|pending ?delete|client ?hold|server ?hold|inactive/i;
const DOMAIN_SERVICES = new Set(['domain_registrar', 'dns', 'web_host', 'website_builder']);

const values = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x.address ?? x.exchange ?? JSON.stringify(x))).sort() : []);
const same = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);
const fmt = (list) => (list?.length ? list.join(', ') : '(none)');

/** Reduce lookup results to the facts worth comparing over time. */
export function snapshotFrom({ domain, rdapResult, dnsResult, ctResult, at = nowUtc() }) {
  return {
    domain, taken_at: at,
    registration: rdapResult?.found ? {
      registrar: rdapResult.registrar ?? null, expires: rdapResult.expires ?? null, last_changed: rdapResult.last_changed ?? null,
      status: [...(rdapResult.status ?? [])].sort(), nameservers: [...(rdapResult.nameservers ?? [])].sort(),
    } : null,
    // Null means a record type could not be checked; [] means a verified negative answer.
    dns: dnsResult ? Object.fromEntries(['A', 'AAAA', 'CNAME', 'NS'].map((t) => [t,
      Array.isArray(dnsResult.records?.[t]) ? values(dnsResult.records[t])
      : ['ENODATA', 'ENOTFOUND', 'ENODOMAIN', 'ENONAME'].includes(dnsResult.records?.[t]?.none) ? [] : null])) : null,
    certificates: ctResult ? { latest_not_before: ctResult.latest_not_before ?? null, issuers: [...(ctResult.issuers ?? [])].sort() } : null,
  };
}

/** Findings, each with a level: urgent (act now), review (someone should look), info (worth knowing). */
export function compareSnapshots(base, cur, now = Date.now()) {
  const findings = [];
  const add = (level, check, message) => findings.push({ level, check, message });
  const reg = cur.registration;
  if (!reg && cur.unverified?.some((e) => e.check === 'rdap')) {
    add('review', 'registration', 'Registration lookup could not be verified; no conclusion about registration or expiry.');
  } else if (!reg) {
    add('review', 'registration', 'No registration record found. Some domain endings have no public registration data; confirm with the registrar before drawing conclusions.');
  } else {
    if (!reg.expires) add('review', 'expiry', 'The expiry date is not published; check it with the registrar.');
    else {
      const days = Math.floor((Date.parse(reg.expires) - now) / 864e5);
      if (days < 0) add('urgent', 'expiry', `The registration expiry date (${reg.expires}) passed ${-days} day(s) ago. The domain may be in a grace or redemption period; the owner should contact the registrar now.`);
      else if (days <= 30) add('urgent', 'expiry', `The registration expires in ${days} day(s) (${reg.expires}).`);
      else if (days <= 60) add('review', 'expiry', `The registration expires in ${days} days (${reg.expires}); confirm auto-renew and the payment method.`);
    }
    const risky = reg.status.filter((s) => RISKY_STATUS.test(s));
    if (risky.length) add('urgent', 'status', `Registry status includes "${risky.join('", "')}", which usually means the domain is not working or may be released.`);
  }
  if (base) {
    const b = base.registration;
    if (b && reg) {
      if (b.registrar !== reg.registrar) add('review', 'registrar', `Registrar changed from "${b.registrar}" to "${reg.registrar}". This can be a planned transfer; confirm with the organization.`);
      if (!same(b.nameservers, reg.nameservers)) add('review', 'nameservers', `Nameservers changed: ${fmt(b.nameservers)} → ${fmt(reg.nameservers)}. Often a hosting move; it is also how a domain gets pointed somewhere else.`);
      if (b.expires && reg.expires && Date.parse(reg.expires) > Date.parse(b.expires)) add('info', 'renewed', `The registration was renewed: expiry moved from ${b.expires} to ${reg.expires}.`);
      if (b.expires && reg.expires && Date.parse(reg.expires) < Date.parse(b.expires)) add('review', 'expiry', `The expiry date moved earlier (${b.expires} → ${reg.expires}).`);
    } else if (b && !reg && !cur.unverified?.some((e) => e.check === 'rdap')) add('review', 'registration', 'A registration record existed in the baseline but none was found now.');
    if (base.dns && cur.dns) {
      for (const t of ['A', 'AAAA', 'CNAME', 'NS']) {
        if (Array.isArray(base.dns[t]) && Array.isArray(cur.dns[t]) && !same(base.dns[t], cur.dns[t])) add('info', `dns_${t}`, `${t} records changed: ${fmt(base.dns[t])} → ${fmt(cur.dns[t])}.`);
      }
    }
    if (base.certificates && cur.certificates && !same(base.certificates.issuers, cur.certificates.issuers)) {
      add('info', 'certificates', `Certificate issuers changed: ${fmt(base.certificates.issuers)} → ${fmt(cur.certificates.issuers)}.`);
    }
  }
  return findings;
}

/** Domains from an org_registers "service" register (registrar/DNS/host/website-builder entries). */
export function domainsFromRegister(register) {
  const out = [];
  for (const r of register?.records ?? []) {
    if (!DOMAIN_SERVICES.has(r.service) || !r.domain_or_account) continue;
    try { out.push(normalizeDomain(r.domain_or_account)); } catch { /* not a domain, e.g. an account name */ }
  }
  return [...new Set(out)];
}

const baselinePath = (domain) => join(BASELINE_DIR, `${domain}.json`);

/** A baseline is only ever saved when a person asks: --save-baseline (first time) or --accept (replace). */
export function baselineDecision({ hasBase, accept = false, saveBaseline = false }) {
  if (hasBase && accept) return { save: true, message: 'current records accepted as the new baseline' };
  if (hasBase) return { save: false, message: 'compared with saved baseline' };
  if (saveBaseline) return { save: true, message: 'no baseline yet: saved this check as the baseline (--save-baseline)' };
  return { save: false, message: 'no baseline saved (nothing kept); pass --save-baseline to keep one for future comparisons' };
}
export function loadBaseline(domain) {
  return existsSync(baselinePath(domain)) ? JSON.parse(readFileSync(baselinePath(domain), 'utf8')) : null;
}

export async function takeSnapshot(domain, { withCt = false, refresh = false, providers = {} } = {}) {
  const opts = { refresh }, unverified = [], verified = [];
  const collect = async (check, key, fn) => {
    try {
      const answer = await cached(key, fn, opts);
      verified.push(check);
      return answer;
    } catch (e) {
      // A withdrawn scope or exhausted safety budget is a mandatory stop,
      // not a reason to continue sending requests to remaining providers.
      if (e.code === 'SCOPE_BLOCKED' || e.code === 'POLITE_BUDGET') throw e;
      unverified.push(failureRecord(check, e));
      return null;
    }
  };
  const rdapResult = await collect('rdap', `domain_watch:rdap:${domain}`, () => (providers.rdap ?? rdap)(domain));
  const dnsResult = await collect('dns', `domain_watch:dns:${domain}`, () => (providers.dns ?? dnsLookup)(domain));
  const ctResult = withCt ? await collect('certificate_logs', `domain_watch:ct:${domain}`, () => (providers.ct ?? certTransparency)(domain, { limit: 5 })) : null;
  if (dnsResult && ((dnsResult.verification?.status && dnsResult.verification.status !== 'verified') ||
      ['A', 'AAAA', 'CNAME', 'NS'].some(t => !Array.isArray(dnsResult.records?.[t]) &&
        !['ENOTFOUND','ENODATA','ENODOMAIN','ENONAME'].includes(dnsResult.records?.[t]?.none)))) {
    verified.splice(verified.indexOf('dns'), 1);
    unverified.push(failureRecord('dns', 'One or more DNS record types were not verified'));
  }
  const snapshot = snapshotFrom({ domain, rdapResult, dnsResult, ctResult });
  // An unexpected network exception is not evidence of missing registration.
  snapshot.unverified = unverified;
  snapshot.verification = coverage(verified, unverified);
  return snapshot;
}

const ICON = { urgent: '🔴 URGENT', review: '🟡 REVIEW', info: '🔵 info  ' };

const HELP = `domain_watch: compare a domain's public registration and DNS records with a saved baseline.

  check <domain> [<domain> ...]   [--with-ct] [--refresh] [--accept] [--json]
  check --register services.json  (domains from an org_registers "service" register)
  --scope FILE is required: each domain must be a scope target; rdap and dns must be scope disclosures.

Baselines are saved only when you ask: --save-baseline keeps this check as the baseline for future comparisons;
after reviewing changes, --accept replaces it. Saving needs a scope with persistence "local". With such a scope,
lookup results are also cached for 12 hours in _shared/.polite_cache (see incident_intake state); with a
"transient" scope no results are kept. At most ${MAX_DOMAINS_PER_RUN} domains per run. Never visits the website.
Exit code: 1 = something urgent, 3 = something to review, 0 = nothing found.`;

export async function main(argv) {
  const { values: o, positionals: [cmd, ...rest] } = parseArgs({ args: argv, allowPositionals: true, options: {
    register: { type: 'string' }, 'with-ct': { type: 'boolean' }, refresh: { type: 'boolean' }, accept: { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, scope: { type: 'string' }, 'save-baseline': { type: 'boolean' },
  } });
  if (cmd !== 'check' || o.help) return console.log(HELP);
  const domains = o.register ? domainsFromRegister(JSON.parse(readFileSync(o.register, 'utf8'))) : rest.map(normalizeDomain);
  if (!domains.length) throw new Error('no domains given');
  if (domains.length > MAX_DOMAINS_PER_RUN) throw new Error(`at most ${MAX_DOMAINS_PER_RUN} domains per run (got ${domains.length}); split them up to stay within polite limits`);
  for (const d of domains) requireScope(o.scope, { action: 'passive_lookup', target: d, services: ['rdap', 'dns', ...(o['with-ct'] ? ['certificate_logs'] : [])] });
  if (o['save-baseline'] || o.accept) requireScope(o.scope, { action: 'save_local' }); // only when a baseline will be saved
  const report = [];
  for (const domain of domains) {
    const current = await takeSnapshot(domain, { withCt: o['with-ct'], refresh: o.refresh });
    const base = loadBaseline(domain);
    const findings = compareSnapshots(base, current);
    const decision = baselineDecision({ hasBase: Boolean(base), accept: o.accept, saveBaseline: o['save-baseline'] });
    // Baselines are the organization's ongoing records: stamped with the incident that saved them, reusable across incidents.
    // Do not poison a trusted comparison baseline with an incomplete external lookup.
    // Keep the partial findings visible and leave existing baselines unchanged.
    const saved = decision.save && current.verification.status === 'verified';
    if (saved) safeWrite(baselinePath(domain), JSON.stringify({ ...current, provenance: provenance() }, null, 2) + '\n', { overwrite: true });
    report.push({ domain, baseline: decision.save && !saved ? 'not saved: external checks incomplete' : decision.message,
      baseline_taken_at: base?.taken_at ?? (saved ? current.taken_at : null), verification: current.verification, findings });
  }
  if (o.json) printJson(report);
  else {
    for (const r of report) {
      console.log(`\n== ${r.domain} (${r.baseline}${r.baseline_taken_at ? `; baseline from ${r.baseline_taken_at}` : ''})`);
      if (!r.findings.length && r.verification.status === 'verified') console.log('  ✅ nothing found that needs attention in the checks completed');
      if (r.verification.status !== 'verified') console.log(`  NOT VERIFIED: ${r.verification.unverified_checks.map(e => `${e.check} [${e.kind}] ${e.reason}`).join('; ')}. No conclusion about missing records or changes.`);
      for (const f of r.findings) console.log(`  ${ICON[f.level]} ${f.message}`);
    }
    console.log('\nThese are public-record changes, not proof of wrongdoing. Confirm anything important with the organization.');
  }
  const levels = report.flatMap((r) => r.findings.map((f) => f.level));
  process.exitCode = report.some(r => r.verification.status !== 'verified') ? 3 : levels.includes('urgent') ? 1 : levels.includes('review') ? 3 : 0;
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
