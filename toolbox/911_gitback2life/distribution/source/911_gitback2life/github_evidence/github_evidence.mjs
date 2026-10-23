#!/usr/bin/env node
// Read-only public GitHub evidence collector. GET requests only, to api.github.com and codeload.github.com.
// It never comments, creates issues, branches, PRs or commits, and never triggers workflows.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, maskForStorage, nowUtc, printJson, safeWrite, TOOLBOX_ROOT } from '../_shared/common.mjs';
import { plainText } from '../_shared/output.mjs';
import { politeFetch, printRunReport } from '../_shared/polite.mjs';
import { provenance, requireSameIncident, requireScope } from '../_shared/scope.mjs';
import { userAgent } from '../_shared/robots.mjs';

const API = 'https://api.github.com';
// #10 (owner's decision): no raw copies are kept. Snapshot files are MASKED copies; GitHub's blob SHA identifies the original.
export const MASKED_EVIDENCE_HANDLING = `MODIFIED EVIDENCE: these files are masked copies made before saving (secrets, credentials and contact details removed), not the originals. Each file's original is identified by its GitHub blob SHA in MANIFEST.json; masked_sha256 is the copy kept here. View only as plain text.`;
const ALLOWED_HOSTS = new Set(['api.github.com', 'codeload.github.com']);
const MAX_PAGES = 10;

export class GhError extends Error {}
export const rate = { remaining: null };
let tokenWarned = false;

/** Refuse any GITHUB_TOKEN that is not a fine-grained personal access token. The token itself is never echoed. */
export function tokenProblem(token) {
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(String(token).trim())) return;
  const kind = /^ghp_/.test(token) ? 'a classic personal access token (ghp_…)' : /^gh[osur]_/.test(token) ? 'an OAuth/app/server token' : 'not a recognised GitHub token';
  throw new GhError(`GITHUB_TOKEN is ${kind}. Only fine-grained, read-only tokens (github_pat_…) are accepted, because other kinds commonly carry broad permissions. Unset GITHUB_TOKEN, or create a fine-grained token with read-only access to public repositories.`);
}

export async function ghGet(url, { accept = 'application/vnd.github+json', fetchImpl = politeFetch, maxBytes = 20 * 1024 * 1024 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new GhError(`blocked host ${u.hostname}: only api.github.com and codeload.github.com are allowed`);
  }
  const headers = { Accept: accept, 'User-Agent': userAgent('github-evidence'), 'X-GitHub-Api-Version': '2022-11-28' };
  // Optional token. Never printed. Only fine-grained tokens (github_pat_…) are accepted: classic tokens (ghp_…) and
  // the other kinds commonly carry broad permissions. Even a fine-grained token's permissions are NOT verified (the
  // API does not reliably report them), so say so every run that uses one (TOOLKIT_RULES 6c).
  if (process.env.GITHUB_TOKEN) {
    tokenProblem(process.env.GITHUB_TOKEN);
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    if (!tokenWarned) {
      tokenWarned = true;
      console.error('note: using GITHUB_TOKEN. Its permissions are not checked by this tool; use a fine-grained, read-only, public-repository token only.');
    }
  }
  const res = await fetchImpl(u, { method: 'GET', headers, signal: AbortSignal.timeout(120_000), maxBytes });
  rate.remaining = res.headers.get('x-ratelimit-remaining') ?? rate.remaining;
  if (!res.ok) {
    let hint = '';
    if (res.status === 404) hint = ' (not found, private, or needs auth)';
    else if (res.status === 401) hint = ' (authentication required)';
    else if (res.status === 403 || res.status === 429) {
      hint = rate.remaining === '0' ? ' (rate limited: 60 unauthenticated requests/hour)' : ' (forbidden: may need a read-only token)';
    }
    throw new GhError(`GET ${u.pathname} -> HTTP ${res.status}${hint}`);
  }
  return res;
}

const getJson = async (url) => (await ghGet(url)).json();

async function getPaged(url, key) {
  const out = [];
  let next = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const res = await ghGet(next);
    const body = await res.json();
    out.push(...(key ? body[key] : body));
    next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  }
  return out;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Accept either `owner/repo ID` or a full github.com URL. */
export function repoAndId(positionals, segment) {
  const [a, b] = positionals;
  if (a?.startsWith('https://github.com/')) {
    const m = new RegExp(`^https://github\\.com/([\\w.-]+/[\\w.-]+)/${segment}/(\\d+)`).exec(a);
    if (!m) throw new GhError(`expected a https://github.com/owner/repo/${segment}/<id> URL`);
    return [m[1], m[2]];
  }
  if (!REPO_RE.test(a ?? '') || !/^\d+$/.test(b ?? '')) throw new GhError('usage: <owner/repo> <id>, or a full github.com URL');
  return [a, b];
}

/** Lines matching `pattern` with `context` lines around them, redacted and capped. */
export function excerpt(text, pattern, { context = 1, maxLines = 40 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const keep = new Set();
  if (!pattern) lines.forEach((_, i) => keep.add(i));
  else {
    const re = new RegExp(pattern, 'i');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
    });
  }
  return [...keep].sort((x, y) => x - y).slice(0, maxLines).map((i) => ({ n: i + 1, text: plainText(lines[i]).slice(0, 400) })); // output guard: secrets, contacts, secret URLs (F07)
}

function printLines(rows, indent = '  ') {
  let prev = 0;
  for (const r of rows) {
    if (prev && r.n !== prev + 1) console.log(`${indent}   …`);
    console.log(`${indent}${String(r.n).padStart(4)} │ ${r.text}`);
    prev = r.n;
  }
  if (!rows.length) console.log(`${indent}(no matching lines)`);
}

function parseRange(spec, total) {
  if (!spec) return [1, total];
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (!m) throw new GhError('--lines must look like 40-80');
  return [Number(m[1]), Math.min(Number(m[2]), total)];
}

export async function resolveCommit(repo, ref) {
  const c = await getJson(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  return { sha: c.sha, date: c.commit?.committer?.date ?? null };
}

export async function fetchFileAt(repo, path, sha) {
  if (path.split('/').some((seg) => seg === '..' || seg === '')) throw new GhError(`invalid path ${path}`);
  const p = path.split('/').map(encodeURIComponent).join('/');
  const url = `${API}/repos/${repo}/contents/${p}?ref=${sha}`;
  const meta = await getJson(url);
  if (Array.isArray(meta) || meta.type !== 'file') throw new GhError(`${path} is not a file`);
  const text = meta.encoding === 'base64' && meta.content
    ? Buffer.from(meta.content, 'base64').toString('utf8')
    : await (await ghGet(url, { accept: 'application/vnd.github.raw+json' })).text();
  return { path, blob_sha: meta.sha, size: meta.size, permalink: `https://github.com/${repo}/blob/${sha}/${path}`, text };
}

async function cmdIssue(pos, o) {
  const [repo, num] = repoAndId(pos, 'issues');
  const retrieved_at = nowUtc();
  const issue = await getJson(`${API}/repos/${repo}/issues/${num}`);
  const comments = issue.comments > 0 ? await getPaged(`${API}/repos/${repo}/issues/${num}/comments?per_page=100`) : [];
  const record = {
    kind: 'github_issue', repo, number: issue.number, url: issue.html_url, title: plainText(issue.title), state: issue.state,
    author: issue.user?.login ?? null, created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
    retrieved_at, body: plainText(issue.body ?? ''), output_guarded: true,
    comments: comments.map((c) => ({ id: c.id, url: c.html_url, author: c.user?.login ?? null, created_at: c.created_at, updated_at: c.updated_at, body: plainText(c.body ?? '') })),
  };
  if (o.json) printJson(record);
  else {
    console.log(`ISSUE ${repo}#${record.number}: ${record.title}`);
    console.log(`  ${record.url}\n  state=${record.state} created=${record.created_at} updated=${record.updated_at} retrieved=${retrieved_at}`);
    printLines(excerpt(record.body, o.grep, opts(o)));
    for (const c of record.comments) {
      console.log(`\nCOMMENT ${c.id} by ${c.author} created=${c.created_at} updated=${c.updated_at}\n  ${c.url}`);
      printLines(excerpt(c.body, o.grep, opts(o)));
    }
  }
  return record;
}

async function cmdRun(pos, o) {
  const [repo, id] = repoAndId(pos, 'actions/runs');
  const retrieved_at = nowUtc();
  const run = await getJson(`${API}/repos/${repo}/actions/runs/${id}`);
  const jobs = await getPaged(`${API}/repos/${repo}/actions/runs/${id}/jobs?per_page=100`, 'jobs');
  const record = {
    kind: 'github_actions_run', repo, run_id: run.id, url: run.html_url, name: run.name, event: run.event,
    status: run.status, conclusion: run.conclusion, head_branch: run.head_branch, head_sha: run.head_sha,
    run_attempt: run.run_attempt, created_at: run.created_at, run_started_at: run.run_started_at, updated_at: run.updated_at, retrieved_at,
    jobs: jobs.map((j) => ({
      id: j.id, name: j.name, url: j.html_url, status: j.status, conclusion: j.conclusion, started_at: j.started_at, completed_at: j.completed_at,
      steps: (j.steps ?? []).map((s) => ({ number: s.number, name: plainText(s.name), status: s.status, conclusion: s.conclusion })),
    })),
  };
  if (o['logs-grep']) {
    for (const j of record.jobs) {
      try {
        const text = await (await ghGet(`${API}/repos/${repo}/actions/jobs/${j.id}/logs`, { accept: '*/*', maxBytes: 50 * 1024 * 1024 })).text();
        j.log_excerpt = excerpt(text, o['logs-grep'], opts(o));
      } catch (e) {
        j.log_error = `${e.message}. GitHub requires a token (Actions: read) to download logs, even for public repos.`;
      }
    }
  }
  if (o['logs-grep'] && record.jobs.some(j => j.log_error)) record.verification = { status: 'partial', note: 'Run metadata was retrieved; some requested job logs could not be checked.' };
  if (o.json) printJson(record);
  else {
    console.log(`RUN ${repo} #${record.run_id} "${record.name}" (${record.event})`);
    console.log(`  ${record.url}\n  status=${record.status} conclusion=${record.conclusion} head_sha=${record.head_sha}`);
    console.log(`  created=${record.created_at} started=${record.run_started_at} updated=${record.updated_at} retrieved=${retrieved_at}`);
    for (const j of record.jobs) {
      console.log(`\n  JOB ${j.name}: ${j.conclusion ?? j.status}  ${j.url}`);
      for (const s of j.steps) console.log(`    ${String(s.number).padStart(2)}. [${s.conclusion ?? s.status}] ${s.name}`);
      if (j.log_excerpt) { console.log('    log excerpt:'); printLines(j.log_excerpt, '    '); }
      if (j.log_error) console.log(`    NOT VERIFIED: requested job logs unavailable: ${j.log_error}`);
    }
    if (record.verification?.status === 'partial') console.log('PARTIAL: GitHub run metadata checked; requested log evidence was not all available.');
  }
  if (record.verification?.status === 'partial') process.exitCode = 3;
  return record;
}

async function cmdFile(pos, o) {
  const [repo, path] = pos;
  if (!REPO_RE.test(repo ?? '') || !path) throw new GhError('usage: file <owner/repo> <path> --ref <branch|tag|sha>');
  if (!o.ref) throw new GhError('--ref is required so results are pinned to a known commit');
  const commit = await resolveCommit(repo, o.ref);
  const f = await fetchFileAt(repo, path, commit.sha);
  const lines = f.text.split(/\r?\n/);
  const [from, to] = parseRange(o.lines, lines.length);
  const rows = (o.grep ? excerpt(f.text, o.grep, opts(o)) : lines.slice(from - 1, to).map((t, i) => ({ n: from + i, text: redact(t) })));
  const record = { kind: 'github_file', repo, ref: o.ref, commit_sha: commit.sha, path, blob_sha: f.blob_sha, size: f.size, permalink: f.permalink, retrieved_at: nowUtc(), lines: rows };
  if (o.json) printJson(record);
  else {
    console.log(`FILE ${repo}:${path} @ ${o.ref} (commit ${commit.sha}, blob ${f.blob_sha})`);
    console.log(`  ${f.permalink}${o.lines ? `#L${from}-L${to}` : ''}\n  retrieved=${record.retrieved_at}`);
    printLines(rows);
  }
  return record;
}

async function cmdSnapshot(pos, o) {
  const [repo] = pos;
  if (!REPO_RE.test(repo ?? '') || !o.ref || !o.paths) throw new GhError('usage: snapshot <owner/repo> --ref <ref> --paths a.ts,b.ts');
  const commit = await resolveCommit(repo, o.ref);
  const outDir = o.out ?? join(TOOLBOX_ROOT, 'github_evidence', 'snapshots', `${repo.replace('/', '__')}@${commit.sha.slice(0, 12)}`);
  const fetched = [];
  for (const path of o.paths.split(',').map((p) => p.trim()).filter(Boolean)) fetched.push({ path, ...(await fetchFileAt(repo, path, commit.sha)) });
  return writeSnapshot({ repo, ref: o.ref, commit, outDir, files: fetched, overwrite: o.overwrite });
}

/**
 * Save a snapshot (#10): every file as a MASKED copy, labelled as modified evidence. The manifest identifies each
 * original by GitHub's blob SHA and records the masked copy's SHA-256 and whether masking changed it.
 * `files`: [{ path, text, blob_sha, size, permalink }]. Separate from fetching so it can be tested offline.
 */
export function writeSnapshot({ repo, ref, commit, outDir, files, overwrite = false }) {
  const saved = [];
  for (const f of files) {
    const masked = maskForStorage(f.text);
    safeWrite(join(outDir, ...f.path.split('/')), masked, { overwrite });
    saved.push({ path: f.path, blob_sha: f.blob_sha, size: f.size, permalink: f.permalink,
      masked_sha256: createHash('sha256').update(masked).digest('hex'), changed_by_masking: masked !== f.text });
    console.log(`  saved masked copy of ${f.path} (original blob ${f.blob_sha})`);
  }
  const manifest = { repo, ref, commit_sha: commit.sha, commit_date: commit.date, retrieved_at: nowUtc(), files: saved,
    raw_evidence: false, masked: true, evidence_status: MASKED_EVIDENCE_HANDLING, provenance: provenance() };
  safeWrite(join(outDir, 'MODIFIED_EVIDENCE.txt'), `MODIFIED_EVIDENCE.txt\n${MASKED_EVIDENCE_HANDLING}\n`, { overwrite });
  console.log(`manifest: ${safeWrite(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { overwrite })}`);
  return manifest;
}

async function cmdStatus(pos, o, scope) {
  const manifest = JSON.parse(readFileSync(pos[0] ?? fail('usage: status <MANIFEST.json>'), 'utf8'));
  // A snapshot is reused only under the incident that made it (unstamped manifests are refused too).
  requireSameIncident(scope, manifest.provenance?.incident_id, 'the snapshot manifest');
  const now = await resolveCommit(manifest.repo, manifest.ref);
  console.log(`${manifest.repo} @ ${manifest.ref}: snapshot commit ${manifest.commit_sha.slice(0, 12)} → current ${now.sha.slice(0, 12)} ${now.sha === manifest.commit_sha ? '(unchanged)' : '(MOVED)'}`);
  const results = [];
  for (const f of manifest.files) {
    let state;
    try {
      const cur = await fetchFileAt(manifest.repo, f.path, now.sha);
      state = cur.blob_sha === f.blob_sha ? 'unchanged' : 'CHANGED';
    } catch (e) { state = e.message.includes('404') ? 'MISSING' : `error: ${e.message}`; }
    console.log(`  ${state.padEnd(9)} ${f.path}`);
    results.push({ path: f.path, state });
  }
  return results;
}

/** #10 (owner's decision): an archive is opaque and cannot be masked, so it is never downloaded or kept. */
async function cmdArchive() {
  throw new GhError('archive is disabled: a zip cannot be masked, and the toolbox keeps masked copies only. Use "snapshot" for the specific files you need (saved as masked copies).');
}

const opts = (o) => ({ context: Number(o.context ?? 1), maxLines: Number(o['max-lines'] ?? 40) });

const HELP = `github_evidence: read-only public GitHub evidence (GET only; never writes to GitHub).

  issue  <owner/repo> <n> | <issue URL>      [--grep RE] [--json] [--save FILE]
  run    <owner/repo> <id> | <run URL>       [--logs-grep RE] [--json] [--save FILE]
  file   <owner/repo> <path> --ref REF       [--lines 40-80 | --grep RE] [--json] [--save FILE]
  snapshot <owner/repo> --ref REF --paths a,b,c [--out DIR]   save files + MANIFEST.json (blob SHAs)
  status <MANIFEST.json>                      have the snapshot's files changed since?
  archive                                     DISABLED: zips cannot be masked (masked copies only)

Options: --scope FILE (required: the repository must be a scope target and github a scope disclosure)
         --context N (default 1) --max-lines N (default 40) --overwrite
Set GITHUB_TOKEN to raise the 60/hour limit or to read Actions logs. It is never printed, and its permissions
are NOT verified: use a fine-grained, read-only, public-repository token only.
Polite limits: 1 request/second, capped per command; each command ends with a count of what was sent.`;

export async function main(argv) {
  const { values: o, positionals: [cmd, ...pos] } = parseArgs({ args: argv, allowPositionals: true, options: {
    grep: { type: 'string' }, 'logs-grep': { type: 'string' }, context: { type: 'string' }, 'max-lines': { type: 'string' },
    ref: { type: 'string' }, lines: { type: 'string' }, paths: { type: 'string' }, out: { type: 'string' },
    json: { type: 'boolean' }, save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    scope: { type: 'string' },
  } });
  const commands = { issue: cmdIssue, run: cmdRun, file: cmdFile, snapshot: cmdSnapshot, status: cmdStatus, archive: cmdArchive };
  if (!cmd || o.help) return console.log(HELP);
  if (!commands[cmd]) throw new GhError(`unknown command "${cmd}"\n\n${HELP}`);
  const repo = cmd === 'status' ? JSON.parse(readFileSync(pos[0] ?? '', 'utf8')).repo
    : pos[0]?.startsWith('https://github.com/') ? pos[0].split('/').slice(3, 5).join('/') : pos[0];
  const scope = requireScope(o.scope, { action: 'read_public_github', target: repo, services: ['github'] });
  if (cmd === 'archive') return cmdArchive(pos, o); // refuses before any authorization or request
  if (o.save || cmd === 'snapshot') requireScope(o.scope, { action: 'save_local' });
  const result = await commands[cmd](pos, o, scope);
  if (o.save && ['issue', 'run', 'file'].includes(cmd)) {
    const stamped = { ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }), provenance: provenance() };
    console.log(`saved ${safeWrite(o.save, JSON.stringify(stamped, null, 2) + '\n', { overwrite: o.overwrite })}`);
  }
  if (rate.remaining !== null) console.error(`(GitHub API requests remaining this hour: ${rate.remaining})`);
}

if (isMain(import.meta)) main(process.argv.slice(2)).finally(printRunReport).catch((e) => fail(e.message));
