import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { escapeMarkdown, mdText, mdUrl, sanitizeText, sanitizeUrl } from './output.mjs';
import { renderSummary } from '../decision_summary/decision_summary.mjs';
import { toMarkdown } from '../evidence_ledger/ledger.mjs';
import { draftNotice } from '../notice_drafter/notice_drafter.mjs';

const example = () => JSON.parse(readFileSync(new URL('../evidence_ledger/examples/nyc-animal-rescue.ledger.json', import.meta.url), 'utf8'));

test('sanitizeUrl strips credentials and secret-looking parameters but keeps ordinary ones', () => {
  assert.equal(sanitizeUrl('https://user:pw@a.example/p?token=abc&page=2'), 'https://a.example/p?token=REDACTED&page=2');
  assert.equal(sanitizeUrl('https://a.example/p?X-Amz-Signature=x&sig=y&session_id=z&email=j@x.org'),
    'https://a.example/p?X-Amz-Signature=REDACTED&sig=REDACTED&session_id=REDACTED&email=REDACTED');
  assert.equal(sanitizeUrl('https://a.example/cb#access_token=abc'), 'https://a.example/cb');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '[non-web link removed]');
  assert.equal(sanitizeUrl('https://github.com/o/r/issues/1?page=2'), 'https://github.com/o/r/issues/1?page=2');
});

test('sanitizeText masks secrets, contact details and secret URLs inside free text', () => {
  const out = sanitizeText('mail jane@example.org or 212-555-0100; token ghp_abcdefghijklmnopqrstuvwxyz0123456789; https://x.example/a?key=s3cr3t');
  assert.doesNotMatch(out, /jane@|555-0100|ghp_|s3cr3t/);
  assert.match(out, /\[contact detail removed\]/);
});

test('escapeMarkdown neutralizes links, images, HTML, headings, tables and emphasis', () => {
  const evil = '# Heading\n[click](javascript:alert(1)) ![img](https://t.example/p.png) <img src=x onerror=alert(1)> | col | **bold** `code` ~~x~~';
  const out = escapeMarkdown(evil);
  assert.doesNotMatch(out, /\n/, 'cannot start a new line (no headings or list items)');
  assert.doesNotMatch(out, /(?<!\\)\[/, 'every [ is escaped, so no link or image can form');
  assert.doesNotMatch(out, /<img/, 'no raw HTML');
  assert.doesNotMatch(out, /(?<!\\)\|/, 'no unescaped table separators');
  assert.doesNotMatch(out, /(?<!\\)\*\*/);
});

test('mdUrl renders only web links, sanitized, as autolinks', () => {
  assert.equal(mdUrl('https://a.example/x?token=1'), '<https://a.example/x?token=REDACTED>');
  assert.equal(mdUrl('javascript:alert(1)'), '\\[non-web link removed\\]');
  assert.equal(mdUrl('https://a.example/<script>'), '<https://a.example/%3Cscript%3E>', 'angle brackets cannot break out of the autolink');
});

function poisonedLedger() {
  const l = example();
  // Hand-edited after the fact: never went through addItem's redaction.
  l.items[2].text = 'See [official notice](https://evil.example/login) <script>alert(1)</script>\n# Fake heading | x | contact jane@example.org token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  l.items[2].source_url = 'https://github.com/o/r/issues/1?access_token=supersecret';
  l.risk = '**URGENT** [act now](https://evil.example)';
  return l;
}

test('the decision summary is safe even when the ledger was hand-edited with hostile or private text', () => {
  const s = renderSummary(poisonedLedger());
  assert.doesNotMatch(s, /<script>|\[official notice\]\(|\[act now\]\(/, 'no live links or HTML from evidence text');
  assert.doesNotMatch(s, /\n# Fake heading/);
  assert.doesNotMatch(s, /jane@example\.org|ghp_|supersecret/);
  assert.match(s, /Before sharing \(a person must check/);
});

test('the Markdown ledger is safe even when the ledger was hand-edited with hostile or private text', () => {
  const md = toMarkdown(poisonedLedger());
  assert.doesNotMatch(md, /<script>|\[official notice\]\(/);
  assert.doesNotMatch(md, /jane@example\.org|ghp_|supersecret/);
  const row = md.split('\n').find((r) => r.startsWith('| E3 '));
  assert.equal(row.split(/(?<!\\)\|/).length, 10, 'the table row still has exactly 8 columns');
});

test('drafted notices remove contact details, tokens and secret URL parameters, and end with the sharing checklist', () => {
  const { text } = draftNotice(poisonedLedger(), { org: 'Kittens and Barbells Rescue, Inc.' });
  assert.doesNotMatch(text, /jane@example\.org|ghp_|supersecret/);
  assert.match(text, /Before sending, a person must check/);
});

test('ordinary evidence text stays readable', () => {
  assert.equal(mdText('Kittens and Barbells Rescue, Inc. (Oct 5) - weekly-check #1'), 'Kittens and Barbells Rescue, Inc. (Oct 5) - weekly-check #1');
});

test('F08: malformed URLs in evidence never crash the sanitizer, and secrets in them are still masked', () => {
  for (const bad of ['https://[', 'http://[::1', 'https://%zz', 'https://exa mple.org/?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'https://[/x?api_key=SYNTHETIC jane@example.org']) {
    let out;
    assert.doesNotThrow(() => { out = sanitizeText(bad); out = mdText(bad); out = mdUrl(bad); }, bad);
    assert.doesNotMatch(sanitizeText(bad), /ghp_|SYNTHETIC|jane@example\.org/, bad);
    assert.doesNotMatch(sanitizeUrl(bad), /ghp_|SYNTHETIC|jane@example\.org/, bad);
  }
});