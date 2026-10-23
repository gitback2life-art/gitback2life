import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { languageWarnings, renderSummary } from './decision_summary.mjs';

const example = () => JSON.parse(readFileSync(new URL('../evidence_ledger/examples/nyc-animal-rescue.ledger.json', import.meta.url), 'utf8'));

test('summary has all six sections in order', () => {
  const s = renderSummary(example());
  const idx = [1, 2, 3, 4, 5, 6].map((n) => s.indexOf(`## ${n}.`));
  assert.ok(idx.every((i) => i >= 0), 'all sections present');
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'in order');
});

test('source reports are labeled as not independently verified and unfetched items say so', () => {
  const s = renderSummary(example());
  assert.match(s, /\*\*E3\*\* \(source report\)/);
  assert.match(s, /retrieved: not re-fetched/);
  assert.match(s, /Source reports \(not independently verified\): E1, E2, E3, E5/);
});

test('the summary shows the suggested verdict next to the (unset) human verdict', () => {
  assert.match(renderSummary(example()), /Kittens and Barbells Rescue, Inc\.\*\*: verdict not set · suggested: "needs review"/);
});

test('the example ledger uses calibrated language', () => {
  assert.deepEqual(languageWarnings(example()), []);
});

test('verdict-sounding words are flagged for a second look', () => {
  const l = example();
  l.risk = 'The site is hacked and infected.';
  const terms = languageWarnings(l).map((w) => w.term);
  assert.ok(terms.includes('hacked') && terms.includes('infected'));
  assert.match(renderSummary(l), /Language check/);
});
