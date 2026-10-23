#!/usr/bin/env node
// lookalike_domain_check: which typo/lookalike versions of an organization's domain are registered?
// Passive: one DNS question per lookalike (does it have nameservers?), plus optional registration dates for a few.
// Never visits any lookalike site. Results say "registered", never "scam": many lookalikes are owned by the
// organization itself, parked, or belong to someone unrelated.
import { Resolver } from 'node:dns/promises';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson } from '../_shared/common.mjs';
import { acquire, cached, printRunReport } from '../_shared/polite.mjs';
import { normalizeDomain, rdap } from '../domain_research/domain_research.mjs';
import { authorizeDerivedTarget, requireScope } from '../_shared/scope.mjs';
import { coverage, failureRecord } from '../_shared/assessment_status.mjs';

export const PER_RUN = 25;          // lookalikes checked per run (DNS budget is 30 per service per run)
export const MAX_RDAP = 5;          // registration-date lookups per run
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'me.uk', 'com.au', 'org.au', 'net.au', 'co.nz', 'org.nz', 'com.br', 'org.br']);
const TLD_SWAPS = ['com', 'org', 'net', 'info', 'co'];
const HOMOGLYPHS = [['o', '0'], ['0', 'o'], ['l', '1'], ['1', 'l'], ['i', 'l'], ['l', 'i'], ['rn', 'm'], ['m', 'rn'], ['vv', 'w'], ['w', 'vv'], ['cl', 'd']];

export function splitDomain(domain) {
  const labels = normalizeDomain(domain).replace(/^www\./, '').split('.');
  const two = labels.slice(-2).join('.');
  const suffix = MULTI_PART_SUFFIXES.has(two) && labels.length >= 3 ? two : labels.at(-1);
  const name = labels[labels.length - suffix.split('.').length - 1];
  if (!name) throw new Error('give the organization\'s main domain, e.g. kittensandbarbells.org');
  return { name, suffix };
}

const validLabel = (s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s);

/** Lookalikes in priority order (most commonly abused kinds first), de-duplicated, never including the original. */
export function generateVariants(domain) {
  const { name, suffix } = splitDomain(domain);
  const original = `${name}.${suffix}`;
  const out = new Map();
  const add = (label, tld, kind) => {
    const d = `${label}.${tld}`;
    if (d !== original && validLabel(label) && !out.has(d)) out.set(d, kind);
  };
  for (const t of TLD_SWAPS) if (t !== suffix) add(name, t, 'different ending');
  for (const [from, to] of HOMOGLYPHS) {
    for (let i = name.indexOf(from); i >= 0; i = name.indexOf(from, i + 1)) add(name.slice(0, i) + to + name.slice(i + from.length), suffix, 'look-alike characters');
  }
  if (name.includes('-')) add(name.replaceAll('-', ''), suffix, 'hyphen removed');
  for (let i = 0; i < name.length; i++) add(name.slice(0, i) + name.slice(i + 1), suffix, 'missing letter');
  for (let i = 0; i < name.length - 1; i++) {
    if (name[i] !== name[i + 1]) add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2), suffix, 'swapped letters');
  }
  for (let i = 0; i < name.length; i++) add(name.slice(0, i + 1) + name[i] + name.slice(i + 1), suffix, 'doubled letter');
  add(`www${name}`, suffix, 'missing dot after www');
  return [...out].map(([domain, kind]) => ({ domain, kind }));
}

/** DNS answer → status. NXDOMAIN means no registration is visible; anything else uncertain stays "unknown". */
export function classify(result) {
  if (Array.isArray(result) && result.length) return 'registered';
  if (result?.code === 'ENOTFOUND') return 'not found';
  if (result?.code === 'ENODATA') return 'registered'; // the name exists but publishes no nameservers here
  return 'unknown';
}

export async function checkVariants(variants, { resolver } = {}) {
  const r = new Resolver({ timeout: 5000, tries: 1 });
  if (resolver) r.setServers([resolver]);
  const server = r.getServers().join(',') || 'system';
  const results = [];
  for (const v of variants) {
    const status = await cached(`lookalike:ns:${v.domain}`, async () => {
      await acquire(`dns:${server}`);
      try { return { status: classify(await r.resolveNs(v.domain)) }; } catch (e) {
        const status = classify(e);
        return { status, error: e.code ?? e.message, ...(status === 'unknown' ? { ttl_hours: 1 } : {}) };
      }
    });
    results.push({ ...v, status: status.status, ...(status.error && status.status === 'unknown' ? { error: status.error } : {}) });
  }
  return { resolver: server, results };
}

export function recentRegistration(created, now = Date.now()) {
  return Boolean(created) && (now - Date.parse(created)) / 864e5 <= 90;
}

const NOTE = 'Registered lookalikes are not evidence of wrongdoing: many belong to the organization itself (defensive\n'
  + 'registrations), are parked, or are owned by someone unrelated. This tool never visits them. Compare with the\n'
  + 'organization\'s own list of domains, and treat a recently registered one as something to review, not a verdict.';

const HELP = `lookalike_domain_check: which typo/lookalike versions of a domain are registered? (DNS only, never visits)

  check <domain> --scope FILE [--offset N] [--rdap] [--resolver IP] [--json]
  list  <domain>                    show the lookalikes that would be checked (no network)

Checks ${PER_RUN} lookalikes per run, most commonly abused kinds first; --offset ${PER_RUN} checks the next batch.
--rdap looks up registration dates for up to ${MAX_RDAP} registered ones and marks any registered in the last 90 days.

${NOTE}`;

export async function main(argv) {
  const { values: o, positionals: [cmd, target] } = parseArgs({ args: argv, allowPositionals: true, options: {
    offset: { type: 'string' }, rdap: { type: 'boolean' }, resolver: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }, scope: { type: 'string' },
  } });
  if (!['check', 'list'].includes(cmd) || !target || o.help) return console.log(HELP);
  const all = generateVariants(target);
  if (cmd === 'list') {
    all.forEach((v, i) => console.log(`${String(i).padStart(3)}  ${v.domain.padEnd(40)} ${v.kind}`));
    return console.log(`\n${all.length} lookalikes; ${Math.ceil(all.length / PER_RUN)} run(s) of ${PER_RUN} to check them all.`);
  }
  const scope = requireScope(o.scope, { action: 'passive_lookup', target, services: ['dns', ...(o.rdap ? ['rdap'] : [])] });
  // The scope lists the TARGET; the names checked here are generated from it and are not in the scope. Each one is
  // disclosed to the DNS resolver (and RDAP), so this needs its own explicit opt-in.
  if (scope.allow_derived_lookalikes !== true) {
    throw new Error('this scope does not allow looking up generated lookalike names (they are not listed targets, and each one is sent to the DNS resolver). Set "allow_derived_lookalikes": true in the scope to allow it, or use "list" (no network).');
  }
  const offset = Math.max(0, Number(o.offset ?? 0) || 0);
  const batch = all.slice(offset, offset + PER_RUN);
  if (!batch.length) throw new Error(`offset ${offset} is past the end (${all.length} lookalikes)`);
  const { resolver, results } = await checkVariants(batch, { resolver: o.resolver });
  if (o.rdap) {
    for (const r of results.filter((x) => x.status === 'registered').slice(0, MAX_RDAP)) {
      try {
        authorizeDerivedTarget(r.domain); // V4-01: each generated name is authorized explicitly before its RDAP lookup
        const info = await cached(`lookalike:rdap:${r.domain}`, () => rdap(r.domain));
        r.registered_on = info.registered ?? null;
        r.recently_registered = recentRegistration(info.registered);
      } catch (e) {
        if (e.code === 'SCOPE_BLOCKED' || e.code === 'POLITE_BUDGET') throw e;
        r.rdap_error = e.message;
      }
    }
  }
  const missing = results.flatMap((r) => [
    ...(r.status === 'unknown' ? [failureRecord(`dns:${r.domain}`, r.error ?? 'DNS response could not be verified')] : []),
    ...(r.rdap_error ? [failureRecord(`rdap:${r.domain}`, r.rdap_error)] : []),
  ]);
  const verification = coverage(results.filter((r) => r.status !== 'unknown').map((r) => `dns:${r.domain}`), missing);
  const out = { domain: target, checked_at: nowUtc(), resolver, offset, checked: batch.length, total_lookalikes: all.length, results, verification };
  if (o.json) { printJson(out); if (missing.length) process.exitCode = 3; return; }
  console.log(`Lookalikes ${offset + 1}-${offset + batch.length} of ${all.length} for ${target} (DNS via ${resolver}, ${out.checked_at})\n`);
  for (const r of results) {
    const mark = r.status === 'registered' ? (r.recently_registered ? '🟡 registered (recently)' : '🔵 registered') : r.status === 'not found' ? '   not found' : '⚪ unknown';
    console.log(`  ${mark.padEnd(26)} ${r.domain.padEnd(40)} ${r.kind}${r.registered_on ? `  [registered ${r.registered_on.slice(0, 10)}]` : ''}`);
  }
  const reg = results.filter((r) => r.status === 'registered').length;
  console.log(`\n${reg} of ${results.length} registered; ${missing.length} checks not verified.${offset + PER_RUN < all.length ? ` Next batch: --offset ${offset + PER_RUN}` : ''}\n\n${NOTE}`);
  for (const m of missing) console.log(`  NOT VERIFIED: ${m.check} [${m.kind}] ${m.reason}`);
  if (missing.length) process.exitCode = 3;
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
