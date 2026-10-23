import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { addHypothesis, addItem, createLedger, itemErrors, setVerdict, suggestVerdict, toMarkdown, validateLedger } from './ledger.mjs';

const example = () => JSON.parse(readFileSync(new URL('./examples/nyc-animal-rescue.ledger.json', import.meta.url), 'utf8'));

test('the NYC example ledger is valid and renders', () => {
  assert.deepEqual(validateLedger(example()), []);
  assert.match(toMarkdown(example()), /talesofhazaribagh/);
});

const SRC = 'https://src.example/evidence';
const OWN = { asset: { kind: 'domain', id: 'org.example', controlled_by: 'organization' } };
const THIRD = { asset: { kind: 'service', id: 'forms-provider.example', controlled_by: 'third_party' } };
const UNKNOWN = { asset: { kind: 'website', id: 'maybe.example', controlled_by: 'unknown' } };
const obs = (id, signal, extra = {}) => ({ id, label: 'confirmed_observation', org: 'Org', text: 't', source_url: SRC, retrieved_at: '2026-10-08T00:00:00Z', signal, ...extra });
const rep = (id, signal, extra = {}) => ({ id, label: 'source_report', org: 'Org', text: 't', source_url: SRC, signal, ...extra });

// ---- Structure ----
test('confirmed observations need a real web source and a UTC retrieval time', () => {
  const l = createLedger('t');
  assert.throws(() => addItem(l, { label: 'confirmed_observation', text: 'x' }), /source_url/);
  assert.throws(() => addItem(l, { label: 'confirmed_observation', text: 'x', source_url: 'u' }), /http\(s\)/);
  assert.throws(() => addItem(l, { label: 'confirmed_observation', text: 'x', source_url: 'javascript:alert(1)', retrieved_at: '2026-10-08T00:00:00Z' }), /http\(s\)/);
  assert.throws(() => addItem(l, { label: 'confirmed_observation', text: 'x', source_url: SRC }), /retrieved_at/);
  assert.equal(addItem(l, { label: 'confirmed_observation', text: 'x', source_url: SRC, retrieved_at: '2026-10-08T00:00:00Z' }).id, 'E1');
});

test('retrieval times must be real UTC timestamps and not in the future', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  for (const bad of ['yesterday', '2026-10-08', '2026-10-08 10:00', '2026-10-08T00:00:00+02:00', '2026-13-40T99:00:00Z']) {
    assert.ok(itemErrors({ ...obs('E1', 'none'), retrieved_at: bad }, { now }).some((e) => /UTC timestamp/.test(e)), bad);
  }
  assert.ok(itemErrors({ ...obs('E1', 'none'), retrieved_at: '2026-10-10T00:00:00Z' }, { now }).some((e) => /future/.test(e)));
  assert.deepEqual(itemErrors({ ...obs('E1', 'none'), retrieved_at: '2026-10-08T23:59:59.123Z' }, { now }), []);
});

test('reports may cite a non-web source_ref; confirmed observations may not', () => {
  assert.deepEqual(itemErrors({ label: 'source_report', text: 't', source_ref: 'handoff brief, prior session' }), []);
  assert.ok(itemErrors({ label: 'source_report', text: 't' }).some((e) => /source_ref/.test(e)));
  assert.ok(itemErrors({ ...obs('E1', 'none'), source_ref: 'notes' }).some((e) => /only for reports/.test(e)));
});

test('warning signals must name the organization; asset signals must name the asset and who controls it', () => {
  assert.ok(itemErrors({ ...rep('E1', 'redirect_off_domain'), org: undefined }).some((e) => /needs org/.test(e)));
  assert.ok(itemErrors(obs('E1', 'compromise_confirmed')).some((e) => /needs asset/.test(e)));
  assert.ok(itemErrors(obs('E1', 'compromise_confirmed', { asset: { kind: 'planet', id: 'x', controlled_by: 'organization' } })).some((e) => /asset\.kind/.test(e)));
  assert.ok(itemErrors(obs('E1', 'compromise_confirmed', { asset: { kind: 'domain', id: '', controlled_by: 'organization' } })).some((e) => /asset\.id/.test(e)));
  assert.ok(itemErrors(obs('E1', 'compromise_confirmed', { asset: { kind: 'domain', id: 'x', controlled_by: 'probably' } })).some((e) => /controlled_by/.test(e)));
  assert.deepEqual(itemErrors(obs('E1', 'compromise_confirmed', OWN)), []);
  assert.deepEqual(itemErrors(obs('E1', 'none', { org: undefined })), [], 'a "nothing notable" item needs no org');
});

test('a requested URL must carry its page role, and URLs must be web addresses', () => {
  const l = createLedger('t');
  assert.throws(() => addItem(l, { label: 'source_report', text: 'x', source_url: SRC, requested_url: 'https://a.org' }), /page_role/);
  assert.throws(() => addItem(l, { label: 'source_report', text: 'x', source_url: SRC, requested_url: 'https://a.org', page_role: 'homepage' }), /page_role/);
  assert.throws(() => addItem(l, { label: 'source_report', text: 'x', source_url: SRC, requested_url: 'not a url', page_role: 'primary' }), /requested_url must be/);
});

test('item text is redacted on the way in', () => {
  const l = createLedger('t');
  const it = addItem(l, { label: 'inference', text: 'saw token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in a log' });
  assert.match(it.text, /REDACTED/);
});

test('hypotheses may only cite evidence that exists', () => {
  const l = createLedger('t');
  assert.throws(() => addHypothesis(l, { id: 'H1', statement: 's', supporting: ['E9'] }), /unknown evidence/);
});

// ---- Verdicts are bound to the organization and to assets it controls (review finding E) ----
test('verdicts are restricted, and "compromise" needs independent confirmed evidence', () => {
  const l = createLedger('t');
  addItem(l, rep('E1', 'redirect_off_domain'));
  assert.throws(() => setVerdict(l, 'Org', 'hacked', ['E1']), /verdict must be/);
  assert.throws(() => setVerdict(l, 'Org', 'needs review', []), /needs at least one/);
  assert.throws(() => setVerdict(l, 'Org', 'independent evidence of compromise', ['E1']), /requires a confirmed_observation/);
  setVerdict(l, 'Org', 'needs review', ['E1']);
  assert.equal(l.verdicts.Org.verdict, 'needs review');
});

test('evidence about organization A cannot support a verdict about organization B', () => {
  const l = createLedger('t');
  addItem(l, obs('E1', 'compromise_confirmed', { org: 'Rescue A', ...OWN }));
  assert.throws(() => setVerdict(l, 'Rescue B', 'independent evidence of compromise', ['E1']), /is about "Rescue A", not "Rescue B"/);
  assert.throws(() => setVerdict(l, 'Rescue B', 'needs review', ['E1']), /not "Rescue B"/);
  assert.doesNotThrow(() => setVerdict(l, 'Rescue A', 'independent evidence of compromise', ['E1']));
});

test('a compromised third-party service is not a compromised rescue', () => {
  const l = createLedger('t');
  addItem(l, obs('E1', 'compromise_confirmed', THIRD));
  assert.throws(() => setVerdict(l, 'Org', 'independent evidence of compromise', ['E1']), /that "Org" itself controls/);
  const s = suggestVerdict(l.items, { subject: 'Org' });
  assert.equal(s.verdict, 'needs review');
  assert.match(s.reason, /not \(known to be\) the organization's own asset: E1/);
  assert.equal(suggestVerdict([obs('E1', 'compromise_confirmed', UNKNOWN)]).verdict, 'needs review', 'unknown ownership is not enough either');
});

test('suggestVerdict for one organization ignores evidence about another', () => {
  const items = [obs('E1', 'compromise_confirmed', { org: 'Rescue A', ...OWN }), rep('E2', 'redirect_off_domain', { org: 'Rescue B', page_role: 'primary' })];
  assert.equal(suggestVerdict(items, { subject: 'Rescue B' }).verdict, 'needs review');
  assert.equal(suggestVerdict(items, { subject: 'Rescue C' }).verdict, 'no evidence found');
  assert.equal(suggestVerdict(items, { subject: 'Rescue A' }).verdict, 'independent evidence of compromise');
});

test('a hand-edited ledger cannot sneak in a cross-organization or third-party verdict', () => {
  const l = createLedger('t');
  l.items.push(obs('E1', 'compromise_confirmed', { org: 'Rescue A', ...OWN }), obs('E2', 'compromise_confirmed', { org: 'Rescue B', ...THIRD }));
  l.verdicts['Rescue B'] = { verdict: 'independent evidence of compromise', basis: ['E1'] };
  const errors = validateLedger(l);
  assert.ok(errors.some((e) => /is about "Rescue A", not "Rescue B"/.test(e)), errors.join('\n'));
  l.verdicts['Rescue B'].basis = ['E2'];
  assert.ok(validateLedger(l).some((e) => /itself controls/.test(e)));
});

// ---- Suggested verdicts ----
test('suggestVerdict: nothing notable, or only inferences/hypotheses → no evidence found', () => {
  assert.equal(suggestVerdict([]).verdict, 'no evidence found');
  assert.equal(suggestVerdict([obs('E1', 'none')]).verdict, 'no evidence found');
  assert.equal(suggestVerdict([{ id: 'E1', label: 'inference', text: 't', signal: 'compromise_confirmed' }]).verdict, 'no evidence found');
});

test('suggestVerdict: secondary-page redirects are not counted as the primary site moving', () => {
  for (const role of ['intake', 'source', 'contact']) {
    const s = suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: role })]);
    assert.equal(s.verdict, 'no evidence found', role);
    assert.match(s.reason, /secondary-page/);
  }
});

test('suggestVerdict: a reported or uncorroborated primary redirect → needs review', () => {
  assert.equal(suggestVerdict([rep('E1', 'redirect_off_domain', { page_role: 'primary' })]).verdict, 'needs review');
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'primary' })]).verdict, 'needs review');
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain')]).verdict, 'needs review', 'unknown page role stays reviewable');
});

test('suggestVerdict: reports alone never reach suspicious or compromise', () => {
  const s = suggestVerdict([rep('E1', 'redirect_off_domain', { page_role: 'primary' }), rep('E2', 'reputation_flag', THIRD), rep('E3', 'compromise_confirmed', OWN)]);
  assert.equal(s.verdict, 'needs review');
});

test('suggestVerdict: confirmed primary redirect plus confirmed corroboration → suspicious indicators', () => {
  const s = suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'primary' }), obs('E2', 'dns_or_registration_change', OWN)]);
  assert.equal(s.verdict, 'suspicious indicators');
  assert.match(s.reason, /E1, E2/);
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'intake' }), obs('E2', 'reputation_flag', THIRD)]).verdict, 'needs review',
    'an intake redirect cannot be the redirect half of the pair');
  // F10: the fixture now says where the redirect went; a flag corroborates only when it is about that place.
  const toForms = { page_role: 'primary', requested_url: 'https://org.example/', final_url: 'https://www.Forms-Provider.example/x' };
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', toForms), obs('E2', 'reputation_flag', THIRD)]).verdict, 'suspicious indicators',
    'a reputation flag on the redirect destination still corroborates');
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', { ...toForms, final_url: 'https://benign.example/' }), obs('E2', 'reputation_flag', THIRD)]).verdict, 'needs review',
    'a flag on a site the redirect did not reach does not corroborate (F10)');
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', toForms), obs('E2', 'reputation_flag', { asset: { kind: 'domain', id: 'example', controlled_by: 'third_party' } })]).verdict, 'needs review',
    'a flag on a parent or non-host identity does not corroborate');
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', { ...toForms, final_url: 'https://benign.example/' }), obs('E2', 'reputation_flag', OWN)]).verdict, 'suspicious indicators',
    "a flag on the organization's own redirecting site corroborates");
  assert.equal(suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'primary' }), obs('E2', 'dns_or_registration_change', THIRD)]).verdict, 'needs review',
    "a DNS change to someone else's domain does not corroborate");
});

test('suggestVerdict: confirmed harmful content on the organization\'s own primary site alone → suspicious indicators, never compromise', () => {
  const s = suggestVerdict([obs('E1', 'malicious_content', { page_role: 'primary', ...OWN })]);
  assert.equal(s.verdict, 'suspicious indicators');
  assert.match(s.reason, /E1/);
  assert.equal(suggestVerdict([obs('E1', 'malicious_content', { page_role: 'primary', ...UNKNOWN })]).verdict, 'needs review', 'ownership must be known');
});

test('suggestVerdict: harmful content on a side page or unknown page → needs review, not suspicious', () => {
  for (const role of ['intake', 'source', 'contact', undefined]) {
    assert.equal(suggestVerdict([obs('E1', 'malicious_content', { page_role: role, ...THIRD })]).verdict, 'needs review', String(role));
  }
});

test('suggestVerdict: side-page harmful content does not corroborate a primary redirect', () => {
  const s = suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'primary' }), obs('E2', 'malicious_content', { page_role: 'intake', ...THIRD })]);
  assert.equal(s.verdict, 'needs review');
  const t = suggestVerdict([obs('E1', 'redirect_off_domain', { page_role: 'primary' }), obs('E2', 'malicious_content', { page_role: 'primary', ...OWN })]);
  assert.equal(t.verdict, 'suspicious indicators');
});

test('suggestVerdict: only a confirmed compromise of the organization\'s own asset reaches the top verdict', () => {
  assert.equal(suggestVerdict([obs('E1', 'compromise_confirmed', OWN)]).verdict, 'independent evidence of compromise');
});

test('suggestVerdict agrees with setVerdict: its top verdict is always settable from the same basis', () => {
  const l = createLedger('t');
  addItem(l, obs('E1', 'compromise_confirmed', OWN));
  assert.doesNotThrow(() => setVerdict(l, 'Org', suggestVerdict(l.items, { subject: 'Org' }).verdict, ['E1']));
});

test('suggestVerdict on the NYC example: Kittens and Barbells → needs review', () => {
  const s = suggestVerdict(example().items, { subject: 'Kittens and Barbells Rescue, Inc.' });
  assert.equal(s.verdict, 'needs review');
  assert.match(s.reason, /E3/);
});

