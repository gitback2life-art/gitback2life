import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { draftNotice, scrub } from './notice_drafter.mjs';

const ledger = () => JSON.parse(readFileSync(new URL('../evidence_ledger/examples/nyc-animal-rescue.ledger.json', import.meta.url), 'utf8'));
const ORG = 'Kittens and Barbells Rescue, Inc.';

test('reports are worded as reports, never as confirmed facts', () => {
  const { text } = draftNotice(ledger(), { org: ORG });
  assert.match(text, /reported, and not yet independently confirmed/);
  assert.match(text, /It was reported that: Issue #1/);
  assert.doesNotMatch(text, /What I observed directly/, 'the example has no confirmed observations');
});

test('the draft says what was not done, offers evidence, and is clearly marked as unsent', () => {
  const { text } = draftNotice(ledger(), { org: ORG });
  assert.match(text, /I have not changed anything, logged in to anything/);
  assert.match(text, /No reply is needed/);
  assert.match(text, /DRAFT: not sent/);
  assert.match(text, /https:\/\/www\.kittensandbarbells\.org\/? is still your correct web address/); // URLs are normalized by the output guard
});

test('the example ledger produces no verdict words', () => {
  for (const to of ['organization', 'maintainer', 'registrar', 'host']) {
    assert.deepEqual(draftNotice(ledger(), { audience: to, org: ORG }).warnings, [], to);
  }
});

test('verdict words in the ledger are caught', () => {
  const l = ledger();
  l.items[2].text = 'The site was hacked and is infected.';
  const { warnings } = draftNotice(l, { org: ORG });
  assert.ok(warnings.includes('hacked') && warnings.includes('infected'));
});

test('contact details and secrets are removed from drafts', () => {
  assert.equal(scrub('call 212-555-0100 or email jane@example.org'), 'call [contact detail removed] or email [contact detail removed]');
  assert.doesNotMatch(scrub('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /ghp_/);
});

test('registrar and host drafts say the organization should make account requests', () => {
  for (const to of ['registrar', 'host']) assert.match(draftNotice(ledger(), { audience: to }).text, /organization itself should make any account requests/);
  assert.throws(() => draftNotice(ledger(), { audience: 'press' }), /audience must be/);
});

test('confirmed observations appear with their time and source', () => {
  const l = ledger();
  l.items.push({ id: 'E9', label: 'confirmed_observation', org: ORG, text: 'Registration expiry date is 2026-12-01.', source_url: 'https://rdap.org/domain/kittensandbarbells.org', retrieved_at: '2026-10-09T01:00:00Z' });
  const { text } = draftNotice(l, { org: ORG });
  assert.match(text, /What I observed directly:\n- Registration expiry date is 2026-12-01\. \(seen 2026-10-09T01:00:00Z; source: https:\/\/rdap\.org/);
});
