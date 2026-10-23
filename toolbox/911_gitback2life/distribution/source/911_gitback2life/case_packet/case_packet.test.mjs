import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { buildPacket, fileProblems, imageMetadata, zipStore } from './case_packet.mjs';

const ledger = () => JSON.parse(readFileSync(new URL('../evidence_ledger/examples/nyc-animal-rescue.ledger.json', import.meta.url), 'utf8'));

/** Read back a stored zip: returns {name: Buffer}, verifying signatures and CRCs. */
function readZip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endAt > 0, 'end record present');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16); const size = buf.readUInt32LE(p + 24); const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const data = buf.subarray(start, start + size);
    assert.equal(crc32(data) >>> 0, crc, `${name} CRC`);
    files[name] = data;
    p += 46 + nameLen;
  }
  return files;
}

// A genuine 1x1 RGB PNG (valid header, pixel data and checksums), plus any extra chunks. V6-02: the strict image
// policy refuses malformed PNGs, so the "clean image" fixture must be a real one (the old one had zero CRCs and no pixels).
const png = (chunks) => {
  const c = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), c('IHDR', ihdr), ...chunks.map(([t, d]) => c(t, Buffer.from(d))),
    c('IDAT', deflateSync(Buffer.from([0, 1, 2, 3]))), c('IEND', Buffer.alloc(0))]);
};

test('zipStore output reads back with matching names, data and CRCs', () => {
  const zip = zipStore([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.json', data: Buffer.from('{}') }]);
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/b.json']);
  assert.equal(files['a.txt'].toString(), 'hello');
});

test('a packet from the NYC example has README, summary, ledger and a manifest that matches', () => {
  const { zip, manifest } = buildPacket(ledger(), [{ name: 'notes.md', data: Buffer.from('Checked issue #1 at 2026-10-09T01:00Z.') }], { now: '2026-10-09T02:00:00Z', humanReviewed: true });
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), ['README.txt', 'summary.md', 'ledger.json', 'evidence/notes.md', 'MANIFEST.json']);
  for (const f of manifest.files) assert.equal(createHash('sha256').update(files[f.path]).digest('hex'), f.sha256, f.path);
  assert.match(files['summary.md'].toString(), /## 1\. What was checked/);
});

test('images with metadata are refused; clean images are accepted', () => {
  assert.deepEqual(imageMetadata(png([['tEXt', 'Author\0Jane']])), ['tEXt']);
  assert.match(fileProblems('shot.png', png([['eXIf', 'MM']])).join(), /run metadata_scrub first/);
  assert.deepEqual(fileProblems('shot.png', png([])), []);
  const jpegExif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda]);
  assert.deepEqual(imageMetadata(jpegExif), ['APP1']);
});

test('secrets, contact details and disallowed types are refused, and the packet is not built', () => {
  assert.match(fileProblems('a.txt', Buffer.from('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).join(), /secret/);
  assert.match(fileProblems('a.txt', Buffer.from('call 212-555-0100')).join(), /email address or phone/);
  assert.match(fileProblems('a.txt', Buffer.from('mail jane@example.org')).join(), /email address or phone/);
  assert.match(fileProblems('run.exe', Buffer.from('MZ')).join(), /not allowed/);
  const r = buildPacket(ledger(), [{ name: 'contacts.txt', data: Buffer.from('jane@example.org') }], { humanReviewed: true });
  assert.equal(r.zip, undefined);
  assert.equal(r.refused[0].name, 'evidence/contacts.txt');
});

test('an invalid ledger is refused', () => {
  const l = ledger();
  l.items[0].label = 'rumour';
  assert.throws(() => buildPacket(l, [], { humanReviewed: true }), /ledger is invalid/);
});

test('a packet is never built until a person confirms the personal-information review', () => {
  assert.throws(() => buildPacket(ledger(), []), /a person must review the packet contents/);
  const { zip } = buildPacket(ledger(), [], { humanReviewed: true });
  assert.match(readZip(zip)['README.txt'].toString(), /a person confirmed they checked/);
});

test('links with credentials or secret-looking parameters are refused', () => {
  assert.match(fileProblems('n.md', Buffer.from('see https://files.example.org/report?token=abc123')).join(), /secret-looking parameter/);
  assert.match(fileProblems('n.md', Buffer.from('see https://cdn.example/x?X-Amz-Signature=deadbeef')).join(), /secret-looking parameter/);
  assert.deepEqual(fileProblems('n.md', Buffer.from('see https://github.com/o/r/issues/1?page=2')), []);
});
test('F09: Markdown and CSV that become active when viewed are refused; inert forms and plain text pass', () => {
  const md = (s) => fileProblems('e.md', Buffer.from(s));
  for (const bad of ['<img src="https://tracking.example/p">', 'x <script>alert(1)</script>', '<!-- hidden -->', '![x](https://tracking.example/p.png)',
    '![x][ref]', '[run](javascript:alert(1))', '[d]( data:text/html,<b>x</b>)', '[f](file:///C:/x)', '[r]: javascript:alert(1)', '<javascript:alert(1)>']) {
    assert.match(md(bad).join(), /becomes active/, bad);
  }
  for (const ok of ['# Title\n\nPlain **bold** text, a [web link](https://example.org/a) and <https://example.org/b>.', 'See [section](#notes); 3 < 4 and 5 > 2.', '- item\n- item']) {
    assert.deepEqual(md(ok), [], ok);
  }
  const csv = (s) => fileProblems('e.csv', Buffer.from(s));
  for (const bad of ['a,b\n=HYPERLINK("https://x.example"),1', 'a,"+cmd"', '@SUM(A1)', 'x;-cmd|calc']) assert.match(csv(bad).join(), /formulas/, bad);
  for (const ok of ['when,count\n2026-10-09,-5\n2026-10-10,-0.5', 'a,b\n,']) assert.deepEqual(csv(ok), [], ok);
  // The inert route: the same bytes as .txt are accepted, so the evidence hash does not change.
  assert.deepEqual(fileProblems('e.txt', Buffer.from('<img src="https://tracking.example/p"> [run](javascript:alert(1))')), []);
});