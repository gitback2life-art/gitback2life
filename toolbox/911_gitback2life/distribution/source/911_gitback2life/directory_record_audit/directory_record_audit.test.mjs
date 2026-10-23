import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { auditRecords, kindOf, leaves, mask, phoneProblem, urlProblem } from './directory_record_audit.mjs';

const NOW = Date.parse('2026-10-09T00:00:00Z');
const rec = (id, data) => ({ id, data });

test('leaves and field recognition by name', () => {
  assert.deepEqual(leaves({ a: { phone: '1' }, urls: ['x'] }), [['a.phone', '1'], ['urls[0]', 'x']]);
  assert.equal(kindOf('intake.phone'), 'phone');
  assert.equal(kindOf('website'), 'url');
  assert.equal(kindOf('source_url'), 'url');
  assert.equal(kindOf('contact.email'), 'email');
  assert.equal(kindOf('last_checked'), 'date');
  assert.equal(kindOf('description'), null);
});

test('US phone format: 10 digits, or 11 starting with 1; extensions allowed', () => {
  assert.equal(phoneProblem('(212) 555-0100'), null);
  assert.equal(phoneProblem('+1 212.555.0100 x204'), null);
  assert.match(phoneProblem('555-0100'), /7 digits/);
  assert.match(phoneProblem('212-555-01000'), /11 digits/);
  assert.match(phoneProblem('call us'), /letters/);
});

test('web address problems', () => {
  assert.equal(urlProblem('https://www.example-rescue.org/adopt'), null);
  assert.equal(urlProblem('example-rescue.org'), null, 'bare domains are fine');
  assert.equal(urlProblem('http://example-rescue.org').level, 'info');
  assert.equal(urlProblem('ftp://example-rescue.org').level, 'review');
  assert.equal(urlProblem('https://exam ple.org').level, 'review');
  assert.equal(urlProblem('https://localhost').level, 'review');
});

test('audit finds stale dates, missing fields, malformed values and duplicates', () => {
  const records = [
    rec('a', { name: 'Paws Rescue', phone: '212-555-0100', website: 'https://paws.example.org', last_checked: '2026-09-01' }),
    rec('b', { name: 'paws rescue', phone: '(212) 555-0100', website: 'http://www.paws.example.org', last_checked: '2025-01-01' }),
    rec('c', { name: 'Kitten Help', intake: { phone: '555-0199', url: 'ftp://kitten.example' }, email: 'not-an-email', last_checked: 'soon' }),
  ];
  const f = auditRecords(records, { require: ['name', 'website'], now: NOW });
  const has = (check, record) => f.some((x) => x.check === check && (!record || x.record === record));
  assert.ok(has('stale', 'b'));
  assert.ok(!has('stale', 'a'));
  assert.ok(has('missing', 'c'));
  assert.ok(has('phone_format', 'c'));
  assert.ok(has('web_address', 'c'));
  assert.ok(has('email_format', 'c'));
  assert.ok(has('date', 'c'));
  assert.ok(has('duplicate_name', 'a, b'));
  assert.ok(has('duplicate_phone', 'a, b'));
  assert.ok(has('duplicate_website', 'a, b'), 'www. and http/https differences still count as the same site');
  assert.equal(f.find((x) => x.check === 'duplicate_phone').level, 'info', 'shared hotlines are normal');
});

test('masking hides most of phone numbers and email names', () => {
  assert.equal(mask('phone', '212-555-0100'), '•••-•••-0100');
  assert.equal(mask('email', 'jane@example.org'), 'j***@example.org');
});

test('the tool contains no network code at all', () => {
  const src = readFileSync(new URL('./directory_record_audit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /node:(https?|net|dns|tls|dgram)|fetch\(|politeFetch/);
});
