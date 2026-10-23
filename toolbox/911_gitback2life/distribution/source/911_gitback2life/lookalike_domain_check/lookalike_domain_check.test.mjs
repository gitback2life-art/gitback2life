import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { classify, generateVariants, PER_RUN, recentRegistration, splitDomain } from './lookalike_domain_check.mjs';

test('splitDomain handles www, plain and two-part endings', () => {
  assert.deepEqual(splitDomain('https://www.kittensandbarbells.org/'), { name: 'kittensandbarbells', suffix: 'org' });
  assert.deepEqual(splitDomain('rescue.org.uk'), { name: 'rescue', suffix: 'org.uk' });
});

test('variants cover the common kinds, never include the original, and are valid names', () => {
  const v = generateVariants('kittensandbarbells.org');
  const domains = v.map((x) => x.domain);
  assert.ok(!domains.includes('kittensandbarbells.org'));
  for (const d of ['kittensandbarbells.com', 'kittensandbarbel1s.org', 'kittensandbarbels.org', 'kittensadnbarbells.org',
    'kittensandbarbellss.org', 'wwwkittensandbarbells.org']) assert.ok(domains.includes(d), d);
  assert.equal(new Set(domains).size, domains.length, 'no duplicates');
  for (const d of domains) assert.match(d, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z.]+$/, d);
});

test('the most commonly abused kinds come first, so the first batch is the most useful', () => {
  const kinds = generateVariants('example-rescue.org').slice(0, 6).map((x) => x.kind);
  assert.deepEqual(kinds.slice(0, 4), ['different ending', 'different ending', 'different ending', 'different ending']);
  assert.ok(PER_RUN <= 25);
});

test('classify: nameservers → registered, NXDOMAIN → not found, errors → unknown', () => {
  assert.equal(classify(['ns1.host.net']), 'registered');
  assert.equal(classify({ code: 'ENOTFOUND' }), 'not found');
  assert.equal(classify({ code: 'ENODATA' }), 'registered');
  assert.equal(classify({ code: 'ETIMEOUT' }), 'unknown');
  assert.equal(classify({ code: 'ESERVFAIL' }), 'unknown');
});

test('recently registered means within 90 days', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  assert.equal(recentRegistration('2026-09-01T00:00:00Z', now), true);
  assert.equal(recentRegistration('2025-01-01T00:00:00Z', now), false);
  assert.equal(recentRegistration(null, now), false);
});

test('the tool never calls a lookalike a scam, fake or malicious', () => {
  const src = readFileSync(new URL('./lookalike_domain_check.mjs', import.meta.url), 'utf8');
  const userText = [...src.matchAll(/(['`])((?:(?!\1).)*)\1/g)].map((m) => m[2]).join(' ').toLowerCase();
  for (const word of ['scam', 'fake', 'malicious', 'fraud', 'phishing']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(userText.replace(/never "scam"/g, '')), word);
  }
});
