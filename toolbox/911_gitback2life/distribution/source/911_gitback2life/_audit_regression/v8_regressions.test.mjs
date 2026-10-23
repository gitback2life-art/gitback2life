// v8 regressions (this round): V8-01 unused palette/transparency entries anywhere in the palette, and V8-02 bounded
// PNG decompression. Synthetic fixtures only. Node and Python must agree.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { safeWrite, TOOLBOX_ROOT } from '../_shared/common.mjs';
import { MAX_DECODED_BYTES, parsePng, sanitizePng } from '../_shared/image_policy.mjs';

const PARENT = join(TOOLBOX_ROOT, '.test_tmp');
mkdirSync(PARENT, { recursive: true });
const TMP = mkdtempSync(join(PARENT, 'v8-'));
after(() => { rmSync(TMP, { recursive: true, force: true }); try { if (!readdirSync(PARENT).length) rmSync(PARENT, { recursive: true }); } catch { /* shared */ } });
const PYTHON = (code, input) => execFileSync('python', ['-I', '-c', `import sys; sys.dont_write_bytecode=True; sys.path.insert(0, ${JSON.stringify(join(TOOLBOX_ROOT, '_shared'))}); ${code}`],
  { input, encoding: 'utf8', windowsHide: true });
const SECRET = Buffer.from('ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01');
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
const ihdr = (w, h, depth, color) => { const x = Buffer.alloc(13); x.writeUInt32BE(w, 0); x.writeUInt32BE(h, 4); x[8] = depth; x[9] = color; return x; };

/** An indexed PNG (filter 0 rows) from a grid of palette indices, packed at `depth` bits. */
function indexed(grid, depth, palette, trns) {
  const w = grid[0].length, stride = Math.ceil((w * depth) / 8);
  const rows = Buffer.concat(grid.map((row) => {
    const b = Buffer.alloc(1 + stride);
    row.forEach((v, x) => { const bit = x * depth; b[1 + (bit >> 3)] |= v << (8 - depth - (bit & 7)); });
    return b;
  }));
  return Buffer.concat([SIG, chunk('IHDR', ihdr(w, grid.length, depth, 3)), chunk('PLTE', palette), ...(trns ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Independent mini-decoder for filter-0 indexed PNGs: the RGBA every pixel renders as (omitted alpha = opaque). */
function render(buf) {
  const parts = {}; let idat = Buffer.alloc(0);
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.subarray(i + 4, i + 8).toString('latin1'), data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IDAT') idat = Buffer.concat([idat, data]); else parts[type] = data;
    i += 12 + len;
  }
  const w = parts.IHDR.readUInt32BE(0), h = parts.IHDR.readUInt32BE(4), depth = parts.IHDR[8], stride = Math.ceil((w * depth) / 8);
  const raw = inflateSync(idat), out = [];
  for (let r = 0; r < h; r++) {
    assert.equal(raw[r * (stride + 1)], 0, 'test decoder handles filter 0 only');
    for (let x = 0; x < w; x++) {
      const bit = x * depth, byte = raw[r * (stride + 1) + 1 + (bit >> 3)], k = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      out.push([parts.PLTE[3 * k], parts.PLTE[3 * k + 1], parts.PLTE[3 * k + 2], parts.tRNS && k < parts.tRNS.length ? parts.tRNS[k] : 255].join(','));
    }
  }
  return out;
}

/** A palette of `n` entries: used entries get distinct colours; the secret is spread over the unused ones. */
function sparse(n, usedSet) {
  const pal = Buffer.alloc(3 * n), alpha = Buffer.alloc(n, 255);
  let s = 0;
  for (let k = 0; k < n; k++) {
    if (usedSet.has(k)) { pal[3 * k] = 10 + k; pal[3 * k + 1] = 100; pal[3 * k + 2] = 200 - k; alpha[k] = 60 + k; }
    else for (let c = 0; c < 3; c++) { pal[3 * k + c] = SECRET[s++ % SECRET.length]; alpha[k] = SECRET[(s + 7) % SECRET.length]; }
  }
  return { pal, alpha };
}

// Sparse indices (gaps below the highest one), several rows, every indexed bit depth.
const CASES = {
  depth1: { depth: 1, grid: [[1, 1, 1], [1, 1, 1]], n: 2 },
  depth2: { depth: 2, grid: [[0, 3, 3, 0, 3], [3, 3, 0, 0, 0], [0, 0, 0, 3, 3]], n: 4 },
  depth4: { depth: 4, grid: [[2, 15, 9], [9, 2, 15], [15, 15, 2]], n: 16 },
  depth8: { depth: 8, grid: [[255, 7, 200, 7], [200, 255, 255, 7]], n: 256 },
};
function fixtures() {
  const out = {};
  for (const [name, { depth, grid, n }] of Object.entries(CASES)) {
    const { pal, alpha } = sparse(n, new Set(grid.flat()));
    out[`${name}-palette`] = indexed(grid, depth, pal, null);
    out[`${name}-transparency`] = indexed(grid, depth, pal, alpha);
  }
  return out;
}

test('V8-01: every unused palette and transparency entry is cleared; every pixel renders identically (1/2/4/8-bit, several rows)', () => {
  for (const [name, input] of Object.entries(fixtures())) {
    assert.ok(input.includes(SECRET.subarray(0, 6)) || name.startsWith('depth1'), `${name}: fixture carries secret bytes`);
    const out = sanitizePng(input);
    assert.deepEqual(render(out), render(input), `${name}: rendered colour and alpha unchanged`);
    for (let k = 0; k + 4 <= SECRET.length; k++) assert.ok(!out.includes(SECRET.subarray(k, k + 4)), `${name}: no 4-byte run of the secret survives`);
    assert.deepEqual(sanitizePng(out), out, `${name}: idempotent`);
    assert.ok(parsePng(input).hidden.some((h) => h.startsWith('unused')), `${name}: reported as hidden (exact backups refuse it)`);
    assert.deepEqual(parsePng(out).hidden, [], `${name}: the canonical form hides nothing`);
  }
});

// Node: bytes actually written to disk by safeWrite. Python: the output of prepare_for_storage (what
// write_bytes_safely would write), NOT a Python disk write; the Python disk writes are in test_v8_independent.py.
test('V8-01: persisted bytes (Node safeWrite) carry no secret; Python prepare_for_storage output agrees', () => {
  const fx = fixtures();
  for (const [name, input] of Object.entries(fx)) {
    const target = join(TMP, `${name}.png`);
    safeWrite(target, input, { root: TMP, binary: 'image' });
    const saved = readFileSync(target);
    assert.ok(!saved.includes(SECRET.subarray(0, 8)), `${name}: persisted file`);
    assert.deepEqual(render(saved), render(input), `${name}: persisted file renders identically`);
  }
  const py = JSON.parse(PYTHON(['import json, base64, gb2l_core as c', 'r = {}',
    'for k, v in json.load(sys.stdin).items():',
    '    out = c.prepare_for_storage(base64.b64decode(v), binary="image")',
    '    r[k] = base64.b64encode(out).decode()',
    'print(json.dumps(r))'].join('\n'), JSON.stringify(Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, v.toString('base64')])))));
  for (const [name, input] of Object.entries(fx)) {
    const out = Buffer.from(py[name], 'base64');
    assert.ok(!out.includes(SECRET.subarray(0, 8)), `python ${name}`);
    assert.deepEqual(render(out), render(input), `python ${name}: renders identically`);
  }
});

test('V8-01: exact backups refuse a palette image whose unused entries hold data, and keep a clean one byte-for-byte', () => {
  const dirty = fixtures()['depth8-transparency'];
  const clean = sanitizePng(dirty); // canonical: unused entries already cleared
  const py = JSON.parse(PYTHON(['import json, base64, gb2l_core as c', 'r = {}',
    'for k, v in json.load(sys.stdin).items():',
    '    data = base64.b64decode(v)',
    '    try:',
    '        r[k] = "kept-identical" if c.prepare_for_storage(data, binary="image", require_unchanged=True) == data else "changed"',
    '    except c.InputError as e:',
    '        r[k] = "refused: " + str(e)',
    'print(json.dumps(r))'].join('\n'), JSON.stringify({ dirty: dirty.toString('base64'), clean: clean.toString('base64') })));
  assert.match(py.dirty, /^refused: .*beyond its core image parts/);
  assert.equal(py.clean, 'kept-identical');
});

test('V8-01: row padding cleanup still works alongside palette cleanup', () => {
  const { pal } = sparse(2, new Set([1]));
  const w = 3, rows = Buffer.from([0, 0b11111111, 0, 0b11111111]); // 3 used bits + 5 padding bits set, two rows
  const input = Buffer.concat([SIG, chunk('IHDR', ihdr(w, 2, 1, 3)), chunk('PLTE', pal), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const p = parsePng(input);
  assert.ok(p.hidden.includes('row padding bits'));
  assert.deepEqual([...p.rows], [0, 0b11100000, 0, 0b11100000]);
});

// ------------------------------------------------------------------------------------------------------- V8-02
const rgb = (w, h, idat) => Buffer.concat([SIG, chunk('IHDR', ihdr(w, h, 8, 2)), ...idat.map((d) => chunk('IDAT', d)), chunk('IEND', Buffer.alloc(0))]);
const GOOD_ROWS = Buffer.from([0, 1, 2, 3]); // 1x1 RGB: 4 decoded bytes expected
const BOUNDED = {
  overrun: rgb(1, 1, [deflateSync(Buffer.alloc(100_000))]),        // ~100 KB from a few hundred bytes: stopped at 4
  overrunByOne: rgb(1, 1, [deflateSync(Buffer.from([0, 1, 2, 3, 4]))]),
  truncated: rgb(1, 1, [deflateSync(GOOD_ROWS).subarray(0, 6)]),
  short: rgb(1, 1, [deflateSync(Buffer.from([0, 1, 2]))]),
  trailing: rgb(1, 1, [Buffer.concat([deflateSync(GOOD_ROWS), Buffer.from([1, 2, 3])])]),
  concatenated: rgb(1, 1, [Buffer.concat([deflateSync(GOOD_ROWS), deflateSync(GOOD_ROWS)])]),
  // 4096 x 4096 RGBA: 4096 * (1 + 4096*4) bytes (the row filter bytes push it just over the 64 MiB budget); refused
  // before decompressing anything.
  overBudget: Buffer.concat([SIG, chunk('IHDR', ihdr(4096, 4096, 8, 6)), chunk('IDAT', deflateSync(GOOD_ROWS)), chunk('IEND', Buffer.alloc(0))]),
};
test('V8-02: the decoded size is bounded before and during decompression (Node and Python agree)', () => {
  assert.ok(4096 * (1 + 4096 * 4) > MAX_DECODED_BYTES && 4095 * (1 + 4096 * 4) <= MAX_DECODED_BYTES, 'sanity: the fixture sits just over the budget');
  const expect = { overrun: /larger than the header says/, overrunByOne: /larger than the header says/, truncated: /does not decompress|truncated/,
    short: /not the size the header says/, trailing: /data after the compressed/, concatenated: /data after the compressed/, overBudget: /exceed the \d+-byte limit/ };
  for (const [name, buf] of Object.entries(BOUNDED)) assert.throws(() => sanitizePng(buf), expect[name], name);
  // V9-D01: the source comment's examples. An 8K RGB screenshot (7680 x 4320) is over the budget and refused before
  // decompression; 4K RGBA (3840 x 2160) and 4096 x 4095 RGBA are under it.
  assert.throws(() => sanitizePng(rgb(7680, 4320, [deflateSync(GOOD_ROWS)])), /exceed the \d+-byte limit/, '8K RGB');
  assert.ok(2160 * (1 + 3840 * 4) <= MAX_DECODED_BYTES && 4095 * (1 + 4096 * 4) <= MAX_DECODED_BYTES, 'documented fitting examples');
  assert.ok(sanitizePng(rgb(1, 1, [deflateSync(GOOD_ROWS)])).length, 'control: a clean image still passes');
  assert.ok(sanitizePng(rgb(1, 1, [deflateSync(GOOD_ROWS).subarray(0, 5), deflateSync(GOOD_ROWS).subarray(5)])).length, 'control: split IDAT still passes');
  const py = JSON.parse(PYTHON(['import json, base64, gb2l_core as c', 'r = {}',
    'for k, v in json.load(sys.stdin).items():',
    '    try:',
    '        c.sanitize_png(base64.b64decode(v)); r[k] = "accepted"',
    '    except c.InputError as e:',
    '        r[k] = str(e)',
    'print(json.dumps(r))'].join('\n'), JSON.stringify(Object.fromEntries(Object.entries(BOUNDED).map(([k, v]) => [k, v.toString('base64')])))));
  for (const [name, re] of Object.entries(expect)) assert.match(py[name], re, `python ${name}`);
});

test('V8-02 (instrumented): Python never asks zlib for more than the expected size plus one byte, and never flushes', () => {
  const out = PYTHON(['import json, base64, zlib, gb2l_core as c', 'calls = []', 'real = zlib.decompressobj',
    'class Spy:',
    '    def __init__(self): self.d = real()',
    '    def decompress(self, data, max_length=0): calls.append(max_length); return self.d.decompress(data, max_length)',
    '    def flush(self, *a): calls.append("flush"); return self.d.flush(*a)',
    '    def __getattr__(self, n): return getattr(self.d, n)',
    'zlib.decompressobj = Spy',
    'try:',
    '    c.sanitize_png(base64.b64decode(sys.stdin.read()))',
    'except c.InputError as e:',
    '    print(json.dumps({"calls": calls, "error": str(e)}))'].join('\n'), BOUNDED.overrun.toString('base64'));
  const r = JSON.parse(out.trim().split('\n').at(-1));
  assert.deepEqual(r.calls, [5], 'one bounded call: expected 4 bytes + 1');
  assert.match(r.error, /larger than the header says/);
});
