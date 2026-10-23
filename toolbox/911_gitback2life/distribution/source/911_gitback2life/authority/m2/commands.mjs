import { maskStoredText } from './masking.mjs';
// M2 (design revision 3.3, §§7, 10, 13): the approve-change command over the M1 engine. Synthetic prototype: the
// signer, the console (display/confirm) and the clock are injected; tests use a dummy Ed25519 key. NOT installed.
// Production differences (M3/M4): the signer decrypts the protected key with the passphrase typed at the elevated
// console; ingestion is the pipe of §6; the masked-storage check is a protected copy, not the toolbox's.
import { createHash, randomBytes } from 'node:crypto';
import { canonical, verifyLedger } from '../m1/ledger.mjs';
import * as E from '../m1/engine.mjs';
import { REGISTERS, registerUpdate, serializeRegister, validateRegister, RuleError } from './register_rules.mjs';
import { decodeStrict, lineDiff, renderReview } from './renderer.mjs';
import { cancelKey, finalKey, tmpKey, treeHash, validateTreeFiles } from '../m3/tree.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const refuse = (m) => { throw new E.Refused(m); };
const WORDS = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'gale', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen', 'maple', 'nectar', 'onyx', 'pine',
  'quartz', 'raven', 'sage', 'tundra', 'umber', 'violet', 'willow', 'xenon', 'yarrow', 'zephyr', 'atlas', 'basil', 'comet', 'dune', 'elm', 'flint'];

/** Parse and check the ingested request (entries from the pipe's FrameReader). Untrusted until proven otherwise. */
export function parseRequest(entries) {
  if (entries.length !== 1 || entries[0].name !== 'request.json') refuse('register operations carry exactly one entry, request.json');
  let r;
  try { r = JSON.parse(decodeStrict(entries[0].data)); } catch (e) { refuse(e.render ? e.message : 'request.json is not valid JSON'); }
  if (!r || r.schema !== 1 || !['register.create', 'register.replace'].includes(r.operation)) refuse('unknown request schema or operation');
  if (!Object.hasOwn(REGISTERS, r.register_key)) refuse('register_key must be one of the protected registers');
  if (typeof r.incident_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(r.incident_id)) refuse('bad incident_id');
  if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 4000)) refuse('reason must be text of at most 4000 characters');
  if (r.operation === 'register.replace' && (!r.record || typeof r.record !== 'object')) refuse('register.replace needs a record');
  if (r.operation === 'register.create' && (!r.register || typeof r.register !== 'object')) refuse('register.create needs a register');
  return r;
}

/**
 * approve-change (§10): compute the proposed register INSIDE the authority, stage it, render the review, require the
 * confirmation code typed AFTER the review, sign, and commit through the M1 engine (all checks re-run there).
 * Options: { entries, signer(bytes) → base64, display(text), confirm() → typed text,
 *            rng(n) → Buffer, apply: boolean }
 */
export function approveChange(env, { entries, signer, display, confirm, rng = randomBytes, apply = false, ttlMinutes = 30 }) {
  const req = parseRequest(entries);
  const st = E.replay(verifyLedger(env.store.bytes).records);
  const scope = st.scopes[req.incident_id] ?? refuse('the incident has no committed scope');
  const key = req.register_key, kind = REGISTERS[key];
  const tgt = st.targets[key] ?? { generation: 0, sha: null, fileId: null };
  const current = env.disk.files.get(key);
  let proposed, priorText = '';
  try {
    if (req.operation === 'register.replace') {
      if (!current || tgt.sha === null) refuse('register.replace needs an existing register (use register.create)');
      if (sha(current.bytes) !== tgt.sha || current.id !== tgt.fileId) refuse('the register on disk does not match the ledger (drift: content or file identity); resolve it first');
      priorText = decodeStrict(current.bytes);
      proposed = registerUpdate(kind, JSON.parse(priorText), req.record, env.now().toISOString());
    } else {
      if (current || tgt.sha !== null) refuse('register.create needs the register to be absent');
      validateRegister(kind, req.register);
      if (req.register.history.length) refuse('a new register starts with an empty history');
      proposed = req.register;
    }
  } catch (e) { if (e instanceof RuleError || e.render) refuse(e.message); throw e; }
  const bytes = serializeRegister(proposed), text = bytes.toString('utf8');
  if (maskStoredText(text) !== text) refuse('the proposed register contains content that masked storage would change; it is refused, not transformed');

  const approvalId = rng(16).toString('hex');
  const expiresAt = new Date(env.now().getTime() + ttlMinutes * 60_000).toISOString();
  return finalize(env, {
    st, req, scope, approvalId, expiresAt, signer, display, confirm, rng, apply,
    staged: new Map([[key, bytes]]),
    target: { target_key: key, prior: tgt.sha ?? 'absent', prior_generation: tgt.generation, prior_file_id: tgt.fileId, proposed_sha256: sha(bytes), proposed_size: bytes.length },
    stagedSha: sha(bytes),
    summary: [`target:       ${key}`, `prior:        ${tgt.sha ? `${tgt.sha} (${current.bytes.length} bytes, generation ${tgt.generation})` : 'absent'}`, `proposed:     ${sha(bytes)} (${bytes.length} bytes)`],
    content: [{ title: 'Register change (prior -> proposed)', untrusted: { label: 'register diff', text: lineDiff(priorText, text) } }],
    // M2-F1: after the review and before signing, the register must still be exactly what the ledger records.
    recheck: () => { const f = env.disk.files.get(key); return (f ? sha(f.bytes) : null) === tgt.sha && (f ? f.id : null) === tgt.fileId; },
  });
}

/**
 * The shared, security-critical tail of every approve-change (§10): stage, render the review, show the confirmation
 * code AFTER the review, require it, re-check the target(s) on disk (bytes and identity), sign, and commit through
 * the M1 engine (which re-runs every check). Staging is removed on every refusal unless the approval was issued.
 */
function finalize(env, { st, req, scope, approvalId, expiresAt, staged, target, stagedSha, summary, content, recheck, signer, display, confirm, rng, apply }) {
  env.disk.staging.set(approvalId, staged);
  try {
    const review = renderReview([
      { title: 'Change to approve', lines: [
        `operation:    ${req.operation}`, `incident:     ${req.incident_id} (scope serial ${scope.serial})`, ...summary, `expires:      ${expiresAt}`,
        'The hashes identify content; they do not describe it. Read the change below.'] },
      ...content,
      ...(req.reason ? [{ title: 'Reason given in the request (not verified)', untrusted: { label: 'reason', text: req.reason } }] : []),
    ]);
    display(review);
    const code = [...rng(6)].map((b) => WORDS[b % WORDS.length]).join('-');
    display(`Type this confirmation code to approve: ${code}\n`);
    // Console confirmation and key unlock may both be asynchronous on Windows.
    // Preserve the existing synchronous return for the synthetic engine/tests.
    const commit = (typedCode) => {
      if (typedCode !== code) refuse('the confirmation code did not match; nothing was signed');
      if (!recheck()) refuse('the target changed during the review (content or file identity); nothing was signed');
      const payload = {
        kind: 'change-approval', policy_version: 2, authority_epoch: st.epoch, key_epoch: 1, approval_id: approvalId,
        operation: req.operation, incident_id: req.incident_id, scope_serial: scope.serial,
        targets: [target], staged_sha256: stagedSha, issued_at: env.now().toISOString(), expires_at: expiresAt,
      };
      const issue = (signature) => {
        E.approveCommit(env, { payload, signature }); // checks re-run under the existing engine
        const result = apply ? E.apply(env, approvalId) : 'issued';
        return { approvalId, review, result };
      };
      const signature = signer(Buffer.from(canonical(payload)));
      return signature && typeof signature.then === 'function' ? signature.then(issue) : issue(signature);
    };
    const typed = confirm();
    const result = typed && typeof typed.then === 'function' ? typed.then(commit) : commit(typed);
    return result && typeof result.then === 'function' ? result.catch(cleanupOnRefusal) : result;
  } catch (e) { return cleanupOnRefusal(e); }
  function cleanupOnRefusal(e) {
    if (!E.replay(verifyLedger(env.store.bytes).records).approvals[approvalId]) env.disk.staging.delete(approvalId);
    throw e;
  }
}

/**
 * M3 approve-change for restore.stage (§7): request.json plus "files/<relpath>" text entries. The authority names the
 * tree restores/<approval_id>, validates membership, text, limits and masked storage, shows the COMPLETE file list
 * and every file's content (the 2,000-line limit applies; larger restores must be split), then the shared tail.
 */
export function approveRestore(env, { entries, signer, display, confirm, rng = randomBytes, apply = false, ttlMinutes = 30 }) {
  if (!entries.length || entries[0].name !== 'request.json') refuse('the first entry must be request.json');
  let req;
  try { req = JSON.parse(decodeStrict(entries[0].data)); } catch (e) { refuse(e.render ? e.message : 'request.json is not valid JSON'); }
  if (!req || req.schema !== 1 || req.operation !== 'restore.stage') refuse('not a restore.stage request');
  if (typeof req.incident_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(req.incident_id)) refuse('bad incident_id');
  if (req.reason !== undefined && (typeof req.reason !== 'string' || req.reason.length > 4000)) refuse('reason must be text of at most 4000 characters');
  const files = new Map();
  for (const e of entries.slice(1)) {
    if (!e.name.startsWith('files/')) refuse(`unexpected entry ${e.name}`);
    files.set(e.name.slice('files/'.length), e.data);
  }
  let listing;
  try { listing = validateTreeFiles(files); } catch (e) { if (e.tree) refuse(e.message); throw e; }
  for (const [rel, bytes] of files) { const t = bytes.toString('utf8'); if (maskStoredText(t) !== t) refuse(`${rel} contains content that masked storage would change; it is refused, not transformed`); }
  const st = E.replay(verifyLedger(env.store.bytes).records);
  const scope = st.scopes[req.incident_id] ?? refuse('the incident has no committed scope');
  const approvalId = rng(16).toString('hex'), key = finalKey(approvalId);
  const total = listing.reduce((n, f) => n + f.size, 0), hash = treeHash(listing);
  const expiresAt = new Date(env.now().getTime() + ttlMinutes * 60_000).toISOString();
  return finalize(env, {
    st, req, scope, approvalId, expiresAt, signer, display, confirm, rng, apply,
    staged: new Map([[key, files]]),
    target: { target_key: key, prior: 'absent', prior_generation: 0, prior_file_id: null, proposed_sha256: hash, proposed_size: total, files: listing },
    stagedSha: hash,
    summary: [`target:       ${key} (a new folder, ${listing.length} text files, ${total} bytes)`, 'prior:        absent', `proposed:     ${hash} (tree hash of the listing)`],
    content: [
      { title: 'Complete file list', untrusted: { label: 'file list', text: listing.map((f) => `${f.relpath}  ${f.size} bytes  ${f.sha256}`).join('\n') } },
      ...listing.map((f) => ({ title: `File: ${f.relpath}`, untrusted: { label: 'file content', text: files.get(f.relpath).toString('utf8') } })),
    ],
    recheck: () => { env.disk.dirs ??= new Map(); return ![key, tmpKey(approvalId), cancelKey(approvalId)].some((k) => env.disk.dirs.has(k)); },
  });
}
