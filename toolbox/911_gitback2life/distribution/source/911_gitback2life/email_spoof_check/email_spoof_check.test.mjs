import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, analyzeDmarc, analyzeSpf, parseTags } from './email_spoof_check.mjs';

const levels = (f) => f.map((x) => x.level);

test('SPF: missing, +all, ?all, ~all, -all', () => {
  assert.equal(analyzeSpf([])[0].level, 'review');
  assert.match(analyzeSpf([], { hasMx: false })[0].fix, /v=spf1 -all/);
  assert.equal(analyzeSpf(['v=spf1 include:_spf.google.com +all'])[0].level, 'urgent');
  assert.equal(analyzeSpf(['v=spf1 all'])[0].level, 'urgent', 'a bare "all" means +all');
  assert.equal(analyzeSpf(['v=spf1 mx ?all'])[0].level, 'review');
  assert.deepEqual(levels(analyzeSpf(['v=spf1 include:_spf.google.com ~all'])), ['info']);
  assert.deepEqual(levels(analyzeSpf(['v=spf1 include:_spf.google.com -all'])), ['info']);
});

test('SPF: duplicates, missing all, redirect, too many lookups, ptr', () => {
  assert.ok(analyzeSpf(['v=spf1 -all', 'v=spf1 mx -all']).some((x) => /more than one/.test(x.message)));
  assert.equal(analyzeSpf(['v=spf1 mx'])[0].level, 'review');
  assert.deepEqual(analyzeSpf(['v=spf1 redirect=_spf.example.org']), [], 'redirect= delegates the ending');
  const many = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.example`).join(' ')} -all`;
  assert.ok(analyzeSpf([many]).some((x) => /11 DNS lookups/.test(x.message)));
  assert.ok(analyzeSpf(['v=spf1 ptr -all']).some((x) => /ptr/.test(x.message)));
});

test('DMARC: missing, none, quarantine, reject, invalid, pct, reports', () => {
  assert.equal(analyzeDmarc([])[0].level, 'review');
  assert.equal(analyzeDmarc(['v=DMARC1; p=none; rua=mailto:dmarc@example.org'])[0].level, 'review');
  assert.deepEqual(levels(analyzeDmarc(['v=DMARC1; p=reject; rua=mailto:dmarc@example.org'])), ['info']);
  assert.ok(analyzeDmarc(['v=DMARC1; p=quarantine; pct=25; rua=mailto:a@example.org']).some((x) => /25%/.test(x.message)));
  assert.equal(analyzeDmarc(['v=DMARC1; p=maybe'])[0].level, 'review');
  assert.ok(analyzeDmarc(['v=DMARC1; p=reject']).some((x) => /does not request reports/.test(x.message)));
});

test('DMARC report addresses are never printed (privacy rule)', () => {
  const out = JSON.stringify(analyzeDmarc(['v=DMARC1; p=none; rua=mailto:jane.volunteer@example.org']));
  assert.doesNotMatch(out, /jane\.volunteer/);
});

test('parseTags handles spacing and case', () => {
  assert.deepEqual(parseTags('v=DMARC1;  P=reject ; pct=50'), { v: 'DMARC1', p: 'reject', pct: '50' });
});

test('overall rating: strong only with good SPF and enforced DMARC; never says "safe"', () => {
  const strong = analyze({ spf: ['v=spf1 include:x -all'], dmarc: ['v=DMARC1; p=reject; rua=mailto:a@b.org'], mx: ['mx.example'], dkim: {} });
  assert.match(strong.rating, /^strong/);
  const partial = analyze({ spf: ['v=spf1 include:x ~all'], dmarc: ['v=DMARC1; p=none; rua=mailto:a@b.org'], mx: ['mx'], dkim: {} });
  assert.match(partial.rating, /^partial/);
  const weak = analyze({ spf: ['v=spf1 +all'], dmarc: [], mx: [], dkim: {} });
  assert.match(weak.rating, /^weak/);
  for (const r of [strong, partial, weak]) assert.doesNotMatch(JSON.stringify(r), /\bsafe\b/i);
});

test('a missing DKIM selector is reported neutrally, not as a problem', () => {
  const r = analyze({ spf: [], dmarc: [], mx: [], dkim: { google: false, selector1: true } });
  const dkim = r.findings.filter((x) => x.check === 'dkim');
  assert.deepEqual(levels(dkim), ['info', 'info']);
  assert.match(dkim[0].message, /normal if the provider uses a different selector/);
});

test('resolver outages never become false missing-SPF/DMARC findings or a strong result', () => {
  const report = analyze({ spf: [], dmarc: [], mx: [], dkim: {}, errors: {spf:'ETIMEOUT', dmarc:'ECONNREFUSED', mx:'EAI_AGAIN'} });
  assert.equal(report.verification.status, 'unverified');
  assert.match(report.rating, /incomplete/);
  assert.ok(!report.findings.some(x => /No SPF|No DMARC/.test(x.message)));
  assert.deepEqual(report.verification.unverified_checks.map(x=>x.check),['spf','dmarc','mx']);
});

test('verified SPF weakness is still reported while unrelated DNS check is unverified', () => {
  const report = analyze({spf:['v=spf1 +all'], dmarc:[], mx:[], dkim:{selector1:'error: ETIMEOUT'},
    errors:{dmarc:'ECONNREFUSED'}, dkim_errors:{selector1:'ETIMEOUT'}});
  assert.equal(report.verification.status,'partial');
  assert.ok(report.findings.some(x=>x.level==='urgent'));
  assert.ok(!report.findings.some(x=>/No DMARC record/.test(x.message)));
  assert.ok(!report.findings.some(x=>/No DKIM key/.test(x.message)));
});
