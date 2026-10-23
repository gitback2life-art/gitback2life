import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDomain, rdap, summarizeCdx, summarizeCt, summarizeRdap } from './domain_research.mjs';

test('normalizeDomain accepts hostnames and URLs from evidence', () => {
  assert.equal(normalizeDomain('https://www.KittensAndBarbells.org/adopt'), 'www.kittensandbarbells.org');
  assert.equal(normalizeDomain('www.talesofhazaribagh.com.'), 'www.talesofhazaribagh.com');
});

test('normalizeDomain refuses IPs, internal names and junk', () => {
  for (const bad of ['127.0.0.1', 'http://[::1]/', 'localhost', 'printer.local', 'db.internal', 'not a domain', 'x']) {
    assert.throws(() => normalizeDomain(bad), undefined, bad);
  }
});

test('rdap walks up from www.<name> to the registrable name on 404, only when the scope covers that parent', async () => {
  const { setActiveScope, clearActiveScope } = await import('../_shared/active_scope.mjs');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('/www.example.org')) return new Response('', { status: 404 });
    return new Response(JSON.stringify({
      ldhName: 'EXAMPLE.ORG', status: ['client transfer prohibited'],
      events: [{ eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' }],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] }],
      nameservers: [{ ldhName: 'NS1.EXAMPLE.NET' }],
    }), { status: 200 });
  };
  // The scope lists example.org (which covers www.example.org): the parent may be asked.
  setActiveScope({ scope: { targets: ['example.org'] } });
  let r;
  try { r = await rdap('www.example.org', { fetchImpl }); } finally { clearActiveScope(); }
  assert.deepEqual(asked, ['https://rdap.org/domain/www.example.org', 'https://rdap.org/domain/example.org']);
  assert.equal(r.expires, '2027-01-01T00:00:00Z');
  assert.equal(r.registrar, 'Example Registrar');
  assert.deepEqual(r.nameservers, ['ns1.example.net']);
  // The scope lists only www.example.org: its parent was never authorized, so the walk stops.
  asked.length = 0;
  setActiveScope({ scope: { targets: ['https://sub.example.org/'] } });
  try { r = await rdap('sub.example.org', { fetchImpl: async (url) => { asked.push(String(url)); return new Response('', { status: 404 }); } }); } finally { clearActiveScope(); }
  assert.deepEqual(asked, ['https://rdap.org/domain/sub.example.org']);
  assert.match(r.note, /not in the scope/);
  // No active scope (direct library use): only the name itself.
  asked.length = 0;
  await rdap('www.example.org', { fetchImpl: async (url) => { asked.push(String(url)); return new Response('', { status: 404 }); } });
  assert.deepEqual(asked, ['https://rdap.org/domain/www.example.org']);
});

test('lookalike lookups need the scope\'s explicit allow_derived_lookalikes opt-in', async () => {
  const { main } = await import('../lookalike_domain_check/lookalike_domain_check.mjs');
  const { mkdirSync, writeFileSync, rmSync, rmdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { TOOLBOX_ROOT } = await import('../_shared/common.mjs');
  const { clearActiveScope } = await import('../_shared/active_scope.mjs');
  const { template } = await import('../_shared/scope.mjs');
  const dir = join(TOOLBOX_ROOT, '.test_tmp', `lookalike-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const file = join(dir, 'scope.json');
    writeFileSync(file, JSON.stringify({ ...template(), targets: ['example.org'] })); // template: allow_derived_lookalikes false
    await assert.rejects(main(['check', 'example.org', '--scope', file]), /allow_derived_lookalikes/);
  } finally {
    clearActiveScope();
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* in use */ }
  }
});

test('deny_actions is executable: it refuses an action even when permitted and attested', async () => {
  const { authorize, template } = await import('../_shared/scope.mjs');
  const s = { ...template(), targets: ['example.org'], disclosures: ['target_website'],
    permissions: { ...template().permissions, live_http_inspection: true }, deny_actions: ['live_http_inspection'],
    approvals: [{ action: 'live_http_inspection', target: 'https://example.org/', attested_at: new Date().toISOString(), attested_by: 'operator' }] };
  const r = authorize(s, { action: 'live_http_inspection', target: 'https://example.org/', services: ['target_website'] });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(), /deny_actions/);
  assert.equal(authorize({ ...s, deny_actions: [] }, { action: 'live_http_inspection', target: 'https://example.org/', services: ['target_website'] }).allowed, true);
});

test('summarizeRdap tolerates sparse records', () => {
  const r = summarizeRdap({}, 'x.org', 'https://rdap.example/');
  assert.equal(r.registered, null);
  assert.deepEqual(r.nameservers, []);
});

test('summarizeCt dedupes precert/leaf pairs by serial and sorts newest first', () => {
  const rows = [
    { id: 1, serial_number: 'aa', issuer_name: "C=US, O=Let's Encrypt, CN=R3", not_before: '2025-01-01', not_after: '2025-04-01', name_value: 'x.org' },
    { id: 2, serial_number: 'aa', issuer_name: "C=US, O=Let's Encrypt, CN=R3", not_before: '2025-01-01', not_after: '2025-04-01', name_value: 'x.org' },
    { id: 3, serial_number: 'bb', issuer_name: 'C=US, O=Google Trust Services, CN=WR3', not_before: '2026-06-01', not_after: '2026-09-01', name_value: 'x.org\nwww.x.org' },
  ];
  const s = summarizeCt(rows, 'x.org');
  assert.equal(s.total_unique, 2);
  assert.equal(s.recent[0].crtsh_id, 3);
  assert.deepEqual(s.issuers, ['Google Trust Services', "Let's Encrypt"]);
});

test('summarizeCdx counts historical redirect captures', () => {
  const s = summarizeCdx([
    ['timestamp', 'statuscode', 'original', 'mimetype'],
    ['20240101000000', '200', 'http://x.org/', 'text/html'],
    ['20260901000000', '301', 'http://x.org/', 'text/html'],
  ], 'x.org');
  assert.equal(s.redirect_captures, 1);
  assert.equal(s.last, '2026-09-01T00:00:00Z');
  assert.match(s.captures[1].wayback_url, /web\.archive\.org\/web\/20260901000000\//);
});

test('summarizeCdx with no rows says absence is not evidence', () => {
  assert.match(summarizeCdx([], 'x.org').note, /not evidence/);
});

test('network failures are not mistaken for empty DNS records', async () => {
  const { assessDnsRecords } = await import('./domain_research.mjs');
  const failures = { A: {none:'ECONNREFUSED'}, AAAA: {none:'ETIMEOUT'},
    CNAME: {none:'EAI_AGAIN'}, NS: {none:'ENETUNREACH'}, MX: {none:'ECONNREFUSED'} };
  const v = assessDnsRecords(failures);
  assert.equal(v.status, 'unverified');
  assert.equal(v.verified_record_types.length, 0);
  assert.equal(v.unverified_record_types.length, 5);
  assert.match(v.note, /not proof of missing DNS records/);
  const partial = assessDnsRecords({ ...failures, A: [{address:'203.0.113.42',ttl:60}], MX: {none:'ENODATA'} });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.verified_record_types, ['A','MX']);
  const negative = assessDnsRecords(Object.fromEntries(['A','AAAA','CNAME','NS','MX'].map(x=>[x,{none:'ENODATA'}])));
  assert.equal(negative.status, 'verified');
});

test('robots policy inaccessible is distinct from an explicit exclusion', async () => {
  const { explainLookupFailure } = await import('./domain_research.mjs');
  const unavailable = explainLookupFailure({code:'ROBOTS_DISALLOWED',message:'robots.txt could not be verified (unreachable EAI_AGAIN); treating the site as off-limits'});
  assert.equal(unavailable.kind,'robots_unavailable');
  assert.match(unavailable.guidance,/DNS\/HTTPS/);
  const banned = explainLookupFailure({code:'ROBOTS_DISALLOWED',message:'robots.txt explicitly disallows / (Disallow: /; robots.txt HTTP 200)'});
  assert.equal(banned.kind,'robots_disallowed');
  assert.match(banned.guidance,/keep the restriction/);
  assert.equal(explainLookupFailure({code:'SCOPE_BLOCKED',message:'Scope blocked'}).kind, 'scope_not_authorized');
  assert.equal(explainLookupFailure({code:'POLITE_BUDGET',message:'Rate limit'}).kind, 'request_limit');
  assert.equal(explainLookupFailure({code:'ECONNREFUSED',message:'connect refused'}).kind, 'network_unavailable');
});

test('a third-party DNS-over-HTTPS provider is never silently authorized by plain DNS disclosure', async () => {
  const { authorize, template } = await import('../_shared/scope.mjs');
  const s = {...template(), targets: ['example.org'],
    permissions: {...template().permissions, passive_lookup: true}, disclosures: ['dns']};
  assert.equal(authorize(s, {action:'passive_lookup',target:'example.org',services:['dns']}).allowed, true);
  const no = authorize(s, {action:'passive_lookup',target:'example.org',services:['doh']});
  assert.equal(no.allowed, false);
  assert.match(no.reasons.join(' '),/doh/);
});
