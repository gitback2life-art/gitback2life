// G0a: OS-exclusive lock behaviour (design revision 3.1, §5; test group B). Synthetic, non-elevated, temporary files.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { acquire, LOCK_FLAGS, selfTest, tryAcquire } from './exclusive_lock.mjs';

const WIN = process.platform === 'win32';
const DIR = mkdtempSync(join(tmpdir(), 'g0a-lock-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
let n = 0;
const lockPath = () => join(DIR, `authority-${n++}.lock`);
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code ?? e.message; } };

/** A child process that takes the lock (or reports busy), prints one line, then waits for "exit" on stdin. */
function contender(path) {
  const src = `const fs=require('fs');let fd=null;try{fd=fs.openSync(${JSON.stringify(path)},${LOCK_FLAGS})}catch(e){console.log(JSON.stringify({held:false,code:e.code}))}
if(fd!==null){console.log(JSON.stringify({held:true}))}
process.stdin.on('data',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['pipe', 'pipe', 'inherit'] });
  const first = new Promise((resolve) => child.stdout.once('data', (d) => resolve(JSON.parse(String(d).trim()))));
  return { child, first, exit: () => new Promise((r) => { child.on('exit', r); child.stdin.write('exit\n'); }) };
}

test('B4: while held, a second open, a rename and a delete all fail with EBUSY', { skip: !WIN }, () => {
  const p = lockPath();
  const lock = acquire(p);
  assert.equal(tryAcquire(p), null, 'a second exclusive open is refused');
  assert.equal(code(() => openSync(p, 'r')), 'EBUSY', 'even a plain read open');
  assert.equal(code(() => renameSync(p, `${p}.moved`)), 'EBUSY');
  assert.equal(code(() => unlinkSync(p)), 'EBUSY');
  lock.release();
  lock.release(); // idempotent: closing twice is harmless and touches nothing else
  assert.ok(existsSync(p), 'the lock file is never deleted');
  const again = acquire(p);
  again.release();
});

test('B4: 2 to 5 real contending processes: exactly one holds; losers cannot move or delete the lock', { skip: !WIN }, async () => {
  for (let count = 2; count <= 5; count++) {
    const p = lockPath();
    writeFileSync(p, ''); // created once, as the installer would
    const procs = Array.from({ length: count }, () => contender(p));
    const results = await Promise.all(procs.map((c) => c.first));
    assert.equal(results.filter((r) => r.held).length, 1, `${count} contenders: exactly one holder`);
    assert.ok(results.filter((r) => !r.held).every((r) => r.code === 'EBUSY'), 'every loser saw EBUSY');
    assert.equal(code(() => renameSync(p, `${p}.x`)), 'EBUSY', 'a loser cannot rename the winner\'s lock');
    assert.equal(code(() => unlinkSync(p)), 'EBUSY', 'or delete it');
    await Promise.all(procs.map((c) => c.exit()));
    acquire(p, { waitMs: 2000 }).release(); // free again once all are gone
  }
});

test('B5: a REAL child killed while holding the lock: the OS releases it; no file operation on the lock path happens', { skip: !WIN }, async () => {
  const p = lockPath();
  const c = contender(p);
  assert.deepEqual(await c.first, { held: true });
  assert.equal(tryAcquire(p), null, 'held by the child');
  await new Promise((r) => { c.child.on('exit', r); c.child.kill('SIGKILL'); });
  const lock = acquire(p, { waitMs: 2000 });
  lock.release();
  assert.ok(existsSync(p), 'the same lock file, never renamed or deleted');
});

test('B6: the handle is not inherited: a child spawned by the holder does not keep the lock alive', { skip: !WIN }, async () => {
  const p = lockPath();
  const lock = acquire(p);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'inherit' });
  lock.release();
  const again = tryAcquire(p);
  assert.notEqual(again, null, 'acquired while the holder\'s child is still running');
  (await import('node:fs')).closeSync(again);
  await new Promise((r) => { child.on('exit', r); child.kill(); });
});

test('B6: the self-test refuses when exclusivity is not enforced (simulated), and passes when it is', { skip: !WIN }, () => {
  const p = lockPath();
  const fakeOpen = (path) => openSync(path, 'a+'); // shared open: what a Node that ignored the flag would do
  assert.throws(() => acquire(p, { open: fakeOpen }), /exclusive locking unavailable/);
  const lock = acquire(p);
  assert.equal(selfTest(p), true);
  lock.release();
});

test('B6: a lock file the account has no access to cannot be opened or held (ACL fixture on our own temp file)', { skip: !WIN }, () => {
  const p = lockPath();
  writeFileSync(p, '');
  const icacls = 'C:\\Windows\\System32\\icacls.exe';
  // Leave only SYSTEM and Administrators (an unelevated token cannot use the Administrators group). We remain owner.
  execFileSync(icacls, [p, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F'], { stdio: 'ignore' });
  try {
    assert.throws(() => tryAcquire(p), (e) => e.code === 'EPERM' || e.code === 'EACCES', 'no access, so it cannot be held');
  } finally {
    execFileSync(icacls, [p, '/grant:r', `${userInfo().username}:F`], { stdio: 'ignore' }); // owner restores access
  }
  acquire(p).release();
});

test('busy: a second command waits, then reports busy, and records nothing', { skip: !WIN }, async () => {
  const p = lockPath();
  const c = contender(p);
  await c.first;
  const started = Date.now();
  assert.throws(() => acquire(p, { waitMs: 300, intervalMs: 50 }), /another authority command is running/);
  assert.ok(Date.now() - started >= 250, 'it waited before giving up');
  await c.exit();
});
