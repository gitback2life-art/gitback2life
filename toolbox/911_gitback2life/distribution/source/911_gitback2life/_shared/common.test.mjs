import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, safeWrite, TOOLBOX_ROOT, verifyWritten } from './common.mjs';

test('redact masks token-shaped strings and header values', () => {
  const input = [
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Bearer abc.def.ghi-very-long-token-value',
    'Set-Cookie: session=abc123; Path=/',
    'AKIAABCDEFGHIJKLMNOP',
  ].join('\n');
  const out = redact(input);
  assert.doesNotMatch(out, /ghp_[A-Za-z0-9]{20}/);
  assert.doesNotMatch(out, /abc123/);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /Authorization: \[REDACTED\]/);
});

test('redact leaves ordinary evidence (URLs, commit SHAs) intact', () => {
  const sha = 'a'.repeat(40);
  const text = `https://github.com/o/r/blob/${sha}/scripts/agent/rules.ts`;
  assert.equal(redact(text), text);
});

test('safeWrite refuses paths outside the toolbox folder', () => {
  assert.throws(() => safeWrite(join(TOOLBOX_ROOT, '..', 'escape.txt'), 'x'), /outside the toolbox/);
  if (process.platform === 'win32') {
    if (process.platform === 'win32') {
    assert.throws(() => safeWrite('C:\\Windows\\Temp\\escape.txt', 'x'), /outside the toolbox/);
  } else {
    assert.throws(() => safeWrite('/tmp/gb2l-escape.txt', 'x'), /outside the toolbox/);
  }
  } else {
    assert.throws(() => safeWrite('/tmp/gb2l-escape.txt', 'x'), /outside the toolbox/);
  }
});

test('safeWrite refuses to overwrite an existing file by default', () => {
  assert.throws(() => safeWrite(join(TOOLBOX_ROOT, '_shared', 'common.mjs'), 'x'), /refusing to overwrite/);
});

// ---- File boundary (review finding D): links inside the toolbox must not let writes escape ----
function linkBox() {
  const base = join(TOOLBOX_ROOT, '.test_tmp', `common-${randomUUID()}`);
  const box = join(base, 'box');          // plays the role of the toolbox folder
  const outside = join(base, 'outside');  // a folder outside "the toolbox"
  mkdirSync(box, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const cleanup = () => {
    rmSync(base, { recursive: true, force: true });
    try { rmdirSync(join(TOOLBOX_ROOT, '.test_tmp')); } catch { /* another test file is still using it */ }
  };
  return { box, outside, cleanup };
}

test('a write through a directory junction/symlink inside the toolbox is refused and nothing lands outside', () => {
  const { box, outside, cleanup } = linkBox();
  try {
    symlinkSync(outside, join(box, 'link'), 'junction'); // junctions need no admin rights on Windows
    assert.throws(() => safeWrite(join(box, 'link', 'escape.txt'), 'x', { root: box }), /through a link/);
    assert.throws(() => safeWrite(join(box, 'link', 'deeper', 'escape.txt'), 'x', { root: box }), /through a link/);
    assert.deepEqual(readdirSync(outside), [], 'nothing was written outside');
  } finally { cleanup(); }
});

test('overwriting a file that is itself a symlink is refused (skipped if this account cannot create file symlinks)', (t) => {
  const { box, outside, cleanup } = linkBox();
  try {
    try { symlinkSync(join(outside, 'target.txt'), join(box, 'f.txt'), 'file'); } catch (e) {
      if (e.code === 'EPERM') return t.skip('creating file symlinks needs Developer Mode or admin on Windows');
      throw e;
    }
    assert.throws(() => safeWrite(join(box, 'f.txt'), 'x', { root: box, overwrite: true }), /through a link/);
    assert.equal(existsSync(join(outside, 'target.txt')), false);
  } finally { cleanup(); }
});

test('ordinary writes inside the toolbox still work, and new files are never silently replaced', () => {
  const { box, cleanup } = linkBox();
  try {
    const p = safeWrite(join(box, 'a', 'b', 'ok.txt'), 'hello', { root: box });
    assert.ok(existsSync(p));
    assert.throws(() => safeWrite(p, 'again', { root: box }), /refusing to overwrite/);
    assert.doesNotThrow(() => safeWrite(p, 'again', { root: box, overwrite: true }));
    assert.equal(readFileSync(p, 'utf8'), 'again');
    assert.deepEqual(readdirSync(join(box, 'a', 'b')), ['ok.txt'], 'the overwrite left no temp file behind');
  } finally { cleanup(); }
});

test('F05: overwriting a hardlinked file is refused and the other name keeps its contents', () => {
  const { box, outside, cleanup } = linkBox();
  try {
    const out = join(outside, 'shared.txt');
    writeFileSync(out, 'unchanged');
    linkSync(out, join(box, 'shared.txt')); // hardlinks need no admin rights; lstat sees an ordinary file
    assert.throws(() => safeWrite(join(box, 'shared.txt'), 'modified', { root: box, overwrite: true }), /hardlinked/);
    assert.equal(readFileSync(out, 'utf8'), 'unchanged');
    assert.deepEqual(readdirSync(box), ['shared.txt'], 'no temp file left behind');
  } finally { cleanup(); }
});

test('verifyWritten: a file that ends up outside the toolbox through a swapped-in junction is removed and reported', () => {
  const { box, outside, cleanup } = linkBox();
  try {
    symlinkSync(outside, join(box, 'swapped'), 'junction');
    // Simulate the race: the write happened after the folder became a junction, so the bytes landed outside.
    const landed = join(box, 'swapped', 'report.json');
    writeFileSync(landed, 'synthetic');
    assert.ok(existsSync(join(outside, 'report.json')), 'precondition: it really is outside');
    assert.throws(() => verifyWritten(box, landed), /write verification failed, so the file was removed: .*(outside the toolbox|link)/);
    assert.equal(existsSync(join(outside, 'report.json')), false, 'the escaped file was removed');
  } finally { cleanup(); }
});

test('verifyWritten: an ordinary file inside the toolbox passes; a hardlinked one is removed', () => {
  const { box, outside, cleanup } = linkBox();
  try {
    const ok = safeWrite(join(box, 'ok.txt'), 'fine', { root: box });
    assert.doesNotThrow(() => verifyWritten(box, ok));
    const p = join(box, 'linked.txt'); writeFileSync(p, 'x'); linkSync(p, join(outside, 'other-name.txt'));
    assert.throws(() => verifyWritten(box, p), /2 names/);
    assert.equal(existsSync(p), false);
    assert.equal(readFileSync(join(outside, 'other-name.txt'), 'utf8'), 'x', 'the other name is untouched');
  } finally { cleanup(); }
});