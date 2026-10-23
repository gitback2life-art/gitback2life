#!/usr/bin/env node
// OS egress probe (V4-06): does the OPERATING SYSTEM stop network traffic inside the tests-mode Windows Sandbox,
// with no help from the toolkit? Run DIRECTLY with node (not through run_offline), so neither the Node network guard
// nor run_offline's dead proxy settings are present; curl is also told to ignore proxies.
//
// It separates the possible causes of a failure:
//   controls   curl starts (`--version`); Node can connect to its own listener on 127.0.0.1 (socket stack works)
//   tcp        Node connects to 192.0.2.1:443 with no guard and no proxy → which OS error, and how fast
//   curl       curl --noproxy "*" to the same address → curl's exit code (7 = could not connect; 5 = proxy; 2 = start)
//   dns        a DNS lookup of a .invalid name → "no DNS server reachable" vs "the name does not exist" (= server answered)
//   config     adapters, default routes, DNS servers, firewall profiles, and whether any guard/proxy was present
//
// 192.0.2.1 is TEST-NET-1 (RFC 5737), reserved for documentation: no real host owns it, so even a complete failure
// of containment would deliver nothing to anyone. Refuses to run outside the verified tests-mode sandbox.
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as dnsp } from 'node:dns';
import net from 'node:net';
import { verifyIsolation } from '../../_shared/isolation.mjs';
import { fail, isMain, nowUtc, printJson } from '../../_shared/common.mjs';

export const TARGET = { host: '192.0.2.1', port: 443 };
const CURL = 'C:\\Windows\\System32\\curl.exe';
// Local refusals only. ECONNREFUSED is deliberately NOT here: a refusal means something answered, so a path exists.
const OS_REFUSALS = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM', 'ENETDOWN', 'EADDRNOTAVAIL']);
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];

/** Pure verdict from collected observations. Each check says what it shows; the probe passes only if all do. */
export function classify(obs) {
  const checks = [];
  const add = (id, pass, why) => checks.push({ id, pass, why });
  add('no_guard_or_proxy', !obs.guardLoaded && obs.proxyVarsPresent.length === 0,
    obs.guardLoaded || obs.proxyVarsPresent.length ? `toolkit help present (guard ${obs.guardLoaded}, proxy vars ${obs.proxyVarsPresent.join(',') || 'none'}): results would not isolate the OS` : 'no Node guard, no proxy variables');
  add('control_curl_starts', obs.curlVersion?.status === 0, `curl --version exit ${obs.curlVersion?.status}`);
  add('control_loopback', obs.loopback === 'connected', `Node to its own 127.0.0.1 listener: ${obs.loopback}`);
  const tcp = obs.tcp ?? {};
  const tcpOs = tcp.result === 'error' && OS_REFUSALS.has(tcp.code);
  const tcpTimeoutNoPath = tcp.result === 'timeout' && obs.config?.adaptersUp === 0 && obs.config?.defaultRoutes === 0;
  add('tcp_blocked_by_os', tcpOs || tcpTimeoutNoPath,
    tcp.result === 'connected' ? 'CONNECTED: the OS let traffic out' : tcpOs ? `OS refused immediately (${tcp.code}, ${tcp.ms} ms)`
      : tcpTimeoutNoPath ? `timed out with no adapter up and no default route (${tcp.ms} ms)` : `inconclusive: ${tcp.result} ${tcp.code ?? ''}`);
  const c = obs.curl ?? {};
  add('curl_blocked_by_os', c.status === 7 || (c.status === 28 && obs.config?.adaptersUp === 0 && obs.config?.defaultRoutes === 0),
    c.status === 0 ? 'curl CONNECTED' : c.status === 7 ? 'curl exit 7: could not connect (no proxy involved)' : c.status === 5 ? 'curl exit 5: proxy problem (should be impossible with --noproxy)' : `curl exit ${c.status}: inconclusive`);
  const d = obs.dns ?? {};
  add('dns_unreachable', d.result === 'error' && d.code !== 'ENOTFOUND' && d.code !== 'ENODATA',
    d.result === 'answer' ? 'a DNS server ANSWERED' : d.code === 'ENOTFOUND' || d.code === 'ENODATA' ? `${d.code}: a DNS server answered "no such name", so DNS is reachable` : `no DNS server reachable (${d.code})`);
  return { contained: checks.every((x) => x.pass), checks };
}

function tcpAttempt({ host, port }, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (r) => { s.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
    s.setTimeout(timeoutMs, () => done({ result: 'timeout' }));
    s.once('connect', () => done({ result: 'connected' }));
    s.once('error', (e) => done({ result: 'error', code: e.code, message: e.message }));
  });
}

function loopbackControl() {
  return new Promise((resolve) => {
    const srv = net.createServer((c) => c.destroy()).listen(0, '127.0.0.1', () => {
      const c = net.connect({ host: '127.0.0.1', port: srv.address().port });
      c.once('connect', () => { c.destroy(); srv.close(); resolve('connected'); });
      c.once('error', (e) => { srv.close(); resolve(`error ${e.code}`); });
    });
  });
}

function readConfig() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "@{ adaptersUp = @(Get-NetAdapter | Where-Object { [string]$_.Status -eq 'Up' }).Count",
    "   adapters = @(Get-NetAdapter | ForEach-Object { '{0}={1}' -f $_.Name, $_.Status })",
    "   defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0'; Get-NetRoute -DestinationPrefix '::/0').Count",
    "   dnsServers = @(Get-DnsClientServerAddress | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique)",
    "   profiles = @(Get-NetFirewallProfile | ForEach-Object { '{0}:{1}:{2}' -f $_.Name, $_.Enabled, $_.DefaultOutboundAction }) } | ConvertTo-Json -Depth 4",
  ].join('\n');
  try { return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 })); } catch (e) { return { error: e.message }; }
}

export async function main({ env = process.env } = {}) {
  const iso = verifyIsolation('tests');
  if (!iso.isolated) throw new Error(`refusing: this probe only runs inside the verified tests-mode sandbox:\n  - ${iso.reasons.join('\n  - ')}`);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !PROXY_VARS.includes(k) && k !== 'NODE_OPTIONS'));
  const obs = {
    started_at: nowUtc(), target: TARGET,
    guardLoaded: /network_guard/.test(env.NODE_OPTIONS ?? '') || Boolean(globalThis.__gitback2lifeNetworkGuard),
    proxyVarsPresent: PROXY_VARS.filter((k) => env[k]),
    config: readConfig(),
    curlVersion: (() => { const r = spawnSync(CURL, ['--version'], { encoding: 'utf8', env: childEnv, timeout: 15000 }); return { status: r.status, error: r.error?.code ?? null, first_line: (r.stdout || '').split('\n')[0] }; })(),
    loopback: await loopbackControl(),
    tcp: await tcpAttempt(TARGET),
    curl: (() => { const r = spawnSync(CURL, ['--noproxy', '*', '-sS', '-I', '--connect-timeout', '6', '--max-time', '10', `https://${TARGET.host}/`], { encoding: 'utf8', env: childEnv, timeout: 20000 }); return { status: r.status, error: r.error?.code ?? null, stderr: (r.stderr || '').trim().slice(0, 300) }; })(),
    dns: await new dnsp.Resolver({ timeout: 4000, tries: 1 }).resolve4('gitback2life-egress-probe.invalid').then((a) => ({ result: 'answer', addresses: a }), (e) => ({ result: 'error', code: e.code })),
  };
  const verdict = classify(obs);
  printJson({ ...obs, finished_at: nowUtc(), ...verdict });
  console.log(`\nOS EGRESS PROBE: ${verdict.contained ? 'CONTAINED' : 'NOT PROVEN'}`);
  for (const c of verdict.checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.id}: ${c.why}`);
  process.exitCode = verdict.contained ? 0 : 1;
}

if (isMain(import.meta)) main().catch((e) => fail(e.message));
