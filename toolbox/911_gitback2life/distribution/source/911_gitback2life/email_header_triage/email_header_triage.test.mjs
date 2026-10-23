import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address, editDistance, mask, parseHeaders, triage } from './email_header_triage.mjs';

const SUSPICIOUS = [
  'From: "billing@kittensandbarbells.org" <alerts@kittensandbarbe1ls.org>',
  'Reply-To: help-desk@freemail.example',
  'Return-Path: <bounce@kittensandbarbe1ls.org>',
  'Subject: Your domain will be deleted',
  'Authentication-Results: mx.example.net;',
  '  spf=softfail smtp.mailfrom=kittensandbarbe1ls.org; dkim=none; dmarc=fail header.from=kittensandbarbe1ls.org',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="XX"',
  '',
  '--XX',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Renew now: <a href=3D"https://renew.registrar-help.example/login">www.godaddy.com</a></p>',
  '<a href="https://xn--kttensandbarbells-6qb.org/">our site</a>',
  '--XX',
  'Content-Type: application/octet-stream; name="invoice.pdf.exe"',
  'Content-Disposition: attachment; filename="invoice.pdf.exe"',
  'Content-Transfer-Encoding: base64',
  '',
  'TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAA=',
  '--XX--',
].join('\r\n');

const CLEAN = [
  'From: Example Rescue <news@example-rescue.org>',
  'Subject: Adoption day',
  'Authentication-Results: mx.example.net; spf=pass; dkim=pass; dmarc=pass header.from=example-rescue.org',
  'Content-Type: text/plain',
  '',
  'See https://www.example-rescue.org/events',
].join('\r\n');

test('headers unfold continuation lines', () => {
  const h = parseHeaders('Subject: a\r\n  b\r\nFrom: x@y.org');
  assert.deepEqual(h, [['subject', 'a b'], ['from', 'x@y.org']]);
});

test('address and mask', () => {
  assert.deepEqual(address('"Jane" <Jane.Doe@Example.org>'), { address: 'jane.doe@example.org', domain: 'example.org' });
  assert.equal(mask('jane.doe@example.org'), 'j***@example.org');
});

test('a suspicious message shows each expected sign', () => {
  const r = triage(SUSPICIOUS, { expected: 'kittensandbarbells.org' });
  const checks = new Set(r.signs.map((s) => s.check));
  for (const c of ['reply_to', 'display_name', 'dmarc', 'lookalike_sender', 'link_mismatch', 'punycode_link', 'attachment']) assert.ok(checks.has(c), c);
  assert.deepEqual(r.attachments, [{ name: 'invoice.pdf.exe', type: 'application/octet-stream' }]);
  assert.ok(r.link_domains.includes('renew.registrar-help.example'), 'quoted-printable href decoded');
});

test('a normal message shows no review signs', () => {
  const r = triage(CLEAN, { expected: 'example-rescue.org' });
  assert.deepEqual(r.signs.filter((s) => s.level === 'review'), []);
  assert.deepEqual(r.link_domains, ['www.example-rescue.org']);
});

test('the attachment is listed but never decoded', () => {
  const r = triage(SUSPICIOUS);
  assert.doesNotMatch(JSON.stringify(r), /TVqQ|MZ/);
});

test('wording stays calibrated: no verdicts', () => {
  const text = JSON.stringify(triage(SUSPICIOUS, { expected: 'kittensandbarbells.org' }).signs).toLowerCase();
  for (const w of ['scam', 'is fake', 'malicious', 'phishing', 'hacked', 'is safe']) assert.ok(!text.includes(w), w);
});

test('editDistance basics', () => {
  assert.equal(editDistance('barbells', 'barbels'), 1);
  assert.equal(editDistance('abc', 'abc'), 0);
});
