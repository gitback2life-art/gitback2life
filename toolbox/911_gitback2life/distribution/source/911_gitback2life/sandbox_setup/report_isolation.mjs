#!/usr/bin/env node
// report_isolation: run by a PERSON inside a gitback2life Windows Sandbox to record the real system state.
// Prints verifyIsolation(mode) (_shared/isolation.mjs, read-only). In inspect mode it also checks the F04 layout:
// one probe file is written to the mapped state folder (C:\gb2l-state) through the same safeWrite path the tools use
// (no junction; link, hardlink and real-path checks on), and the report is saved there so it can be read from the host
// (the sandbox has no clipboard). Never contacts the network. Run elsewhere, it simply reports "not isolated".
import { join } from 'node:path';
import { fail, isMain, nowUtc, safeWrite } from '../_shared/common.mjs';
import { MODES } from './sandbox_setup.mjs';
import { verifyIsolation } from '../_shared/isolation.mjs';
import { resolveStateDir, SANDBOX_STATE_ROOT } from '../_shared/polite.mjs';

export const REPORT_FILE = 'isolation-report-inspect.txt'; // .txt: never parsed or pruned as polite state

export function report(mode, { verify = verifyIsolation, env = process.env, write = safeWrite, now = nowUtc } = {}) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  const out = { checked_at: now(), mode, isolation: verify(mode) };
  if (mode === 'inspect') {
    try {
      const st = resolveStateDir(env);
      if (st.dir !== SANDBOX_STATE_ROOT) throw new Error(`GITBACK2LIFE_STATE_ROOT is not set to ${SANDBOX_STATE_ROOT}`);
      write(join(st.dir, 'sandbox-write-probe.txt'), `${out.checked_at}\n`, { root: st.root, overwrite: true });
      out.state_folder = { path: st.dir, writable_without_junction: true };
    } catch (e) {
      out.state_folder = { path: SANDBOX_STATE_ROOT, writable_without_junction: false, error: e.message };
    }
  }
  return out;
}

export function main(argv, { env = process.env } = {}) {
  const mode = argv[0] ?? env.GITBACK2LIFE_ISOLATED;
  const r = report(mode, { env });
  const text = JSON.stringify(r, null, 2) + '\n';
  process.stdout.write(text);
  if (mode === 'inspect' && r.state_folder.writable_without_junction) {
    const st = resolveStateDir(env);
    console.log(`saved ${safeWrite(join(st.dir, REPORT_FILE), text, { root: st.root, overwrite: true })} (visible on the host in _shared\\.polite_cache)`);
  } else if (mode === 'tests') {
    console.log('tests mode shares no writable folder with the host: read "isolated" and any "reasons" above to the operator.');
  }
  process.exitCode = r.isolation.isolated ? 0 : 1;
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
