#!/usr/bin/env node
// Controlled redirect-chain inspector. DISABLED BY DEFAULT.
// One HEAD request per hop (plus one GET of each site's robots.txt, read as plain text), automatic redirects off,
// every hop validated before contact, no page bodies,
// no JavaScript, no rendering, no downloads, no proxies. Each site's robots.txt is read first and obeyed.
// All requests use the shared guarded transport (_shared/safe_http.mjs) and the shared robots.txt reader.
// Offline validation (`check-url`) is always available.
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson, safeWrite } from '../_shared/common.mjs';
import { checkHop, validateTarget } from '../_shared/guards.mjs';
import { acquire, cached, cooldown, fetchRobotsPolicy, LIMITS, markContacted, printRunReport, sendWatched } from '../_shared/polite.mjs';
import { groupFor, isAllowed, MAX_CRAWL_DELAY_SECONDS, userAgent } from '../_shared/robots.mjs';
import { guardedFetch, guardedRequest } from '../_shared/safe_http.mjs';
import { hasSecretUrlParts } from '../_shared/output.mjs';
import { authorize, provenance, requireScope, ScopeError } from '../_shared/scope.mjs';
import { activeScope } from '../_shared/active_scope.mjs';
import { verifyIsolation } from '../_shared/isolation.mjs';

const UA = userAgent('redirect-inspector');

/** Real hop transport: a single HEAD through the guarded transport. Never reads a body. */
export async function httpHeadTransport(url, { timeoutMs = 8000, signal } = {}) {
  const r = await guardedRequest(url, { method: 'HEAD', timeoutMs, maxBytes: 0, truncate: true, signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
  const location = r.headers.location;
  return { status: r.status, location: typeof location === 'string' ? location.slice(0, 2048) : null, remoteAddress: r.remoteAddress };
}

/** Per-run robots checker: one robots.txt read per site (shared fail-closed reader), reused via polite limits. */
export function makeRobotsCheck({ fetcher = (url) => fetchRobotsPolicy(url, { fetchImpl: guardedFetch }), cache = (key, fn) => cached(key, fn) } = {}) {
  const memo = new Map();
  return async (url) => {
    if (!memo.has(url.origin)) memo.set(url.origin, cache(`robots:${url.origin}`, () => fetcher(url)));
    const info = await memo.get(url.origin);
    const verdict = isAllowed(info.policy, url.href);
    return { ...verdict, basis: info.basis, crawlDelay: groupFor(info.policy).crawlDelay };
  };
}

const stopCode = (e) => (e.code === 'GUARD_BLOCKED' ? 'blocked_by_guard' : e.code === 'POLITE_BUDGET' ? 'stopped_by_limits' : 'request_error');

/** Follow a redirect chain hop by hop. `transport` and `robots` are injectable so tests never touch the network. */
export async function inspectChain(startUrl, { transport = httpHeadTransport, robots = makeRobotsCheck(), maxHops = 5, timeoutMs = 8000, now = nowUtc, allowHop = () => true } = {}) {
  const hops = [];
  const seen = new Set();
  let current;
  try { current = validateTarget(startUrl); } catch (e) { return { start: startUrl, hops, outcome: 'blocked_by_guard', reason: e.message }; }
  for (let i = 0; i < maxHops; i++) {
    if (seen.has(current.href)) return { start: startUrl, hops, outcome: 'loop_detected', reason: `revisited ${current.href}` };
    seen.add(current.href);
    const at = now();
    let permitted;
    try { permitted = allowHop(current); } catch (e) {
      hops.push({ n: i + 1, url: current.href, at, note: `not contacted: ${e.message}` });
      return { start: startUrl, hops, outcome: 'stopped_by_scope', reason: e.message };
    }
    if (!permitted) {
      hops.push({ n: i + 1, url: current.href, at, note: 'not contacted: no authorization for this exact URL' });
      return { start: startUrl, hops, outcome: 'stopped_out_of_scope', reason: `the chain leads to ${current.href}, which has no authorization of its own` };
    }
    let rb;
    try { rb = await robots(current); } catch (e) {
      hops.push({ n: i + 1, url: current.href, at, error: `robots.txt check failed: ${e.message}` });
      return { start: startUrl, hops, outcome: stopCode(e), reason: e.message };
    }
    if (!rb.allowed && /unreach|unavail|could not|not verif|timed out/i.test(rb.basis ?? '')) {
      hops.push({ n: i + 1, url: current.href, at, robots: `not verified: ${rb.basis}` });
      return { start: startUrl, hops, outcome: 'robots_unverified', reason: `robots.txt could not be verified (${rb.basis}); no page request sent` };
    }
    if (!rb.allowed || (rb.crawlDelay ?? 0) > MAX_CRAWL_DELAY_SECONDS) {
      const why = rb.allowed ? `Crawl-delay ${rb.crawlDelay}s is longer than we will wait` : `${rb.rule ?? 'disallowed'} (${rb.basis})`;
      hops.push({ n: i + 1, url: current.href, at, robots: `not requested: ${why}` });
      return { start: startUrl, hops, outcome: 'blocked_by_robots_txt', reason: `the site's robots.txt asks automated tools not to request this page: ${why}` };
    }
    let r;
    try { r = await transport(current, { timeoutMs, crawlDelay: rb.crawlDelay }); } catch (e) {
      hops.push({ n: i + 1, url: current.href, at, method: 'HEAD', error: e.message });
      return { start: startUrl, hops, outcome: stopCode(e), reason: e.message };
    }
    const hop = { n: i + 1, url: current.href, at, method: 'HEAD', status: r.status, location: r.location ?? null,
      remote_address: r.remoteAddress ?? null, robots: `allowed${rb.rule ? ` (${rb.rule})` : ''}; ${rb.basis}` };
    hops.push(hop);
    if (!(r.status >= 300 && r.status < 400 && r.location)) return { start: startUrl, hops, outcome: 'final_response', final_url: current.href };
    try { current = checkHop(current, new URL(r.location, current)); } catch (e) {
      hop.next_blocked = e.message;
      return { start: startUrl, hops, outcome: 'blocked_by_guard', reason: `redirect target refused: ${e.message}` };
    }
  }
  return { start: startUrl, hops, outcome: 'max_hops_reached', reason: `stopped after ${maxHops} hops` };
}

/**
 * F02: each live destination needs its own authorization: the live action, the target_website disclosure, and a
 * fresh operator attestation for that EXACT URL. Being on an attested domain is not enough.
 * F12: `fresh` returns the current scope before each hop; the CLI passes the active scope's recheck, which re-reads
 * the scope file and throws if it was stopped, expired or narrowed since the command started.
 */
export function liveHopAuthorizer(scope, fresh = () => scope) {
  return (u) => authorize(fresh(), { action: 'live_http_inspection', target: u.href, services: ['target_website'] }).allowed;
}

/**
 * The live transport: wait for the polite slot, then (V4-03) re-confirm this exact URL's authorization from the
 * fresh scope file immediately before sending. A site's Crawl-delay only ever widens the 1-second spacing.
 */
export function liveTransport(scope, { acquireFn = acquire, send = httpHeadTransport, fresh = () => activeScope().recheck() } = {}) {
  return async (u, opts) => {
    const minIntervalMs = Math.max(LIMITS.minIntervalMs, (opts.crawlDelay ?? 0) * 1000);
    await acquireFn(u.host, { limits: { ...LIMITS, minIntervalMs } });
    const check = () => { if (!liveHopAuthorizer(scope, fresh)(u)) throw new ScopeError(`${u.href} is no longer authorized; not sent`); };
    check();
    // F12: keep checking while the request is in flight; a stop or withdrawn attestation aborts it.
    return sendWatched((signal) => send(u, { ...opts, signal }), { check });
  };
}

/** Live use needs: --live, a per-URL --approve, a declared isolated environment, and no check of this URL in the last day. */
export function liveGate({ url, approve, live, env = process.env, recent = { allowed: true, last: null }, isolation = { isolated: false, reasons: ['isolation was not checked'] } }) {
  const reasons = [];
  if (!recent.allowed) reasons.push(`this URL was already checked at ${recent.last}; live checks of the same URL are limited to once every ${LIMITS.liveCooldownHours} hours`);
  if (!live) reasons.push('live inspection is disabled by default; pass --live');
  if (approve !== url) reasons.push('--approve must repeat the exact URL being inspected (approval is per URL)');
  // The real operating-system state is checked (_shared/isolation.mjs); a typed setting alone never counts.
  if (!isolation.isolated) for (const why of isolation.reasons) reasons.push(`not isolated: ${why}`);
  if (env.NODE_USE_ENV_PROXY || env.HTTP_PROXY || env.HTTPS_PROXY) reasons.push('proxy environment variables are set; implicit proxies are not allowed');
  return { allowed: reasons.length === 0, reasons };
}

const WARNING = `WARNING: a live request is logged by the site operator, may change server-side counters,
and reveals this machine's IP address. Pages get HEAD requests only (no page content is downloaded); each site's
robots.txt is fetched once with GET first and read as plain text.`;

const HELP = `redirect_inspector: hop-by-hop redirect chain inspection (DISABLED BY DEFAULT).

  check-url <url>                       offline: would this URL be allowed? (no network)
  inspect <url> --scope FILE --live --approve <url>  live HEAD chain, only inside the verified inspect-mode sandbox
       (sandbox_setup create --mode inspect). The tool checks the real system: sandbox account, firewall
       default-block on every profile, exactly the gitback2life rules, nothing else allowed out.
       The scope must permit live_http_inspection, list the URL's site as a target, allow target_website,
       and hold a fresh operator attestation for this exact URL (incident_intake approve). An attestation is the
       operator's statement, not proof that a person approved.
       [--max-hops N (1-5, default 5)] [--timeout-ms N] [--json] [--save FILE]

Polite limits: at most 5 HEAD requests per check, 1 per second, and the same URL at most once every 24 hours.
robots.txt: read once per site before any page request (reused 12 hours) and obeyed, including Crawl-delay.
If robots.txt is unreachable or returns a server error, the site is treated as off-limits (RFC 9309).
Sites can address this tool with "User-agent: gitback2life".

Prefer domain_research (passive) first. Live inspection stays off until it runs in an isolated environment.`;

export async function main(argv) {
  const { values: o, positionals: [cmd, url] } = parseArgs({ args: argv, allowPositionals: true, options: {
    live: { type: 'boolean' }, approve: { type: 'string' }, 'max-hops': { type: 'string' }, 'timeout-ms': { type: 'string' },
    json: { type: 'boolean' }, save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    scope: { type: 'string' },
  } });
  if (!cmd || o.help) return console.log(HELP);
  if (cmd === 'check-url') {
    try { const u = validateTarget(url); console.log(`allowed by URL guard: ${u.href}\n(DNS answers are validated again at connect time)`); }
    catch (e) { console.log(`REFUSED: ${e.message}`); process.exitCode = 1; }
    return;
  }
  if (cmd !== 'inspect') throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  // F07: a URL carrying credentials or secret-looking parts is refused before it is sent, approved or stored.
  if (hasSecretUrlParts(url)) throw new Error('refusing a URL that carries credentials or secret-looking parameters');
  const scope = requireScope(o.scope, { action: 'live_http_inspection', target: url, services: ['target_website'] });
  if (o.save) requireScope(o.scope, { action: 'save_local' });
  const g = liveGate({ url, approve: o.approve, live: o.live, recent: cooldown(`redirect_inspector:${url}`), isolation: verifyIsolation('inspect') });
  if (!g.allowed) {
    console.log('Live inspection NOT run:');
    g.reasons.forEach((r) => console.log(`  - ${r}`));
    console.log('Passive alternative: node domain_research/domain_research.mjs all <domain>');
    process.exitCode = 1;
    return;
  }
  console.error(WARNING);
  const politeTransport = liveTransport(scope);
  const maxHops = Math.min(Math.max(1, Number(o['max-hops'] ?? 5)), 5);
  markContacted(`redirect_inspector:${url}`);
  const result = await inspectChain(url, { transport: politeTransport, maxHops, timeoutMs: Number(o['timeout-ms'] ?? 8000), allowHop: liveHopAuthorizer(scope, () => activeScope().recheck()) });
  if (o.json) printJson(result);
  else {
    console.log(`chain from ${result.start}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    for (const h of result.hops) {
      console.log(`  ${h.n}. ${h.at} ${h.method ?? '(no request)'} ${h.url} → ${h.error ?? h.status ?? ''}${h.location ? `  Location: ${h.location}` : ''}${h.next_blocked ? `  [next hop refused: ${h.next_blocked}]` : ''}`);
      if (h.robots) console.log(`       robots.txt: ${h.robots}`);
    }
  }
  if (o.save) console.log(`saved ${safeWrite(o.save, JSON.stringify({ ...result, provenance: provenance() }, null, 2) + '\n', { overwrite: o.overwrite })}`);
  if (!['final_response', 'loop_detected', 'max_hops_reached'].includes(result.outcome)) {
    console.log('NOT VERIFIED: the redirect chain was not fully inspected; do not infer a redirect or compromise from this stop.');
    process.exitCode = 3;
  }
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
