// Development-build diagnostics: record lifecycle, operation names, error stacks,
// exit status and subprocess outcomes. Never record prompted input, register data,
// incident contents, request payloads, one-time codes or passphrases.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskForStorage } from '../_shared/common.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const idFromLauncher = process.env.GB2L_TOOLBOX_RUN_ID;
const runId = /^\d{1,6}_\d{1,6}_\d{1,6}$/.test(idFromLauncher ?? '')
  ? idFromLauncher : `${Date.now()}_${process.pid}`;
export const diagnosticsPath = join(ROOT, 'Temp', 'Logs', `toolbox_${runId}.log`);
const PRIVATE_HEX = /\b[a-f\d]{32}\b/gi;
const PRIVATE_FIELD = /\b(passphrase|one[- ]?time (?:code|token)|password|secret)\s*[:=]\s*[^\s,;]+/gi;
function safeDetail(value) {
  return maskForStorage(String(value ?? '')).replace(PRIVATE_HEX, '[redacted-code]')
    .replace(PRIVATE_FIELD, '$1=[redacted]')
    .slice(0, 12000);
}
let warnedOnce = false;
export function diagnostic(event, detail = '') {
  const row = `[${new Date().toISOString()}] ${safeDetail(event)}${detail ? ` | ${safeDetail(detail)}` : ''}\n`;
  try {
    mkdirSync(join(ROOT, 'Temp', 'Logs'), { recursive: true });
    appendFileSync(diagnosticsPath, row, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (e) {
    // A logging problem must not prevent the ordinary toolbox from starting.
    // The launcher captures stderr in a *different* file on Windows.
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(`WARNING: Toolbox diagnostic file unavailable (${e.code || 'I/O error'}). Logging continues on stderr.`);
    }
    console.error(row.trimEnd());
    return false;
  }
}
// Do not make operators finish the whole interactive session to retrieve a
// diagnosis of a failed operation. This is intentionally the *existing*
// Downloads support collector, not a second collection format or workflow.
// The launcher owns the stderr handle until exit, so mid-run ZIPs contain only
// the closed-per-write application log and the launcher log. Its normal final
// ZIP includes stderr after Node exits, as before.
let earlySnapshotAttempted = false;
function snapshotOnFirstError() {
  if (earlySnapshotAttempted || process.platform !== 'win32' ||
      !/^\d{1,6}_\d{1,6}_\d{1,6}$/.test(idFromLauncher ?? '')) return;
  earlySnapshotAttempted = true;
  const script = join(ROOT, 'toolbox', 'make_support_zip.ps1');
  const launcher = join(ROOT, 'Temp', 'Logs', `launcher_${runId}.log`);
  if (!existsSync(script) || !existsSync(launcher)) return;
  // Fixed executable, file, and argument vector; never shell-evaluate input.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', script,
    '-LaunchLog', launcher, '-AppLog', diagnosticsPath,
    '-StderrLog', join(ROOT, 'Temp', 'Logs', `node_stderr_${runId}.log`),
    '-RunId', runId, '-ExitCode', '1', '-Snapshot'],
    { cwd: ROOT, shell: false, timeout: 30_000, encoding: 'utf8',
      windowsHide: true, maxBuffer: 128 * 1024 });
  diagnostic(r.status === 0 ? 'SUPPORT_SNAPSHOT_OK' : 'SUPPORT_SNAPSHOT_WARNING',
    r.status === 0 ? 'early error ZIP saved to Downloads' : 'early ZIP could not be made; normal exit collector still runs');
}
export function diagnosticError(context, error) {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  diagnostic(`ERROR ${context}`, message);
  snapshotOnFirstError();
}
export function attachFatalDiagnostics() {
  // Observe fatal crashes without suppressing Node's default failure behavior.
  // In the one-click launcher, Node's native stderr is captured in the same log.
  process.on('uncaughtExceptionMonitor', (error) => {
    try { diagnosticError('fatal exception', error); } catch { /* native stderr is still captured */ }
  });
}
