#!/usr/bin/env node
// Run a project's test command with the network blocked and secret-looking environment variables removed,
// then report the exact command, exit status, counts and environment.
//
// THIS RUNNER IS NOT A SANDBOX by itself: its network guard covers Node.js processes only, and hostile code
// could switch it off. So it refuses to run anywhere except inside the verified tests-mode Windows Sandbox
// (networking turned off; checked from the real system state, see _shared/isolation.mjs). It never uses a shell:
// commands become fixed argument lists, and npx is run with --no so it can never download a package.
// Downloaded code is untrusted: a person must read the tests and package.json scripts first (--reviewed).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release, platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson, safeWrite } from '../_shared/common.mjs';
import { requireScope } from '../_shared/scope.mjs';
import { verifyIsolation } from '../_shared/isolation.mjs';
import { dirname, join } from 'node:path';

const GUARD = pathToFileURL(fileURLToPath(new URL('./network_guard.mjs', import.meta.url))).href;
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|COOKIE|SESSION|AUTH/i;
const MAX_CAPTURE = 5 * 1024 * 1024;

export function offlineEnv(base = process.env) {
  // V4-05: npm also reads its settings from npm_config_* variables (e.g. npm_config_ignore_scripts=false), so
  // inherited ones are dropped and the safe values set here.
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !SECRET_ENV.test(k) && !/^npm_config_/i.test(k)));
  env.npm_config_ignore_scripts = 'true';
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${GUARD}`.trim();
  // Belt and braces for tools that honor proxies (npm, pip, git): point them at a dead local port.
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) env[k] = 'http://127.0.0.1:9';
  env.NO_PROXY = '';
  env.npm_config_offline = 'true';
  return env;
}

/** Parse node:test summaries from either the TAP (`# pass 3`) or spec (`ℹ pass 3`) reporter. */
export function parseTestSummary(output) {
  const counts = {};
  for (const m of String(output).matchAll(/^\s*(?:#|ℹ)\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/gm)) {
    counts[m[1]] = Number(m[2]);
  }
  return counts;
}

// Only Node test runners, and no shell chaining/redirection that could start other programs directly.
const ALLOWED_RUNNERS = new Set(['node', 'npm', 'npx', 'tsx']);
// Naming one of these with "npm run" runs it explicitly, which --ignore-scripts does not prevent.
const LIFECYCLE_SCRIPT = /^(pre|post)|^(install|uninstall|prepare|prepublish|prepublishonly|publish|prepack|pack|postpack|version|dependencies|restart|start|stop)$/i;

export function commandProblems(command) {
  const problems = [];
  const [first, second] = String(command).trim().split(/\s+/).map((w) => w.toLowerCase().replace(/\.(cmd|exe|ps1)$/, ''));
  if (!ALLOWED_RUNNERS.has(first)) problems.push(`only Node test runners are allowed (${[...ALLOWED_RUNNERS].join(', ')}), not "${first}"`);
  // npx can download and run any package; only the tsx test runner is allowed through it.
  if (first === 'npx' && second !== 'tsx') problems.push('npx is only allowed as "npx tsx ..."');
  if (first === 'npm' && !/^(test|t|run)$/.test(second ?? '')) problems.push('npm is only allowed as "npm test" or "npm run <test script>"');
  if (/[;&|<>`$]|\$\(|\r|\n/.test(command)) problems.push('shell chaining, pipes, redirection and substitution are not allowed');
  if (/\b(install|ci|i|add|update|exec|publish|run-script\s+(pre|post)?install)\b/i.test(command) && first !== 'node') {
    problems.push('installing or publishing packages is not a test run (install separately with --ignore-scripts)');
  }
  if (first === 'npm') {
    // V4-05: the caller may not pass npm options at all (they could undo --ignore-scripts: "--ignore-scripts=false",
    // "--no-ignore-scripts", ...). run_offline sets npm's options itself. Arguments after "--" go to the test script.
    const words = splitCommand(command);
    const cut = words.indexOf('--');
    const npmWords = (cut === -1 ? words : words.slice(0, cut)).slice(1);
    if (npmWords.some((w) => w.startsWith('-'))) problems.push('npm options are not allowed here (run_offline sets npm\'s options itself, including --ignore-scripts); put test arguments after "--"');
    const [verb, script, ...extra] = npmWords;
    if (/^(test|t)$/i.test(verb ?? '') && script !== undefined) problems.push('"npm test" takes no further npm arguments; put test arguments after "--"');
    if (/^run$/i.test(verb ?? '')) {
      if (!script) problems.push('"npm run" needs the name of a test script');
      else if (LIFECYCLE_SCRIPT.test(script)) problems.push(`"${script}" is a package lifecycle script, not a test script`);
      if (extra.length) problems.push('"npm run <script>" takes no further npm arguments; put test arguments after "--"');
    }
  }
  return problems;
}

/** Split a command into arguments (quotes group words). No shell ever sees it. */
export function splitCommand(command) {
  const out = [];
  for (const m of String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Turn node/npm/npx/tsx into a fixed program + argument list run by this Node, without a shell. npx never downloads.
 * npm always gets --ignore-scripts. Real-sandbox finding (2026-10-09): `npm test` ran the project's `pretest`
 * script, which is arbitrary project code outside the test command. With --ignore-scripts, npm still runs the named
 * script (`test`, or `run <name>`) but skips every pre/post lifecycle script.
 */
export function resolveRunner([first, ...rest], { execPath = process.execPath } = {}) {
  const bin = join(dirname(execPath), 'node_modules', 'npm', 'bin');
  switch (String(first).toLowerCase().replace(/\.(cmd|exe|ps1)$/, '')) {
    case 'node': return [execPath, rest];
    case 'npm': return [execPath, [join(bin, 'npm-cli.js'), '--ignore-scripts', ...rest]];
    case 'npx': return [execPath, [join(bin, 'npx-cli.js'), '--no', ...rest]];
    case 'tsx': return [execPath, [join(bin, 'npx-cli.js'), '--no', 'tsx', ...rest]];
    default: throw new Error(`unsupported runner "${first}"`);
  }
}

export function runOffline(command, cwd) {
  return new Promise((resolvePromise) => {
    const started_at = nowUtc();
    let captured = '';
    const [file, args] = resolveRunner(splitCommand(command));
    const child = spawn(file, args, { cwd, env: offlineEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, sink) => stream.on('data', (chunk) => {
      sink.write(chunk);
      if (captured.length < MAX_CAPTURE) captured += chunk.toString('utf8');
    });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('close', (code, signal) => resolvePromise({
      command, cwd, started_at, finished_at: nowUtc(), exit_code: code, signal,
      counts: parseTestSummary(captured),
      network_guard: 'Node.js network guard active; run inside the verified tests-mode Windows Sandbox (networking off); no shell; secret-like env vars removed.',
      environment: { node: process.version, platform: `${platform()} ${release()}` },
    }));
  });
}

const HELP = `run_offline: run a project's Node test command with the network blocked for Node.js.

  node run_offline.mjs --cwd <project folder> --reviewed --scope FILE [--save report.json] -- <command ...>

Example:
  node run_offline.mjs --cwd workspace\\nyc-animal-rescue --reviewed --scope scope.json -- npx tsx --test tests/*.test.ts

THIS RUNNER IS NOT A SANDBOX by itself, so it only runs inside the verified tests-mode Windows Sandbox
(sandbox_setup create --mode tests: networking turned off). It checks the real system state before running.
--reviewed confirms a person has read the test files and package.json scripts. No shell is used.
Allowed runners: node, npm, npx, tsx. No shell chaining or redirection. No installs.
Dependencies must already be installed with:  npm ci --ignore-scripts   (needs network and its own approval).
Reports the exact command, exit status, test counts, timestamps and environment.`;

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    cwd: { type: 'string' }, save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    reviewed: { type: 'boolean' }, scope: { type: 'string' },
  } });
  if (o.help || !positionals.length) return console.log(HELP);
  if (!o.cwd || !existsSync(o.cwd)) throw new Error('--cwd must point to an existing project folder');
  if (!o.reviewed) throw new Error('refusing to run downloaded code: read the tests and package.json scripts first, then pass --reviewed');
  requireScope(o.scope, { action: 'run_project_tests' });
  // Untrusted project code only runs inside the verified tests-mode sandbox (networking off), never on this computer.
  const iso = verifyIsolation('tests');
  if (!iso.isolated) throw new Error(`refusing to run project tests outside the verified tests-mode sandbox (sandbox_setup create --mode tests):\n  - ${iso.reasons.join('\n  - ')}`);
  if (o.save) requireScope(o.scope, { action: 'save_local' });
  const command = positionals.join(' ');
  const problems = commandProblems(command);
  if (problems.length) throw new Error(`command refused:\n  - ${problems.join('\n  - ')}`);
  console.error('Running inside the verified tests-mode sandbox (networking off). No shell; npx cannot download packages.');
  const report = await runOffline(command, o.cwd);
  console.log('\n===== run_offline report =====');
  printJson(report);
  if (report.counts.tests === undefined) console.log('(No node:test summary found in output; read the output above for counts.)');
  if (o.save) console.log(`saved ${safeWrite(o.save, JSON.stringify(report, null, 2) + '\n', { overwrite: o.overwrite })}`);
  process.exitCode = report.exit_code ?? 1;
}

if (isMain(import.meta)) main(process.argv.slice(2)).catch((e) => fail(e.message));
