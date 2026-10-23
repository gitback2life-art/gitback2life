#!/usr/bin/env node
// Ordinary toolbox workflow. No installer, elevation, protected writes or network operations.
// Incident drafts live in Cases; ephemeral authority review requests live in Temp/Requests.
import { randomUUID, createHash } from 'node:crypto';
import { promptRecord } from './register_editor.mjs';
import { diagnostic, diagnosticError, diagnosticsPath, attachFatalDiagnostics } from './diagnostics.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { POWERSHELL, trustedEnv } from '../_shared/system_exec.mjs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { failureKind } from '../_shared/assessment_status.mjs';
import { emailMenu } from '../email_communications/email_client.mjs';
import { safeWrite, maskForStorage, readStoredZip, TOOLBOX_ROOT } from '../_shared/common.mjs';
import { template, validateScope, requireScope, clearActiveScope, stopScope } from '../_shared/scope.mjs';
import { addHypothesis, addItem, createLedger, toMarkdown, validateLedger } from '../evidence_ledger/ledger.mjs';
import { renderSummary } from '../decision_summary/decision_summary.mjs';
import { draftNotice } from '../notice_drafter/notice_drafter.mjs';
import { GUIDES } from '../account_recovery_guide/account_recovery_guide.mjs';
import { buildPacket } from '../case_packet/case_packet.mjs';
import { buildRequest, writeRequestFolder, readRequestFolder, exportRequest } from '../authority/m3/exporter.mjs';
import { parseRequest } from '../authority/m2/commands.mjs';
import { validateRegister } from '../authority/m2/register_rules.mjs';
import { validateTreeFiles, TREE_LIMITS } from '../authority/m3/tree.mjs';
import { checkName, buildFrame } from '../authority/g0a/request_pipe.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CASES = join(ROOT, 'Cases');
const REQUESTS = join(ROOT, 'Temp', 'Requests');
const CASE_ID = /^[A-Za-z0-9_-]{1,60}$/;
const REV = /^ledger_(\d{4})\.json$/;
const KIND_KEY = Object.freeze({ service: 'registers/services.json', data: 'registers/personal_data.json', access: 'registers/access.json' });

function refuse(msg) { throw new Error(msg); }
attachFatalDiagnostics();
function runPython(script, args, { report = false, timeoutMs = 30_000 } = {}) {
  // Fixed bundled scripts and positional arrays: no shell, no copied command strings, no elevation.
  const file = join(ROOT, script);
  const candidates = process.platform === 'win32' ? [['py', ['-3', '-I']], ['python', ['-I']]] : [['python3', ['-I']], ['python', ['-I']]];
  for (const [exe, flags] of candidates) {
    const r = spawnSync(exe, [...flags, file, ...args], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 2 * 1024 * 1024, shell: false });
    if (r.error?.code === 'ENOENT') continue;
    diagnostic('PYTHON_TOOL', `${script} exit=${r.status ?? 'not-started'}${r.error ? ' spawn-failed' : ''}`);
    if (r.error) refuse(`${script}: ${r.error.message}`);
    if (r.status !== 0) {
      // Existing Python report tools use 1=fail finding and 3=unresolved finding.
      // Those are completed reports, not execution errors; keep the findings visible.
      let result = null;
      if (report && [1, 3].includes(r.status)) {
        try { result = JSON.parse(r.stdout); } catch { /* not a valid report */ }
      }
      if (!result || result.result !== (r.status === 1 ? 'fail' : 'unresolved')) {
        refuse(`${script} refused (${r.status}): ${r.stderr || r.stdout}`);
      }
    }
    return r.stdout;
  }
  refuse('Python 3.10+ is required for this existing Python tool');
}
export function registerReport(kind, inputPath, asOf = new Date().toISOString().slice(0, 10)) {
  if (!Object.hasOwn(KIND_KEY, kind)) refuse('unknown register kind');
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!dateParts) refuse('as-of must be a real YYYY-MM-DD calendar date');
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]));
  if (date.toISOString().slice(0, 10) !== asOf || Number(dateParts[1]) < 1)
    refuse('as-of must be a real YYYY-MM-DD calendar date');
  const input = ensureInside(inputPath);
  safeRead(input);
  return kind === 'access'
    ? runPython('access_offboarding/access_offboarding.py', ['report', '--register', input, '--as-of', asOf], { report: true })
    : runPython('org_registers/org_registers.py', ['report', '--kind', kind, '--register', input, '--as-of', asOf], { report: true });
}
export function scanSourceFolder(folder) {
  const input = ensureInside(folder);
  if (!lstatSync(input).isDirectory()) refuse('scan source must be a directory');
  return runPython('code_flow_scan/code_flow_scan.py', ['discover', '--root', input]);
}
export function scanSourceConfig(configPath) {
  const input = ensureInside(configPath);
  safeRead(input);
  return runPython('code_flow_scan/code_flow_scan.py', ['scan', '--input', input], { report: true });
}
export function dependencyReport(configPath) {
  const input = ensureInside(configPath);
  safeRead(input);
  return runPython('dependency_inventory/dependency_inventory.py', ['--input', input], { report: true });
}
export function cleanImageCopies(incidentId, sourcePath) {
  const c = currentCase(incidentId);
  const input = ensureInside(sourcePath);
  if (!lstatSync(input).isFile() && !lstatSync(input).isDirectory()) refuse('select an ordinary file or folder');
  // This existing utility writes only new scrubbed copies, never modifies originals.
  return runPython('metadata_scrub/metadata_scrub.py', [input, '--scope', join(c.dir, 'scope.json')]);
}
// Only verified, current role labels from an existing access register are offered
// to a nontechnical operator. This is a read-only preview, never an edit.
export function listCurrentAccessRoles(inputPath) {
  const input = ensureInside(inputPath);
  const doc = json(input);
  validateRegister('access', doc);
  const roles = [...new Set(doc.records.filter(r => r.state !== 'removed').map(r => r.role))]
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (roles.length > 1000) refuse('access register has too many roles to display');
  return roles.map(role => ({
    role,
    systems: [...new Set(doc.records.filter(r => r.role === role && r.state !== 'removed').map(r => r.system))]
      .sort((a, b) => a.localeCompare(b, 'en')),
  }));
}
export function offboardingChecklist(inputPath, role) {
  const input = ensureInside(inputPath);
  safeRead(input);
  if (!role || role.length > 160) refuse('role name required');
  return runPython('access_offboarding/access_offboarding.py', ['offboard', '--register', input, '--role', role]);
}
export function timelineReport(inputPath) {
  const input = ensureInside(inputPath);
  safeRead(input);
  return runPython('incident_timeline/incident_timeline.py', ['--input', input], { report: true });
}
// Original approved device_check utility: read-only Windows security posture.
// A fail or unresolved status is a *completed report*, not a crashed subprocess.
// Use the pre-existing fixed system executable and constructed environment.
export function deviceStatus() {
  if (process.platform !== 'win32') refuse('device-status is available on Windows only');
  const script = join(ROOT, 'device_check', 'check_device.ps1');
  if (!existsSync(POWERSHELL) || !existsSync(script)) refuse('Windows PowerShell or bundled device check is missing');
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script], { cwd: ROOT, env: trustedEnv(), shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 45_000, maxBuffer: 256 * 1024 });
  diagnostic('DEVICE_STATUS', `completed=${[0, 1, 3].includes(r.status)} exit=${r.status ?? 'not-started'}`);
  if (r.error) refuse(`device status could not run (${r.error.code || 'process error'})`);
  if (![0, 1, 3].includes(r.status)) refuse(`device status did not complete (exit ${r.status}); check the diagnostic log`);
  let report;
  try { report = JSON.parse(r.stdout); } catch { refuse('device status did not return a valid JSON report'); }
  const statusForExit = {0: 'pass', 1: 'fail', 3: 'unresolved'};
  if (report.tool !== 'device' || report.environment !== 'local_device' ||
      report.result !== statusForExit[r.status] || !Array.isArray(report.checks))
    refuse('device status report structure does not match its exit status');
  return report;
}
// Client report is supplied by the organization; never connects to or changes its PC.
// The bounded Python ZIP reader does not extract files, run commands, or trust client identity.
export function reviewClientDeviceReport(archivePath) {
  const selected = resolve(String(archivePath || '').trim().replace(/^"|"$/g, ''));
  if (!selected.toLowerCase().endsWith('.zip')) refuse('select the ZIP provided by the client');
  return runPython('device_check/review_client_report.py', [selected], { timeoutMs: 20_000 });
}
export function backupPreview(selectionPath) {
  const input = ensureInside(selectionPath);
  safeRead(input);
  return runPython('safe_backup/safe_backup.py', ['preview', '--input', input], { report: true });
}
// Prepare the existing backup tool's selection without requiring a person to
// hand-write JSON. This only saves selection metadata and returns a preview;
// a separate human BACKUP confirmation is still required for any local copy.
export function prepareBackupSelection(sourceFolder, filePaths, sourceVersion) {
  const root = ensureInside(sourceFolder);
  if (!lstatSync(root).isDirectory()) refuse('choose an ordinary source folder');
  if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 1000)
    refuse('choose 1-1000 explicit files; no backup was started');
  if (typeof sourceVersion !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(sourceVersion))
    refuse('enter a short source version or date label');
  let total = 0;
  const files = [], seen = new Set();
  for (const name of filePaths) {
    const file = ensureInside(name);
    const rel = relative(root, file);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
      refuse('backup file is not within the selected source folder');
    const normalized = rel.split(sep).join('/');
    if (seen.has(normalized.toLowerCase())) refuse('backup selection lists the same file twice');
    seen.add(normalized.toLowerCase());
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) refuse('choose only ordinary source files');
    if (st.size > 10_000_000) refuse('backup file exceeds the existing 10 MB limit');
    total += st.size;
    if (total > 100_000_000) refuse('backup selection exceeds the existing 100 MB limit');
    files.push(normalized);
  }
  const config = { root, files, exclude: [], source_version: sourceVersion };
  const file = join(ROOT, 'Temp', 'Backups', `selection_${randomUUID()}.json`);
  safeWrite(file, JSON.stringify(config, null, 2) + '\n');
  // The original safe_backup tool checks sensitive names and other constraints.
  const preview = JSON.parse(backupPreview(file));
  return { selection: file, preview };
}
// Read-only discovery for people who know their source folder but not every
// filename. Nothing is selected automatically: an explicit numbered selection
// and the existing preview/BACKUP confirmation remain mandatory.
export function discoverBackupCandidates(sourceFolder) {
  const root = ensureInside(sourceFolder);
  if (!lstatSync(root).isDirectory()) refuse('choose an ordinary source folder');
  const candidates = [];
  let examined = 0;
  const ignoredDirs = new Set(['.git', '.test_tmp', 'node_modules', '__pycache__', '.venv', 'venv']);
  const ignoredNames = /^(?:\.env(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|.*\.(?:pem|p12|pfx|key|sqlite|db))$/i;
  // Numbered discovery should not browse internal incident histories, logs,
  // authority or protected register files. An explicitly supplied existing
  // selection uses the original backup tool's own approval checks instead.
  for (const protectedFolder of [CASES, join(ROOT, 'Temp', 'Logs'), join(ROOT, 'Temp', 'Requests'), join(ROOT, 'authority'), join(ROOT, 'registers')]) {
    const rel = relative(protectedFolder, root);
    if (!rel || rel === '.' || rel !== '..' && !rel.startsWith(`..${sep}`))
      refuse('choose an ordinary source folder outside internal case, log and protected files');
  }
  const walk = (dir, depth = 0) => {
    if (depth > 12) refuse('source folder is too deeply nested; choose a smaller folder');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++examined > 5000) refuse('too many source entries; choose a smaller source folder');
      if (entry.isSymbolicLink() || ignoredNames.test(entry.name)) continue;
      const file = ensureInside(join(dir, entry.name));
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name.toLowerCase())) walk(file, depth + 1);
      } else if (entry.isFile()) {
        const st = lstatSync(file);
        if (st.nlink !== 1 || st.size > 10_000_000) continue;
        const rel = relative(root, file).split(sep).join('/');
        // Do not offer obviously private or unrelated files. The original
        // safe_backup preview makes the final authoritative allow/deny check.
        if (/(?:^|\/)(?:donors?|contacts?|secrets?|credentials?|private|keys?)(?:\/|$)/i.test(rel)) continue;
        if (candidates.length >= 1000) refuse('over 1000 candidate files; choose a smaller source folder');
        candidates.push({ relativePath: rel, bytes: st.size, fullPath: file });
      }
    }
  };
  walk(root);
  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
  return candidates;
}
export function selectBackupCandidateNumbers(candidates, value) {
  if (!Array.isArray(candidates) || !candidates.length || typeof value !== 'string' || value.length > 5000)
    refuse('no candidate files or invalid selection');
  const selected = [], seen = new Set();
  const parts = value.trim().split(',').map(s => s.trim());
  if (!parts.length || parts.some(s => !/^\d{1,4}(?:\s*-\s*\d{1,4})?$/.test(s)))
    refuse('enter file numbers separated by commas, such as 1,3-5');
  for (const part of parts) {
    const [a, b = a] = part.split(/\s*-\s*/).map(Number);
    if (!a || a > b || b > candidates.length) refuse('file number is not in the displayed list');
    for (let n = a; n <= b; n++) {
      if (seen.has(n)) refuse('a file number was selected more than once');
      seen.add(n);
      if (selected.length >= 1000) refuse('select no more than 1000 files');
      selected.push(candidates[n - 1].fullPath);
    }
  }
  return selected;
}
// Explicit reviewed backup: the operator inspects the preview before triggering
// this call. The original backup utility hashes again and refuses changed source
// bytes; output is a new folder under the project's existing Temp directory.
export function createReviewedBackup(id, selectionPath, manifest) {
  const c = currentCase(id);
  const selectedFile = ensureInside(selectionPath);
  const selectedText = safeRead(selectedFile);
  const selectedConfig = JSON.parse(selectedText);
  if (!selectedConfig || !Array.isArray(selectedConfig.files)) refuse('invalid backup selection');
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
    refuse('reviewed backup manifest is missing or invalid');
  const dir = join(ROOT, 'Temp', 'Backups');
  const marker = `backup_${id}_${randomUUID()}`;
  const manifestFile = join(dir, `${marker}.manifest.json`);
  const destination = join(dir, marker);
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  if (maskForStorage(manifestText) !== manifestText) refuse('manifest includes private material; no backup started');
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
    safeWrite(manifestFile, manifestText);
    const result = runPython('safe_backup/safe_backup.py', ['backup', '--input', selectedFile,
      '--reviewed-manifest', manifestFile, '--destination', destination, '--scope', join(c.dir, 'scope.json')],
    { timeoutMs: 120_000 });
    return { destination, reviewedManifest: manifestFile, report: JSON.parse(result),
      note: 'LOCAL COPY ONLY: originals untouched; restore is not performed' };
  } finally { clearActiveScope(); }
}
// These are existing, offline-only utilities. Run the bundled executable directly;
// no shell, external executable, network target or caller-supplied command switches.
function runOfflineNode(script, args) {
  const file = join(ROOT, script);
  const result = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false,
    env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' } });
  diagnostic('OFFLINE_TOOL', `${script} exit=${result.status ?? 'not-started'}`);
  if (result.error) refuse(`${script}: ${result.error.message}`);
  if (result.status !== 0) refuse(`${script} refused (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trimEnd();
}
export function emailHeaderReview(inputPath, expectedDomain = '') {
  const path = ensureInside(inputPath);
  if (!/\.eml$/i.test(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
    refuse('select an ordinary .eml file inside the toolbox');
  if (lstatSync(path).size > 10 * 1024 * 1024) refuse('email file exceeds 10 MB');
  if (expectedDomain && !/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(expectedDomain))
    refuse('expected domain must be a plain domain name');
  return runOfflineNode('email_header_triage/email_header_triage.mjs',
    [path, ...(expectedDomain ? ['--expected', expectedDomain] : [])]);
}
// Present the existing offline provider guides by number, with no search,
// login, provider contact or added recovery steps. The source is the bundled
// static guide inventory used by the original recovery utility.
export function listRecoveryProviders() {
  const entries = Object.entries(GUIDES.providers ?? {});
  if (entries.length > 100 || entries.some(([key, guide]) =>
      !/^[a-z0-9_-]{1,64}$/.test(key) || !guide ||
      typeof guide.name !== 'string' || guide.name.length > 100))
    refuse('bundled provider guide inventory is invalid');
  return entries.map(([key, guide]) => ({ key, name: guide.name }));
}
export function selectRecoveryProvider(listed, value) {
  if (!Array.isArray(listed) || typeof value !== 'string') refuse('invalid recovery guide choice');
  if (!value.trim() || value.toLowerCase() === 'general' || value === '0') return '';
  const numbered = /^#?([1-9][0-9]*)$/.exec(value);
  if (numbered) {
    const found = listed[Number(numbered[1]) - 1];
    if (!found?.key) refuse('choose a displayed provider number or 0 for general guidance');
    return found.key;
  }
  const item = listed.find(i => i.key === value.toLowerCase());
  if (!item) refuse('choose an existing bundled provider name or number');
  return item.key;
}
export function recoveryGuide(provider = '') {
  // Only a printable guide; never start account recovery or connect to a provider.
  if (typeof provider !== 'string' || (provider && !/^[a-z0-9_-]{1,64}$/.test(provider)))
    refuse('provider must be a plain guide name');
  return runOfflineNode('account_recovery_guide/account_recovery_guide.mjs',
    provider === 'list' ? ['list'] : provider ? ['show', provider] : ['general']);
}
export function listLookalikeCandidates(domain) {
  if (typeof domain !== 'string' || !/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain))
    refuse('enter a plain domain name');
  // This prints candidate names only. Never the network-enabled 'check' command.
  return runOfflineNode('lookalike_domain_check/lookalike_domain_check.mjs', ['list', domain]);
}
// Directory audit remains offline and read-only. The optional audit settings
// are exactly the pre-existing directory tool's options; never expose
// --show-values (which could print emails and phone numbers to a console log).
export function directoryAudit(inputPath, options = {}) {
  const path = ensureInside(inputPath), st = lstatSync(path);
  if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) refuse('select a local directory or JSON file');
  if (st.isDirectory()) {
    const names = readdirSync(path).filter(name => /\.json$/i.test(name));
    if (names.length > 5000) refuse('directory exceeds the original 5000-record limit');
    for (const name of names) {
      const entry = ensureInside(join(path, name));
      const info = lstatSync(entry);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 20 * 1024 * 1024)
        refuse('directory contains a link or oversized JSON entry');
    }
  } else if (!/\.json$/i.test(path) || st.nlink !== 1 || st.size > 20 * 1024 * 1024) {
    refuse('choose an ordinary JSON file up to 20 MB');
  }
  const { required = [], staleDays = 180, country = 'US' } = options ?? {};
  if (!Array.isArray(required) || required.length > 12 ||
      required.some(v => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.\[\]]{0,79}$/.test(v)) ||
      new Set(required).size !== required.length) refuse('required fields must be up to 12 unique field names');
  if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 3650)
    refuse('stale days must be a whole number from 1 through 3650');
  if (!['US', 'other'].includes(country)) refuse('choose US or other phone number rules');
  return runOfflineNode('directory_record_audit/directory_record_audit.mjs',
    [path, '--stale-days', String(staleDays), '--country', country, '--max', '100',
      ...(required.length ? ['--require', required.join(',')] : [])]);
}
export function offlineUrlCheck(url) {
  if (!/^https?:\/\//i.test(url ?? '') || url.length > 2048) refuse('enter a full HTTP(S) URL');
  // Never invoke the live 'inspect' mode here; this only checks URL syntax and safety.
  return runOfflineNode('redirect_inspector/redirect_inspector.mjs', ['check-url', url]);
}
export function scanDisclosure(configPath) {
  const input = ensureInside(configPath);
  safeRead(input);
  return runPython('code_flow_scan/code_flow_scan.py', ['disclosure', '--input', input], { report: true });
}
// One guided path from source discovery to a reviewed local config and both existing
// static reports. Nothing in the scanned source is modified and no network is used.
export function discoverScanSelection(folder) {
  const path = ensureInside(folder);
  if (!lstatSync(path).isDirectory()) refuse('choose an ordinary source folder');
  const selection = JSON.parse(runPython('code_flow_scan/code_flow_scan.py', ['discover', '--root', path]));
  if (!Array.isArray(selection.files) || selection.files.length === 0) refuse('no supported source files found');
  if (resolve(selection.root) !== path) refuse('discovery returned a different source folder');
  // Capture a bounded content fingerprint when the files are proposed for review.
  // Prevent a later static report from accidentally describing different bytes.
  selection.fingerprints = fingerprintScanSelection(path, selection.files);
  return selection;
}
function fingerprintScanSelection(root, names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 2000 ||
      new Set(names).size !== names.length) refuse('source selection contains duplicate or missing files');
  const fingerprints = [];
  let total = 0;
  for (const name of names) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') ||
        name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..'))
      refuse('source selection contains an unsafe path');
    const path = ensureInside(join(root, ...name.split('/')));
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) refuse('source selection escaped reviewed folder');
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1_000_000)
      refuse('reviewed source contains a link or oversized/nonordinary file');
    total += st.size;
    if (total > 20_000_000) refuse('reviewed source is larger than static scan budget');
    const bytes = readFileSync(path);
    if (bytes.length !== st.size) refuse('reviewed source changed while reading');
    fingerprints.push({ file: name, size: st.size, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return fingerprints;
}
function verifyScanFingerprint(selection, root) {
  if (!Array.isArray(selection.fingerprints) || selection.fingerprints.length !== selection.files.length)
    refuse('reviewed source fingerprint missing; rediscover and review the file list');
  const actual = fingerprintScanSelection(root, selection.files);
  if (actual.some((item, i) => item.file !== selection.fingerprints[i]?.file ||
      item.size !== selection.fingerprints[i]?.size || item.sha256 !== selection.fingerprints[i]?.sha256))
    refuse('source files changed since review; rediscover and review the updated files');
}
export function scanReviewedSelection(selection, reviewedVersion) {
  if (!selection || !Array.isArray(selection.files) || selection.files.length === 0 || selection.files.length > 2000)
    refuse('invalid or empty scan selection');
  const root = ensureInside(selection.root);
  if (!lstatSync(root).isDirectory()) refuse('scan root is not a folder');
  if (new Set(selection.files).size !== selection.files.length ||
      selection.files.some(name => typeof name !== 'string' || !name || name.includes('\\') ||
        name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || !part)))
    refuse('scan selection has duplicate or unsafe file names; review the source again');
  if (typeof reviewedVersion !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(reviewedVersion))
    refuse('source version must be a short label, tag or commit ID');
  verifyScanFingerprint(selection, root);
  const config = { root, files: selection.files, source_version: reviewedVersion };
  // Save only the selection metadata, inside the designated temporary workspace.
  const dir = join(ROOT, 'Temp', 'Scans');
  const file = join(dir, `scan_${randomUUID()}.json`);
  safeWrite(file, JSON.stringify(config, null, 2) + '\n');
  const contentFlow = scanSourceConfig(file);
  const disclosure = scanDisclosure(file);
  // If the code changed during the two independent scans, refuse a misleading
  // combined result. The original source is left untouched; no verdict implied.
  verifyScanFingerprint(selection, root);
  return { config: file, sourceFiles: config.files.length, contentFlow, disclosure };
}
// Existing dependency_inventory utility, with a guided, read-only input path.
// Both npm inputs are fixed filenames under one reviewed folder: no package
// installation, network lookup, advisory fetch, or arbitrary command invocation.
function dependencyInputHashes(root) {
  const result = [];
  for (const name of ['package.json', 'package-lock.json']) {
    const file = ensureInside(join(root, name));
    const sizeLimit = name === 'package-lock.json' ? 20_000_000 : 2_000_000;
    const bytes = safeReadBytes(file, sizeLimit);
    result.push({ file: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return result;
}
export function reviewLocalDependencies(folder, sourceVersion) {
  const root = ensureInside(folder);
  if (!lstatSync(root).isDirectory()) refuse('select a local npm project folder');
  if (typeof sourceVersion !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(sourceVersion))
    refuse('enter a short source version, snapshot date or commit label');
  const inputs = dependencyInputHashes(root);
  let manifest, lock;
  try {
    manifest = JSON.parse(safeRead(join(root, 'package.json'), 2_000_000));
    lock = JSON.parse(safeRead(join(root, 'package-lock.json'), 20_000_000));
  } catch { refuse('package.json and package-lock.json must both be valid JSON files'); }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' ||
      !lock || Array.isArray(lock) || ![2, 3].includes(lock.lockfileVersion) ||
      !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages))
    refuse('select an npm project with package.json and npm lockfile version 2 or 3');
  if (manifest.name && lock.name && manifest.name !== lock.name)
    refuse('npm manifest and lockfile name a different project; no report was produced');
  const config = { root, manifest: 'package.json', lockfile: 'package-lock.json', source_version: sourceVersion };
  const destination = join(ROOT, 'Temp', 'Dependencies', `dependencies_${randomUUID()}.json`);
  safeWrite(destination, JSON.stringify(config, null, 2) + '\n');
  const report = dependencyReport(destination);
  const after = dependencyInputHashes(root);
  if (after.some((item, i) => item.file !== inputs[i].file || item.size !== inputs[i].size || item.sha256 !== inputs[i].sha256))
    refuse('npm manifest or lockfile changed during review; no current dependency conclusion is available');
  let result;
  try { result = JSON.parse(report); } catch { refuse('dependency inventory returned an unreadable report'); }
  if (result.tool !== 'dependencies' || !Array.isArray(result.inventory) || !Array.isArray(result.findings))
    refuse('dependency inventory returned a report in an unexpected format');
  const text = JSON.stringify(result, null, 2) + '\n';
  if (maskForStorage(text) !== text)
    refuse('dependency report includes private-looking material; no detailed report was saved');
  const reportFile = join(ROOT, 'Temp', 'Dependencies', `report_${randomUUID()}.json`);
  safeWrite(reportFile, text);
  return { config: destination, reportFile, sourceFiles: inputs, report,
    count: result.inventory.length, unknownLicenses: result.findings.filter(v => v.unknown_license).length,
    note: 'OFFLINE INVENTORY ONLY; no advisories retrieved, packages installed or source files modified' };
}
function ensureInside(path) {
  // Windows Explorer / File Properties often supply a quoted absolute path.
  // Accept one matching pair of quotes; never trim or reinterpret internal characters.
  if (typeof path !== 'string' || !path.trim()) refuse('select a file or folder inside the toolbox');
  let selected = path.trim();
  if (selected.startsWith('"') && selected.endsWith('"') && selected.length > 2)
    selected = selected.slice(1, -1);
  const full = resolve(selected), rel = relative(ROOT, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) refuse('file must be inside the toolbox');
  let part = ROOT;
  for (const segment of rel.split(sep)) {
    part = join(part, segment);
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) refuse(`refusing a linked path: ${part}`);
  }
  return full;
}
function safeReadBytes(path, maxBytes = 1024 * 1024) {
  const full = ensureInside(path), st = lstatSync(full);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maxBytes) refuse(`not an ordinary bounded file: ${basename(full)}`);
  const bytes = readFileSync(full);
  if (bytes.length !== st.size) refuse('file changed while reading');
  return bytes;
}
function safeRead(path, maxBytes) {
  const bytes = safeReadBytes(path, maxBytes);
  if (bytes.includes(0)) refuse('text input contains NUL');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function json(path, maxBytes) { return JSON.parse(safeRead(path, maxBytes)); }
function idPath(id) {
  if (!CASE_ID.test(id ?? '')) refuse('case ID: use 1-60 letters, numbers, underscores or hyphens');
  return join(CASES, id);
}
function revisions(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).map((f) => ({ file: f, match: REV.exec(f) }))
    .filter((x) => x.match).map((x) => ({ file: x.file, n: +x.match[1] }));
  return files.sort((a, b) => a.n - b.n);
}
// Every toolbox save is a single immutable revision. Validate the ordered
// snapshots, not only the latest filename, so later work cannot silently rely
// on an edited/removed older evidence item or review decision. This checks
// *consistency*, not cryptographic authorship (a rewritten entire chain would
// still require an independent owner backup to detect).
const LEDGER_ARRAYS = ['checked', 'not_checked', 'items', 'hypotheses'];
function verifyLedgerTransition(previous, next) {
  if (previous.incident_id !== next.incident_id || previous.schema !== next.schema ||
      previous.created_at !== next.created_at ||
      !isDeepStrictEqual(Object.keys(previous).sort(), Object.keys(next).sort()))
    refuse('ledger revision changed case identity or immutable metadata; preserve the history for review');
  let changes = 0;
  for (const key of LEDGER_ARRAYS) {
    const before = previous[key], after = next[key];
    if (!Array.isArray(before) || !Array.isArray(after) || after.length < before.length ||
        after.length > before.length + 1 || !isDeepStrictEqual(after.slice(0, before.length), before))
      refuse(`ledger history edited or removed previous ${key}; preserve all revisions for review`);
    if (after.length > before.length) changes++;
  }
  for (const key of ['risk', 'next_step', 'verdicts']) {
    if (!isDeepStrictEqual(previous[key], next[key])) {
      if (key === 'verdicts' && (Object.keys(previous.verdicts).some(k => !Object.hasOwn(next.verdicts, k)) ||
          Object.keys(next.verdicts).filter(k => !isDeepStrictEqual(previous.verdicts[k], next.verdicts[k])).length !== 1))
        refuse('ledger history changed multiple verdicts or removed a verdict');
      changes++;
    }
  }
  if (changes > 1) refuse('ledger revision combined unrelated edits; preserve the history for review');
  // Additional immutable schema fields may be present in an older case. They
  // must not be modified by a review operation.
  for (const key of Object.keys(previous)) {
    if (![...LEDGER_ARRAYS, 'risk', 'next_step', 'verdicts'].includes(key) &&
        !isDeepStrictEqual(previous[key], next[key]))
      refuse('ledger revision modified historical metadata; preserve the history for review');
  }
}
function currentCase(id, { verifyHistory = true } = {}) {
  const dir = idPath(id);
  const scope = json(join(dir, 'scope.json'));
  const errors = validateScope(scope);
  if (errors.length) refuse(`invalid scope: ${errors.join('; ')}`);
  if (scope.incident_id !== id) refuse('case scope ID does not match folder');
  const revs = revisions(dir), latest = revs.at(-1);
  if (!latest) refuse('case has no ledger revision');
  if (revs.some((entry, index) => entry.n !== index))
    refuse('case ledger revision history has a missing number; preserve the files and review the case before editing');
  let ledger = null, previous = null;
  // Listing many case names is a read-only convenience, not a history audit;
  // full continuity verification occurs before every edit/export and in T.
  for (const entry of verifyHistory ? revs : [latest]) {
    ledger = json(join(dir, entry.file));
    if (ledger.incident_id !== id) refuse('ledger belongs to a different case');
    const problems = validateLedger(ledger);
    if (problems.length) refuse(`invalid ledger revision: ${problems.join('; ')}`);
    if (previous) verifyLedgerTransition(previous, ledger);
    else if (verifyHistory && entry.n === 0 &&
        (LEDGER_ARRAYS.some(key => ledger[key].length !== 0) ||
         ledger.risk !== '' || !isDeepStrictEqual(ledger.next_step, { action: '', permission_needed: '' }) ||
         Object.keys(ledger.verdicts ?? {}).length !== 0))
      refuse('original ledger revision was not an empty incident; preserve the history for review');
    previous = ledger;
  }
  return { dir, scope, ledger, revision: latest.n };
}
function nextRevision(c, ledger) {
  if (c.revision >= 9999) refuse('revision limit reached');
  const file = join(c.dir, `ledger_${String(c.revision + 1).padStart(4, '0')}.json`);
  // The storage guard would mask contact/secret-shaped input. Do not silently
  // change evidence references in a revision and leave it unusable on reload.
  const content = JSON.stringify(ledger, null, 2) + '\n';
  if (maskForStorage(content) !== content)
    refuse('entry contains a contact or secret-shaped value; replace it with a neutral source reference before saving');
  safeWrite(file, content);
  return file;
}
export function newCase(id, target, question) {
  clearActiveScope(); // do not inherit the previous incident's authorization inside the long-running menu
  const dir = idPath(id);
  if (!target || !question?.trim() || question.length > 500) refuse('target and a short question are required');
  if (existsSync(dir)) refuse(`case ${id} already exists; nothing overwritten`);
  const s = template();
  Object.assign(s, { incident_id: id, targets: [target], question, scope: `Offline review of ${target}; no external writes or publication.`,
    stopping_condition: 'Stop after review and a documented decision.',
    persistence: 'local', disclosures: [], permissions: Object.fromEntries(Object.keys(s.permissions).map((k) => [k, k === 'save_local'])) });
  const errors = validateScope(s);
  if (errors.length) refuse(`invalid case input: ${errors.join('; ')}`);
  // Validate content before any first-write: silent masking could change a
  // target and invalidate the saved scope; never create a partial incident.
  const scopeText = JSON.stringify(s, null, 2) + '\n';
  const ledgerText = JSON.stringify(createLedger(id), null, 2) + '\n';
  if (maskForStorage(scopeText) !== scopeText || maskForStorage(ledgerText) !== ledgerText)
    refuse('incident details contain contact or secret-shaped text; use an ordinary public target and short neutral question');
  // Scope is created first; if a disk failure prevents the ledger save, leave
  // the incomplete folder visible so it cannot be mistaken for a valid case.
  safeWrite(join(dir, 'scope.json'), scopeText);
  safeWrite(join(dir, 'ledger_0000.json'), ledgerText);
  return dir;
}
export function appendEvidence(id, text, source, observed = false) {
  const c = currentCase(id);
  if (!text?.trim() || text.length > 4000 || !source?.trim() || source.length > 500) refuse('short text and source are required');
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
  const item = observed
    ? { label: 'confirmed_observation', text, source_url: source, retrieved_at: new Date().toISOString(), signal: 'none' }
    : { label: 'source_report', text, source_ref: source, signal: 'none' };
  addItem(c.ledger, item);
  const problems = validateLedger(c.ledger);
  if (problems.length) refuse(`ledger refused: ${problems.join('; ')}`);
  return nextRevision(c, c.ledger);
  } finally { clearActiveScope(); }
}
// Finish the six-part incident review using immutable ledger revisions. The earlier
// menu could capture only reports and observations, leaving the checked/unknown,
// explanations, risk and next-step sections of the exported summary permanently blank.
function shortReviewText(value, label, max = 600) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) refuse(`${label} must be 1-${max} characters`);
  const clean = value.trim();
  if (maskForStorage(clean) !== clean) refuse(`${label} includes contact- or secret-shaped content; use an evidence reference`);
  return clean;
}
function saveCaseReview(id, change) {
  const c = currentCase(id);
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
    change(c.ledger);
    const errors = validateLedger(c.ledger);
    if (errors.length) refuse(`review update refused: ${errors.join('; ')}`);
    return nextRevision(c, c.ledger);
  } finally { clearActiveScope(); }
}
export function recordReviewCheck(id, category, description) {
  if (!['checked', 'not_checked'].includes(category)) refuse('choose checked or not_checked');
  const text = shortReviewText(description, 'review item');
  return saveCaseReview(id, ledger => {
    if (ledger[category].includes(text)) refuse('review item already recorded');
    ledger[category].push(text);
  });
}
export function recordRisk(id, assessment) {
  const risk = shortReviewText(assessment, 'risk assessment', 1500);
  return saveCaseReview(id, ledger => { ledger.risk = risk; });
}
export function recordNextStep(id, action, permissionNeeded) {
  const next = { action: shortReviewText(action, 'proposed action', 800),
    permission_needed: shortReviewText(permissionNeeded, 'permission requirement', 500) };
  return saveCaseReview(id, ledger => { ledger.next_step = next; });
}
function evidenceReferences(ledger, text, label) {
  const refs = text ? text.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (refs.length > 20 || new Set(refs).size !== refs.length) refuse(`${label}: use up to 20 distinct evidence IDs`);
  for (const ref of refs) if (!ledger.items.some(item => item.id === ref)) refuse(`${label}: evidence ID ${ref} was not recorded in this case`);
  return refs;
}
export function recordHypothesis(id, statement, forIds = '', againstIds = '') {
  const text = shortReviewText(statement, 'hypothesis', 1000);
  return saveCaseReview(id, ledger => {
    const supporting = evidenceReferences(ledger, forIds, 'supporting'), against = evidenceReferences(ledger, againstIds, 'against');
    const number = ledger.hypotheses.length + 1;
    addHypothesis(ledger, { id: `H${number}`, statement: text, supporting, against, status: 'open' });
  });
}
export function recordAnalysis(id, label, description, basis = '') {
  if (!['inference', 'recommendation', 'decision'].includes(label)) refuse('choose inference, recommendation or decision');
  const text = shortReviewText(description, 'analysis note', 1000);
  return saveCaseReview(id, ledger => {
    const refs = evidenceReferences(ledger, basis, 'supporting evidence');
    addItem(ledger, { label, text, ...(refs.length ? { source_ref: refs.join(', ') } : {}) });
  });
}
export function caseEvidence(id) {
  const c = currentCase(id);
  return { case: id, revision: c.revision, items: c.ledger.items.map(i => ({ id: i.id, label: i.label,
    text: i.text, source: i.source_ref ?? i.source_url ?? '(unspecified)',
    retrievedAt: i.retrieved_at ?? '(not directly observed)' })),
    checked: c.ledger.checked, notChecked: c.ledger.not_checked,
    hypotheses: c.ledger.hypotheses, risk: c.ledger.risk || '(not assessed)',
    nextStep: c.ledger.next_step };
}
export function reports(id) {
  const c = currentCase(id);
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
  const rev = String(c.revision).padStart(4, '0');
  const paths = [join(c.dir, 'reports', `evidence_${rev}.md`), join(c.dir, 'reports', `decision_${rev}.md`)];
  const content = [toMarkdown(c.ledger), renderSummary(c.ledger)];
  // Preflight every existing output BEFORE creating a new output. If one old
  // report was changed, do not create a misleading half-complete report pair.
  for (let i = 0; i < paths.length; i++) {
    if (existsSync(paths[i]) && safeRead(paths[i], 10 * 1024 * 1024) !== content[i])
      refuse(`saved ${basename(paths[i])} differs from this revision; original preserved for review`);
  }
  for (let i = 0; i < paths.length; i++) {
    if (!existsSync(paths[i])) safeWrite(paths[i], content[i]);
  }
  return paths;
  } finally { clearActiveScope(); }
}
export function prepareNotice(id, audience = 'organization') {
  const c = currentCase(id);
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
    const { text, warnings } = draftNotice(c.ledger, { audience });
    if (warnings.length) refuse('draft contains unsupported verdict terms: revise the evidence before drafting');
    const rev = String(c.revision).padStart(4, '0');
    const file = join(c.dir, 'reports', `notice_${rev}_${audience}.txt`);
    if (existsSync(file)) refuse('draft for this revision and audience already exists; original preserved');
    safeWrite(file, text + '\n');
    return { file, status: 'DRAFT ONLY — not sent; review before sharing' };
  } finally { clearActiveScope(); }
}
const PACKET_MAX_FILE = 10 * 1024 * 1024;
const PACKET_MAX_TOTAL = 50 * 1024 * 1024;
// A full case packet is shareable. Preview the exact revision and every chosen
// file hash *before* a person confirms the privacy review. No file contents
// are logged or copied by the preview.
function packetSelection(c, evidencePaths) {
  if (!Array.isArray(evidencePaths) || evidencePaths.length > 30)
    refuse('choose no more than 30 explicit evidence files');
  const names = new Set(), selected = [];
  let total = Buffer.byteLength(renderSummary(c.ledger), 'utf8') +
    Buffer.byteLength(JSON.stringify(c.ledger, null, 2) + '\n', 'utf8');
  for (const rawPath of evidencePaths) {
    const path = ensureInside(rawPath);
    const name = basename(path);
    if (names.has(name.toLowerCase())) refuse(`evidence file names collide: ${name}`);
    names.add(name.toLowerCase());
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > PACKET_MAX_FILE)
      refuse(`evidence must be an ordinary file no larger than 10 MB: ${name}`);
    total += st.size;
    if (total > PACKET_MAX_TOTAL) refuse('selected files exceed the original 50 MB packet limit');
    const data = safeReadBytes(path, PACKET_MAX_FILE);
    selected.push({ name, path, data, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') });
  }
  return selected;
}
export function previewCasePacket(id, evidencePaths = []) {
  const c = currentCase(id);
  const selected = packetSelection(c, evidencePaths);
  return {
    incident: id, revision: c.revision,
    ledgerSha256: createHash('sha256').update(JSON.stringify(c.ledger)).digest('hex'),
    files: selected.map(({ name, path, bytes, sha256 }) => ({ name, path, bytes, sha256 })),
    status: 'PREVIEW ONLY — manually review the current case, personal details and selected files before creating a local packet'
  };
}
export function exportCasePacket(id, personalInfoReviewed = false, evidencePaths = [], reviewedPreview = null) {
  if (personalInfoReviewed !== true) refuse('manual personal-information review is required before making a shareable packet');
  if (!reviewedPreview) refuse('review the exact current case and selected file hashes before confirming a packet');
  const c = currentCase(id);
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
    const selected = packetSelection(c, evidencePaths);
    const ledgerSha256 = createHash('sha256').update(JSON.stringify(c.ledger)).digest('hex');
    const expected = reviewedPreview.files;
    if (reviewedPreview.incident !== id || reviewedPreview.revision !== c.revision ||
        reviewedPreview.ledgerSha256 !== ledgerSha256 || !Array.isArray(expected) ||
        expected.length !== selected.length || selected.some((item, i) =>
          item.name !== expected[i].name || item.path !== expected[i].path ||
          item.bytes !== expected[i].bytes || item.sha256 !== expected[i].sha256))
      refuse('case or supporting files changed since the privacy review; preview and review them again');
    const includes = selected.map(({ name, data }) => ({ name, data }));
    const result = buildPacket(c.ledger, includes, { humanReviewed: true });
    if (result.refused) refuse('packet refused: ' + result.refused.map(x => x.name + ': ' + x.problems.join(', ')).join('; '));
    const rev = String(c.revision).padStart(4, '0');
    const file = join(c.dir, 'packets', `case_${rev}.zip`);
    if (existsSync(file)) refuse('packet for this revision already exists; original preserved');
    safeWrite(file, result.zip, { binary: 'case-packet' });
    return { file, entries: result.manifest.files.length, status: 'LOCAL COPY ONLY — never sent' };
  } finally { clearActiveScope(); }
}
export function stopCase(id) {
  clearActiveScope();
  const c = currentCase(id);
  const stopped = stopScope(c.scope);
  // Deliberate stop action is always possible; no protected file is modified.
  safeWrite(join(c.dir, 'scope.json'), JSON.stringify(stopped, null, 2) + '\n', { overwrite: true });
  return `Incident ${id} stopped. Subsequent incident-saving actions will be refused.`;
}
// Link the existing incident-timeline Python tool to persistent case records.
// Every timeline edit creates a new numbered revision; older evidence stays intact.
const TIMELINE = /^timeline_(\d{4})\.json$/;
const TIMELINE_STAGES = ['recognize', 'contain', 'preserve', 'scope', 'notify_assessment', 'recover', 'follow_up'];
const TIMELINE_SCENARIOS = ['website_redirect', 'domain_expiry', 'account_takeover', 'data_exposure', 'content_logging', 'service_outage', 'other'];
const TIMELINE_FACTS = ['confirmed', 'reported', 'unknown', 'simulated'];
// Keep the guided menu's schema identical to the existing Python incident
// timeline tool. Rejected input is not written into an immutable revision.
function timelineLabel(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./:# @+\-=(),*~^<>'&]{1,160}$/.test(value) ||
      maskForStorage(value) !== value) refuse(`${name}: use a short nonprivate metadata label (letters, spaces, numbers, / - : etc.)`);
  return value;
}
function validateTimelineDraft(data, id, ledger = null) {
  if (!data || data.id !== id || !TIMELINE_SCENARIOS.includes(data.scenario) ||
      !['real', 'exercise'].includes(data.mode) || !Array.isArray(data.events) ||
      data.events.length > 200 || !data.decisions || typeof data.decisions !== 'object' ||
      Array.isArray(data.decisions)) refuse('timeline structure is invalid; no revision saved');
  for (const ev of data.events) {
    if (!ev || typeof ev !== 'object' || Object.keys(ev).sort().join(',') !== 'at,fact_status,reference,stage' ||
        typeof ev.at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(ev.at) || !Number.isFinite(Date.parse(ev.at)) ||
        !TIMELINE_STAGES.includes(ev.stage) || !TIMELINE_FACTS.includes(ev.fact_status) ||
        (data.mode !== 'exercise' && ev.fact_status === 'simulated'))
      refuse('timeline contains an invalid or unpermitted event');
    timelineLabel(ev.reference, 'timeline evidence reference');
    if (ledger && /^E[0-9]+$/.test(ev.reference) && !ledger.items.some(item => item.id === ev.reference))
      refuse(`timeline refers to missing incident evidence ${ev.reference}`);
  }
  for (const [stage, decision] of Object.entries(data.decisions)) {
    if (!TIMELINE_STAGES.includes(stage) || !decision || typeof decision !== 'object' ||
        Object.keys(decision).sort().join(',') !== 'complete,owner,reference' ||
        typeof decision.complete !== 'boolean') refuse('timeline contains an invalid stage decision');
    timelineLabel(decision.owner, 'decision owner role');
    timelineLabel(decision.reference, 'decision reference');
    if (ledger && /^E[0-9]+$/.test(decision.reference) && !ledger.items.some(item => item.id === decision.reference))
      refuse(`timeline decision refers to missing incident evidence ${decision.reference}`);
  }
}
// Timeline revisions are a history of *single* user actions, not unrelated
// replacement documents. Verify that each revision preserves the previous
// events and decisions. This detects an otherwise-valid but inconsistent older
// revision instead of silently accepting the latest filename alone. It cannot
// prove authenticity if every historical file was deliberately rewritten.
function validateTimelineTransition(previous, next) {
  if (previous.id !== next.id || previous.scenario !== next.scenario || previous.mode !== next.mode)
    refuse('timeline history changed its incident, scenario or mode; preserve all revisions for review');
  const oldEvents = previous.events, newEvents = next.events;
  const oldDecisions = previous.decisions, newDecisions = next.decisions;
  if (newEvents.length < oldEvents.length || newEvents.length > oldEvents.length + 1 ||
      !isDeepStrictEqual(newEvents.slice(0, oldEvents.length), oldEvents))
    refuse('timeline revision changed or removed previously recorded events; preserve the history for review');
  const changedStages = new Set([...Object.keys(oldDecisions), ...Object.keys(newDecisions)]);
  for (const stage of [...changedStages])
    if (isDeepStrictEqual(oldDecisions[stage], newDecisions[stage])) changedStages.delete(stage);
  if (newEvents.length === oldEvents.length + 1 && changedStages.size !== 0 ||
      newEvents.length === oldEvents.length && changedStages.size !== 1)
    refuse('timeline revision must add one event OR change one stage decision');
  if (changedStages.size === 1 && [...changedStages].some(stage => !Object.hasOwn(newDecisions, stage)))
    refuse('timeline revision removed a stage decision; preserve the history for review');
}
function latestTimeline(id) {
  const c = currentCase(id);
  const revs = readdirSync(c.dir).map(name => ({ name, m: TIMELINE.exec(name) }))
    .filter(x => x.m).sort((a, b) => +a.m[1] - +b.m[1]);
  if (!revs.length) refuse('no timeline for this case; create one first');
  if (revs.some((entry, index) => Number(entry.m[1]) !== index))
    refuse('timeline revision history has a missing number; preserve the files and review it before editing');
  let previous = null;
  for (const entry of revs) {
    const data = json(join(c.dir, entry.name));
    validateTimelineDraft(data, id, c.ledger);
    if (!previous) {
      if (data.events.length || Object.keys(data.decisions).length)
        refuse('original timeline revision is not empty; preserve the original history for review');
    } else validateTimelineTransition(previous, data);
    previous = data;
  }
  return { c, rev: Number(revs.at(-1).m[1]), data: previous, file: join(c.dir, revs.at(-1).name) };
}
function saveTimelineRevision(c, rev, data) {
  if (rev >= 9999) refuse('timeline revision limit reached');
  validateTimelineDraft(data, c.scope.incident_id, c.ledger);
  const content = JSON.stringify(data, null, 2) + '\n';
  if (maskForStorage(content) !== content) refuse('timeline contains contact or secret-shaped content; use metadata references only');
  return safeWrite(join(c.dir, `timeline_${String(rev + 1).padStart(4, '0')}.json`), content);
}
export function createCaseTimeline(id, scenario, mode = 'real') {
  const c = currentCase(id);
  if (!TIMELINE_SCENARIOS.includes(scenario) || !['real', 'exercise'].includes(mode)) refuse('unsupported timeline scenario or mode');
  if (readdirSync(c.dir).some(n => TIMELINE.test(n))) refuse('timeline already exists; original preserved');
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try {
    const data = { id, scenario, mode, events: [], decisions: {} };
    return safeWrite(join(c.dir, 'timeline_0000.json'), JSON.stringify(data, null, 2) + '\n');
  } finally { clearActiveScope(); }
}
export function addTimelineEvent(id, stage, factStatus, reference) {
  const { c, rev, data } = latestTimeline(id);
  if (!TIMELINE_STAGES.includes(stage) || !['confirmed', 'reported', 'unknown', 'simulated'].includes(factStatus))
    refuse('invalid timeline stage or fact status');
  if (factStatus === 'simulated' && data.mode !== 'exercise') refuse('simulated events belong only in an exercise');
  timelineLabel(reference, 'timeline evidence reference');
  // Explicit E-number references denote evidence from this case, not free-form notes.
  if (/^E[0-9]+$/.test(reference) && !c.ledger.items.some(item => item.id === reference))
    refuse(`timeline references missing case evidence ${reference}`);
  if (data.events.length >= 200) refuse('timeline event limit reached');
  data.events.push({ at: new Date().toISOString(), stage, fact_status: factStatus, reference });
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try { return saveTimelineRevision(c, rev, data); } finally { clearActiveScope(); }
}
export function recordTimelineDecision(id, stage, owner, reference, complete = false) {
  const { c, rev, data } = latestTimeline(id);
  if (!TIMELINE_STAGES.includes(stage)) refuse('unknown timeline stage');
  timelineLabel(owner, 'decision owner role');
  timelineLabel(reference, 'decision reference');
  if (typeof complete !== 'boolean') refuse('complete must be true or false');
  // Keep timeline decisions tied to the same case evidence as stage events.
  // Short human-readable references are permitted, but an explicit E-number
  // must point to an actual recorded evidence item, never an invented ID.
  if (/^E[0-9]+$/.test(reference) && !c.ledger.items.some(item => item.id === reference))
    refuse(`timeline decision references missing case evidence ${reference}`);
  data.decisions[stage] = { owner, reference, complete };
  requireScope(join(c.dir, 'scope.json'), { action: 'save_local' });
  try { return saveTimelineRevision(c, rev, data); } finally { clearActiveScope(); }
}
export function caseTimelineReport(id) {
  return runPython('incident_timeline/incident_timeline.py', ['--input', latestTimeline(id).file], { report: true });
}
// Verify an already-created case packet without modifying it. A ZIP filename
// alone is not evidence that its included manifest and case revision agree.
// This inspects only the current-revision packet (max original packet budget),
// not every historic packet. This says nothing about whether sharing is safe.
function currentPacketIntegrity(c, path) {
  try {
    const { entries } = readStoredZip(safeReadBytes(path, 55 * 1024 * 1024));
    if (entries.length < 4 || entries.length > 35) return 'invalid_or_changed';
    const byName = new Map(entries.map(e => [e.name, e.data]));
    const manifestBytes = byName.get('MANIFEST.json');
    if (!manifestBytes || !byName.has('README.txt') || !byName.has('summary.md') || !byName.has('ledger.json'))
      return 'invalid_or_changed';
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    if (manifest.incident_id !== c.scope.incident_id || !Array.isArray(manifest.files) ||
        manifest.files.length !== entries.length - 2) return 'invalid_or_changed';
    const mentioned = new Set();
    for (const item of manifest.files) {
      if (typeof item.path !== 'string' || mentioned.has(item.path) ||
          !['summary.md', 'ledger.json'].includes(item.path) && !item.path.startsWith('evidence/') ||
          typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
          !Number.isSafeInteger(item.bytes) || item.bytes < 0) return 'invalid_or_changed';
      mentioned.add(item.path);
      const bytes = byName.get(item.path);
      if (!bytes || bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
        return 'invalid_or_changed';
    }
    if (!mentioned.has('summary.md') || !mentioned.has('ledger.json')) return 'invalid_or_changed';
    const ledger = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(byName.get('ledger.json')));
    if (JSON.stringify(ledger) !== JSON.stringify(c.ledger)) return 'invalid_or_changed';
    if (byName.get('summary.md').toString('utf8') !== renderSummary(c.ledger)) return 'invalid_or_changed';
    return 'manifest_matches_current_case_privacy_review_still_required';
  } catch { return 'invalid_or_changed'; }
}
// Read-only incident overview for a real operator: what exists, what has been
// summarized, and what still needs manual attention. Never invent a verdict.
export function caseOverview(id) {
  const c = currentCase(id);
  const rev = String(c.revision).padStart(4, '0');
  const evidenceLabels = {};
  for (const item of c.ledger.items) evidenceLabels[item.label] = (evidenceLabels[item.label] ?? 0) + 1;
  const files = readdirSync(c.dir, { withFileTypes: true });
  const reportDir = join(c.dir, 'reports');
  const packetDir = join(c.dir, 'packets');
  const safeFile = (path) => {
    if (!existsSync(path)) return false;
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  };
  const publishedReports = existsSync(reportDir) && lstatSync(reportDir).isDirectory()
    ? readdirSync(reportDir).filter(n => /^((evidence|decision)_\d{4}\.md|notice_\d{4}_[a-z]+\.txt)$/.test(n) && safeFile(join(reportDir, n))) : [];
  const timelineCount = files.filter(f => f.isFile() && TIMELINE.test(f.name)).length;
  const expectedReports = [
    { file: `evidence_${rev}.md`, text: toMarkdown(c.ledger) },
    { file: `decision_${rev}.md`, text: renderSummary(c.ledger) },
  ];
  // Existence is not proof of a valid export. Only report an exact current
  // revision match as verified; never delete or silently repair altered files.
  const reportIntegrity = Object.fromEntries(expectedReports.map(({ file, text }) => {
    const path = join(reportDir, file);
    if (!safeFile(path)) return [file, 'missing'];
    try { return [file, safeRead(path, 10 * 1024 * 1024) === text ? 'verified' : 'changed']; }
    catch { return [file, 'unreadable']; }
  }));
  let timelineIntegrity = timelineCount ? 'verified' : 'not_started';
  if (timelineCount) {
    try { latestTimeline(id); } catch { timelineIntegrity = 'invalid_or_incomplete'; }
  }
  const packets = existsSync(packetDir) && lstatSync(packetDir).isDirectory()
    ? readdirSync(packetDir).filter(n => /^case_\d{4}\.zip$/.test(n) && safeFile(join(packetDir, n))) : [];
  const currentPacket = join(packetDir, `case_${rev}.zip`);
  const packetIntegrity = safeFile(currentPacket) ? currentPacketIntegrity(c, currentPacket) : 'not_created';
  const expired = Date.parse(c.scope.expires_at) <= Date.now();
  const blockers = [];
  if (c.scope.status === 'stopped') blockers.push('incident scope stopped — no further local saves');
  if (expired) blockers.push('incident scope expired — start a new incident for additional work');
  if (!c.ledger.items.length) blockers.push('no evidence items recorded');
  if (Object.values(reportIntegrity).some(status => status !== 'verified'))
    blockers.push('latest Markdown reports are missing, unreadable, or changed; do not treat them as verified exports');
  if (timelineIntegrity === 'invalid_or_incomplete')
    blockers.push('timeline history is invalid or incomplete; inspect original revisions before editing');
  if (packetIntegrity === 'invalid_or_changed')
    blockers.push('current case packet is unreadable or its manifest does not match; do not share it');
  if (!c.ledger.checked.length && !c.ledger.not_checked.length)
    blockers.push('no checked/not-checked review steps recorded');
  if (!c.ledger.risk) blockers.push('risk assessment not yet recorded');
  if (!c.ledger.next_step?.action || !c.ledger.next_step?.permission_needed)
    blockers.push('safe next step and required permission not yet recorded');
  blockers.push('manual source and privacy review still required before sharing or acting');
  return {
    incident: id, status: c.scope.status, expired, expiresAt: c.scope.expires_at,
    latestRevision: c.revision, evidenceItems: c.ledger.items.length,
    evidenceByLabel: evidenceLabels,
    review: { checked: c.ledger.checked.length, notChecked: c.ledger.not_checked.length,
      hypotheses: c.ledger.hypotheses.length, riskRecorded: Boolean(c.ledger.risk),
      nextStepRecorded: Boolean(c.ledger.next_step?.action && c.ledger.next_step?.permission_needed) },
    savedRevisions: files.filter(f => f.isFile() && REV.test(f.name)).length, timelineRevisions: timelineCount,
    reportIntegrity, timelineIntegrity, packetIntegrity,
    markdownAndDrafts: publishedReports.sort(), casePackets: packets.sort(),
    notes: blockers, authorityActivated: false,
  };
}
export function listCases() {
  if (!existsSync(CASES)) return [];
  return readdirSync(CASES, { withFileTypes: true }).filter((e) => e.isDirectory() && CASE_ID.test(e.name)).map((e) => {
    try { const c = currentCase(e.name, { verifyHistory: false }); return { id: e.name, revisions: c.revision, evidence: c.ledger.items.length, scope: c.scope.status }; }
    catch { return { id: e.name, status: 'incomplete/invalid — inspect manually' }; }
  });
}
export function prepareRegisterRequest(incidentId, kind, operation, inputPath, reason = 'Operator review requested') {
  return prepareRegisterIntent(incidentId, kind, operation, json(inputPath), reason);
}
export function prepareEmptyRegister(incidentId, kind, reason = 'Prepare a new empty register') {
  return prepareRegisterIntent(incidentId, kind, 'create', { schema_version: 1, records: [], history: [] }, reason);
}
function prepareRegisterIntent(incidentId, kind, operation, document, reason) {
  if (!CASE_ID.test(incidentId ?? '')) refuse('invalid incident ID');
  if (!Object.hasOwn(KIND_KEY, kind) || !['create', 'replace'].includes(operation)) refuse('invalid register kind or operation');
  const registerKey = KIND_KEY[kind];
  if (operation === 'create') {
    validateRegister(kind, document);
    if (document.history.length) refuse('new register must have empty history');
  } else {
    validateRegister(kind, { schema_version: 1, records: [document], history: [] });
  }
  const intent = { operation: `register.${operation}`, incident_id: incidentId, register_key: registerKey,
    reason, ...(operation === 'create' ? { register: document } : { record: document }) };
  const entries = buildRequest(intent);
  parseRequest(entries);
  for (const e of entries) checkName(e.name);
  // Check protocol size/name limits before creating a request directory.
  buildFrame({ code: Buffer.alloc(16), operation: intent.operation, entries });
  const requestText = entries[0].data.toString('utf8');
  if (maskForStorage(requestText) !== requestText) refuse('input contains data that must be masked; edit it before submitting');
  const dir = join(REQUESTS, `${incidentId}_${operation}_${randomUUID()}`);
  ensureInside(REQUESTS); // neither request root nor its existing ancestors may be symlinks
  mkdirSync(REQUESTS, { recursive: true });
  writeRequestFolder(dir, entries);
  return { dir, operation: intent.operation, register: registerKey, incident: incidentId };
}
// One guided path covers a fresh register with its first record and a replacement
// record. A replacement may start from existing metadata or from blank values.
// The result is a review request; it never edits the source register.
export function prepareGuidedRegister(incidentId, kind, operation, record, reason) {
  if (!['create', 'replace'].includes(operation)) refuse('choose create or replace');
  if (operation === 'create') {
    return prepareRegisterIntent(incidentId, kind, 'create', { schema_version: 1, records: [record], history: [] }, reason);
  }
  return prepareRegisterIntent(incidentId, kind, 'replace', record, reason);
}
// Guided read-only register listing: avoid asking small organizations to
// memorize opaque record IDs. Only validated metadata is displayed.
export function listCurrentRegisterRecords(kind, registerFile) {
  if (!Object.hasOwn(KIND_KEY, kind)) refuse('unknown register kind');
  const document = json(registerFile);
  validateRegister(kind, document);
  if (document.records.length > 1000) refuse('too many register records; choose a smaller register');
  return document.records.map(item => ({
    id: item.id,
    label: kind === 'service' ? `${item.service} — ${item.provider}` :
      kind === 'access' ? `${item.system} — ${item.role} (${item.state})` :
        item.category,
  }));
}
export function resolveRegisterSelection(listed, answer) {
  if (!Array.isArray(listed) || typeof answer !== 'string') refuse('invalid register record choice');
  const exact = answer.startsWith('id:') ? answer.slice(3) : answer;
  const byId = listed.find(item => item.id === exact)?.id;
  const index = /^#?([1-9]\d*)$/.exec(answer);
  const byNumber = index ? listed[Number(index[1]) - 1]?.id : undefined;
  if (answer.startsWith('id:')) {
    if (!byId) refuse('record ID is not in the displayed list');
    return byId;
  }
  if (answer.startsWith('#')) {
    if (!byNumber) refuse('record number is not in the displayed list');
    return byNumber;
  }
  if (byId && byNumber && byId !== byNumber)
    refuse('number is ambiguous: enter #N for the listed row, or id:N for the literal record ID');
  if (byId || byNumber) return byId || byNumber;
  refuse('choose a displayed register record');
}
export function previousRegisterRecord(kind, registerFile, recordId) {
  if (!Object.hasOwn(KIND_KEY, kind)) refuse('unknown register kind');
  const document = json(registerFile);
  validateRegister(kind, document);
  const item = document.records.find(r => r.id === recordId);
  if (!item) refuse('record ID not found in selected register');
  return structuredClone(item);
}
export function listPreparedRequests(limit = 20) {
  if (!existsSync(REQUESTS)) return [];
  ensureInside(REQUESTS);
  const all = readdirSync(REQUESTS, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.isSymbolicLink())
    .map(e => ({ name: e.name, dir: join(REQUESTS, e.name) }));
  const results = [];
  // Sort by folder modification time, not incident ID. No file is modified.
  const recent = all.map(e => ({ ...e, mtime: statSync(e.dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 100);
  for (const { dir, name } of recent) {
    try { results.push({ ...inspectRequest(dir), name }); }
    catch { results.push({ name, path: dir, status: 'invalid/incomplete — not selectable' }); }
  }
  return results.slice(0, Math.max(1, Math.min(50, limit)));
}
// Build exactly the same bounded, secret-screened file set for a preview and
// final request. The operator sees only paths, byte counts and hashes; no
// source contents are displayed, and no original is modified.
function collectRestoreSelection(sourceFolder) {
  const root = ensureInside(sourceFolder);
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) refuse('source must be an ordinary local folder');
  const files = new Map();
  let total = 0;
  const walk = (dir, prefix = '') => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      checkName(`files/${rel}`);
      const file = ensureInside(join(dir, d.name));
      if (d.isDirectory()) { walk(file, rel); continue; }
      if (!d.isFile() || d.isSymbolicLink()) refuse(`not a regular text file: ${rel}`);
      if (files.size >= TREE_LIMITS.files) refuse('restore selection exceeds the original 1000-file limit');
      const st = lstatSync(file);
      if (st.nlink !== 1 || st.size > TREE_LIMITS.file) refuse(`restore file is linked or too large: ${rel}`);
      total += st.size;
      if (total > TREE_LIMITS.total) refuse('restore selection exceeds the original 100 MB limit');
      const content = safeReadBytes(file, TREE_LIMITS.file);
      if (content.includes(0)) refuse(`${rel}: binary content is not allowed`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      if (maskForStorage(text) !== text) refuse(`${rel} has content requiring masking`);
      files.set(rel, content);
    }
  };
  walk(root);
  validateTreeFiles(files);
  return files;
}
function restoreDigest(files) {
  // Include each path and length as well as bytes to bind the review to the
  // exact tree, rather than merely the count or a file modification timestamp.
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    hash.update(Buffer.from(name, 'utf8')); hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(bytes.length))); hash.update(Buffer.from([0]));
    hash.update(createHash('sha256').update(bytes).digest());
  }
  return hash.digest('hex');
}
export function previewRestoreSelection(incidentId, sourceFolder) {
  if (!CASE_ID.test(incidentId ?? '')) refuse('invalid incident ID');
  const files = collectRestoreSelection(sourceFolder);
  return { incident: incidentId, files: [...files.entries()].map(([name, content]) => ({
      name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')
    })), totalBytes: [...files.values()].reduce((n, v) => n + v.length, 0), fingerprint: restoreDigest(files),
    status: 'PREVIEW ONLY — no review request saved, no files restored' };
}
export function prepareRestoreRequest(incidentId, sourceFolder, reason = 'Restore files for operator review', reviewedPreview = null) {
  if (!CASE_ID.test(incidentId ?? '')) refuse('invalid incident ID');
  const files = collectRestoreSelection(sourceFolder);
  if (reviewedPreview && (reviewedPreview.incident !== incidentId ||
      reviewedPreview.fingerprint !== restoreDigest(files) || reviewedPreview.files?.length !== files.size))
    refuse('restore selection changed after preview; review the updated folder before preparing a request');
  const entries = buildRequest({ operation: 'restore.stage', incident_id: incidentId, reason, files });
  buildFrame({ code: Buffer.alloc(16), operation: 'restore.stage', entries });
  ensureInside(REQUESTS);
  mkdirSync(REQUESTS, { recursive: true });
  const dir = join(REQUESTS, `${incidentId}_restore_${randomUUID()}`);
  writeRequestFolder(dir, entries);
  return { dir, operation: 'restore.stage', incident: incidentId, files: files.size,
    note: 'REVIEW REQUEST ONLY; no restore performed, no authority approval granted' };
}

export function inspectRequest(dir) {
  const abs = ensureInside(dir), rel = relative(REQUESTS, abs);
  if (!rel || rel.startsWith('..') || rel.includes(sep)) refuse('select a direct child of Temp/Requests');
  const entries = readRequestFolder(abs);
  let req;
  try { req = JSON.parse(entries[0].data.toString('utf8')); } catch { refuse('invalid request JSON'); }
  if (req.operation === 'restore.stage') {
    if (!CASE_ID.test(req.incident_id) || entries.length < 2 || entries.slice(1).some((e) => !e.name.startsWith('files/'))) refuse('invalid restore request');
    validateTreeFiles(new Map(entries.slice(1).map((e) => [e.name.slice(6), e.data])));
  } else req = parseRequest(entries);
  const bytes = entries.reduce((n, e) => n + e.data.length, 0);
  return { operation: req.operation, incident: req.incident_id, register: req.register_key ?? '(restore files)', files: entries.length - 1, bytes, path: abs, status: 'prepared only — NOT approved or submitted' };
}

// A list index and a numeric incident ID can be identical but refer to
// *different* incidents. Never silently attach evidence to the wrong case.
// #N always means row N; id:N always means that literal incident ID.
export function resolveCaseSelection(cases, selection) {
  if (!Array.isArray(cases) || typeof selection !== 'string') refuse('invalid case selection');
  const listEntry = /^#([1-9][0-9]*)$/.exec(selection);
  if (listEntry) {
    const selected = cases[Number(listEntry[1]) - 1];
    if (!selected) refuse('that list number is not available');
    if (!CASE_ID.test(selected.id)) refuse('selected incident is invalid');
    return selected.id;
  }
  const literal = /^id:(.+)$/i.exec(selection);
  if (literal) {
    const id = literal[1];
    if (!CASE_ID.test(id) || !cases.some(c => c.id === id)) refuse('that exact incident ID is not listed');
    return id;
  }
  if (/^\d+$/.test(selection)) {
    const listed = cases[Number(selection) - 1];
    const literalExists = cases.some(c => c.id === selection);
    if (listed && literalExists && listed.id !== selection)
      refuse(`ambiguous selection: enter #${selection} for the displayed row, or id:${selection} for the exact incident ID`);
    if (literalExists) return selection;
    if (listed && CASE_ID.test(listed.id)) return listed.id;
    refuse('that number is not listed and no incident has that ID');
  }
  if (!CASE_ID.test(selection)) refuse('incident ID: use letters, numbers, _ or -');
  if (!cases.some(c => c.id === selection)) refuse('incident not found; choose one from the list or create a new incident first');
  return selection;
}
export async function submitPreparedRequest(dir, { pipe, codeHex }) {
  // The protected authority chooses the pipe name and 16-byte code. Neither is logged or put on a command line.
  const preview = inspectRequest(dir);
  if (typeof pipe !== 'string' || !/^\\\\\.\\pipe\\gb2l-[0-9a-f]{32}$/.test(pipe)) refuse('enter the local pipe name displayed by the authority');
  if (typeof codeHex !== 'string' || !/^[0-9a-fA-F]{32}$/.test(codeHex)) refuse('enter the 32-digit hex code displayed by the authority');
  const entries = readRequestFolder(preview.path);
  const result = await exportRequest(entries, { pipe, code: Buffer.from(codeHex, 'hex') });
  return { operation: preview.operation, incident: preview.incident,
    result: 'request bytes sent to the pipe; this is NOT approval or evidence of acceptance', details: result ?? null };
}

// Cancelling a partially entered action must never leave the readline interface
// closed and then try to ask the next menu question (Windows Ctrl+C does close it).
class MenuBack extends Error {
  constructor() { super('Return to main menu'); this.name = 'MenuBack'; }
}
function inputWasInterrupted(error) {
  return error?.name === 'AbortError' || error?.code === 'ERR_USE_AFTER_CLOSE';
}
// The owner's later written authorization adds dedicated Email Communications.
// The original thirteen groups remain intact; no public menu for
// authority, regression harness or sandbox prerequisites.
export const TOOL_GROUPS = Object.freeze([
  {name:'Incident Management', actions:[
    {label:'Start incident', code:'1'}, {label:'Find incidents', code:'5'},
    {label:'Review incident progress', code:'T'}, {label:'Incident timeline', code:'U'},
    {label:'Stop incident', code:'F'}]},
  {name:'Evidence Collection', actions:[
    {label:'Record reported information', code:'2'}, {label:'Record direct observation', code:'3'},
    {label:'Review evidence and risk', code:'X'}, {label:'Collect public GitHub evidence (scope required)', code:'GITHUB'}]},
  {name:'Reports & Evidence Packages', actions:[
    {label:'Create evidence and decision reports', code:'4'}, {label:'Draft unsent notice', code:'M'},
    {label:'Build manually reviewed evidence packet', code:'N'}]},
  {name:'Domain Health', actions:[
    {label:'Read public domain records (scope required)', code:'DOMAIN'},
    {label:'Check domain against prior baseline (scope required)', code:'WATCH'}]},
  {name:'Website Redirect & Authenticity', actions:[
    {label:'Check URL format (offline)', code:'Q'},
    {label:'Live redirect chain (verified sandbox only)', code:'REDIRECT'},
    {label:'Preview possible lookalike domains (offline)', code:'W'},
    {label:'Check lookalike DNS (scope required)', code:'LOOKALIKE'}]},
  {name:'Email Security', actions:[
    {label:'Inspect saved suspicious email headers', code:'O'},
    {label:'Check domain SPF/DMARC/MX records (scope required)', code:'SPOOF'}]},
  {name:'Account Recovery & Access', actions:[
    {label:'Account recovery instructions (no logins)', code:'V'},
    {label:'Departing staff access review', code:'9'}]},
  {name:'Organization Registers', actions:[
    {label:'Prepare a register review request', code:'6'}, {label:'Inspect prepared request', code:'7'},
    {label:'Review service/access registers', code:'8'}, {label:'Prepare empty register', code:'C'},
    {label:'Submit request to owner console', code:'D'}, {label:'Guided register editing', code:'G'},
    {label:'List prepared requests', code:'H'}]},
  {name:'Directory Audit', actions:[{label:'Review rescue directory records', code:'P'}]},
  {name:'Website Code Analysis', actions:[
    {label:'Find local source files', code:'I'}, {label:'Run selected code flow scan', code:'J'},
    {label:'Static disclosure scan', code:'R'}, {label:'Guided source scan', code:'S'},
    {label:'Review fetch and redirect code (static)', code:'FETCHER'}]},
  {name:'Dependency Analysis', actions:[{label:'Review local npm dependencies', code:'K'}]},
  {name:'File Protection', actions:[
    {label:'Preview backup selection', code:'B'}, {label:'Make reviewed local backup', code:'Y'},
    {label:'Prepare restore review request (does not restore)', code:'E'},
    {label:'Make cleaned screenshot copies', code:'L'}]},
  {name:'Computer Security Check', actions:[
    {label:'Review a client security report ZIP', code:'CLIENT_DEVICE'},
    {label:'Check this computer (optional)', code:'DEVICE'}]},
  {name:'Email Communications', actions:[{label:'Prepare, review and authorize an outgoing incident email',code:'EMAIL_COMM'}]},
].map(g => Object.freeze({...g, actions: Object.freeze(g.actions.map(a => Object.freeze(a)))})));

async function interactive(preselected = null) {
  const io = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt) => {
    const value = (await io.question(prompt)).trim();
    if (/^\/(?:back|cancel)$/i.test(value)) throw new MenuBack();
    return value;
  };
  // Selecting an existing controlled vocabulary by number prevents typos.
  // Exact saved values are unchanged; direct CLI behavior remains the same.
  const askChoice = async (label, options) => {
    console.log(options.map((value, index) => `${index + 1} ${value.replaceAll('_', ' ')}`).join('  |  '));
    const answer = await ask(`${label} (number or exact label): `);
    const chosen = /^\d+$/.test(answer) ? options[Number(answer) - 1] : answer.toLowerCase();
    if (!options.includes(chosen)) refuse(`${label}: choose one of the displayed options; nothing saved`);
    return chosen;
  };
  const chooseRequest = async () => {
    const requests = listPreparedRequests();
    if (requests.length) {
      console.log('Recent prepared requests:');
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        console.log(`  ${i + 1} ${r.operation ?? '(invalid)'} | ${r.incident ?? '-'} | ${r.name}${r.operation ? '' : ' [not selectable]'}`);
      }
    }
    const selection = await ask('Request number, or paste an existing request folder path: ');
    if (/^\d+$/.test(selection)) {
      const item = requests[Number(selection) - 1];
      if (!item?.operation) refuse('select a valid request number');
      return item.path;
    }
    return selection;
  };
  const chooseCase = async () => {
    const cases = listCases();
    if (cases.length) {
      console.log('Existing incidents:');
      cases.forEach((c, i) => console.log(`  ${i + 1} ${c.id} | ${c.status ?? `${c.evidence} evidence, revision ${c.revisions}`}`));
      console.log('Tip: type a row number, # followed by the row number, or the exact incident ID. For numeric incident IDs, use id:ID if prompted.');
    }
    const choice = await ask('Number from list, or exact incident ID: ');
    return resolveCaseSelection(cases, choice);
  };
  const caseReviewMenu = async () => {
    const id = await chooseCase();
    while (true) {
    console.log('Case review: 1 View evidence and assessment | 2 Record checked/not checked | 3 Record risk | 4 Set safe next step | 5 Record hypothesis | 6 Record inference/recommendation/decision | 7 Export evidence and decision reports | 0 Main menu');
    const action = await ask('Review action [0-7]: ');
    if (!action || action === '0') return;
    if (action === '1') console.log(JSON.stringify(caseEvidence(id), null, 2));
    else if (action === '2') {
      console.log('Saved:', recordReviewCheck(id, await askChoice('Review status', ['checked', 'not_checked']), await ask('What was or was not checked? (no private data): ')));
    } else if (action === '3') console.log('Saved:', recordRisk(id, await ask('Risk and impact assessment, without unsupported conclusions: ')));
    else if (action === '4') {
      const next = await ask('Proposed safe next step: '), permission = await ask('Permission needed before taking that step: ');
      console.log('Saved:', recordNextStep(id, next, permission));
    } else if (action === '5') {
      console.log('Evidence IDs:', caseEvidence(id).items.map(i => i.id).join(', ') || '(none)');
      const statement = await ask('Possible explanation (not established fact): ');
      const support = await ask('Supporting evidence IDs, comma separated (optional): ');
      const against = await ask('Contradicting evidence IDs, comma separated (optional): ');
      console.log('Saved:', recordHypothesis(id, statement, support, against));
    } else if (action === '6') {
      const label = await askChoice('Note type', ['inference', 'recommendation', 'decision']);
      const detail = await ask('Description (clearly label uncertain information): ');
      console.log('Evidence IDs:', caseEvidence(id).items.map(i => i.id).join(', ') || '(none)');
      const basis = await ask('Evidence IDs to cite, comma separated (optional): ');
      console.log('Saved:', recordAnalysis(id, label, detail, basis));
    } else if (action === '7') console.log('Saved:', reports(id).join('\n'));
    else console.log('Unknown review action; no change made.');
    }
  };
  const guided = async () => {
    const id = await ask('Incident ID: ');
    const kind = await askChoice('Register kind', ['service', 'data', 'access']);
    const operation = await askChoice('Create new register or replace a record', ['create', 'replace']);
    let previous = null;
    let sourceRegister = null, reviewedSourceHash = null;
    if (operation === 'replace') {
      const existing = (await ask('Load existing register record for editing? Type yes or no: ')).toLowerCase();
      if (!['yes', 'no'].includes(existing)) refuse('enter yes or no; no request was created');
      if (existing === 'yes') {
        sourceRegister = await ask('Existing local register JSON path: ');
        reviewedSourceHash = createHash('sha256').update(safeReadBytes(sourceRegister)).digest('hex');
        const listed = listCurrentRegisterRecords(kind, sourceRegister);
        if (!listed.length) refuse('no existing records in this register; use Create instead');
        console.log('Existing records:');
        listed.forEach((r, i) => console.log(`  ${i + 1}  ${r.id} — ${r.label}`));
        const answer = await ask('Choose record number (#1) or exact record ID (id:my-id): ');
        const recordId = resolveRegisterSelection(listed, answer);
        previous = previousRegisterRecord(kind, sourceRegister, recordId);
        if (createHash('sha256').update(safeReadBytes(sourceRegister)).digest('hex') !== reviewedSourceHash)
          refuse('register changed during selection; reopen and review the new version');
      }
    }
    console.log('Metadata only: no passwords, personal contacts or private data. Blank retains shown value; - clears optional values.');
    const record = await promptRecord(kind, ask, previous);
    console.log('Proposed metadata (not applied):', JSON.stringify(record, null, 2));
    if ((await ask('Type PREPARE to save this review request: ')) !== 'PREPARE') { console.log('Cancelled.'); return; }
    if (sourceRegister && createHash('sha256').update(safeReadBytes(sourceRegister)).digest('hex') !== reviewedSourceHash)
      refuse('source register changed during editing; review it again before preparing the request');
    console.log(prepareGuidedRegister(id, kind, operation, record, 'Guided metadata review request'));
  };
  const guidedStaticScan = async () => {
    const selection = discoverScanSelection(await ask('Source folder inside toolbox: '));
    console.log(`Discovered ${selection.files.length} source file(s) to review:`);
    for (let index = 0; index < selection.files.length; index += 40) {
      const page = selection.files.slice(index, index + 40);
      for (let offset = 0; offset < page.length; offset++)
        console.log(`  ${index + offset + 1} ${page[offset]}`);
      if (index + page.length < selection.files.length) {
        if ((await ask('Type NEXT to inspect the remaining files (anything else cancels): ')) !== 'NEXT') {
          console.log('Cancelled; no scan configuration saved.');
          return;
        }
      }
    }
    const version = await ask('Reviewed source version / commit / label: ');
    if (await ask('Type SCAN to run both offline static checks: ') !== 'SCAN') {
      console.log('Cancelled; no scan configuration saved.');
      return;
    }
    const result = scanReviewedSelection(selection, version);
    console.log(`Reviewed configuration saved: ${result.config}`);
    console.log('Static content-flow report:', result.contentFlow);
    console.log('Static disclosure report:', result.disclosure);
  };
  const reviewedBackupMenu = async () => {
    const id = await chooseCase();
    console.log('Backup: 1 Enter individual file paths | 2 Use existing selection JSON | 3 Choose files by number');
    const mode = await ask('Choose 1, 2 or 3: ');
    let selection, preview;
    if (mode === '1') {
      const root = await ask('Source folder inside toolbox: ');
      const files = [];
      while (files.length < 1000) {
        const name = await ask('Full path of a file to back up (blank when done): ');
        if (!name) break;
        files.push(name);
      }
      if (!files.length) { console.log('Cancelled. No backup was created.'); return; }
      const version = await ask('Source version or date label (letters/numbers/-/_/.): ');
      const prepared = prepareBackupSelection(root, files, version);
      selection = prepared.selection;
      preview = prepared.preview;
      console.log('Selection JSON saved:', selection);
    } else if (mode === '2') {
      selection = await ask('Existing explicit backup selection JSON (inside toolbox): ');
      preview = JSON.parse(backupPreview(selection));
    } else if (mode === '3') {
      const root = await ask('Source folder inside toolbox: ');
      const candidates = discoverBackupCandidates(root);
      if (!candidates.length) { console.log('No ordinary candidate files found. Nothing backed up.'); return; }
      console.log(`Found ${candidates.length} candidate file(s). Nothing is selected automatically.`);
      for (let offset = 0; offset < candidates.length; offset += 40) {
        for (let i = offset; i < Math.min(offset + 40, candidates.length); i++)
          console.log(`  ${i + 1}  ${candidates[i].relativePath}  (${candidates[i].bytes} bytes)`);
        if (offset + 40 < candidates.length &&
            (await ask('Type NEXT to view more files (anything else cancels): ')) !== 'NEXT') {
          console.log('Cancelled. No backup was created.'); return;
        }
      }
      const selected = selectBackupCandidateNumbers(candidates,
        await ask('Enter the numbers of files to back up (e.g. 1,3-5): '));
      const version = await ask('Source version or date label (letters/numbers/-/_/.): ');
      const prepared = prepareBackupSelection(root, selected, version);
      selection = prepared.selection; preview = prepared.preview;
      console.log('Selection JSON saved:', selection);
    } else { console.log('Choose 1, 2 or 3; no backup was created.'); return; }
    console.log('BACKUP PREVIEW — inspect every listed file and hash:');
    console.log(JSON.stringify(preview, null, 2));
    if (await ask('Type BACKUP to create a NEW local copy (anything else cancels): ') !== 'BACKUP') {
      console.log('Cancelled. No backup was created.');
      return;
    }
    console.log('Saved:', createReviewedBackup(id, selection, preview));
  };
  const guidedOffboarding = async () => {
    const path = await ask('Existing access register JSON path (inside toolbox): ');
    const originalBytes = safeReadBytes(path);
    const originalHash = createHash('sha256').update(originalBytes).digest('hex');
    const roles = listCurrentAccessRoles(path);
    if (!roles.length) { console.log('No current roles recorded. No checklist needed.'); return; }
    console.log('Current roles recorded in this register:');
    roles.forEach((r, i) => console.log(`  ${i + 1}  ${r.role}  (${r.systems.length} system(s))`));
    const choice = await ask('Choose role number or exact role label: ');
    const role = /^\d+$/.test(choice) ? roles[Number(choice) - 1]?.role : choice;
    if (!role || !roles.some(r => r.role === role)) refuse('choose a displayed current role; no change made');
    const currentHash = createHash('sha256').update(safeReadBytes(path)).digest('hex');
    if (currentHash !== originalHash) refuse('access register changed since role selection; reopen and review it again');
    const checklist = offboardingChecklist(path, role);
    if (createHash('sha256').update(safeReadBytes(path)).digest('hex') !== originalHash)
      refuse('access register changed while generating the checklist; reopen and review it again');
    console.log('READ-ONLY CHECKLIST — no access will be changed:');
    console.log(checklist);
  };
  const guidedDirectoryAudit = async () => {
    const path = await ask('Local directory records JSON file or folder (inside toolbox): ');
    const fields = await ask('Required field names (comma-separated, blank to check only present data): ');
    const required = fields ? fields.split(',').map(v => v.trim()) : [];
    const age = await ask('How many days until a last-checked date is stale? (blank for 180): ');
    const countryChoice = await askChoice('Phone-number format', ['us', 'other']);
    const country = countryChoice === 'us' ? 'US' : 'other';
    const staleDays = age === '' ? 180 : Number(age);
    console.log('Review findings only — this will not contact, correct or update any record:');
    console.log(directoryAudit(path, { required, staleDays, country }));
  };
  const timelineMenu = async () => {
    const id = await chooseCase();
    while (true) {
    console.log('Timeline: 1 Create | 2 Add event | 3 Record stage decision | 4 View report | 0 Main menu');
    const action = await ask('Timeline action [0-4]: ');
    if (!action || action === '0') return;
    if (!['1', '2', '3', '4'].includes(action)) {
      console.log('Choose 1, 2, 3 or 4; no changes made.');
      continue;
    }
    if (action === '1') {
      const scenario = await askChoice('Timeline scenario', TIMELINE_SCENARIOS);
      const mode = await askChoice('Real incident or exercise', ['real', 'exercise']);
      console.log(createCaseTimeline(id, scenario, mode));
    } else if (action === '2') {
      const stage = await askChoice('Timeline stage', TIMELINE_STAGES);
      const status = await askChoice('Evidence status', ['confirmed', 'reported', 'unknown', 'simulated']);
      console.log(addTimelineEvent(id, stage, status, await ask('Reference to saved evidence (no private content): ')));
    } else if (action === '3') {
      const stage = await askChoice('Timeline stage', TIMELINE_STAGES);
      const owner = await ask('Decision owner role: '), ref = await ask('Evidence/decision reference: ');
      const answer = (await ask('Decision recorded as complete? Type yes or no: ')).toLowerCase();
      if (!['yes', 'no'].includes(answer)) refuse('enter yes or no; no timeline change was saved');
      console.log(recordTimelineDecision(id, stage, owner, ref, answer === 'yes'));
    } else if (action === '4') console.log(caseTimelineReport(id));
    else console.log('Unknown timeline option; no change made.');
    }
  };
  // Exactly thirteen user-facing workflows. Every selectable action calls an
  // existing, approved specialist or the previously reviewed local workflow.
  // Source modules and safety/authority helpers remain separate internally;
  // grouping never weakens their own scope, permission or approval checks.
  const groups = TOOL_GROUPS;
  const menu = `\n911_gitback2life Toolbox — 14 tools\n\n${groups.map((g, i) =>
    `  ${String(i + 1).padStart(2)}  ${g.name}`).join('\n')}\n\n   0  Exit\n`;
  if (!preselected) console.log('Choose a tool number. At any question type /back to cancel; Ctrl+C exits.');
  const specialist = (script, args, { findingCodes = [] } = {}) => {
    // Bounded, fixed executable and audited bundled module; never shell input.
    const approved = new Set(['github_evidence/github_evidence.mjs', 'domain_research/domain_research.mjs',
      'domain_watch/domain_watch.mjs', 'email_spoof_check/email_spoof_check.mjs',
      'lookalike_domain_check/lookalike_domain_check.mjs', 'fetcher_review/fetcher_review.mjs',
      'redirect_inspector/redirect_inspector.mjs']);
    if (!approved.has(script) || !args.every(a => typeof a === 'string' && a.length <= 2048))
      refuse('unsupported specialist request');
    const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {cwd: ROOT, shell: false,
      windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      env: {...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '1'}});
    diagnostic('APPROVED_SPECIALIST', `${script} exit=${r.status ?? 'not-started'}`);
    // Preserve the check's partial findings and exact refusal reason even if it exits nonzero.
    // Without this, remote helpers see only a generic "not completed" message.
    if (r.stdout) console.log(maskForStorage(r.stdout.trimEnd()));
    if (r.stderr) console.log(maskForStorage(r.stderr.trimEnd()));
    if (r.error || ![0, ...findingCodes].includes(r.status)) {
      const kind = failureKind(r.error ?? {message: r.stderr || r.stdout});
      refuse(`${script}: check incomplete (${kind}; exit ${r.status ?? 'unknown'}). Findings printed above remain available but missing checks are NOT VERIFIED. This does not establish a problem with the client's target.`);
    }
  };
  const scopeFile = async () => join(currentCase(await chooseCase()).dir, 'scope.json');
  const permittedLookup = async () => {
    console.log('This sends a limited, scoped request to outside public information services.');
    console.log('No request is made unless the incident scope permits its target and disclosures.');
    if (await ask('Type LOOKUP to permit the existing scoped check: ') !== 'LOOKUP') throw new MenuBack();
    return scopeFile();
  };
  const plainDomain = async () => {
    const domain = (await ask('Domain name (example.org): ')).toLowerCase();
    if (!/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) refuse('enter a plain domain name');
    return domain;
  };
  const repoName = async () => {
    const repo = await ask('Public GitHub owner/repository: ');
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) refuse('enter owner/repository');
    return repo;
  };
  try {
    while (true) {
      if (!preselected) console.log(menu);
      let choice = '';
      try {
        const groupNumber = preselected ? String(preselected.group) : await ask('Tool number: ');
        if (groupNumber === '0' || !groupNumber) return;
        if (!/^(?:[1-9]|1[0-4])$/.test(groupNumber)) { console.log('Choose a number from 1 to 14.'); continue; }
        const group = groups[Number(groupNumber) - 1];
        console.log(`\n${group.name}`);
        group.actions.forEach((action, i) => console.log(`  ${i + 1}  ${action.label}`));
        console.log('  0  Main menu');
        const selection = preselected ? String(preselected.action) : await ask('Action number (0 for main menu): ');
        if (selection === '0' || !selection) continue;
        if (!/^\d{1,2}$/.test(selection) || Number(selection) < 1 || Number(selection) > group.actions.length) {
          console.log('Choose a displayed action number; nothing was changed.'); continue;
        }
        choice = group.actions[Number(selection) - 1].code;
        diagnostic('MENU_CHOICE', `tool=${groupNumber} action=${choice}`);
        if (choice === '1') console.log('Created:', newCase(await ask('Case ID: '), await ask('Domain or owner/repo: '), await ask('Question: ')));
        else if (choice === '2') console.log('Saved revision:', appendEvidence(await chooseCase(), await ask('Reported information (not verified): '), await ask('Reference to source (e.g. issue-1): ')));
        else if (choice === '3') console.log('Saved revision:', appendEvidence(await chooseCase(), await ask('Directly observed information: '), await ask('HTTP(S) source URL: '), true));
        else if (choice === '4') console.log('Saved:', reports(await chooseCase()).join('\n'));
        else if (choice === '5') console.table(listCases());
        else if (choice === '6') {
          const id = await ask('Incident ID (must have committed authority scope before approval): ');
          const kind = await askChoice('Register kind', ['service','data','access']);
          const op = await askChoice('Review request type', ['create','replace']);
          const path = await ask('Existing JSON input path (inside toolbox): ');
          const why = await ask('Reason (optional): ');
          console.log(prepareRegisterRequest(id, kind, op, path, why || undefined));
        } else if (choice === '7') console.log(inspectRequest(await chooseRequest()));
        else if (choice === '8') console.log(registerReport(await askChoice('Register kind', ['service','data','access']), await ask('Existing register JSON path: '), (await ask('As-of date YYYY-MM-DD (blank for today): ')) || undefined));
        else if (choice === '9') await guidedOffboarding();
        else if (choice.toUpperCase() === 'A') console.log(timelineReport(await ask('Timeline JSON path: ')));
        else if (choice.toUpperCase() === 'B') console.log(backupPreview(await ask('Backup selection JSON path: ')));
        else if (choice.toUpperCase() === 'C') console.log(prepareEmptyRegister(await ask('Committed incident ID (required later for approval): '), await askChoice('Register kind', ['service','data','access'])));
        else if (choice.toUpperCase() === 'D') {
          const dir = await chooseRequest();
          console.log('Review before submitting:', inspectRequest(dir));
          if (await ask('Type SEND to submit (anything else cancels): ') !== 'SEND') { console.log('Cancelled.'); continue; }
          const pipe = await ask('Local pipe name displayed by owner console: ');
          const codeHex = await ask('One-time 32-digit hexadecimal code: ');
          console.log(await submitPreparedRequest(dir, { pipe, codeHex }));
        }
        else if (choice.toUpperCase() === 'E') {
          const id = await ask('Committed incident ID: ');
          const folder = await ask('Local text folder (inside toolbox): ');
          const preview = previewRestoreSelection(id, folder);
          console.log('RESTORE REVIEW REQUEST PREVIEW — no restoration or approval is performed:');
          console.log(JSON.stringify(preview, null, 2));
          if (await ask('Type PREPARE to save this exact reviewed selection (anything else cancels): ') !== 'PREPARE') {
            console.log('Cancelled. No restore request was created.'); continue;
          }
          console.log(prepareRestoreRequest(id, folder, undefined, preview));
        }
        else if (choice.toUpperCase() === 'F') {
          const id = await chooseCase();
          if (await ask(`Type ${id} again to confirm STOP (anything else cancels): `) === id) console.log(stopCase(id));
          else console.log('Cancelled.');
        }
        else if (choice.toUpperCase() === 'G') await guided();
        else if (choice.toUpperCase() === 'H') console.table(listPreparedRequests().map(({ name, operation, incident, status }) => ({ name, operation: operation ?? '-', incident: incident ?? '-', status })));
        else if (choice.toUpperCase() === 'I') console.log(scanSourceFolder(await ask('Local source folder to discover: ')));
        else if (choice.toUpperCase() === 'J') console.log(scanSourceConfig(await ask('Existing scan config JSON path: ')));
        else if (choice.toUpperCase() === 'K') {
          console.log('Dependencies: 1 Review local npm project (recommended) | 2 Existing dependency configuration JSON');
          const selection = await ask('Choose 1 or 2: ');
          if (selection === '1') {
            const dir = await ask('Local npm project folder inside toolbox: ');
            const version = await ask('Source version / date label: ');
            const result = reviewLocalDependencies(dir, version);
            console.log(`Found ${result.count} locked npm package(s). ${result.unknownLicenses} have no reported license metadata.`);
            console.log('Vulnerability status is UNKNOWN: no advisory database was fetched or checked. Licenses need manual review.');
            console.log(`Detailed offline report: ${result.reportFile}`);
            console.log(`Reviewed input configuration: ${result.config}`);
          } else if (selection === '2') {
            console.log(dependencyReport(await ask('Existing dependency config JSON path: ')));
          } else console.log('Cancelled; no inventory ran.');
        }
        else if (choice.toUpperCase() === 'L') console.log(cleanImageCopies(await chooseCase(), await ask('Image file or folder to clean (originals untouched): ')));
        else if (choice.toUpperCase() === 'M') console.log(prepareNotice(await chooseCase(), await askChoice('Notice audience', ['organization','maintainer','registrar','host'])));
        else if (choice.toUpperCase() === 'O') console.log(emailHeaderReview(await ask('Local .eml path inside toolbox: '), await ask('Expected sender domain (optional): ')));
        else if (choice.toUpperCase() === 'P') await guidedDirectoryAudit();
        else if (choice.toUpperCase() === 'Q') console.log(offlineUrlCheck(await ask('Full URL to check (no network request): ')));
        else if (choice.toUpperCase() === 'R') console.log(scanDisclosure(await ask('Reviewed static scan configuration JSON: ')));
        else if (choice.toUpperCase() === 'S') await guidedStaticScan();
        else if (choice.toUpperCase() === 'T') console.log(caseOverview(await chooseCase()));
        else if (choice.toUpperCase() === 'U') await timelineMenu();
        else if (choice.toUpperCase() === 'V') {
          const providers = listRecoveryProviders();
          console.log('Account recovery guidance for an authorized organization representative. No account access or provider contact.');
          console.log('  0  General recovery checklist');
          providers.forEach((p, i) => console.log(`  ${i + 1}  ${p.name}`));
          const selected = selectRecoveryProvider(providers, await ask('Guide number or exact provider key (blank for general): '));
          console.log(recoveryGuide(selected));
        }
        else if (choice.toUpperCase() === 'W') console.log(listLookalikeCandidates(await ask('Domain (no DNS requests): ')));
        else if (choice.toUpperCase() === 'X') await caseReviewMenu();
        else if (choice.toUpperCase() === 'Y') await reviewedBackupMenu();
        else if (choice.toUpperCase() === 'CLIENT_DEVICE') {
          console.log('Ask the client to run CLIENT_DEVICE_CHECK.cmd from the provided small collector ZIP.');
          console.log('Have them review and voluntarily send the resulting report ZIP. No remote access is used.');
          console.log(reviewClientDeviceReport(await ask('Path to the client report ZIP from Downloads: ')));
        }
        else if (choice.toUpperCase() === 'DEVICE') console.log(JSON.stringify(deviceStatus(), null, 2));
        else if (choice === 'EMAIL_COMM') await emailMenu({ask,chooseCase,
          suggest: (id,audience) => {
            const c=currentCase(id);
            const proposal=draftNotice(c.ledger,{audience});
            if(proposal.warnings.length)refuse('notice contains unverified verdict language; review evidence first');
            const lines=proposal.text.split('\n');
            const subject=lines[0].replace(/^Subject: /,'');
            const end=lines.indexOf('----');
            return {subject,body:lines.slice(2,end>=0?end:undefined).join('\n').trim()};
          }});
        else if (choice.toUpperCase() === 'N') {
          const id = await chooseCase();
          console.log('Review all case content for names, addresses, faces, and visible personal information before proceeding.');
          const additional = [];
          console.log('Supporting evidence: Enter to include none | 1 file paths | 2 numbered files in a folder');
          const evidenceMode = await ask('Choose optional evidence mode (blank/1/2): ');
          if (evidenceMode === '1') {
            while (additional.length < 30) {
              const file = await ask('Optional supporting evidence file inside toolbox (blank when finished): ');
              if (!file) break;
              additional.push(ensureInside(file));
            }
          } else if (evidenceMode === '2') {
            const folder = await ask('Folder containing optional supporting files: ');
            const candidates = discoverBackupCandidates(folder).filter(({ relativePath }) =>
              /\.(?:md|txt|json|csv|png|jpe?g)$/i.test(relativePath));
            if (!candidates.length) { console.log('No supported files found; no packet created.'); throw new MenuBack(); }
            console.log('Files eligible for manual selection (not automatically included):');
            for (let offset = 0; offset < candidates.length; offset += 40) {
              for (let i = offset; i < Math.min(offset + 40, candidates.length); i++)
                console.log(`  ${i + 1}  ${candidates[i].relativePath}  (${candidates[i].bytes} bytes)`);
              if (offset + 40 < candidates.length &&
                  (await ask('Type NEXT to view more files (anything else cancels): ')) !== 'NEXT') {
                console.log('Cancelled; no packet created.'); throw new MenuBack();
              }
            }
            additional.push(...selectBackupCandidateNumbers(candidates,
              await ask('Enter up to 30 file numbers (e.g. 1,3-5): ')));
            if (additional.length > 30) refuse('choose no more than 30 supporting evidence files');
          } else if (evidenceMode !== '') { console.log('Cancelled; no packet created.'); continue; }
          const snapshot = previewCasePacket(id, additional);
          console.log('CURRENT CASE REVISION:', snapshot.revision);
          console.log('CURRENT CASE LEDGER AND REVIEW (inspect carefully for personal details):');
          console.log(JSON.stringify(caseEvidence(id), null, 2));
          console.log('DECISION SUMMARY:');
          console.log(renderSummary(currentCase(id).ledger));
          console.log('Case review summary:', JSON.stringify(caseOverview(id).review, null, 2));
          console.log('Supporting files and their exact SHA-256 fingerprints:',
            JSON.stringify(snapshot.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), null, 2));
          console.log('This will include the current case ledger, decision summary, and the listed evidence files.');
          if ((await ask('Type REVIEWED only after manually checking the case content and every selected file: ')) === 'REVIEWED')
            console.log(exportCasePacket(id, true, additional, snapshot));
          else console.log('Cancelled; no packet created.');
        }
        else if (choice === 'GITHUB') {
          const action = await askChoice('GitHub evidence', ['issue','run','file','snapshot','status']);
          if (action === 'status') {
            const manifest = ensureInside(await ask('Existing snapshot MANIFEST.json path: '));
            const scope = await scopeFile();
            specialist('github_evidence/github_evidence.mjs', ['status', manifest, '--scope', scope]);
          } else {
            const repo = await repoName();
            const scope = await permittedLookup();
            if (['issue','run'].includes(action)) {
              const id = await ask('Issue or run number (digits only): ');
              if (!/^\d{1,15}$/.test(id)) refuse('enter an issue/run number');
              specialist('github_evidence/github_evidence.mjs', [action, repo, id, '--scope', scope], {findingCodes: action === 'run' ? [3] : []});
            } else if (action === 'file') {
              const path = await ask('Repository file path: ');
              const ref = await ask('Commit hash, tag or branch: ');
              if (!path || !ref || path.length > 512 || ref.length > 128 || /^-/.test(path) || /^-/.test(ref))
                refuse('invalid repository file or revision');
              specialist('github_evidence/github_evidence.mjs', ['file', repo, path, '--ref', ref, '--scope', scope]);
            } else {
              console.log('Snapshots save masked copies only and require incident permission for local persistence.');
              if (await ask('Type SNAPSHOT to continue: ') !== 'SNAPSHOT') throw new MenuBack();
              const ref = await ask('Revision to snapshot: ');
              const paths = await ask('Comma-separated repository file paths: ');
              if (!ref || !paths || ref.length > 128 || paths.length > 1024 || /^-/.test(ref) || /^-/.test(paths))
                refuse('invalid revision or paths');
              specialist('github_evidence/github_evidence.mjs', ['snapshot', repo, '--ref', ref, '--paths', paths, '--scope', scope]);
            }
          }
        }
        else if (choice === 'DOMAIN') {
          const mode = await askChoice('Public records', ['rdap','dns','ct','archive','all']);
          const domain = await plainDomain();
          const args = [mode, domain];
          if (mode === 'dns' || mode === 'all') {
            // Existing DNS methods, not new tools. DoH is an explicit third-party disclosure,
            // never a silent fallback if a local resolver cannot be reached.
            const via = await askChoice('DNS resolver (requires corresponding scope disclosure)',
              ['System default DNS', 'Cloudflare DNS-over-HTTPS', 'Google DNS-over-HTTPS']);
            if (via === 'Cloudflare DNS-over-HTTPS') args.push('--doh', 'cloudflare');
            if (via === 'Google DNS-over-HTTPS') args.push('--doh', 'google');
          }
          const scope = await permittedLookup();
          specialist('domain_research/domain_research.mjs', [...args, '--scope', scope]);
        }
        else if (choice === 'WATCH') {
          const domain = await plainDomain();
          const scope = await permittedLookup();
          specialist('domain_watch/domain_watch.mjs', ['check', domain, '--scope', scope], {findingCodes: [1,3]});
        }
        else if (choice === 'REDIRECT') {
          console.log('Live inspection requires the original verified inspect-mode Windows Sandbox and an incident-specific operator attestation.');
          console.log('The specialist independently refuses unverified Windows environments, unscoped URLs, and unauthorised requests.');
          const url = await ask('Exact HTTPS URL to inspect: ');
          if (!/^https:\/\/[^\s]{1,2048}$/i.test(url)) refuse('enter an exact HTTPS URL');
          const scope = await permittedLookup();
          if (await ask(`Retype the exact URL to confirm this live request: `) !== url) throw new MenuBack();
          specialist('redirect_inspector/redirect_inspector.mjs', ['inspect', url, '--scope', scope, '--live', '--approve', url]);
        }
        else if (choice === 'LOOKALIKE') {
          const domain = await plainDomain();
          const scope = await permittedLookup();
          specialist('lookalike_domain_check/lookalike_domain_check.mjs', ['check', domain, '--scope', scope], {findingCodes: [3]});
        }
        else if (choice === 'SPOOF') {
          const domain = await plainDomain();
          const scope = await permittedLookup();
          specialist('email_spoof_check/email_spoof_check.mjs', ['check', domain, '--scope', scope], {findingCodes: [3]});
        }
        else if (choice === 'FETCHER') {
          const dir = ensureInside(await ask('Existing project source folder inside toolbox: '));
          if (!lstatSync(dir).isDirectory()) refuse('choose a source folder');
          specialist('fetcher_review/fetcher_review.mjs', ['scan', dir]);
        }
        else console.log('Unknown choice.');
        diagnostic('MENU_OK', choice.toUpperCase());
      } catch (e) {
        if (e instanceof MenuBack) {
          diagnostic('MENU_CANCEL', /^(?:[0-9A-Y]|DEVICE)$/i.test(choice) ? choice.toUpperCase() : 'menu');
          console.log('Cancelled; returning to main menu.');
          continue;
        }
        if (inputWasInterrupted(e)) {
          diagnostic('MENU_EXIT', 'keyboard interrupt / input closed');
          console.log('Toolbox closed by operator.');
          return; // readline is already closed after Ctrl+C: do not call question() again
        }
        diagnosticError(`menu option ${/^(?:[0-9A-Y]|DEVICE)$/i.test(choice) ? choice.toUpperCase() : 'unknown'}`, e);
        console.log(`Refused: ${e.message}`);
        console.log(`Details were saved to ${diagnosticsPath}`);
        if (preselected) process.exitCode = 2;
      } finally {
        // GUI-launched operations run only the selected existing action.
        // Even cancelled choices must not reopen an unrelated main menu.
        if (preselected) return;
      }
    }
  } finally { io.close(); }
}
const HELP = `Usage: node toolbox/toolbox.mjs [command args...]\nCommands:\n  (none)                            guided Windows menu\n  new-case ID TARGET QUESTION\n  add-report ID TEXT SOURCE_REF\n  add-observation ID TEXT SOURCE_URL\n  reports ID\n  list\n  prepare-register ID service|data|access create|replace INPUT_JSON [REASON]\n  inspect-request DIR\n  register-report service|data|access INPUT_JSON [YYYY-MM-DD]\n  offboarding INPUT_JSON ROLE\n  timeline INPUT_JSON\n  backup-preview SELECTION_JSON\n  empty-register ID service|data|access\n  list-requests\n  scan-discover LOCAL_FOLDER\n  scan-source CONFIG_JSON\n  dependency-report CONFIG_JSON\n  clean-images CASE_ID IMAGE_OR_FOLDER\n  notice-draft CASE_ID organization|maintainer|registrar|host\n  case-packet CASE_ID (interactive menu only; requires manual review)\n  prepare-restore ID LOCAL_TEXT_FOLDER [REASON]\n  stop-case ID\n  email-headers LOCAL_EML [EXPECTED_DOMAIN]\n  directory-audit LOCAL_JSON_OR_DIR\n  check-url HTTP_URL\n  scan-disclosure CONFIG_JSON\n  discover-scan LOCAL_FOLDER (preview only; use menu S to run)\n  case-overview CASE_ID\n  case-evidence CASE_ID\n  review-check CASE_ID checked|not_checked DESCRIPTION\n  review-risk CASE_ID ASSESSMENT\n  review-next CASE_ID ACTION PERMISSION_NEEDED\n  review-hypothesis CASE_ID STATEMENT [SUPPORTING_EIDS] [AGAINST_EIDS]\n  review-analysis CASE_ID inference|recommendation|decision DESCRIPTION [BASIS_EIDS]\n  create-timeline CASE_ID SCENARIO real|exercise\n  add-timeline-event CASE_ID STAGE confirmed|reported|unknown|simulated REFERENCE\n  record-timeline-decision CASE_ID STAGE OWNER_ROLE REFERENCE true|false\n  case-timeline CASE_ID\n  recovery-guide [PROVIDER|list]\n  lookalike-preview DOMAIN\n  device-status (this PC; Windows only, read-only)
  client-device-report CLIENT_ZIP (offline review of client's report ZIP)\nThere are no install, activate, apply, or direct-update commands.\n`;
export async function main(argv) {
  const [cmd, ...a] = argv;
  diagnostic('START', `Node=${process.version}; mode=${cmd || 'menu'}`);
  if (!cmd) { if (!process.stdin.isTTY) { console.log(HELP); return; } return interactive(); }
  if (cmd === '--menu-action') {
    // Private UI route to the exact same guided action as the console menu.
    // There are fourteen owner-approved tools, and no bypass of confirmations.
    if (a.length !== 2 || !/^(?:[1-9]|1[0-4])$/.test(a[0]) || !/^\d{1,2}$/.test(a[1]) ||
        Number(a[1]) < 1 || Number(a[1]) > TOOL_GROUPS[Number(a[0]) - 1].actions.length)
      refuse('invalid tool or action button');
    if (!process.stdin.isTTY) refuse('the guided action needs an interactive console');
    return interactive({group: Number(a[0]), action: Number(a[1])});
  }
  if (['help', '--help', '-h'].includes(cmd)) return console.log(HELP);
  const arities = { 'new-case': 3, 'add-report': 3, 'add-observation': 3, reports: 1, list: 0, 'prepare-register': 4, 'inspect-request': 1, 'register-report': 2, 'offboarding': 2, timeline: 1, 'backup-preview': 1, 'empty-register': 2, 'prepare-restore': 2, 'stop-case': 1, 'list-requests': 0, 'scan-discover': 1, 'scan-source': 1, 'dependency-report': 1, 'clean-images': 2, 'notice-draft': 2, 'case-packet': 1, 'email-headers': 1, 'directory-audit': 1, 'check-url': 1, 'scan-disclosure': 1, 'discover-scan': 1, 'case-overview': 1, 'case-evidence': 1, 'review-check': 3, 'review-risk': 2, 'review-next': 3, 'review-hypothesis': 2, 'review-analysis': 3, 'create-timeline': 3, 'add-timeline-event': 4, 'record-timeline-decision': 5, 'case-timeline': 1, 'recovery-guide': 0, 'lookalike-preview': 1, 'device-status': 0, 'client-device-report': 1 };
  if (!(cmd in arities) || a.length < arities[cmd] || (!['prepare-register', 'register-report', 'prepare-restore', 'email-headers', 'recovery-guide', 'review-hypothesis', 'review-analysis'].includes(cmd) && a.length !== arities[cmd]) || a.length > 5) refuse(`invalid command/arguments\n${HELP}`);
  if (cmd === 'record-timeline-decision' && !['true', 'false'].includes(a[4])) refuse('decision complete must be true or false');
  const out = cmd === 'new-case' ? newCase(...a) : cmd === 'add-report' ? appendEvidence(...a) : cmd === 'add-observation' ? appendEvidence(...a, true)
    : cmd === 'reports' ? reports(...a) : cmd === 'list' ? listCases()
    : cmd === 'prepare-register' ? prepareRegisterRequest(...a) : cmd === 'inspect-request' ? inspectRequest(...a)
    : cmd === 'register-report' ? registerReport(...a) : cmd === 'offboarding' ? offboardingChecklist(...a)
    : cmd === 'timeline' ? timelineReport(...a) : cmd === 'backup-preview' ? backupPreview(...a) : cmd === 'empty-register' ? prepareEmptyRegister(...a) : cmd === 'prepare-restore' ? prepareRestoreRequest(...a) : cmd === 'list-requests' ? listPreparedRequests() : cmd === 'scan-discover' ? scanSourceFolder(...a) : cmd === 'scan-source' ? scanSourceConfig(...a) : cmd === 'dependency-report' ? dependencyReport(...a) : cmd === 'clean-images' ? cleanImageCopies(...a) : cmd === 'notice-draft' ? prepareNotice(...a) : cmd === 'case-packet' ? refuse('case packet creation requires the interactive REVIEWED confirmation') : cmd === 'email-headers' ? emailHeaderReview(...a) : cmd === 'directory-audit' ? directoryAudit(...a) : cmd === 'check-url' ? offlineUrlCheck(...a) : cmd === 'scan-disclosure' ? scanDisclosure(...a) : cmd === 'discover-scan' ? discoverScanSelection(...a) : cmd === 'case-overview' ? caseOverview(...a) : cmd === 'case-evidence' ? caseEvidence(...a) : cmd === 'review-check' ? recordReviewCheck(...a) : cmd === 'review-risk' ? recordRisk(...a) : cmd === 'review-next' ? recordNextStep(...a) : cmd === 'review-hypothesis' ? recordHypothesis(...a) : cmd === 'review-analysis' ? recordAnalysis(...a) : cmd === 'create-timeline' ? createCaseTimeline(...a)
    : cmd === 'add-timeline-event' ? addTimelineEvent(...a) : cmd === 'record-timeline-decision' ? recordTimelineDecision(...a.slice(0, 4), a[4] === 'true')
    : cmd === 'case-timeline' ? caseTimelineReport(...a) : cmd === 'recovery-guide' ? recoveryGuide(...a)
    : cmd === 'lookalike-preview' ? listLookalikeCandidates(...a)
    : cmd === 'device-status' ? deviceStatus() : cmd === 'client-device-report' ? reviewClientDeviceReport(...a) : stopCase(...a);
  console.log(Array.isArray(out) || (out && typeof out === 'object') ? JSON.stringify(out, null, 2) : out);
  diagnostic('COMMAND_OK', cmd);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(() => diagnostic('END', `exit=${process.exitCode || 0}`))
    .catch((e) => {
      try { diagnosticError('command failure', e); } catch (logError) { console.error('Diagnostic logging also failed:', logError.message); }
      console.log(`Refused: ${e.message}`);
      console.log(`Details: ${diagnosticsPath}`);
      process.exitCode = 2;
    });
}
