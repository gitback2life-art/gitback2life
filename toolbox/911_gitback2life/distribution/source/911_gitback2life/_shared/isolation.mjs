// Isolation check: verifies the ACTUAL operating-system state before live inspection or untrusted test runs.
// A setting someone can type (like GITBACK2LIFE_ISOLATED=1) is never enough on its own. Read-only: it only
// queries Windows (account name, firewall profiles, firewall rule FILTERS, network adapters) and changes nothing.
//
// F03: rule names and counts prove nothing, so every gitback2life rule's effective filters (action, protocol,
// ports, remote addresses, program, profile) are compared with an exact expected set. Anything missing, extra,
// changed or unreadable fails closed.
//
// Modes (each produced by sandbox_setup):
//   inspect  Windows Sandbox; all three profiles block outbound by default; exactly four gitback2life rules:
//            DHCP, DNS to the sandbox resolver, web ports 80/443, and the private/reserved-range block rule.
//   tests    Windows Sandbox with networking turned off: no connected adapter; only the block rule; no allow rules.
//
// Not verified here (documented limits): that host folders are mapped read-only; that the account is really a
// disposable sandbox (the account name is a signal, not attestation); IPv6 web traffic is allowed to any public
// address by the firewall and restricted only by the application's own guards.
import { runPowerShell } from './system_exec.mjs';
import { isIP } from 'node:net';
import os from 'node:os';
import { BLOCKED_RANGES } from '../sandbox_setup/sandbox_setup.mjs';

export const SANDBOX_ACCOUNT = 'WDAGUtilityAccount'; // the built-in account Windows Sandbox runs as
const PROFILES = ['Domain', 'Private', 'Public'];

const STATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$profiles = @(Get-NetFirewallProfile | ForEach-Object { @{ name = [string]$_.Name; enabled = [bool]$_.Enabled; defaultOutbound = [string]$_.DefaultOutboundAction } })',
  "$out = @(Get-NetFirewallRule -Direction Outbound | Where-Object { [string]$_.Enabled -eq 'True' })",
  "$rules = @($out | Where-Object { $_.DisplayName -like 'gb2l *' } | ForEach-Object {",
  '  $pf = $_ | Get-NetFirewallPortFilter; $af = $_ | Get-NetFirewallAddressFilter; $ap = $_ | Get-NetFirewallApplicationFilter',
  '  $sf = $_ | Get-NetFirewallServiceFilter; $if = $_ | Get-NetFirewallInterfaceTypeFilter',
  '  @{ name = [string]$_.DisplayName; action = [string]$_.Action; profile = [string]$_.Profile; protocol = [string]$pf.Protocol',
  '     localPort = @($pf.LocalPort | ForEach-Object { [string]$_ }); remotePort = @($pf.RemotePort | ForEach-Object { [string]$_ })',
  '     remoteAddress = @($af.RemoteAddress | ForEach-Object { [string]$_ }); localAddress = @($af.LocalAddress | ForEach-Object { [string]$_ })',
  '     program = [string]$ap.Program; service = [string]$sf.Service; interfaceType = [string]$if.InterfaceType } })',
  // V4-04: the sandbox's ACTUAL DNS servers, the same query the setup script uses to build the DNS rule.
  '$resolvers = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { [string]$_ })',
  "@{ profiles = $profiles; rules = $rules; resolverAddresses = $resolvers",
  "   otherAllow = @($out | Where-Object { [string]$_.Action -eq 'Allow' -and $_.DisplayName -notlike 'gb2l *' }).Count",
  "   adaptersUp = @(Get-NetAdapter | Where-Object { [string]$_.Status -eq 'Up' }).Count } | ConvertTo-Json -Depth 6",
].join('\n');

/** Read the facts the check needs. Windows only; read-only PowerShell queries. */
export function readSystemState({ platform = process.platform, run } = {}) {
  const base = { platform, username: os.userInfo().username };
  if (platform !== 'win32') return base;
  const out = runPowerShell(STATE_SCRIPT, run ? { run } : {}); // V6-03: pinned PowerShell, constructed environment
  return { ...base, ...JSON.parse(out) };
}

// Windows reports IPv4 subnets as "10.0.0.0/255.0.0.0"; convert to prefix form so they can be compared.
export function normalizeRange(s) {
  const t = String(s).trim().toLowerCase();
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (m) {
    const bits = m[2].split('.').map(Number).reduce((n, o) => n + (o >>> 0).toString(2).split('').filter((b) => b === '1').length, 0);
    return `${m[1]}/${bits}`;
  }
  return t;
}
const list = (v) => [].concat(v ?? []).map(String);
const sameSet = (a, b) => { const x = new Set(list(a).map((s) => s.toLowerCase())); const y = new Set(list(b).map((s) => s.toLowerCase())); return x.size === y.size && [...x].every((v) => y.has(v)); };

const ANY = ['Any'];
export const EXPECTED_RULES = Object.freeze({
  inspect: [
    { name: 'gb2l allow DHCP', action: 'Allow', protocol: 'UDP', localPort: ['68'], remotePort: ['67'], remoteAddress: ANY },
    { name: 'gb2l allow DNS to sandbox resolver', action: 'Allow', protocol: 'UDP', localPort: ANY, remotePort: ['53'], remoteAddress: 'resolver' },
    { name: 'gb2l allow web ports', action: 'Allow', protocol: 'TCP', localPort: ANY, remotePort: ['80', '443'], remoteAddress: ANY },
    { name: 'gb2l block private and reserved (TCP)', action: 'Block', protocol: 'TCP', localPort: ANY, remotePort: ANY, remoteAddress: 'blocked-ranges' },
  ],
  tests: [
    { name: 'gb2l block private and reserved (TCP)', action: 'Block', protocol: 'TCP', localPort: ANY, remotePort: ANY, remoteAddress: 'blocked-ranges' },
  ],
});

// V4-04: every one of these must be READ and equal "Any". A missing value is unreadable, and unreadable fails closed
// (earlier versions treated a missing profile or program as "Any").
const MUST_BE_ANY = ['profile', 'program', 'service', 'interfaceType'];

/**
 * Why one observed rule differs from its expected definition (empty array = identical).
 * `resolvers` is the sandbox's actual DNS server list; the DNS rule must allow exactly those addresses.
 */
export function ruleProblems(expected, rule, { resolvers } = {}) {
  const p = [];
  if (!rule) return [`rule "${expected.name}" is missing`];
  for (const k of ['action', 'protocol']) if (String(rule[k] ?? '').toLowerCase() !== expected[k].toLowerCase()) p.push(`rule "${expected.name}": ${k} is ${rule[k] ?? '(unreadable)'}`);
  for (const k of ['localPort', 'remotePort']) if (!rule[k] || !sameSet(rule[k], expected[k])) p.push(`rule "${expected.name}": ${k} is ${list(rule[k]).join(',') || '(unreadable)'}`);
  for (const k of MUST_BE_ANY) if (rule[k] === undefined || rule[k] === null || rule[k] === '') p.push(`rule "${expected.name}": ${k} unreadable`);
  else if (String(rule[k]).toLowerCase() !== 'any') p.push(`rule "${expected.name}": ${k} is ${rule[k]}, not as generated`);
  if (!rule.localAddress || !sameSet(rule.localAddress, ANY)) p.push(`rule "${expected.name}": local address is ${list(rule.localAddress).join(',') || '(unreadable)'}`);
  const addrs = list(rule.remoteAddress).map(normalizeRange);
  if (!addrs.length) p.push(`rule "${expected.name}": remote addresses unreadable`);
  else if (expected.remoteAddress === 'resolver') {
    const real = list(resolvers).map(normalizeRange);
    if (!real.length || !real.every((a) => isIP(a))) p.push(`rule "${expected.name}": the sandbox's DNS server addresses could not be read, so the DNS rule cannot be checked`);
    else if (!sameSet(addrs, real)) p.push(`rule "${expected.name}": allows ${addrs.join(',')}, but the sandbox's DNS server is ${real.join(',')}`);
  } else if (expected.remoteAddress === 'blocked-ranges') {
    const missing = BLOCKED_RANGES.map(normalizeRange).filter((r) => !addrs.includes(r));
    if (missing.length) p.push(`rule "${expected.name}": does not block ${missing.join(', ')}`);
  } else if (!sameSet(addrs, expected.remoteAddress)) p.push(`rule "${expected.name}": remote addresses are ${addrs.join(',')}`);
  return p;
}

/** Decide whether the system is isolated enough for `mode`. Pure: tests pass a fake state. */
export function checkIsolation(mode, { env = process.env, state } = {}) {
  const reasons = [];
  if (!['inspect', 'tests'].includes(mode)) return { isolated: false, reasons: [`unknown isolation mode "${mode}"`] };
  if (state?.platform !== 'win32') reasons.push('isolation can only be verified inside Windows Sandbox on Windows');
  if (env.GITBACK2LIFE_ISOLATED !== mode) reasons.push(`not started by the gitback2life ${mode}-mode sandbox (GITBACK2LIFE_ISOLATED is not "${mode}")`);
  if (state?.username !== SANDBOX_ACCOUNT) reasons.push('not running inside Windows Sandbox (the user is not the sandbox account)');
  const profiles = list(state?.profiles?.map?.((p) => p?.name));
  const byName = Object.fromEntries((state?.profiles ?? []).map((p) => [p?.name, p]));
  if (!PROFILES.every((n) => profiles.includes(n))) reasons.push('the Domain, Private and Public firewall profiles could not all be read');
  else if (!PROFILES.every((n) => byName[n].enabled === true && byName[n].defaultOutbound === 'Block')) reasons.push('the firewall does not block outgoing traffic by default on every profile');
  if (state?.otherAllow !== 0) reasons.push('outbound allow rules other than gitback2life\'s are enabled (or could not be counted)');
  if (!Array.isArray(state?.rules)) reasons.push('firewall rule details could not be read');
  else {
    const expected = EXPECTED_RULES[mode];
    const names = state.rules.map((r) => r?.name);
    for (const n of names) if (!expected.some((e) => e.name === n)) reasons.push(`unexpected gitback2life rule "${n}"`);
    for (const e of expected) {
      const matches = state.rules.filter((r) => r?.name === e.name);
      if (matches.length > 1) reasons.push(`rule "${e.name}" appears ${matches.length} times`);
      reasons.push(...ruleProblems(e, matches[0], { resolvers: state.resolverAddresses }));
    }
  }
  if (mode === 'tests' && state?.adaptersUp !== 0) reasons.push('a network adapter is connected (or the adapters could not be read); tests mode needs networking turned off');
  return { isolated: reasons.length === 0, reasons };
}

/** Convenience for tools: read the real state (failures count as "not isolated") and check it. */
export function verifyIsolation(mode, { env = process.env, read = readSystemState } = {}) {
  let state;
  try { state = read(); } catch (e) { return { isolated: false, reasons: [`could not read the system state: ${e.message}`] }; }
  return checkIsolation(mode, { env, state });
}
