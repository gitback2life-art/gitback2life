// V6-03: system programs the toolbox relies on for TRUST decisions are launched from fixed absolute paths, with a
// constructed (not inherited) environment and a fixed working folder. A program named "powershell.exe" earlier on
// PATH, a poisoned PSModulePath or NODE_OPTIONS, or the current folder can therefore never be picked up.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const WINDOWS_DIR = 'C:\\Windows';
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const PROTECTED_NODE = 'C:\\Program Files\\nodejs\\node.exe';

/** The only environment a trust-related child process gets: system folders and nothing the user account chose. */
export function trustedEnv() {
  return {
    SystemRoot: WINDOWS_DIR, windir: WINDOWS_DIR, SystemDrive: 'C:',
    PATH: `${WINDOWS_DIR}\\System32;${WINDOWS_DIR};${WINDOWS_DIR}\\System32\\WindowsPowerShell\\v1.0`,
    PSModulePath: `${WINDOWS_DIR}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    TEMP: `${WINDOWS_DIR}\\Temp`, TMP: `${WINDOWS_DIR}\\Temp`,
  };
}

/** Run a PowerShell script with the pinned executable. `run` is injectable for tests. */
export function runPowerShell(script, { run = execFileSync, timeout = 120_000 } = {}) {
  if (run === execFileSync && !existsSync(POWERSHELL)) throw new Error(`the system PowerShell was not found at ${POWERSHELL}`);
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout, env: trustedEnv(), cwd: `${WINDOWS_DIR}\\System32`, windowsHide: true });
}
