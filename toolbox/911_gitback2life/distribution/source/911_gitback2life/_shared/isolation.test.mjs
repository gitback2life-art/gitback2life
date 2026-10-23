import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCKED_RANGES } from '../sandbox_setup/sandbox_setup.mjs';
import { checkIsolation, EXPECTED_RULES, normalizeRange, readSystemState, SANDBOX_ACCOUNT, verifyIsolation } from './isolation.mjs';

const PROFILES = ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: true, defaultOutbound: 'Block' }));
// How Windows reports IPv4 subnets (dotted masks), to prove normalization works.
const winRanges = BLOCKED_RANGES.map((r) => {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(r);
  if (!m) return r;
  const bits = Number(m[2]); const mask = [0, 1, 2, 3].map((i) => Math.max(0, Math.min(8, bits - 8 * i))).map((b) => 256 - 2 ** (8 - b)).join('.');
  return `${m[1]}/${mask}`;
});
const rule = (e) => ({
  name: e.name, action: e.action, protocol: e.protocol, profile: 'Any', program: 'Any', service: 'Any', interfaceType: 'Any',
  localAddress: ['Any'], localPort: e.localPort, remotePort: e.remotePort,
  remoteAddress: e.remoteAddress === 'resolver' ? ['172.20.0.1'] : e.remoteAddress === 'blocked-ranges' ? winRanges : e.remoteAddress,
});
const good = (mode) => ({ platform: 'win32', username: SANDBOX_ACCOUNT, profiles: PROFILES, otherAllow: 0, adaptersUp: mode === 'tests' ? 0 : 1, resolverAddresses: ['172.20.0.1'], rules: EXPECTED_RULES[mode].map(rule) });
const env = (mode) => ({ GITBACK2LIFE_ISOLATED: mode });
const check = (mode, state) => checkIsolation(mode, { env: env(mode), state });

test('Windows dotted subnet masks normalize to prefix form', () => {
  assert.equal(normalizeRange('10.0.0.0/255.0.0.0'), '10.0.0.0/8');
  assert.equal(normalizeRange('100.64.0.0/255.192.0.0'), '100.64.0.0/10');
  assert.equal(normalizeRange('fc00::/7'), 'fc00::/7');
});

test('a correctly locked inspect-mode and tests-mode sandbox pass', () => {
  assert.deepEqual(check('inspect', good('inspect')), { isolated: true, reasons: [] });
  assert.deepEqual(check('tests', good('tests')), { isolated: true, reasons: [] });
});

test('F03: same names and counts but different filters are rejected', () => {
  const widen = (name, change) => { const s = good('inspect'); s.rules = s.rules.map((r) => (r.name === name ? { ...r, ...change } : r)); return check('inspect', s); };
  assert.equal(widen('gb2l allow web ports', { remotePort: ['Any'] }).isolated, false, 'web rule opened to every port');
  assert.equal(widen('gb2l allow web ports', { protocol: 'Any' }).isolated, false, 'web rule opened to every protocol');
  assert.equal(widen('gb2l allow DNS to sandbox resolver', { remoteAddress: ['Any'] }).isolated, false, 'DNS rule opened to every address');
  assert.equal(widen('gb2l block private and reserved (TCP)', { remoteAddress: ['203.0.113.1'] }).isolated, false, 'block rule no longer covers private ranges');
  assert.equal(widen('gb2l block private and reserved (TCP)', { action: 'Allow' }).isolated, false, 'block rule turned into allow');
  assert.equal(widen('gb2l allow DHCP', { program: 'C:\\x.exe' }).isolated, false);
  assert.equal(widen('gb2l allow DHCP', { profile: 'Public' }).isolated, false);
  const extra = good('inspect'); extra.rules.push({ ...extra.rules[2], name: 'gb2l allow anything', remotePort: ['Any'] });
  assert.match(check('inspect', extra).reasons.join(), /unexpected gitback2life rule/);
  const missing = good('inspect'); missing.rules = missing.rules.slice(1);
  assert.match(check('inspect', missing).reasons.join(), /is missing/);
  const dup = good('inspect'); dup.rules.push(dup.rules[0]);
  assert.match(check('inspect', dup).reasons.join(), /appears 2 times/);
});

test('incomplete or unreadable details fail closed', () => {
  for (const change of [{ rules: undefined }, { profiles: PROFILES.slice(0, 2) }, { otherAllow: undefined }, { rules: [{ name: 'gb2l allow DHCP' }] }]) {
    assert.equal(check('inspect', { ...good('inspect'), ...change }).isolated, false, JSON.stringify(change));
  }
});

test('setting the variable by hand on a normal computer is NOT enough', () => {
  const host = { platform: 'win32', username: 'someone', profiles: PROFILES.map((p) => ({ ...p, defaultOutbound: 'Allow' })), rules: [], otherAllow: 40, adaptersUp: 2 };
  const r = check('inspect', host);
  assert.equal(r.isolated, false);
  assert.ok(r.reasons.some((x) => /not running inside Windows Sandbox/.test(x)));
  assert.ok(r.reasons.some((x) => /does not block outgoing traffic/.test(x)));
});

test('each weakened condition is caught on its own', () => {
  const fails = (mode, over, e = env(mode)) => checkIsolation(mode, { env: e, state: { ...good(mode), ...over } }).isolated === false;
  assert.ok(fails('inspect', {}, {}), 'variable missing');
  assert.ok(fails('inspect', { username: 'Admin' }), 'not the sandbox account');
  assert.ok(fails('inspect', { profiles: [PROFILES[0], { ...PROFILES[1], enabled: false }, PROFILES[2]] }), 'a profile disabled');
  assert.ok(fails('inspect', { otherAllow: 1 }), 'another allow rule');
  assert.ok(fails('inspect', { platform: 'linux' }), 'not Windows');
  assert.ok(fails('tests', { adaptersUp: 1 }), 'tests mode with a network adapter up');
  assert.ok(fails('tests', { rules: EXPECTED_RULES.inspect.map(rule) }), 'tests mode with the inspect allow rules');
  assert.ok(fails('tests', {}, env('inspect')), 'inspect sandbox used for tests');
});

test('if the system state cannot be read, the answer is "not isolated"', () => {
  const r = verifyIsolation('inspect', { env: env('inspect'), read: () => { throw new Error('access denied'); } });
  assert.equal(r.isolated, false);
  assert.match(r.reasons[0], /could not read the system state: access denied/);
});

test('readSystemState only runs read-only PowerShell queries and reads rule filters', () => {
  let ran;
  readSystemState({ platform: 'win32', run: (file, args) => { ran = args.join(' '); return '{"profiles":[],"rules":[],"otherAllow":0,"adaptersUp":0}'; } });
  for (const q of ['Get-NetFirewallProfile', 'Get-NetFirewallPortFilter', 'Get-NetFirewallAddressFilter', 'Get-NetFirewallApplicationFilter']) assert.match(ran, new RegExp(q));
  assert.doesNotMatch(ran, /\b(Set|New|Remove|Enable|Disable|Add)-\w+/, 'no command that changes anything');
});

test('V4-04: the DNS rule must allow exactly the sandbox\'s real resolver, and that resolver must be readable', () => {
  const s = good('inspect');
  s.rules = s.rules.map((r) => (r.name === 'gb2l allow DNS to sandbox resolver' ? { ...r, remoteAddress: ['8.8.8.8'] } : r));
  assert.match(check('inspect', s).reasons.join(), /allows 8\.8\.8\.8, but the sandbox's DNS server is 172\.20\.0\.1/);
  for (const resolverAddresses of [undefined, [], ['not-an-ip']]) {
    assert.equal(check('inspect', { ...good('inspect'), resolverAddresses }).isolated, false, JSON.stringify(resolverAddresses));
  }
  assert.equal(check('inspect', { ...good('inspect'), resolverAddresses: ['172.20.0.1', '172.20.0.2'] }).isolated, false, 'rule lists fewer resolvers than the sandbox uses');
});

test('V4-04: every collected filter field is checked on its own, and a missing field fails closed', () => {
  const variants = { profile: 'Private', program: 'C:\\x.exe', service: 'dnscache', interfaceType: 'Wired', localAddress: ['10.0.0.5'] };
  for (const mode of ['inspect', 'tests']) {
    for (const e of EXPECTED_RULES[mode]) {
      for (const [field, value] of Object.entries(variants)) {
        const changed = good(mode); changed.rules = changed.rules.map((r) => (r.name === e.name ? { ...r, [field]: value } : r));
        assert.equal(check(mode, changed).isolated, false, `${mode} ${e.name}: ${field}=${value}`);
        const missing = good(mode); missing.rules = missing.rules.map((r) => { if (r.name !== e.name) return r; const c = { ...r }; delete c[field]; return c; });
        assert.match(check(mode, missing).reasons.join(), /unreadable/, `${mode} ${e.name}: ${field} missing`);
      }
    }
  }
});