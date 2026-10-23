#!/usr/bin/env node
// sandbox_setup: generate Windows Sandbox configurations for the two things that must never run on this computer:
//   inspect  live redirect checks (redirect_inspector): networking on, firewall locked to DNS + web ports to public
//            addresses only, every private/local/reserved address blocked.
//   tests    running a downloaded project's tests (run_offline): networking OFF, no outbound rules allowed, and no
//            writable folder shared with this computer.
// This tool only WRITES files (a .wsb config and the script that runs inside the sandbox). It never enables Windows
// features, never starts the sandbox, and never contacts the network. A person reviews and launches it.
// Inside, the script locks and verifies the firewall and only then sets GITBACK2LIFE_ISOLATED=<mode>. The tools
// do not trust that setting alone: they re-check the real system state (_shared/isolation.mjs).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, safeWrite, TOOLBOX_ROOT } from '../_shared/common.mjs';

export const OUT_DIR = join(TOOLBOX_ROOT, 'sandbox_setup', 'generated');
export const MODES = Object.freeze(['inspect', 'tests']);
const SANDBOX_EXE = 'C:\\Windows\\System32\\WindowsSandbox.exe';
export const ENABLE_COMMAND = 'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All';

// Never reachable from inside the sandbox, on any port. Block rules win over allow rules in Windows Firewall.
// Real-sandbox finding (2026-10-09): New-NetFirewallRule REFUSES IPv6 unspecified, multicast, broadcast and loopback
// addresses in -RemoteAddress ("An unspecified, multicast, broadcast, or loopback IPv6 address was specified"), which
// aborted the whole setup. So ::1/128 and ff00::/8 are not listed here (FIREWALL_REFUSED). Nothing is lost: Windows
// Firewall does not filter loopback traffic at all, TCP cannot use multicast, and the tools' own guard
// (_shared/guards.mjs isPublicAddress) refuses both before connecting and re-checks the connected address.
export const FIREWALL_REFUSED = Object.freeze(['::1/128', 'ff00::/8']);
export const BLOCKED_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
  'fc00::/7', 'fe80::/10', 'fec0::/10', '::ffff:0:0/96', '64:ff9b::/96', '2001:db8::/32', '2002::/16',
];

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const checkMode = (mode) => { if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(', ')}`); return mode; };

export function buildWsb(mode = 'inspect', { toolboxRoot = TOOLBOX_ROOT, nodeDir = dirname(process.execPath) } = {}) {
  checkMode(mode);
  const map = (host, inside, readOnly) => `    <MappedFolder>
      <HostFolder>${xml(host)}</HostFolder>
      <SandboxFolder>${xml(inside)}</SandboxFolder>
      <ReadOnly>${readOnly ? 'true' : 'false'}</ReadOnly>
    </MappedFolder>`;
  const maps = [map(toolboxRoot, 'C:\\gb2l-ro', true), map(nodeDir, 'C:\\nodejs', true)];
  // Only inspect mode shares one writable folder: the polite-limit state, so cool-downs and daily caps persist.
  if (mode === 'inspect') maps.push(map(join(toolboxRoot, '_shared', '.polite_cache'), 'C:\\gb2l-state', false));
  return `<!-- gitback2life ${mode}-mode sandbox. Review before launching. -->
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>${mode === 'inspect' ? 'Enable' : 'Disable'}</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>2048</MemoryInMB>
  <MappedFolders>
${maps.join('\n')}
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\gb2l-ro\\sandbox_setup\\generated\\inside_sandbox_${mode}.ps1</Command>
  </LogonCommand>
</Configuration>
`;
}

// Top-level toolbox folders copied into the sandbox's working copy, per mode. Everything the mode's tools import
// must be inside these (sandbox_setup.test.mjs follows the imports to prove it): isolation.mjs imports
// sandbox_setup.mjs, so sandbox_setup is always copied (its .mjs files only, never generated/).
export const SANDBOX_COPIES = Object.freeze({
  inspect: Object.freeze(['_shared', 'redirect_inspector', 'sandbox_setup']),
  tests: Object.freeze(['_shared', 'regression_harness', 'sandbox_setup']),
});

function copyLines(mode) {
  return SANDBOX_COPIES[mode].map((d) => (d === '_shared'
    ? `    Copy-Item -Recurse -Force C:\\gb2l-ro\\_shared C:\\gb2l\\_shared -Exclude '.polite_cache'
    if (Test-Path C:\\gb2l\\_shared\\.polite_cache) { Remove-Item -Recurse -Force C:\\gb2l\\_shared\\.polite_cache }`
    : d === 'sandbox_setup'
      ? `    New-Item -ItemType Directory -Force -Path C:\\gb2l\\sandbox_setup | Out-Null
    Copy-Item -Force C:\\gb2l-ro\\sandbox_setup\\*.mjs C:\\gb2l\\sandbox_setup\\`
      : `    Copy-Item -Recurse -Force C:\\gb2l-ro\\${d} C:\\gb2l\\${d}`)).join('\n');
}

export function buildInsideScript(mode = 'inspect') {
  checkMode(mode);
  const inspect = mode === 'inspect';
  const copy = copyLines(mode) + (inspect ? `
    # F04: no junction. The tools address the mapped state folder directly (GITBACK2LIFE_STATE_ROOT, set below);
    # it is the only state folder outside the toolbox they accept, with its own containment root.` : '');
  const allowRules = inspect ? `    $dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ }) | Select-Object -Unique
    if (-not $dns) { throw 'No DNS server found inside the sandbox' }
    New-NetFirewallRule -DisplayName 'gb2l allow DHCP' -Direction Outbound -Action Allow -Protocol UDP -LocalPort 68 -RemotePort 67 | Out-Null
    New-NetFirewallRule -DisplayName 'gb2l allow DNS to sandbox resolver' -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 -RemoteAddress $dns | Out-Null
    New-NetFirewallRule -DisplayName 'gb2l allow web ports' -Direction Outbound -Action Allow -Protocol TCP -RemotePort 80,443 | Out-Null
` : '    # tests mode: no allow rules at all (networking is also turned off in the .wsb).\n';
  const verify = inspect ? `    $mine = @(Get-NetFirewallRule -DisplayName 'gb2l *' | Where-Object { [string]$_.Enabled -eq 'True' })
    if (@($mine | Where-Object { [string]$_.Action -eq 'Allow' }).Count -ne 3) { throw 'Expected exactly 3 gitback2life allow rules' }
    $others = @(Get-NetFirewallRule -Direction Outbound | Where-Object { [string]$_.Enabled -eq 'True' -and [string]$_.Action -eq 'Allow' -and $_.DisplayName -notlike 'gb2l *' })
    if ($others.Count -gt 0) { throw 'Other outbound allow rules are still enabled' }` : `    $allow = @(Get-NetFirewallRule -Direction Outbound | Where-Object { [string]$_.Enabled -eq 'True' -and [string]$_.Action -eq 'Allow' })
    if ($allow.Count -gt 0) { throw 'Outbound allow rules are still enabled' }
    if (@(Get-NetAdapter | Where-Object { [string]$_.Status -eq 'Up' }).Count -gt 0) { throw 'A network adapter is connected; tests mode needs networking off' }`;
  const record = `Write-Host 'FIRST, record the real isolation state (read-only; no network):'
Write-Host '  node sandbox_setup\\report_isolation.mjs ${mode}'
Write-Host ''
`;
  const banner = record + (inspect
    ? `Write-Host 'gitback2life INSPECT sandbox ready. Firewall locked: DNS to the sandbox resolver, web ports to public addresses only.'
Write-Host 'Live checks still need a scope with a fresh exact-URL operator attestation, --live and --approve <exact URL>. Example:'
Write-Host '  node redirect_inspector\\redirect_inspector.mjs inspect https://example.org/ --scope C:\\gb2l-ro\\<your scope>.json --live --approve https://example.org/'`
    : `Write-Host 'gitback2life TESTS sandbox ready. Networking is off; nothing here can reach the internet or this computer''s files.'
Write-Host 'Copy the project into C:\\gb2l\\regression_harness\\workspace if it is not there, then for example:'
Write-Host '  node regression_harness\\run_offline.mjs --cwd regression_harness\\workspace\\<project> --reviewed --scope C:\\gb2l-ro\\<your scope>.json -- npm test'
Write-Host 'Anything saved here is discarded when the sandbox closes; copy the printed report out by hand.'`);
  return `# gitback2life: runs INSIDE Windows Sandbox only (${mode} mode). Locks the firewall, verifies it, then opens one window.
# If any step fails, GITBACK2LIFE_ISOLATED is NOT set, and the tools also re-check the real system state themselves.
$ErrorActionPreference = 'Stop'
try {
    # 1. Sandbox-local working copy of only the tools needed (the toolbox itself is mapped read-only).
    New-Item -ItemType Directory -Force -Path C:\\gb2l | Out-Null
${copy}

    # 2. Firewall: block everything outbound by default, and switch off the built-in outbound allow rules.
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
    Get-NetFirewallRule -Direction Outbound | Where-Object { [string]$_.Enabled -eq 'True' } | Disable-NetFirewallRule
${allowRules}    # Block rules win over allow rules: no private, local or reserved address is reachable on any TCP port.
    $blocked = @(${BLOCKED_RANGES.map((r) => `'${r}'`).join(', ')})
    New-NetFirewallRule -DisplayName 'gb2l block private and reserved (TCP)' -Direction Outbound -Action Block -Protocol TCP -RemoteAddress $blocked | Out-Null

    # 3. Verify before declaring the environment isolated.
    $profiles = Get-NetFirewallProfile
    if (@($profiles | Where-Object { [string]$_.DefaultOutboundAction -ne 'Block' -or -not $_.Enabled }).Count -gt 0) { throw 'Firewall default-block did not apply' }
${verify}

    # 4. Open one prepared window. Nothing is run automatically.
    $env:GITBACK2LIFE_ISOLATED = '${mode}'
${inspect ? "    $env:GITBACK2LIFE_STATE_ROOT = 'C:\\gb2l-state'\n" : ''}    $env:Path = "C:\\nodejs;$env:Path"
    Start-Process powershell.exe -WorkingDirectory C:\\gb2l -ArgumentList '-NoExit', '-Command', @'
${banner}
Write-Host 'Close the sandbox when finished; everything inside it is discarded.'
'@
} catch {
    Write-Host "gitback2life sandbox setup FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'GITBACK2LIFE_ISOLATED was NOT set. Do not run live checks or tests. Close this sandbox.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
}
`;
}

export function sandboxStatus({ exists = existsSync } = {}) {
  return exists(SANDBOX_EXE)
    ? { available: true, message: 'Windows Sandbox is installed.' }
    : { available: false, message: `Windows Sandbox is not turned on. To turn it on (needs administrator rights and a restart; this tool will not do it for you), run in an administrator PowerShell:\n  ${ENABLE_COMMAND}` };
}

const HELP = `sandbox_setup: generate locked-down Windows Sandbox configurations.

  status                                 is Windows Sandbox turned on? (read-only; prints how to turn it on)
  create --mode inspect|tests [--overwrite]
       inspect  for redirect_inspector live checks (networking on, firewall locked to DNS + web ports)
       tests    for run_offline project tests (networking OFF, no writable folder shared with this computer)
       writes generated/gitback2life-<mode>.wsb and generated/inside_sandbox_<mode>.ps1

Then review both files and double-click the .wsb to start the sandbox. This tool never changes Windows
settings, never starts the sandbox, and never contacts the network. It has not yet been exercised in a real
Windows Sandbox on this computer: test it there before relying on it.`;

export function main(argv) {
  const { values: o, positionals: [cmd] } = parseArgs({ args: argv, allowPositionals: true, options: {
    overwrite: { type: 'boolean' }, help: { type: 'boolean' }, mode: { type: 'string' },
  } });
  if (!cmd || o.help) return console.log(HELP);
  if (cmd === 'status') return console.log(sandboxStatus().message);
  if (cmd !== 'create') throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  const mode = checkMode(o.mode);
  if (mode === 'inspect') mkdirSync(join(TOOLBOX_ROOT, '_shared', '.polite_cache'), { recursive: true }); // its writable mapping must exist
  const wsb = safeWrite(join(OUT_DIR, `gitback2life-${mode}.wsb`), buildWsb(mode), { overwrite: o.overwrite });
  const ps1 = safeWrite(join(OUT_DIR, `inside_sandbox_${mode}.ps1`), buildInsideScript(mode), { overwrite: o.overwrite });
  console.log(`wrote ${wsb}\nwrote ${ps1}\n\n${sandboxStatus().message}\nReview both files, then double-click the .wsb to start. Nothing has been started.`);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
