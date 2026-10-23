import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineDecision, compareSnapshots, domainsFromRegister, snapshotFrom } from './domain_watch.mjs';

test('a baseline is only saved when a person asks (--save-baseline first time, --accept to replace)', () => {
  assert.equal(baselineDecision({ hasBase: false }).save, false);
  assert.match(baselineDecision({ hasBase: false }).message, /nothing kept/);
  assert.equal(baselineDecision({ hasBase: false, saveBaseline: true }).save, true);
  assert.equal(baselineDecision({ hasBase: true }).save, false);
  assert.equal(baselineDecision({ hasBase: true, accept: true }).save, true);
});

const NOW = Date.parse('2026-10-09T00:00:00Z');
const snap = (over = {}) => snapshotFrom({
  domain: 'example-rescue.org', at: '2026-10-01T00:00:00Z',
  rdapResult: { found: true, registrar: 'Registrar A', expires: '2027-06-01T00:00:00Z', status: ['client transfer prohibited'], nameservers: ['ns1.host-a.net', 'ns2.host-a.net'], ...over.rdap },
  dnsResult: { records: { A: [{ address: '203.0.113.10', ttl: 300 }], AAAA: { none: 'ENODATA' }, CNAME: { none: 'ENODATA' }, NS: ['ns2.host-a.net', 'ns1.host-a.net'], ...over.dns } },
});

test('snapshotFrom keeps comparable facts only, sorted', () => {
  const s = snap();
  assert.deepEqual(s.dns.A, ['203.0.113.10']);
  assert.deepEqual(s.dns.AAAA, []);
  assert.deepEqual(s.dns.NS, ['ns1.host-a.net', 'ns2.host-a.net']);
  assert.equal(s.registration.registrar, 'Registrar A');
});

test('nothing changed and expiry far away → no findings', () => {
  assert.deepEqual(compareSnapshots(snap(), snap(), NOW), []);
});

test('expiry: passed or within 30 days is urgent, within 60 is review', () => {
  const lvl = (expires) => compareSnapshots(null, snap({ rdap: { expires } }), NOW).find((f) => f.check === 'expiry')?.level;
  assert.equal(lvl('2026-10-01T00:00:00Z'), 'urgent');
  assert.equal(lvl('2026-10-20T00:00:00Z'), 'urgent');
  assert.equal(lvl('2026-11-25T00:00:00Z'), 'review');
  assert.equal(lvl('2027-06-01T00:00:00Z'), undefined);
});

test('risky registry status (redemption / hold) is urgent', () => {
  const f = compareSnapshots(null, snap({ rdap: { status: ['redemption period'] } }), NOW);
  assert.ok(f.some((x) => x.check === 'status' && x.level === 'urgent'));
});

test('registrar and nameserver changes are review; DNS changes are info; wording stays calibrated', () => {
  const after = snap({ rdap: { registrar: 'Registrar B', nameservers: ['ns1.parking.example'] }, dns: { A: [{ address: '198.51.100.7' }] } });
  const f = compareSnapshots(snap(), after, NOW);
  const by = Object.fromEntries(f.map((x) => [x.check, x.level]));
  assert.equal(by.registrar, 'review');
  assert.equal(by.nameservers, 'review');
  assert.equal(by.dns_A, 'info');
  for (const x of f) assert.doesNotMatch(x.message, /hijack|hacked|compromis|malicious/i);
});

test('a renewal is reported as good news', () => {
  const f = compareSnapshots(snap(), snap({ rdap: { expires: '2028-06-01T00:00:00Z' } }), NOW);
  assert.deepEqual(f.map((x) => [x.check, x.level]), [['renewed', 'info']]);
});

test('missing registration data is review, not alarm', () => {
  const f = compareSnapshots(null, snapshotFrom({ domain: 'x.example', rdapResult: { found: false } }), NOW);
  assert.deepEqual(f.map((x) => x.level), ['review']);
});

test('domainsFromRegister picks domain-type services and skips account names', () => {
  const reg = { records: [
    { service: 'domain_registrar', domain_or_account: 'Example-Rescue.org' },
    { service: 'web_host', domain_or_account: 'www.example-rescue.org' },
    { service: 'social_media', domain_or_account: 'example_rescue_insta' },
    { service: 'email', domain_or_account: 'example-rescue.org' },
    { service: 'dns', domain_or_account: 'not a domain' },
  ] };
  assert.deepEqual(domainsFromRegister(reg), ['example-rescue.org', 'www.example-rescue.org']);
});

test('network failure cannot be mistaken for lost registrar or changed DNS baseline', () => {
  const base = snap();
  const check = snapshotFrom({domain: base.domain, rdapResult: null, dnsResult: {
    records: {A: {none:'ECONNREFUSED'}, AAAA:{none:'ENODATA'}, CNAME:{none:'ENODATA'}, NS:{none:'ETIMEOUT'}}
  }});
  check.unverified = [{check:'rdap', kind:'network_unavailable',reason:'EAI_AGAIN'}];
  const findings = compareSnapshots(base, check, NOW);
  assert.ok(!findings.some(x=>/record existed|nameserver|DNS records changed/i.test(x.message)));
  assert.equal(check.dns.A, null);
  assert.deepEqual(check.dns.AAAA,[]);
});
