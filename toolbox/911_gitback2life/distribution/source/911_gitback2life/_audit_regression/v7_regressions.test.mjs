// v7 regressions: the toolbox's own tests for the v6 findings (V6-01..V6-07) and the privileged-write / init concerns.
// Synthetic fixtures only; no network; nothing elevated; the real authority folder is never read or written.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { POWERSHELL, runPowerShell, trustedEnv } from '../_shared/system_exec.mjs';
import * as toolboxAcl from '../_shared/acl_check.mjs';
import * as cli from '../authority/authority_cli.mjs';
import { generateAuthorityKey, emptyState } from '../authority/authority_core.mjs';
import { sanitizeImage, sanitizePng, sanitizeJpeg } from '../_shared/image_policy.mjs';
import { maskStoredText, prepareForStorage, readStoredZip, TOOLBOX_ROOT, zipStore } from '../_shared/common.mjs';
import { _resetAuthority, _setAuthorityForTests, authorityStatus } from '../_shared/authority_link.mjs';

const PARENT = join(TOOLBOX_ROOT, '.test_tmp');
mkdirSync(PARENT, { recursive: true });
const TMP = mkdtempSync(join(PARENT, 'v7-'));
after(() => { _resetAuthority(); rmSync(TMP, { recursive: true, force: true }); try { if (!readdirSync(PARENT).length) rmSync(PARENT, { recursive: true }); } catch { /* shared */ } });
let n = 0;
const fresh = (label) => { const d = join(TMP, `${label}-${n++}`); mkdirSync(d); return d; };
const PYTHON = (code, input) => execFileSync('python', ['-I', '-c', `import sys; sys.dont_write_bytecode=True; sys.path.insert(0, ${JSON.stringify(join(TOOLBOX_ROOT, '_shared'))}); ${code}`],
  { input, encoding: 'utf8', windowsHide: true });

// ---------------------------------------------------------------------------------------------------- V6-03 pinning
test('V6-03: every PowerShell launch uses the pinned absolute path, a constructed env and System32 as cwd', () => {
  const saved = { PATH: process.env.PATH, PSModulePath: process.env.PSModulePath, NODE_OPTIONS: process.env.NODE_OPTIONS };
  process.env.PATH = `C:\\poisoned;${saved.PATH}`; process.env.PSModulePath = 'C:\\poisoned\\modules'; process.env.NODE_OPTIONS = '--require C:\\poisoned\\x.js';
  try {
    const calls = [];
    const run = (file, args, opts) => { calls.push({ file, args, opts }); return '{}'; };
    runPowerShell('1', { run });
    toolboxAcl.readAcls(['C:\\x'], { run });
    cli.readAcls(['C:\\x'], { run });
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.file, POWERSHELL);
      assert.equal(cli.POWERSHELL, POWERSHELL);
      assert.deepEqual(c.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.deepEqual(c.opts.env, trustedEnv());
      assert.equal(c.opts.cwd, 'C:\\Windows\\System32');
      assert.ok(!JSON.stringify(c.opts.env).includes('poisoned'), 'nothing from the user environment');
    }
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('V6-03: a program named powershell.exe earlier on PATH is never run (real launch)', { skip: process.platform !== 'win32' || !existsSync(POWERSHELL) }, () => {
  const bin = fresh('poisoned-path');
  copyFileSync('C:\\Windows\\System32\\whoami.exe', join(bin, 'powershell.exe')); // prints the account name if it ever runs
  const saved = process.env.PATH;
  process.env.PATH = `${bin};${saved}`;
  try {
    assert.equal(runPowerShell("Write-Output 'pinned-ok'").trim(), 'pinned-ok');
  } finally { process.env.PATH = saved; }
});

test('V6-03 (installer, static text only; never run): the owner is told to use Node by full path, and re-running accepts the authorizations folder', () => {
  const ps1 = readFileSync(join(TOOLBOX_ROOT, 'authority', 'install.ps1'), 'utf8');
  assert.match(ps1, /\$node = 'C:\\Program Files\\nodejs\\node\.exe'/);
  for (const line of ps1.split('\n').filter((l) => l.includes('authority_cli.mjs') && l.includes('Write-Host'))) {
    assert.match(line, /& `"\$node`"/, `printed command uses the pinned Node: ${line.trim()}`);
  }
  assert.ok(!/Write-Host "\s+node /.test(ps1), 'no bare "node" command is printed');
  assert.match(ps1, /\$expected = @\([^)]*'authorizations'/);
});

// ------------------------------------------------------------------------------------------------- V6-05 rights
const RIGHTS_CASES = [
  ['', undefined, false], ['   ', undefined, false], ['268435456', undefined, false], ['-1610612736', undefined, false],
  ['ReadAndExecute, Synchronize', undefined, true], ['Read', 1179785, true], ['ReadAndExecute, Synchronize', 1179817, true],
  ['ReadAndExecute, Synchronize', 1179817 | 0x2, false], ['Read, Write', undefined, false], ['ReadData, AppendData', undefined, false],
  ['Modify, Synchronize', undefined, false], ['FullControl', undefined, false], ['ChangePermissions', undefined, false],
  ['TakeOwnership', undefined, false], ['Delete', undefined, false], ['CreateFiles', undefined, false], ['SomethingNew', undefined, false],
  ['Read', -1, false], ['Read', 1.5, false], ['Read', 0x10000000, false], ['Read', 0x40000000, false], ['Read', 0x00010000, false],
];
test('V6-05: rights are read-only only when every name is in the closed list and the mask has only read bits', () => {
  for (const [r, m, want] of RIGHTS_CASES) {
    assert.equal(toolboxAcl.rightsAreReadOnly(r, m), want, `toolbox ${JSON.stringify([r, m])}`);
    assert.equal(cli.rightsAreReadOnly(r, m), want, `authority ${JSON.stringify([r, m])}`);
  }
  assert.equal(toolboxAcl.rightsAreReadOnly(undefined), false);
  assert.equal(toolboxAcl.rightsAreReadOnly(5), false);
});

test('V6-05 parity: Python decides every rights case exactly as Node', () => {
  const cases = RIGHTS_CASES.map(([r, m]) => [r, m === undefined ? null : m]);
  const py = JSON.parse(PYTHON('import json, gb2l_core as c; print(json.dumps([c.rights_are_read_only(r, m) for r, m in json.load(sys.stdin)]))', JSON.stringify(cases)));
  assert.deepEqual(py, RIGHTS_CASES.map(([, , w]) => w));
});

test('V6-05: an ACE with write-capable rights for an untrusted identity is reported, in both implementations', () => {
  const acl = (rights, mask) => ({ exists: true, reparse: false, owner: 'BUILTIN\\Administrators', aces: [{ identity: 'BUILTIN\\Users', rights, mask, type: 'Allow' }] });
  for (const [r, m, want] of RIGHTS_CASES) {
    assert.equal(toolboxAcl.aclProblems(acl(r, m)).length === 0, want, `toolbox ${r}`);
    assert.equal(cli.protectionProblems(acl(r, m)).length === 0, want, `authority ${r}`);
  }
});

// ------------------------------------------------------------------------------------------------- V6-02 images
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (interlace = 0) => { const h = Buffer.alloc(13); h.writeUInt32BE(2, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 2; h[12] = interlace; return h; };
const PIXELS = Buffer.from([0, 10, 20, 30, 40, 50, 60]); // 2x1 RGB, filter 0
const png = (parts) => Buffer.concat([SIG, ...parts]);
const GOOD = png([chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]);
const SECRET = 'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01';

test('V6-02: a valid PNG is rebuilt; hidden ancillary chunks are dropped; the rebuild is idempotent', () => {
  const withHidden = png([chunk('IHDR', ihdr()), chunk('raNd', Buffer.from(SECRET)), chunk('iCCP', Buffer.from(`icc\0\0${SECRET}`)), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]);
  const out = sanitizePng(withHidden);
  assert.ok(!out.includes(SECRET));
  assert.deepEqual(sanitizePng(out), out, 'idempotent');
  assert.deepEqual(sanitizePng(GOOD), sanitizePng(sanitizePng(GOOD)));
});

const BAD_PNGS = {
  truncated: GOOD.subarray(0, GOOD.length - 5),
  trailer: Buffer.concat([GOOD, Buffer.from(SECRET)]),
  badCrc: (() => { const b = Buffer.from(GOOD); b[b.length - 13] ^= 1; return b; })(),
  interlaced: png([chunk('IHDR', ihdr(1)), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]),
  unknownCritical: png([chunk('IHDR', ihdr()), chunk('ABCD', Buffer.from('x')), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]),
  afterStream: png([chunk('IHDR', ihdr()), chunk('IDAT', Buffer.concat([deflateSync(PIXELS), Buffer.from(SECRET)])), chunk('IEND', Buffer.alloc(0))]),
  wrongSize: png([chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.concat([PIXELS, Buffer.from(SECRET)]))), chunk('IEND', Buffer.alloc(0))]),
  badFilter: png([chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.from([9, 1, 2, 3, 4, 5, 6]))), chunk('IEND', Buffer.alloc(0))]),
  noIdat: png([chunk('IHDR', ihdr()), chunk('IEND', Buffer.alloc(0))]),
  splitIdat: png([chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(PIXELS)), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))]),
};
test('V6-02: malformed, truncated, trailing, interlaced and inconsistent PNGs are refused (Node and Python)', () => {
  for (const [name, buf] of Object.entries(BAD_PNGS)) assert.throws(() => sanitizeImage(buf), /image refused/, name);
  const py = JSON.parse(PYTHON('import json, base64, gb2l_core as c\nr = {}\nfor k, v in json.load(sys.stdin).items():\n    try:\n        c.sanitize_image(base64.b64decode(v)); r[k] = "accepted"\n    except Exception:\n        r[k] = "refused"\nprint(json.dumps(r))',
    JSON.stringify(Object.fromEntries(Object.entries({ ...BAD_PNGS, good: GOOD }).map(([k, v]) => [k, v.toString('base64')])))));
  for (const k of Object.keys(BAD_PNGS)) assert.equal(py[k], 'refused', `python ${k}`);
  assert.equal(py.good, 'accepted');
});

const seg = (m, body) => { const b = Buffer.alloc(4 + body.length); b[0] = 0xff; b[1] = m; b.writeUInt16BE(body.length + 2, 2); Buffer.from(body).copy(b, 4); return b; };
const SOF = seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const DQT = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
const SOS = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]);
const jpeg = (...parts) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xd9])]);
test('V6-02: JPEG APPn/COM/ICC metadata is dropped wherever it appears, including after the scan starts', () => {
  const hidden = jpeg(seg(0xe1, Buffer.from(`Exif\0\0${SECRET}`)), seg(0xe2, Buffer.from(`ICC_PROFILE\0${SECRET}`)), DQT, SOF, seg(0xfe, Buffer.from(SECRET)),
    SOS, SCAN, seg(0xe1, Buffer.from(SECRET)), seg(0xfe, Buffer.from(SECRET)), SOS, SCAN);
  const out = sanitizeJpeg(hidden);
  assert.ok(!out.includes(SECRET));
  assert.deepEqual(sanitizeJpeg(out), out, 'idempotent');
  assert.throws(() => sanitizeJpeg(Buffer.concat([jpeg(DQT, SOF, SOS, SCAN), Buffer.from(SECRET)])), /bytes after the end/);
  assert.throws(() => sanitizeJpeg(jpeg(DQT, SOF, seg(0xc8, Buffer.from('x')), SOS, SCAN)), /unknown segment/);
  assert.throws(() => sanitizeJpeg(jpeg(DQT, SOS, SCAN)), /scan before frame/);
  assert.throws(() => sanitizeJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), DQT, SOF, SOS, SCAN])), /off the end/);
});

test('V6-02: storage writes the REBUILT image, and still refuses known metadata with a clear instruction', () => {
  const stored = prepareForStorage(png([chunk('IHDR', ihdr()), chunk('raNd', Buffer.from(SECRET)), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]), { binary: 'image' });
  assert.ok(!stored.includes(SECRET));
  assert.throws(() => prepareForStorage(png([chunk('IHDR', ihdr()), chunk('tEXt', Buffer.from(`k\0${SECRET}`)), chunk('IDAT', deflateSync(PIXELS)), chunk('IEND', Buffer.alloc(0))]), { binary: 'image' }), /run metadata_scrub first/);
});

test('v7 review: transparency, palettes and padding bits keep only pixel data (Node and Python agree)', () => {
  const hdr = (w, depth, color) => { const x = Buffer.alloc(13); x.writeUInt32BE(w, 0); x.writeUInt32BE(1, 4); x[8] = depth; x[9] = color; return x; };
  const img = (h, rows, ...extra) => png([chunk('IHDR', h), ...extra, chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const s = Buffer.from(SECRET);
  const cases = {
    trnsWrongSize: img(ihdr(), PIXELS, chunk('tRNS', s)),
    trnsOutOfRange: img(hdr(1, 4, 0), Buffer.from([0, 0x10]), chunk('tRNS', Buffer.from([0x01, 0x00]))),
    trnsWithAlpha: img(hdr(1, 8, 6), Buffer.from([0, 1, 2, 3, 4]), chunk('tRNS', Buffer.from([0, 1]))),
    paletteOnGrey: img(hdr(1, 8, 0), Buffer.from([0, 7]), chunk('PLTE', Buffer.from([1, 2, 3]))),
    indexPastPalette: img(hdr(1, 8, 3), Buffer.from([0, 5]), chunk('PLTE', Buffer.from([1, 2, 3]))),
  };
  for (const [name, buf] of Object.entries(cases)) assert.throws(() => sanitizeImage(buf), /image refused/, name);
  // A palette image using entry 0 only, with the secret hidden in unused palette and transparency entries:
  const tail = Buffer.concat([Buffer.from([9, 9, 9]), s.subarray(0, 39)]); // 14 entries x 3 bytes
  const pal = img(hdr(1, 8, 3), Buffer.from([0, 0]), chunk('PLTE', tail), chunk('tRNS', Buffer.concat([Buffer.from([255]), s.subarray(0, 13)])));
  const out = sanitizeImage(pal);
  assert.ok(!out.includes(s.subarray(0, 8)), 'unused palette/transparency entries removed');
  // A suggested palette on an RGB image is dropped; padding bits after a 1-bit pixel are zeroed:
  assert.ok(!sanitizeImage(img(ihdr(), PIXELS, chunk('PLTE', s.subarray(0, 39)))).includes(s.subarray(0, 8)));
  const padded = sanitizeImage(img(hdr(1, 1, 0), Buffer.from([0, 0b10111111])));
  assert.deepEqual(sanitizeImage(padded), padded);
  const py = JSON.parse(PYTHON('import json, base64, gb2l_core as c\nr = {}\nfor k, v in json.load(sys.stdin).items():\n    try:\n        r[k] = base64.b64encode(c.sanitize_image(base64.b64decode(v))).decode()\n    except c.InputError:\n        r[k] = "refused"\nprint(json.dumps(r))',
    JSON.stringify(Object.fromEntries(Object.entries({ ...cases, pal, padded }).map(([k, v]) => [k, v.toString('base64')])))));
  for (const k of Object.keys(cases)) assert.equal(py[k], 'refused', `python ${k}`);
  assert.ok(!Buffer.from(py.pal, 'base64').includes(s.subarray(0, 8)), 'python trims the palette too');
});

test('v7 review: every kept JPEG segment must be exactly its structure', () => {
  const s = Buffer.from(SECRET);
  const bad = {
    sofExtra: jpeg(DQT, seg(0xc0, Buffer.concat([SOF.subarray(4), s])), SOS, SCAN),
    dqtExtra: jpeg(seg(0xdb, Buffer.concat([DQT.subarray(4), s])), SOF, SOS, SCAN),
    dqtZero: jpeg(seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64)])), SOF, SOS, SCAN),
    dhtExtra: jpeg(DQT, seg(0xc4, Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0]), s])), SOF, SOS, SCAN),
    driWrong: jpeg(DQT, SOF, seg(0xdd, Buffer.from([0, 1, 2])), SOS, SCAN),
    sosExtra: jpeg(DQT, SOF, seg(0xda, Buffer.concat([SOS.subarray(4), s])), SCAN),
    twoFrames: jpeg(DQT, SOF, SOF, SOS, SCAN),
  };
  for (const [name, buf] of Object.entries(bad)) assert.throws(() => sanitizeJpeg(buf), /image refused/, name);
  const jfif = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0x12, 0x34, 0x56, 0x78, 0, 0]));
  assert.ok(!sanitizeJpeg(jpeg(jfif, DQT, SOF, SOS, SCAN)).includes(Buffer.from('JFIF')), 'the JFIF header is dropped');
  const py = JSON.parse(PYTHON('import json, base64, gb2l_core as c\nr = {}\nfor k, v in json.load(sys.stdin).items():\n    try:\n        c.sanitize_jpeg(base64.b64decode(v)); r[k] = "accepted"\n    except c.InputError:\n        r[k] = "refused"\nprint(json.dumps(r))',
    JSON.stringify(Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.toString('base64')])))));
  for (const k of Object.keys(bad)) assert.equal(py[k], 'refused', `python ${k}`);
});

test('v7 review: zip entry names and sensitive JSON objects', () => {
  assert.throws(() => prepareForStorage(zipStore([{ name: `${SECRET}.txt`, data: Buffer.from('x') }]), { binary: 'case-packet' }), /entry name/);
  assert.throws(() => prepareForStorage(zipStore([{ name: 'call-212-555-0100.txt', data: Buffer.from('x') }]), { binary: 'case-packet' }), /entry name/);
  const out = JSON.parse(maskStoredText(JSON.stringify({ credentials: { user: 'a', value: 'v' }, token: ['t1'], api_key: 7, password: null, secret: true, note: 'ok' })));
  assert.deepEqual(out, { credentials: '[REDACTED]', token: '[REDACTED]', api_key: '[REDACTED]', password: null, secret: true, note: 'ok' });
});

// ---------------------------------------------------------------------------------------------------- V6-04 zips
const ENTRIES = [{ name: 'README.txt', data: Buffer.from('synthetic packet') }, { name: 'evidence/a.md', data: Buffer.from('# note') }];
const ZIP = zipStore(ENTRIES, new Date('2026-10-10T00:00:00Z'));
const eocdAt = (b) => b.length - 22; // zipStore writes no comment, so the end record is the last 22 bytes
test('V6-04: an archive comment is dropped by the rebuild; only validated entry data persists', () => {
  const withComment = Buffer.concat([ZIP, Buffer.from(SECRET)]);
  withComment.writeUInt16LE(SECRET.length, eocdAt(ZIP) + 20);
  const { entries } = readStoredZip(withComment);
  assert.deepEqual(entries.map((e) => e.name), ENTRIES.map((e) => e.name));
  const rebuilt = prepareForStorage(withComment, { binary: 'case-packet' });
  assert.ok(!rebuilt.includes(SECRET));
  assert.deepEqual(rebuilt, ZIP, 'rebuilt byte-for-byte as a fresh zipStore output');
});

test('V6-04: gaps, trailing bytes, CRC errors, record mismatches and unsafe names are refused', () => {
  const cdOff = ZIP.readUInt32LE(eocdAt(ZIP) + 16);
  const gap = Buffer.concat([ZIP.subarray(0, cdOff), Buffer.from(SECRET), ZIP.subarray(cdOff)]);
  gap.writeUInt32LE(cdOff + SECRET.length, gap.length - 22 + 16);
  assert.throws(() => readStoredZip(gap), /bytes between the entries/);
  assert.throws(() => readStoredZip(Buffer.concat([ZIP, Buffer.from(SECRET)])), /trailing bytes/);
  const badCrc = Buffer.from(ZIP); badCrc[30 + 'README.txt'.length] ^= 1;
  assert.throws(() => readStoredZip(badCrc), /checksum mismatch/);
  const mismatch = Buffer.from(ZIP); mismatch.write('X', cdOff + 46, 'latin1'); // central name differs from local name
  assert.throws(() => readStoredZip(mismatch), /disagree/);
  assert.throws(() => readStoredZip(zipStore([{ name: '../escape.txt', data: Buffer.from('x') }])), /unsafe entry name/);
  assert.throws(() => readStoredZip(zipStore([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'a.txt', data: Buffer.from('2') }])), /duplicate/);
  assert.throws(() => prepareForStorage(zipStore([{ name: 'k.txt', data: Buffer.from(`token ${SECRET}`) }]), { binary: 'case-packet' }), /not masked/);
});

// ------------------------------------------------------------------------------------------------ V6-06 JSON masking
const STRUCTURES = {
  cache: { url: 'https://example.org/a', fetched_at: '2026-10-10T00:00:00Z', headers: { 'set-cookie': 'sid=abc', etag: 'x' }, body: `token ${SECRET}` },
  ledger: { incident_id: 'synthetic', items: [{ label: 'observed', note: 'mail jane@example.org', sources: ['https://example.org'] }] },
  scope: { incident_id: 'synthetic', targets: ['example.org'], approvals: [{ by: 'owner', api_key: 'abc123', attested_at: '2026-10-10T00:00:00Z' }] },
  report: [{ check: 'tls', result: 'ok' }, { check: 'secrets', found: `Authorization: Bearer ${SECRET}`, password: 1234 }],
};
test('V6-06: JSON is masked by value; the result parses, keeps its structure, and holds no secret or contact', () => {
  for (const [name, obj] of Object.entries(STRUCTURES)) {
    for (const indent of [0, 2]) {
      const text = JSON.stringify(obj, null, indent) + '\n';
      const out = maskStoredText(text);
      const parsed = JSON.parse(out);
      const keys = (v) => (Array.isArray(v) ? v.map(keys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys(x)])) : typeof v);
      assert.deepEqual(Object.keys(keys(parsed)), Object.keys(keys(obj)), `${name}: same shape`);
      assert.ok(!out.includes(SECRET) && !out.includes('jane@example.org') && !out.includes('abc123') && !out.includes('sid=abc'), `${name}: masked`);
      assert.equal(maskStoredText(out), out, `${name}: masking a masked file changes nothing`);
      if (indent) assert.match(out, /^[[{]\n {2}\S/,`${name}: indentation kept`);
    }
  }
  const clean = '{ "a": 1,\n    "b": [true, null] }\n';
  assert.equal(maskStoredText(clean), clean, 'unchanged JSON keeps its exact bytes');
});

test('V6-06 parity: Python masks the same structures to equal JSON values', () => {
  for (const [name, obj] of Object.entries(STRUCTURES)) {
    const text = JSON.stringify(obj, null, 2);
    const py = PYTHON('import gb2l_core as c; sys.stdout.write(c.mask_stored_text(sys.stdin.read()))', text);
    assert.deepEqual(JSON.parse(py), JSON.parse(maskStoredText(text)), name);
  }
});

// --------------------------------------------------------------------------------------------- V6-07 detection
test('V6-07: only a genuinely absent path means "not installed"; files, dangling links and links are refused; absence is not cached', () => {
  const base = fresh('detect');
  const dir = join(base, 'authority');
  _setAuthorityForTests(dir, { checkAcl: false });
  assert.deepEqual(authorityStatus(), { installed: false });
  writeFileSync(dir, 'planted');
  assert.equal(authorityStatus().trusted, false, 'a file at the path');
  rmSync(dir);
  symlinkSync(join(base, 'does-not-exist'), dir, 'junction');
  const dangling = authorityStatus();
  assert.equal(dangling.installed, true); assert.equal(dangling.trusted, false, 'a dangling junction');
  rmSync(dir);
  const real = fresh('real-authority');
  symlinkSync(real, dir, 'junction');
  assert.equal(authorityStatus().trusted, false, 'a junction to a real folder');
  rmSync(dir);
  assert.deepEqual(authorityStatus(), { installed: false });
  mkdirSync(dir); copyFileSync(join(TOOLBOX_ROOT, 'authority', 'authority_core.mjs'), join(dir, 'authority_core.mjs'));
  assert.equal(authorityStatus().trusted, true, 'an authority that appears is noticed at the next check');
  _resetAuthority();
});

test('V6-07 parity: Python refuses a file and a dangling junction at the authority path', () => {
  const base = fresh('detect-py');
  const file = join(base, 'file'); writeFileSync(file, 'planted');
  const link = join(base, 'link'); symlinkSync(join(base, 'missing'), link, 'junction');
  const out = PYTHON('import json, gb2l_core as c\nr = []\nfor p in json.load(sys.stdin):\n    c._set_authority_for_tests(p, check_acl=True)\n    try:\n        c._check_authority(b"{}"); r.append("accepted")\n    except c.InputError:\n        r.append("refused")\nc._set_authority_for_tests(sys.argv[0] + "-absent-path")\nr.append(repr(c._check_authority(b"{}")))\nprint(json.dumps(r))',
    JSON.stringify([file, link]));
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), ['refused', 'refused', 'None']);
});

// -------------------------------------------------------------------------------------- init lifecycle / sidecar
const PASS = 'synthetic v7 regression passphrase';
test('init: exclusive, all-or-nothing; a second init, a held lock and partial files are all refused unchanged', () => {
  const dir = fresh('init');
  cli.initializeAuthority(dir, PASS);
  assert.deepEqual(readdirSync(dir).sort(), ['authorizations', 'private_key.enc.json', 'public_key.pem', 'state.json']);
  const before = readFileSync(join(dir, 'public_key.pem'), 'utf8');
  assert.throws(() => cli.initializeAuthority(dir, PASS), /already initialised/);
  assert.equal(readFileSync(join(dir, 'public_key.pem'), 'utf8'), before, 'the first key is untouched');
  assert.ok(!existsSync(join(dir, 'init.lock')), 'the lock is released');

  const locked = fresh('init-locked');
  writeFileSync(join(locked, 'init.lock'), 'held');
  assert.throws(() => cli.initializeAuthority(locked, PASS), /another initialization is in progress/);
  assert.deepEqual(readdirSync(locked), ['init.lock'], 'nothing written while the lock is held');

  for (const partial of ['public_key.pem', 'private_key.enc.json', 'state.json', 'authorizations']) {
    const d = fresh('init-partial');
    if (partial === 'authorizations') mkdirSync(join(d, partial)); else writeFileSync(join(d, partial), 'partial');
    assert.throws(() => cli.initializeAuthority(d, PASS), /did not finish/, partial);
    assert.deepEqual(readdirSync(d), [partial], `${partial}: nothing else written`);
  }
});

const KEYS = generateAuthorityKey(PASS);
const scopeFor = (incident_id) => ({ incident_id, status: 'open', expires_at: '2099-01-01T00:00:00Z', persistence: 'local', permissions: { save_local: true },
  question: 'q', scope: 's', stopping_condition: 'c', targets: ['example.org'], urgency: 'normal', confidence: 'low', prohibited: ['p'], disclosures: [], approvals: [] });
const authorityDir = () => {
  const d = fresh('approve');
  writeFileSync(join(d, 'public_key.pem'), KEYS.publicKeyPem);
  writeFileSync(join(d, 'state.json'), JSON.stringify(emptyState()));
  mkdirSync(join(d, 'authorizations'));
  return d;
};

test('no privileged sidecar: approve writes the signature only inside the protected authorizations folder', () => {
  const dir = authorityDir();
  const workspace = fresh('workspace');
  const { file } = cli.commitApproval(dir, scopeFor('synthetic-ok'), { expectedSerial: 1, keys: KEYS, passphrase: PASS });
  assert.equal(file, join(dir, 'authorizations', 'synthetic-ok.json'));
  assert.deepEqual(readdirSync(join(dir, 'authorizations')), ['synthetic-ok.json']);
  assert.deepEqual(readdirSync(workspace), [], 'nothing written outside the protected folder');
  assert.equal(cli.verifyScopeBytes(dir, Buffer.from(JSON.stringify(scopeFor('synthetic-ok')))).valid, true);
});

test('no privileged sidecar: unsafe incident ids are refused before anything is signed; a linked folder is refused', () => {
  const dir = authorityDir();
  for (const id of ['..', '..\\..\\escape', 'a/b', 'C:x', '', 'x'.repeat(129), 'con:'] ) {
    assert.throws(() => cli.commitApproval(dir, scopeFor(id), { expectedSerial: 1, keys: KEYS, passphrase: PASS }), /cannot be used as a file name/, JSON.stringify(id));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), emptyState(), 'state unchanged');
  rmSync(join(dir, 'authorizations'), { recursive: true });
  const elsewhere = fresh('elsewhere');
  symlinkSync(elsewhere, join(dir, 'authorizations'), 'junction');
  assert.throws(() => cli.commitApproval(dir, scopeFor('synthetic-link'), { expectedSerial: 1, keys: KEYS, passphrase: PASS }), /is a link/);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
});
