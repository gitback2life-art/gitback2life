// Predeployment bootstrap: narrow self-check then ALWAYS refuse pending G0b/G2/M4.
// Must not be treated as production authority bootstrap or as key/genesis initialization.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = 'C:\\ProgramData\\gitback2life-authority';
const sha = (x) => createHash('sha256').update(x).digest('hex');
const fail = (reason) => { process.stderr.write('Authority inactive: ' + reason + '\n'); process.exit(3); };
const fixed = { systemroot:'C:\\Windows', windir:'C:\\Windows', systemdrive:'C:', path:'C:\\Windows\\System32', temp:'C:\\Windows\\Temp', tmp:'C:\\Windows\\Temp' };
if (JSON.stringify(process.execArgv) !== JSON.stringify(['--no-addons','--no-global-search-paths'])) fail('unexpected node arguments');
const env = Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k.toLowerCase(),v]));
if (Object.keys(env).length !== Object.keys(fixed).length || Object.entries(fixed).some(([k,v])=>env[k]!==v)) fail('untrusted environment');
if (!process.argv.slice(2).every((a)=>/^[a-z0-9-]{1,64}$/.test(a))) fail('invalid arguments');
if (existsSync(join(ROOT,'authority_testkit.mjs'))) fail('testkit present');
let m;
try { m = JSON.parse(readFileSync(join(ROOT,'installed_manifest.json'),'utf8')); } catch { fail('missing installation receipt'); }
if (m.schema !== 'gb2l-predeploy-v1' || m.status !== 'not_initialized_no_authority') fail('unknown install state');
if (sha(readFileSync(process.execPath)) !== m.runtime_sha256) fail('runtime fingerprint mismatch');
try {
  for (const [rel, fingerprint] of Object.entries(m.files)) {
    if (!/^[a-z0-9_./-]+$/.test(rel) || rel.includes('..')) fail('unexpected installed path');
    if (sha(readFileSync(join(ROOT,rel))) !== fingerprint) fail('protected module changed: ' + rel);
  }
} catch { fail('protected module absent or mismatched'); }
fail('NOT ACTIVATED. Owner-only security gates G0b and G2, reviewed genesis initialization and M4 remain required.');
