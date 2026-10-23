// G0a prototype (design revision 3.1, §5): the authority's command-wide lock as an OS-held exclusive open handle.
// NOT installed and NOT used by the production authority. Synthetic, non-elevated tests only.
//
// The file is opened with libuv's Windows flag UV_FS_O_EXLOCK (0x10000000): share mode 0. While the handle is open,
// every other open, rename and delete of that file fails with EBUSY. The OS closes the handle when the holder exits
// or is killed, so there is never a stale lock to take over. Release = close our own handle. The lock file is never
// deleted or renamed by this module.
// Node does not export this constant (fs.constants.UV_FS_O_EXLOCK is undefined on Node 24), so every acquisition runs
// a self-test: a second open of the same path MUST fail with EBUSY, or the lock is refused as unavailable.
import { closeSync, constants, openSync } from 'node:fs';

export const UV_FS_O_EXLOCK = 0x10000000;
export const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** One attempt. Returns the file descriptor, or null if another process holds the lock (EBUSY). Other errors throw. */
export function tryAcquire(path, { open = openSync } = {}) {
  try { return open(path, LOCK_FLAGS); } catch (e) {
    if (e.code === 'EBUSY') return null;
    throw e;
  }
}

/**
 * The startup self-test: with the lock held (fd), a second open of the same path must fail with EBUSY and nothing
 * else. If it succeeds, exclusivity is not being enforced (a different Node/libuv): close everything and refuse.
 */
export function selfTest(path, { open = openSync } = {}) {
  let second;
  try { second = open(path, LOCK_FLAGS); } catch (e) {
    if (e.code === 'EBUSY') return true;
    throw new Error(`lock self-test failed: unexpected error ${e.code}`);
  }
  closeSync(second);
  throw new Error('exclusive locking unavailable on this Node version: a second open of the lock succeeded');
}

/**
 * Acquire with bounded waiting (§5: about 10 s), then self-test. Returns { fd, release }. Throws "busy" when another
 * command holds it for the whole wait. `release` only closes OUR handle; it can never affect another holder.
 */
export function acquire(path, { waitMs = 10_000, intervalMs = 100, open = openSync, now = Date.now } = {}) {
  if (process.platform !== 'win32') throw new Error('the authority lock is Windows-only');
  const deadline = now() + waitMs;
  for (;;) {
    const fd = tryAcquire(path, { open });
    if (fd !== null) {
      try { selfTest(path, { open }); } catch (e) { closeSync(fd); throw e; }
      let released = false;
      return { fd, release: () => { if (!released) { released = true; closeSync(fd); } } };
    }
    if (now() >= deadline) throw new Error('another authority command is running (the lock is busy); wait for it to finish and run this again');
    sleep(intervalMs);
  }
}
