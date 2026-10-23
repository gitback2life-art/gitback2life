// G0a PROTOTYPE bootstrap (design revision 3.1, §14.1). NOT installed. Imports ONLY node: built-ins; everything else
// is loaded with dynamic import() AFTER its bytes have been hashed and compared with installed_manifest.json.
// Prototype difference from production: the authority root is this file's own folder (the tests run it from
// throwaway copies); in production it is the fixed constant C:\ProgramData\gitback2life-authority.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXEC_ARGV = ['--no-addons', '--no-global-search-paths'];
const ENV = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', PATH: 'C:\\Windows\\System32', TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp' };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ARG = /^[a-z0-9-]{1,64}$/;
const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const refuse = (why) => { out({ ok: false, refused: why }); process.exit(3); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// 1. Launched only through authority.cmd: exact flags and exact environment (keys case-insensitive, values exact).
if (JSON.stringify(process.execArgv) !== JSON.stringify(EXEC_ARGV)) refuse(`unexpected node options ${JSON.stringify(process.execArgv)}`);
const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]));
const want = Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k.toLowerCase(), v]));
const extra = Object.keys(env).filter((k) => !(k in want));
if (extra.length) refuse(`unexpected environment variables: ${extra.join(', ')}`);
for (const [k, v] of Object.entries(want)) if (env[k] !== v) refuse(`environment variable ${k} is not the fixed value`);

// 2. Arguments: the authoritative exact check (authority.cmd's check is defence in depth).
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || !args.every((a) => ARG.test(a))) refuse(`invalid arguments ${JSON.stringify(args)}`);

// 3. No test seams in an installed folder.
if (existsSync(join(ROOT, 'authority_testkit.mjs'))) refuse('authority_testkit.mjs is present in the authority folder');

// 4. Verify every protected file BEFORE anything of it runs.
let manifest;
try { manifest = JSON.parse(readFileSync(join(ROOT, 'installed_manifest.json'), 'utf8')); } catch { refuse('installed_manifest.json missing or unreadable'); }
const MODULES = ['prototype_module.mjs'];
const HELPERS = ['helper_env.ps1'];
const verified = {};
for (const name of [...MODULES, ...HELPERS]) {
  let bytes;
  try { bytes = readFileSync(join(ROOT, name)); } catch { refuse(`${name} missing`); }
  if (manifest?.files?.[name] !== sha(bytes)) refuse(`${name} does not match installed_manifest.json`);
  verified[name] = true;
}

// 5. Only now load the verified modules.
const mod = await import(pathToFileURL(join(ROOT, 'prototype_module.mjs')).href);
const result = { ok: true, args, module: mod.describe() };

// 6. The PowerShell helper gets a CONSTRUCTED environment (no COR_*/COMPlus_* from the caller).
if (args[0] === 'helper-env') {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'helper_env.ps1')],
    { encoding: 'utf8', env: { ...ENV }, cwd: ROOT, windowsHide: true, timeout: 60_000 });
  result.helper_env_names = String(r.stdout).trim().split(/\r?\n/).filter(Boolean).sort();
}
out(result);
