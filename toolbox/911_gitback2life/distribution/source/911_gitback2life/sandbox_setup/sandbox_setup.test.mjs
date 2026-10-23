import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { BLOCKED_RANGES, buildInsideScript, buildWsb, sandboxStatus } from './sandbox_setup.mjs';

const opts = { toolboxRoot: 'C:\\Toolkit & Co', nodeDir: 'C:\\Program Files\\nodejs' };
const mappings = (wsb) => [...wsb.matchAll(/<HostFolder>(.*?)<\/HostFolder>\s*<SandboxFolder>(.*?)<\/SandboxFolder>\s*<ReadOnly>(.*?)<\/ReadOnly>/g)];

test('both modes disable clipboard, printers, audio, video and GPU, and escape paths', () => {
  for (const mode of ['inspect', 'tests']) {
    const wsb = buildWsb(mode, opts);
    for (const tag of ['ClipboardRedirection', 'PrinterRedirection', 'AudioInput', 'VideoInput', 'VGpu']) assert.match(wsb, new RegExp(`<${tag}>Disable</${tag}>`), `${mode} ${tag}`);
    assert.match(wsb, /C:\\Toolkit &amp; Co/);
  }
});

test('inspect mode: networking on; toolbox and Node read-only; only the polite-limit state is writable', () => {
  const wsb = buildWsb('inspect', opts);
  assert.match(wsb, /<Networking>Enable<\/Networking>/);
  const maps = mappings(wsb);
  assert.deepEqual(maps.filter((m) => m[3] === 'false').map((m) => m[2]), ['C:\\gb2l-state']);
  assert.ok(maps.find((m) => m[2] === 'C:\\gb2l-state')[1].endsWith('.polite_cache'));
});

test('tests mode: networking OFF and NO writable folder shared with this computer', () => {
  const wsb = buildWsb('tests', opts);
  assert.match(wsb, /<Networking>Disable<\/Networking>/);
  assert.deepEqual(mappings(wsb).filter((m) => m[3] === 'false'), []);
  assert.match(wsb, /inside_sandbox_tests\.ps1/);
});

test('unknown modes are refused', () => {
  assert.throws(() => buildWsb('yolo', opts), /--mode must be one of/);
  assert.throws(() => buildInsideScript(undefined ?? 'none'), /--mode must be one of/);
});

test('both scripts block outbound by default and block private ranges on every TCP port', () => {
  for (const mode of ['inspect', 'tests']) {
    const ps1 = buildInsideScript(mode);
    assert.match(ps1, /DefaultOutboundAction Block/);
    assert.match(ps1, /Disable-NetFirewallRule/);
    assert.match(ps1, /-Action Block -Protocol TCP -RemoteAddress \$blocked/);
    for (const r of ['10.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', 'fe80::/10']) {
      assert.ok(BLOCKED_RANGES.includes(r) && ps1.includes(`'${r}'`), `${mode} ${r}`);
    }
  }
});

test('real-sandbox finding: the firewall list has no address Windows Firewall refuses, and the app guard still blocks those', async () => {
  const { FIREWALL_REFUSED } = await import('./sandbox_setup.mjs');
  const { isPublicAddress } = await import('../_shared/guards.mjs');
  // New-NetFirewallRule rejects IPv6 unspecified, multicast and loopback ranges; one bad entry aborts the setup.
  for (const r of BLOCKED_RANGES) {
    const [addr] = r.split('/');
    if (!addr.includes(':')) continue;
    assert.ok(!['::', '::1'].includes(addr) && !/^ff/i.test(addr), `${r} would be refused by Windows Firewall`);
  }
  for (const r of FIREWALL_REFUSED) assert.ok(!BLOCKED_RANGES.includes(r), r);
  // What the firewall cannot hold, the tools' own guard does.
  for (const a of ['::1', '::', 'ff02::1', 'ff05::2', '127.0.0.1', '224.0.0.1']) assert.equal(isPublicAddress(a), false, a);
});

test('inspect allows only DNS to the sandbox resolver and web ports; tests allows nothing and checks adapters', () => {
  const inspect = buildInsideScript('inspect');
  assert.match(inspect, /-RemotePort 53 -RemoteAddress \$dns/);
  assert.match(inspect, /-RemotePort 80,443/);
  const tests = buildInsideScript('tests');
  assert.doesNotMatch(tests, /-Action Allow/, 'tests mode creates no allow rules');
  assert.match(tests, /Get-NetAdapter/);
  assert.match(tests, /Outbound allow rules are still enabled/);
});

test('GITBACK2LIFE_ISOLATED is set to the mode only after verification, and never on failure', () => {
  for (const mode of ['inspect', 'tests']) {
    const ps1 = buildInsideScript(mode);
    const setAt = ps1.indexOf(`$env:GITBACK2LIFE_ISOLATED = '${mode}'`);
    assert.ok(ps1.indexOf('# 3. Verify') > 0 && setAt > ps1.indexOf('# 3. Verify'), mode);
    const catchBlock = ps1.slice(ps1.indexOf('} catch {'));
    assert.doesNotMatch(catchBlock, /GITBACK2LIFE_ISOLATED = '/);
    assert.match(catchBlock, /was NOT set/);
  }
});

test('nothing runs automatically inside the sandbox, and the generator never runs commands', () => {
  const src = readFileSync(new URL('./sandbox_setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process|spawn|exec(File)?\(/);
  for (const mode of ['inspect', 'tests']) assert.doesNotMatch(buildInsideScript(mode), /^\s*node /m, 'example commands are only printed');
});

test('status explains how to turn the feature on without doing it', () => {
  const off = sandboxStatus({ exists: () => false });
  assert.equal(off.available, false);
  assert.match(off.message, /will not do it for you/);
  assert.equal(sandboxStatus({ exists: () => true }).available, true);
});

test('the sandbox working copy contains every file its tools import (real-sandbox finding: isolation.mjs needs sandbox_setup.mjs)', async () => {
  const { SANDBOX_COPIES } = await import('./sandbox_setup.mjs');
  const { dirname, join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const closure = (entry) => {
    const seen = new Set(); const todo = [join(root, entry)];
    while (todo.length) {
      const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)) todo.push(join(dirname(f), m[1]));
    }
    return [...seen].map((f) => relative(root, f).replace(/\\/g, '/'));
  };
  const entries = { inspect: ['redirect_inspector/redirect_inspector.mjs', 'sandbox_setup/report_isolation.mjs'], tests: ['regression_harness/run_offline.mjs', 'sandbox_setup/report_isolation.mjs', 'regression_harness/containment_probe/os_egress_probe.mjs'] };
  for (const [mode, list] of Object.entries(entries)) {
    const script = buildInsideScript(mode);
    for (const file of list.flatMap(closure)) {
      const top = file.split('/')[0];
      assert.ok(SANDBOX_COPIES[mode].includes(top), `${mode}: ${file} is imported but ${top}/ is not copied into the sandbox`);
      assert.ok(!file.startsWith('sandbox_setup/') || file.endsWith('.mjs'), file);
    }
    for (const top of SANDBOX_COPIES[mode]) assert.match(script, new RegExp(`C:\\\\gb2l-ro\\\\${top}`), `${mode} script copies ${top}`);
    assert.match(script, new RegExp(`node sandbox_setup\\\\report_isolation\\.mjs ${mode}`), 'the ready window tells the person to record the state');
  }
});

test('report_isolation: reports the real check, and in inspect mode proves the state folder is writable without a junction', async () => {
  const { report } = await import('./report_isolation.mjs');
  const verify = (mode) => ({ isolated: false, reasons: [`synthetic ${mode}`] });
  const writes = [];
  const write = (file, content, opts) => { writes.push({ file, opts }); return file; };
  const ok = report('inspect', { verify, env: { GITBACK2LIFE_STATE_ROOT: 'C:\\gb2l-state' }, write, now: () => 't' });
  assert.deepEqual(ok.isolation, { isolated: false, reasons: ['synthetic inspect'] });
  assert.equal(ok.state_folder.writable_without_junction, true);
  assert.equal(writes[0].opts.root, 'C:\\gb2l-state', 'contained to the state folder');
  const off = report('inspect', { verify, env: {}, write, now: () => 't' });
  assert.equal(off.state_folder.writable_without_junction, false, 'without the variable it does not claim the state folder works');
  const failing = report('inspect', { verify, env: { GITBACK2LIFE_STATE_ROOT: 'C:\\gb2l-state' }, write: () => { throw new Error('refusing to write through a link'); }, now: () => 't' });
  assert.match(failing.state_folder.error, /link/);
  assert.equal(report('tests', { verify, env: {}, write, now: () => 't' }).state_folder, undefined, 'tests mode writes nothing');
  assert.throws(() => report('other', { verify }), /mode must be/);
});