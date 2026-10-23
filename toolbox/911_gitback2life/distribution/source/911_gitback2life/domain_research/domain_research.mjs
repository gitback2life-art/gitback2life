#!/usr/bin/env node
// Passive domain research: registration (RDAP), DNS, certificate transparency, and web-archive history.
// These look up EXISTING public records. Nothing here visits the target website or submits it to a scanner.
// Note: each lookup service (rdap.org/registry, your DNS resolver, crt.sh, web.archive.org) sees the domain you ask about.
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson, safeWrite } from '../_shared/common.mjs';
import { acquire, cached, politeFetch, printRunReport } from '../_shared/polite.mjs';
import { userAgent } from '../_shared/robots.mjs';
import { inScope, provenance, requireScope } from '../_shared/scope.mjs';
import { activeScope } from '../_shared/active_scope.mjs';

const MAX_ARCHIVE_ROWS = 100;

const UA = userAgent('domain-research');
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const DOH = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};

/** Accept a hostname or URL copied from evidence; refuse IPs and internal-looking names. */
export function normalizeDomain(input) {
  let h = String(input ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = new URL(h).hostname;
  h = h.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (isIP(h)) throw new Error('IP addresses are not accepted; use the exact domain from the source evidence');
  if (!HOST_RE.test(h)) throw new Error(`not a valid public hostname: ${input}`);
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa|corp|intranet)$/.test(h)) throw new Error('internal-looking hostnames are refused');
  return h;
}

async function get(url, accept, ms, fetchImpl) {
  return fetchImpl(url, { headers: { Accept: accept, 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
}

export function summarizeRdap(j, queried, server) {
  const ev = Object.fromEntries((j.events ?? []).map((e) => [e.eventAction, e.eventDate]));
  const registrar = (j.entities ?? []).find((e) => e.roles?.includes('registrar'));
  const fn = registrar?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] ?? null;
  return {
    queried, found: true, ldh_name: j.ldhName ?? null, rdap_server: server, status: j.status ?? [],
    registered: ev.registration ?? null, expires: ev.expiration ?? null, last_changed: ev['last changed'] ?? null,
    rdap_db_updated: ev['last update of RDAP database'] ?? null, registrar: fn,
    nameservers: (j.nameservers ?? []).map((n) => n.ldhName?.toLowerCase()).filter(Boolean),
  };
}

/**
 * RDAP via the rdap.org bootstrap. Tries the name, then parents (www.x.org → x.org), but a parent is only queried
 * when the active scope covers it (a listed target or a subdomain of one); otherwise the walk stops. Without an
 * active scope (direct library use) only the name itself is queried.
 */
export async function rdap(domain, { fetchImpl = politeFetch, mayQuery } = {}) {
  const ctx = activeScope();
  const allowed = mayQuery ?? ((name) => name === domain || Boolean(ctx && inScope(ctx.scope, name)));
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.');
    if (!allowed(candidate)) {
      return { looked_up_at: nowUtc(), queried: domain, found: false, note: `No RDAP record for ${domain}; its parent ${candidate} is not in the scope, so it was not looked up.` };
    }
    const res = await get(`https://rdap.org/domain/${candidate}`, 'application/rdap+json, application/json', 20_000, fetchImpl);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
    return { looked_up_at: nowUtc(), ...summarizeRdap(await res.json(), candidate, res.url) };
  }
  return { looked_up_at: nowUtc(), queried: domain, found: false, note: 'No RDAP record for the name or its parents. Absence is not proof the domain is unregistered; some TLDs lack RDAP.' };
}

const RTYPES = ['A', 'AAAA', 'CNAME', 'NS', 'MX'];

/** DNS via the system (or a chosen) resolver. TTLs: A/AAAA only with this method; use --doh for all TTLs. */
export async function dnsLookup(domain, { resolver, resolverFactory = (options) => new Resolver(options) } = {}) {
  const r = resolverFactory({ timeout: 5000, tries: 2 });
  if (resolver) {
    if (!isIP(resolver)) throw new Error('--resolver must be an IP address, e.g. 1.1.1.1');
    r.setServers([resolver]);
  }
  const out = { domain, method: 'node:dns', resolver_servers: r.getServers(), resolver_source: resolver ? 'explicit --resolver' : 'system default', looked_up_at: nowUtc(), records: {} };
  const q = async (type, fn) => {
    await acquire(`dns:${out.resolver_servers.join(',') || 'system'}`);
    try { out.records[type] = await fn(); } catch (e) { out.records[type] = { none: e.code ?? e.message }; }
  };
  await q('A', () => r.resolve4(domain, { ttl: true }));
  await q('AAAA', () => r.resolve6(domain, { ttl: true }));
  await q('CNAME', () => r.resolveCname(domain));
  await q('NS', () => r.resolveNs(domain));
  await q('MX', () => r.resolveMx(domain));
  const verification = assessDnsRecords(out.records);
  return { ...out, verification, ...(verification.status !== 'verified' ? { ttl_hours: 1 } : {}) };
}

/** DNS-over-HTTPS JSON lookup: gives TTLs for every type and names the resolver precisely. */
export async function dohLookup(domain, provider = 'cloudflare', { fetchImpl = politeFetch } = {}) {
  const base = DOH[provider];
  if (!base) throw new Error(`--doh must be one of ${Object.keys(DOH).join(', ')}`);
  const out = { domain, method: 'DNS-over-HTTPS', resolver: base, looked_up_at: nowUtc(), records: {} };
  for (const type of RTYPES) {
    try {
      const res = await get(`${base}?name=${encodeURIComponent(domain)}&type=${type}`, 'application/dns-json', 10_000, fetchImpl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const answers = (j.Answer ?? []).map((a) => ({ name: a.name, type: a.type, ttl: a.TTL, data: a.data }));
      out.records[type] = answers.length ? answers : { none: `status ${j.Status}` };
    } catch (e) { out.records[type] = { error: e.message }; }
  }
  const verification = assessDnsRecords(out.records);
  return { ...out, verification, ...(verification.status !== 'verified' ? { ttl_hours: 1 } : {}) };
}

// Distinguish a real negative DNS reply from inability to query the resolver.
// Failed lookups must never appear as proof that a domain has no records.
const NEGATIVE_DNS = new Set(['ENOTFOUND', 'ENODATA', 'ENODOMAIN', 'ENONAME', 'status 0', 'status 3']);
export function assessDnsRecords(records) {
  const verified_record_types = [];
  const unverified_record_types = [];
  for (const type of RTYPES) {
    const answer = records?.[type];
    if (Array.isArray(answer) || (answer && typeof answer.none === 'string' && NEGATIVE_DNS.has(answer.none))) {
      verified_record_types.push(type);
    } else {
      unverified_record_types.push({ type, reason: String(answer?.error ?? answer?.none ?? 'no resolver response') });
    }
  }
  const status = unverified_record_types.length === 0 ? 'verified'
    : verified_record_types.length === 0 ? 'unverified' : 'partial';
  return { status, verified_record_types, unverified_record_types,
    note: status === 'verified' ? 'Resolver answered each requested type; this does not establish website safety.'
      : 'One or more DNS types could not be verified. Connection/refusal/timeout errors are not proof of missing DNS records.' };
}

export function explainLookupFailure(error) {
  const message = String(error?.message ?? error);
  const code = String(error?.code ?? '');
  if (code === 'SCOPE_BLOCKED' || /blocked by scope|scope no longer allows|protected authority/i.test(message)) {
    return { kind: 'scope_not_authorized', message,
      guidance: 'Review the existing incident scope and approved services. Never bypass a refused scope.' };
  }
  if (code === 'POLITE_BUDGET' || /budget.*reached|cool-down|already ran at/i.test(message)) {
    return { kind: 'request_limit', message,
      guidance: 'Use already saved results or wait for the existing rate limit; do not reset counters.' };
  }
  if (code === 'ROBOTS_DISALLOWED') {
    if (/could not be verified|unreachable|redirect refused|redirected more than/i.test(message)) {
      return { kind: 'robots_unavailable', message,
        guidance: 'The lookup provider robots.txt was unreachable or could not be verified. No permission conclusion can be drawn. Check this computer or execution environment DNS/HTTPS access; the lookup remains blocked.' };
    }
    return { kind: 'robots_disallowed', message,
      guidance: 'The lookup provider explicitly disallows this request; keep the restriction in place.' };
  }
  if (/EAI_AGAIN|ECONNREFUSED|ETIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|DNS|fetch failed/i.test(`${code} ${message}`)) {
    return { kind: 'network_unavailable', message,
      guidance: 'The execution environment could not reach a resolver or lookup provider. This is not a conclusion about the target. Verify permitted DNS/HTTPS access on a suitable machine; do not loosen the incident scope.' };
  }
  return { kind: 'service_or_unknown_failure', message,
    guidance: 'The check was not verified. Review the specific service error; do not infer anything about the target.' };
}

export function summarizeLookupResults(results, failed = []) {
  const dns = results?.dns?.verification;
  return { status: failed.length ? 'incomplete' : dns && dns.status !== 'verified' ? 'incomplete' : 'complete',
    note: 'Only successful, verified service responses are findings. Unreachable services are not evidence of a target problem.' };
}

export function summarizeCt(rows, domain, limit = 15) {
  const seen = new Map();
  for (const r of rows) {
    const key = r.serial_number ?? r.id;
    if (!seen.has(key)) seen.set(key, r);
  }
  const certs = [...seen.values()]
    .map((r) => ({ crtsh_id: r.id, issuer: r.issuer_name, not_before: r.not_before, not_after: r.not_after, names: String(r.name_value ?? '').split('\n') }))
    .sort((a, b) => String(b.not_before).localeCompare(String(a.not_before)));
  const issuers = [...new Set(certs.map((c) => /O=([^,]+)/.exec(c.issuer ?? '')?.[1] ?? c.issuer))];
  return {
    domain, source: `https://crt.sh/?q=${domain}`, total_unique: certs.length,
    earliest_not_before: certs.at(-1)?.not_before ?? null, latest_not_before: certs[0]?.not_before ?? null,
    issuers, recent: certs.slice(0, limit),
  };
}

export async function certTransparency(domain, { limit = 15, fetchImpl = politeFetch } = {}) {
  const res = await get(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, 'application/json', 60_000, fetchImpl);
  if (!res.ok) throw new Error(`crt.sh HTTP ${res.status} (crt.sh is often overloaded; retry later)`);
  return { looked_up_at: nowUtc(), ...summarizeCt(await res.json(), domain, limit) };
}

const tsToIso = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;

export function summarizeCdx(rows, target) {
  const [header, ...data] = rows;
  if (!header) return { target, captures: [], note: 'No captures returned. Absence of archive captures is not evidence either way.' };
  const captures = data
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
    .map((c) => ({ ...c, captured_at: tsToIso(c.timestamp), wayback_url: `https://web.archive.org/web/${c.timestamp}/${c.original}` }));
  return {
    target, source: 'Wayback Machine CDX API', captures,
    first: captures[0]?.captured_at ?? null, last: captures.at(-1)?.captured_at ?? null,
    redirect_captures: captures.filter((c) => /^3/.test(c.statuscode)).length,
  };
}

/** Most recent archive captures (one per month). 3xx captures are historical redirects worth a look. */
export async function archiveHistory(target, { limit = 40, from, fetchImpl = politeFetch } = {}) {
  const rows = Math.min(Math.max(1, Number(limit) || 40), MAX_ARCHIVE_ROWS);
  const params = new URLSearchParams({ url: target, output: 'json', fl: 'timestamp,statuscode,original,mimetype', collapse: 'timestamp:6', limit: `-${rows}` });
  if (from) params.set('from', from);
  const res = await get(`https://web.archive.org/cdx/search/cdx?${params}`, 'application/json', 60_000, fetchImpl);
  if (!res.ok) throw new Error(`Wayback CDX HTTP ${res.status}`);
  const text = await res.text();
  return { looked_up_at: nowUtc(), ...summarizeCdx(text.trim() ? JSON.parse(text) : [], target) };
}

const HELP = `domain_research: passive lookups of existing public records (no visits to the site, no scanner submissions).

  rdap    <domain>                         registration, expiry, registrar, nameservers
  dns     <domain> [--resolver IP | --doh cloudflare|google] (DoH requires scoped disclosure)
  ct      <domain> [--limit N]             certificate transparency history (crt.sh)
  archive <domain-or-url> [--limit N] [--from YYYY]   Wayback captures, one per month
  all     <domain> [--doh cloudflare|google]  run all four; report incomplete checks clearly

Options: --scope FILE (required)  --json  --save FILE  --overwrite  --refresh
Polite limits: 1 request/second per service, capped per command; answers are reused for 12 hours
(--refresh still waits at least 1 hour). Each command ends with a count of what was sent.
A missing result is not proof of safety or wrongdoing. Record lookup times with any finding.`;

function show(title, data, o) {
  if (o.json) return printJson(data);
  console.log(`\n== ${title} ==`);
  console.log(JSON.stringify(data, null, 2));
}

export async function main(argv) {
  const { values: o, positionals: [cmd, target] } = parseArgs({ args: argv, allowPositionals: true, options: {
    resolver: { type: 'string' }, doh: { type: 'string' }, limit: { type: 'string' }, from: { type: 'string' },
    json: { type: 'boolean' }, save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    refresh: { type: 'boolean' }, scope: { type: 'string' },
  } });
  if (!cmd || o.help) return console.log(HELP);
  if (!target) throw new Error(`${cmd} needs a domain\n\n${HELP}`);
  const limit = o.limit ? Number(o.limit) : undefined;
  const domain = cmd === 'archive' ? target : normalizeDomain(target);
  const SERVICE_FOR = { rdap: ['rdap'], dns: [o.doh ? 'doh' : 'dns'], ct: ['certificate_logs'], archive: ['web_archive'] };
  const services = cmd === 'all' ? [...new Set(Object.values(SERVICE_FOR).flat())] : SERVICE_FOR[cmd] ?? [];
  requireScope(o.scope, { action: 'passive_lookup', target: domain, services });
  if (o.save) requireScope(o.scope, { action: 'save_local' });
  const viaCache = (name, fn) => cached(`domain_research:${name}:${domain}:${o.resolver ?? ''}:${o.doh ?? ''}:${limit ?? ''}:${o.from ?? ''}`, fn, { refresh: o.refresh });
  const tasks = {
    rdap: () => viaCache('rdap', () => rdap(domain)),
    dns: () => viaCache('dns', () => (o.doh ? dohLookup(domain, o.doh) : dnsLookup(domain, { resolver: o.resolver }))),
    ct: () => viaCache('ct', () => certTransparency(domain, { limit })),
    archive: () => viaCache('archive', () => archiveHistory(cmd === 'archive' ? target : domain, { limit, from: o.from })),
  };
  let result;
  if (cmd === 'all') {
    result = { domain, started_at: nowUtc(), completed: [], partial: [], failed: [], results: {} };
    for (const [name, fn] of Object.entries(tasks)) {
      try {
        result.results[name] = await fn();
        if (name === 'dns' && result.results.dns.verification?.status !== 'verified') {
          const status = result.results.dns.verification.status;
          if (status === 'partial') result.partial.push('dns');
          else result.failed.push({ check: 'dns', kind: 'network_unavailable', error: 'DNS resolver replies were unavailable or inconclusive' });
        } else result.completed.push(name);
        show(name, result.results[name], o);
      } catch (e) { result.failed.push({ check: name, ...explainLookupFailure(e) }); }
    }
    result.assessment = summarizeLookupResults(result.results, result.failed);
    if (result.partial.length) result.assessment.status = 'incomplete';
    console.log(`\nVerified checks: ${result.completed.join(', ') || 'none'}`);
    if (result.partial.length) console.log(`PARTIAL: ${result.partial.join(', ')} (some DNS types not verified)`);
    for (const f of result.failed) console.log(`NOT VERIFIED: ${f.check} [${f.kind}] ${f.error ?? f.message}\n  ${f.guidance ?? 'No conclusion about the target.'}`);
    if (result.assessment.status === 'incomplete') {
      console.log('RESEARCH INCOMPLETE: lookup/network failures do not prove a target is safe, unsafe or missing DNS records.');
      process.exitCode = 2;
    }
  } else if (tasks[cmd]) {
    result = await tasks[cmd]();
    show(cmd, result, o);
    if (cmd === 'dns' && result.verification.status !== 'verified') {
      console.log(`DNS ${result.verification.status.toUpperCase()}: this is not a verified DNS assessment.`);
      process.exitCode = 2;
    }
  } else throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  if (o.save) console.log(`saved ${safeWrite(o.save, JSON.stringify({ ...result, provenance: provenance() }, null, 2) + '\n', { overwrite: o.overwrite })}`);
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
