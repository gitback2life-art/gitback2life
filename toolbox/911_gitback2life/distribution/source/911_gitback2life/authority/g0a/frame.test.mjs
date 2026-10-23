// G0a: pipe framing, bounds, EOF, timeouts and name validation (design revision 3.1, §6; test group D, protocol
// half). Same-integrity synthetic server and client, non-elevated, temporary staging folders. The privilege-boundary
// tests (first instance, DACL, remote rejection, medium vs elevated client) are gate G0b and are NOT run here.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrame, LIMITS, MAGIC, receiveRequest, sendRequest } from './request_pipe.mjs';

const WIN = process.platform === 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'g0a-pipe-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
/** A fresh pipe name, one-time code and staging folder for one exchange. */
const setup = () => ({ pipe: `\\\\.\\pipe\\gb2l-${randomBytes(16).toString('hex')}`, code: randomBytes(16), stagingDir: join(ROOT, `s${n++}`) });
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const prefix = (code, header) => { const h = Buffer.from(JSON.stringify(header)); return Buffer.concat([MAGIC, code, u32(h.length), h]); };
const REQ = { name: 'request.json', data: Buffer.from('{"record":"synthetic"}') };

/** Start the server, then run the client actions; returns the server's outcome. */
async function exchange(ctx, client, opts = {}) {
  mkdirSync(ctx.stagingDir);
  // Handlers are attached at once: a refusal can arrive while the client is still sending.
  const outcome = receiveRequest({ ...ctx, ...opts }).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
  await new Promise((r) => setTimeout(r, 30));
  await client().catch(() => {});
  return outcome;
}
const raw = (pipe, chunks, { gapMs = 0, end = true } = {}) => () => new Promise((resolve) => {
  const s = connect(pipe, async () => {
    for (const c of chunks) { if (s.destroyed) break; s.write(c); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); }
    if (end && !s.destroyed) s.end();
    resolve();
  });
  s.on('error', () => resolve());
});
const incomingGone = (ctx) => !existsSync(join(ctx.stagingDir, 'incoming'));

test('D: valid requests round-trip; entries are staged with their exact bytes and hashes', { skip: !WIN }, async () => {
  const ctx = setup();
  const files = [REQ, { name: 'files/index.html', data: Buffer.from('<h1>Adopt</h1>') }, { name: 'files/css/site.css', data: Buffer.from('h1{}') }, { name: 'files/empty.txt', data: Buffer.alloc(0) }];
  const r = await exchange(ctx, () => sendRequest(ctx.pipe, buildFrame({ code: ctx.code, operation: 'restore.stage', entries: files })));
  assert.ok(r.ok, r.err);
  assert.deepEqual(r.ok.entries.map((e) => e.name), files.map((f) => f.name));
  for (const e of r.ok.entries) {
    const bytes = readFileSync(join(r.ok.incoming, `entry-${String(e.index).padStart(4, '0')}`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), e.sha256);
  }
  const ctx2 = setup();
  const r2 = await exchange(ctx2, () => sendRequest(ctx2.pipe, buildFrame({ code: ctx2.code, operation: 'register.replace', entries: [REQ] })));
  assert.equal(r2.ok.entries.length, 1);
});

test('G0a-F2: short staging writes are completed; a write that makes no progress refuses and removes staging', { skip: !WIN }, async () => {
  const { writeSync } = await import('node:fs');
  const data = Buffer.from('0123456789'.repeat(50));
  const entries = [REQ, { name: 'files/a.txt', data }];
  // Every write stores at most 7 bytes: the loop must still stage every byte.
  const short = (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(len, 7));
  let ctx = setup();
  let r = await exchange(ctx, () => sendRequest(ctx.pipe, buildFrame({ code: ctx.code, operation: 'restore.stage', entries })), { write: short });
  assert.ok(r.ok, r.err);
  assert.deepEqual(readFileSync(join(r.ok.incoming, 'entry-0001')), data, 'complete bytes despite short writes');
  // A write that reports 0 bytes is refused rather than looping or silently truncating.
  ctx = setup();
  r = await exchange(ctx, () => sendRequest(ctx.pipe, buildFrame({ code: ctx.code, operation: 'restore.stage', entries })), { write: () => 0 });
  assert.match(r.err ?? '', /made no progress/);
  assert.ok(incomingGone(ctx), 'incomplete staging removed');
});

test('D: bounds are refused from the declared length alone, before the data is sent or allocated', { skip: !WIN }, async () => {
  const cases = [
    ['header over 64 KiB', (c) => [MAGIC, c, u32(LIMITS.header + 1)], /header length/],
    ['count over 1,000', (c) => [prefix(c, { schema: 1, operation: 'restore.stage', count: 1001, total: 1 })], /entry count/],
    ['total over 100 MB', (c) => [prefix(c, { schema: 1, operation: 'restore.stage', count: 2, total: LIMITS.total + 1 })], /declared total/],
    ['name over 255 bytes', (c) => [prefix(c, { schema: 1, operation: 'register.create', count: 1, total: 1 }), u16(256)], /name length/],
    ['entry over 10 MB', (c) => [prefix(c, { schema: 1, operation: 'restore.stage', count: 2, total: LIMITS.total }), u16(12), Buffer.from('request.json'), u32(LIMITS.entry + 1)], /over the/],
    ['entries over the declared total', (c) => [prefix(c, { schema: 1, operation: 'register.create', count: 1, total: 5 }), u16(12), Buffer.from('request.json'), u32(6)], /exceed the declared total/],
  ];
  for (const [label, frame, re] of cases) {
    const ctx = setup();
    // The client sends ONLY the prefix and keeps the connection open: a refusal proves no further bytes were needed.
    const r = await exchange(ctx, raw(ctx.pipe, frame(ctx.code), { end: false }), { idleMs: 5000 });
    assert.match(r.err ?? '', re, label);
    assert.ok(incomingGone(ctx), `${label}: nothing staged`);
  }
});

test('D: names, operations, hashes, code, magic and trailer are validated; every refusal deletes the staging', { skip: !WIN }, async () => {
  const restore = (...names) => [REQ, ...names.map((x) => ({ name: x, data: Buffer.from('x') }))];
  const bad = [
    ['uppercase', restore('files/Index.html'), /segment not allowed/],
    ['dot-dot', restore('files/../x'), /segment not allowed/],
    ['device name', restore('files/con.txt'), /segment not allowed/],
    ['trailing dot', restore('files/a.'), /segment not allowed/],
    ['reserved manifest', restore('files/restore_manifest.json'), /reserved/],
    ['prefix collision (file, then folder)', restore('files/a', 'files/a/b'), /collides|colliding/],
    ['prefix collision (folder, then file)', restore('files/a/b', 'files/a'), /colliding/],
    ['duplicate', restore('files/a', 'files/a'), /duplicate/],
    ['too deep', restore(`files/${Array(9).fill('d').join('/')}`), /too long or too deep/],
    ['non-ASCII', restore('files/é.txt'), /segment not allowed/],
    ['not under files/', restore('other/x'), /not allowed/],
    ['first entry not request.json', [{ name: 'files/a', data: Buffer.from('x') }], /first entry must be request\.json/],
  ];
  for (const [label, entries, re] of bad) {
    const ctx = setup();
    const r = await exchange(ctx, () => sendRequest(ctx.pipe, buildFrame({ code: ctx.code, operation: 'restore.stage', entries })));
    assert.match(r.err ?? '', re, label);
    assert.ok(incomingGone(ctx), `${label}: nothing staged`);
  }
  const more = [
    ['register op with two entries', (c) => buildFrame({ code: c, operation: 'register.replace', entries: [REQ, REQ] }), /exactly one entry/],
    ['unknown operation', (c) => buildFrame({ code: c, operation: 'patch.stage', entries: [REQ] }), /unknown schema or operation/],
    ['wrong code', () => buildFrame({ code: randomBytes(16), operation: 'register.create', entries: [REQ] }), /wrong one-time code/],
    ['wrong magic', (c) => { const f = buildFrame({ code: c, operation: 'register.create', entries: [REQ] }); f[0] ^= 1; return f; }, /not a request frame/],
    ['entry hash mismatch', (c) => { const f = buildFrame({ code: c, operation: 'register.create', entries: [REQ] }); f[f.length - 33] ^= 1; return f; }, /hash mismatch in request\.json/],
    ['trailer mismatch', (c) => { const f = buildFrame({ code: c, operation: 'register.create', entries: [REQ] }); f[f.length - 1] ^= 1; return f; }, /trailer hash mismatch/],
    ['invalid UTF-8 name', (c) => Buffer.concat([prefix(c, { schema: 1, operation: 'register.create', count: 1, total: 1 }), u16(2), Buffer.from([0xc3, 0x28])]), /not valid UTF-8/],
  ];
  for (const [label, frame, re] of more) {
    const ctx = setup();
    const r = await exchange(ctx, raw(ctx.pipe, [frame(ctx.code)]));
    assert.match(r.err ?? '', re, label);
    assert.ok(incomingGone(ctx), `${label}: nothing staged`);
  }
});

test('D: end of stream: an early end, bytes after the trailer, and no EOF after the trailer are refused', { skip: !WIN }, async () => {
  const frame = (c) => buildFrame({ code: c, operation: 'register.create', entries: [REQ] });
  let ctx = setup();
  let r = await exchange(ctx, raw(ctx.pipe, [frame(ctx.code).subarray(0, 60)]));
  assert.match(r.err, /ended early/); assert.ok(incomingGone(ctx));
  ctx = setup();
  r = await exchange(ctx, raw(ctx.pipe, [Buffer.concat([frame(ctx.code), Buffer.from([0])])]));
  assert.match(r.err, /bytes after the trailer/); assert.ok(incomingGone(ctx));
  ctx = setup();
  r = await exchange(ctx, raw(ctx.pipe, [frame(ctx.code)], { end: false }), { eofMs: 200 });
  assert.match(r.err, /no end of stream after the trailer/); assert.ok(incomingGone(ctx));
});

test('D: idle and total time limits; a second connection; non-pipe names are refused', { skip: !WIN }, async () => {
  const frame = (c) => buildFrame({ code: c, operation: 'register.create', entries: [REQ] });
  let ctx = setup();
  let r = await exchange(ctx, raw(ctx.pipe, [frame(ctx.code).subarray(0, 20)], { end: false }), { idleMs: 200 });
  assert.match(r.err, /idle time limit/); assert.ok(incomingGone(ctx));
  ctx = setup();
  const bytes = frame(ctx.code);
  const trickle = Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1));
  r = await exchange(ctx, raw(ctx.pipe, trickle, { gapMs: 20 }), { totalMs: 300, idleMs: 5000 });
  assert.match(r.err, /total time limit/); assert.ok(incomingGone(ctx));
  ctx = setup();
  r = await exchange(ctx, async () => { const hold = raw(ctx.pipe, [bytes.subarray(0, 10)], { end: false })(); await new Promise((x) => setTimeout(x, 50)); await raw(ctx.pipe, [bytes])(); await hold; }, { idleMs: 5000 });
  assert.match(r.err, /second connection/); assert.ok(incomingGone(ctx));
  assert.throws(() => receiveRequest({ pipe: '127.0.0.1:9', code: Buffer.alloc(16), stagingDir: ROOT }), /only a local/);
  assert.throws(() => receiveRequest({ pipe: '\\\\server\\pipe\\gb2l-' + '0'.repeat(32), code: Buffer.alloc(16), stagingDir: ROOT }), /only a local/);
  await assert.rejects(sendRequest('\\\\.\\pipe\\other', Buffer.alloc(1)), /only a local/);
});
