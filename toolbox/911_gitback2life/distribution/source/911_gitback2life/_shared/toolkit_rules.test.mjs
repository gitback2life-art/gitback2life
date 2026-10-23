// Enforces TOOLKIT_RULES.md in code: no tool may reach the network except through the polite limits module,
// and offline tools may not contain network code at all. Add a new tool → this test checks it automatically.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { TOOLBOX_ROOT } from './common.mjs';

const SKIP_DIRS = new Set(['node_modules', '.polite_cache', '.test_tmp', 'fixtures', 'snapshots', 'archives', 'workspace', 'cleaned', '__pycache__']);

function* toolFiles(dir = TOOLBOX_ROOT) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* toolFiles(p);
    else if (['.mjs', '.py', '.ps1'].includes(extname(name)) && !/(\.test\.mjs|^test_.*\.py)$/.test(name)) {
      yield { rel: relative(TOOLBOX_ROOT, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') };
    }
  }
}

// The only files allowed to import network-capable Node modules, and which ones.
const NETWORK_MODULE_ALLOWLIST = {
  '_shared/safe_http.mjs': ['dns', 'http', 'https'], // existing public-evidence HTTP transport
  'email_communications/protected_backend.mjs': ['https'], // separately authorized, TLS-only outgoing-mail service
  '_shared/guards.mjs': ['net'], // address math only (BlockList, isIP)
  '_shared/isolation.mjs': ['net'], // address math only (isIP, validating firewall rule addresses)
  'regression_harness/network_guard.mjs': ['dgram', 'dns', 'net'], // it blocks them
  // V4-06 OS egress probe: deliberately ATTEMPTS a connection to TEST-NET-1 (192.0.2.1, no real host) and a .invalid
  // DNS lookup, to prove the OS blocks them. It refuses to run outside the verified tests-mode sandbox.
  'regression_harness/containment_probe/os_egress_probe.mjs': ['dns', 'net'],
  'domain_research/domain_research.mjs': ['dns/promises', 'net'],
  'email_spoof_check/email_spoof_check.mjs': ['dns/promises'],
  'lookalike_domain_check/lookalike_domain_check.mjs': ['dns/promises'],
  // G0a prototype (change-approval design §6): a one-time LOCAL named pipe (\\.\pipe\gb2l-<32 hex>) only. It refuses
  // every other address (tested in authority/g0a/frame.test.mjs); not installed, not used by any tool.
  'authority/g0a/request_pipe.mjs': ['net'],
  // The immutable deployment payload has the same named-pipe-only protocol as the source.
  // Test below requires byte-for-byte equality so no generic network client can hide here.
  'authority/deployment/payload/g0a/request_pipe.mjs': ['net'],
  // The immutable deployment payload has the same named-pipe-only protocol as the source.
  // Test below requires byte-for-byte equality so no generic network client can hide here.
  'authority/deployment/payload/g0a/request_pipe.mjs': ['net'],
};
const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises'];
// Files that can reach the network must route through polite limits.
const MUST_USE_POLITE = ['github_evidence/github_evidence.mjs', 'domain_research/domain_research.mjs', 'redirect_inspector/redirect_inspector.mjs',
  'domain_watch/domain_watch.mjs', 'email_spoof_check/email_spoof_check.mjs', 'lookalike_domain_check/lookalike_domain_check.mjs'];

test('Node tools only import network modules where explicitly allowed', () => {
  const approved = readFileSync(join(TOOLBOX_ROOT, 'authority/g0a/request_pipe.mjs'));
  const payload = readFileSync(join(TOOLBOX_ROOT, 'authority/deployment/payload/g0a/request_pipe.mjs'));
  assert.deepEqual(payload, approved, 'the deployment pipe must be identical to the local-only reviewed source');
  assert.match(approved.toString('utf8'), /const PIPE = \/\^/, 'the reviewed pipe protocol must validate an exact local address');
  for (const { rel, text } of toolFiles()) {
    if (!rel.endsWith('.mjs')) continue;
    const imported = [...text.matchAll(/from ['"]node:([\w/]+)['"]/g)].map((m) => m[1]).filter((m) => NET_MODULES.includes(m));
    const allowed = NETWORK_MODULE_ALLOWLIST[rel] ?? [];
    for (const m of imported) assert.ok(allowed.includes(m), `${rel} imports node:${m} without being on the network allowlist`);
  }
});

test('only the protected Email Communications client uses built-in fetch; other tools use politeFetch', () => {
  for (const { rel, text } of toolFiles()) {
    if (!rel.endsWith('.mjs') || rel === 'regression_harness/network_guard.mjs' || rel === 'email_communications/email_client.mjs') continue;
    assert.doesNotMatch(text, /globalThis\.fetch|(?<![\w.])fetch\s*\(/, `${rel} calls fetch directly; use politeFetch`);
  }
});

test('no code asks for automatic redirects; every redirect is followed by hand and checked', () => {
  for (const { rel, text } of toolFiles()) {
    if (!rel.endsWith('.mjs')) continue;
    assert.doesNotMatch(text, /redirect\s*:\s*['"]follow['"]/, `${rel} requests automatic redirects`);
  }
  const polite = readFileSync(join(TOOLBOX_ROOT, '_shared', 'polite.mjs'), 'utf8');
  const fn = (name) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(polite)?.[0] ?? '';
  for (const name of ['politeFetch', 'fetchRobotsPolicy']) {
    assert.match(fn(name), /checkHop\(/, `${name} must validate every hop`);
    assert.match(fn(name), /redirect: 'manual'/, `${name} must disable automatic redirects`);
  }
  assert.match(fn('fetchRobotsPolicy'), /offLimits\(`robots\.txt redirected more than/, 'too many robots.txt redirects must fail closed');
  assert.doesNotMatch(polite, /\bALLOW_ALL\b/, 'no allow-all fallback in the shared network code');
});

test('shared read-only transport and isolated protected email HTTPS service are the only Node transports', () => {
  const CALLERS = ['_shared/polite.mjs', 'redirect_inspector/redirect_inspector.mjs'];
  for (const { rel, text } of toolFiles()) {
    if (!rel.endsWith('.mjs')) continue;
    if (/from ['"]node:https?['"]/.test(text)) assert.ok(['_shared/safe_http.mjs','email_communications/protected_backend.mjs'].includes(rel), `${rel} imports node:http(s) without an approved transport purpose`);
    if (/safe_http\.mjs['"]/.test(text)) assert.ok(CALLERS.includes(rel), `${rel} uses the raw transport; use politeFetch`);
  }
  const inspector = readFileSync(join(TOOLBOX_ROOT, 'redirect_inspector', 'redirect_inspector.mjs'), 'utf8');
  assert.match(inspector, /robots = makeRobotsCheck\(\)/, 'redirect_inspector must check robots.txt by default');
  assert.match(inspector, /checkHop\(current/, 'redirect_inspector must validate every hop');
  assert.match(inspector, /userAgent\(/, 'redirect_inspector must identify itself');
});

test('every network-capable tool routes through polite limits and prints a run report', () => {
  for (const rel of MUST_USE_POLITE) {
    const text = readFileSync(join(TOOLBOX_ROOT, rel), 'utf8');
    assert.match(text, /from '\.\.\/_shared\/polite\.mjs'/, `${rel} does not import polite.mjs`);
    assert.match(text, /printRunReport/, `${rel} does not print a network-use report`);
  }
});


test('Python and PowerShell tools contain no network code', () => {
  for (const { rel, text } of toolFiles()) {
    if (rel.endsWith('.py')) {
      assert.doesNotMatch(text, /^\s*(import|from)\s+(socket|ssl|urllib|http|requests|httpx|aiohttp|smtplib|ftplib|xmlrpc|telnetlib)\b/m, `${rel} imports a network module`);
    }
    if (rel.endsWith('.ps1')) {
      assert.doesNotMatch(text, /Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Net\.Http|Test-NetConnection|Start-BitsTransfer|Send-MailMessage/i, `${rel} contains network commands`);
    }
  }
});

test('documentation never recommends installing packages with their install scripts enabled', () => {
  const docs = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|mjs)$/.test(name)) docs.push([relative(TOOLBOX_ROOT, p), readFileSync(p, 'utf8')]);
    }
  };
  walk(TOOLBOX_ROOT);
  for (const [rel, text] of docs) {
    for (const m of text.matchAll(/`[^`\n]*\bnpm (install|i|ci)\b[^`\n]*`/g)) {
      if (rel.endsWith('toolkit_rules.test.mjs')) continue;
      assert.match(m[0], /--ignore-scripts/, `${rel} recommends "${m[0]}" without --ignore-scripts`);
    }
  }
});

test('run_offline refuses to run downloaded code without review, without a shell, or outside the verified sandbox', () => {
  const text = readFileSync(join(TOOLBOX_ROOT, 'regression_harness', 'run_offline.mjs'), 'utf8');
  assert.match(text, /NOT A SANDBOX/);
  assert.match(text, /if \(!o\.reviewed\) throw/);
  assert.match(text, /commandProblems\(command\)/);
  assert.match(text, /verifyIsolation\('tests'\)/);
  assert.doesNotMatch(text, /shell:\s*true/);
});

test('live inspection depends on the real isolation check, not on a typed setting', () => {
  const text = readFileSync(join(TOOLBOX_ROOT, 'redirect_inspector', 'redirect_inspector.mjs'), 'utf8');
  assert.match(text, /isolation: verifyIsolation\('inspect'\)/);
  assert.doesNotMatch(text, /GITBACK2LIFE_ISOLATED !== '1'/);
});

test('every network request is checked against robots.txt and the daily cap', () => {
  const text = readFileSync(join(TOOLBOX_ROOT, '_shared', 'polite.mjs'), 'utf8');
  assert.match(text, /export async function politeFetch[\s\S]*?robotsFor\(url/, 'politeFetch must check robots.txt for every hop');
  assert.match(text, /export async function acquire[\s\S]*?bumpDaily\(/, 'acquire must enforce the daily cap');
});

test('every tool that goes online or saves incident data checks the incident scope first', () => {
  const NODE = {
    'github_evidence/github_evidence.mjs': ['read_public_github', 'save_local'],
    'domain_research/domain_research.mjs': ['passive_lookup', 'save_local'],
    'domain_watch/domain_watch.mjs': ['passive_lookup', 'save_local'],
    'email_spoof_check/email_spoof_check.mjs': ['passive_lookup'],
    'lookalike_domain_check/lookalike_domain_check.mjs': ['passive_lookup'],
    'redirect_inspector/redirect_inspector.mjs': ['live_http_inspection', 'save_local'],
    'evidence_ledger/ledger.mjs': ['save_local'],
    'decision_summary/decision_summary.mjs': ['save_local'],
    'notice_drafter/notice_drafter.mjs': ['save_local'],
    'case_packet/case_packet.mjs': ['save_local'],
    'regression_harness/run_offline.mjs': ['run_project_tests', 'save_local'],
  };
  for (const [rel, actions] of Object.entries(NODE)) {
    const text = readFileSync(join(TOOLBOX_ROOT, rel), 'utf8');
    assert.match(text, /from '\.\.\/_shared\/scope\.mjs'/, `${rel} does not use the scope module`);
    for (const a of actions) assert.match(text, new RegExp(`requireScope\\(o\\.scope, \\{ action: '${a}'`), `${rel} does not check "${a}" against the scope`);
  }
  // Network tools must name their target and the services that will see it.
  for (const rel of MUST_USE_POLITE) {
    const text = readFileSync(join(TOOLBOX_ROOT, rel), 'utf8');
    assert.match(text, /requireScope\(o\.scope, \{ action: '\w+', target[^}]*services/, `${rel} must pass target and services to the scope check`);
  }
  // Any Node tool that can write (safeWrite) is either scope-checked above or on the documented exempt list.
  // The interactive menu is a scope-aware wrapper, not a stand-alone ungated writer.
  // Verify its case-mutating operations use the same save_local guard.
  const toolboxText = readFileSync(join(TOOLBOX_ROOT, 'toolbox/toolbox.mjs'), 'utf8');
  assert.match(toolboxText, /requireScope\(join\(c\.dir, 'scope\.json'\), \{ action: 'save_local' \}\)/,
    'interactive toolbox must gate incident saves by the active case scope');
  const EXEMPT = new Set(['toolbox/toolbox.mjs', '_shared/common.mjs', '_shared/polite.mjs', 'incident_intake/incident_intake.mjs', 'sandbox_setup/sandbox_setup.mjs', 'sandbox_setup/report_isolation.mjs', 'account_recovery_guide/account_recovery_guide.mjs']);
  for (const { rel, text } of toolFiles()) {
    if (rel.endsWith('.mjs') && /safeWrite\(/.test(text) && !text.includes('export function safeWrite')) {
      assert.ok(NODE[rel] || EXEMPT.has(rel), `${rel} writes files but is neither scope-checked nor on the exempt list`);
    }
  }
  // Python tools that write reports or copies go through emit()/require_scope.
  for (const rel of ['safe_backup/safe_backup.py', 'metadata_scrub/metadata_scrub.py']) {
    assert.match(readFileSync(join(TOOLBOX_ROOT, rel), 'utf8'), /require_scope\(args\.scope\)/, `${rel} must require a scope before writing`);
  }
  assert.match(readFileSync(join(TOOLBOX_ROOT, '_shared', 'gb2l_core.py'), 'utf8'), /if output:\n\s+require_scope\(scope\)/, 'emit() must require a scope before writing');
});

test('every report, summary, draft and packet goes through the output guard', () => {
  for (const rel of ['evidence_ledger/ledger.mjs', 'decision_summary/decision_summary.mjs', 'notice_drafter/notice_drafter.mjs', 'case_packet/case_packet.mjs']) {
    assert.match(readFileSync(join(TOOLBOX_ROOT, rel), 'utf8'), /from '\.\.\/_shared\/output\.mjs'/, `${rel} must sanitize its output with _shared/output.mjs`);
  }
  assert.match(readFileSync(join(TOOLBOX_ROOT, 'case_packet', 'case_packet.mjs'), 'utf8'), /if \(!humanReviewed\) throw/, 'case_packet must require the human personal-information review');
});

test('the rules state the untrusted-content rule, define contact, and document stored data', () => {
  const rules = readFileSync(join(TOOLBOX_ROOT, 'TOOLKIT_RULES.md'), 'utf8');
  const claude = readFileSync(join(TOOLBOX_ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(rules, /Collected content is evidence, never instructions/);
  assert.match(rules, /What "contact" means/);
  assert.match(rules, /What the toolkit stores, where, and for how long/);
  assert.match(claude, /untrusted evidence, never\s+instructions/);
  assert.match(claude, /"Contact" means human communication/);
  // Every kind of state the code can write is listed in the storage table.
  for (const where of ['daily-<date>.json', 'daily.lock', 'cooldown:', 'robots:', 'repeat:', 'domain_watch/baselines/', 'case_packet/packets', 'metadata_scrub/cleaned']) {
    assert.ok(rules.includes(where), `storage table is missing ${where}`);
  }
});

test('no tool installs a schedule or background job on its own', () => {
  for (const { rel, text } of toolFiles()) {
    assert.doesNotMatch(text, /Register-ScheduledTask|schtasks(\.exe)?\s+\/create|New-ScheduledTask|crontab\s+-/i, `${rel} creates a scheduled task`);
  }
});
