// M1 (design revision 3.3, §§4, 8, 9, 11, 12): the change-approval state machine over the ledger, against a
// SIMULATED disk. Synthetic only: no real filesystem, keys, elevation or installed authority. NOT used by any tool.
//
// env = {
//   store:  { bytes }                         the durable ledger (survives a simulated crash)
//   disk:   { files: Map(key → {bytes, id}), nextId, staging: Map(approvalId → Map(key → Buffer)),
//             journal: Map(approvalId → Map(key → {bytes, id} | null)), evidence: [] }   durable "disk"
//   publicKeyPem, now(): Date, boot: string, fault(point): throws Crash when a test injects one
// }
// Every command: startup (§4: verify read-only → torn-tail handling → session check → session_start) → work →
// session_end. A thrown Crash leaves the ledger and disk exactly as written so far, like a killed process.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendRecord, canonical, verifyLedger } from './ledger.mjs';
import { cancelKey, compareMembership, finalKey, isTreeKey, listingOf, manifestBytes, MANIFEST, members, renameDir, tmpKey, treeHash, treeState } from '../m3/tree.mjs';

export class Refused extends Error { constructor(m) { super(`refused: ${m}`); this.refused = true; } }
export class Crash extends Error { constructor(point) { super(`simulated crash at ${point}`); this.crash = point; } }
const refuse = (m) => { throw new Refused(m); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const AUTH_TYPES = new Set(['scope_committed', 'stop', 'deny', 'revoked', 'revoke_requested', 'new_epoch']);
const PENDING = new Set(['consuming', 'recovering_forward', 'recovering_back', 'needs_decision']);

// ------------------------------------------------------------------------------------------------- replay

/** Rebuild the full state from verified records. Pure. */
export function replay(records) {
  const st = { epoch: 0, scopes: {}, stopped: {}, denied: {}, auth: [], approvals: {}, decisions: {}, targets: {}, sessions: [] };
  const tgt = (k) => (st.targets[k] ??= { generation: 0, sha: null, fileId: null, quarantinedBy: null, txQuarantine: false, inTx: null, tombstone: false });
  for (const { seq, body: b } of records) {
    if (AUTH_TYPES.has(b.type)) st.auth.push({ seq, incident: b.incident ?? '*' });
    switch (b.type) {
      case 'genesis': st.epoch = b.authority_epoch; break;
      case 'target_registered': Object.assign(tgt(b.target_key), { sha: b.sha, fileId: b.file_id }); break;
      case 'session_start': st.sessions.push({ seq, boot: b.boot, command: b.command, ended: false }); break;
      case 'session_end': if (st.sessions.length) st.sessions.at(-1).ended = true; break;
      case 'scope_committed': st.scopes[b.incident] = { serial: b.serial, expires_at: b.expires_at, permits: b.permits, seq }; break;
      case 'stop': st.stopped[b.incident] = seq; break;
      case 'deny': st.denied[b.incident] = { actions: b.actions, seq }; break;
      case 'new_epoch': {
        st.epoch = b.authority_epoch;
        for (const a of Object.values(st.approvals)) if (a.status === 'issued' || PENDING.has(a.status)) a.status = 'void_by_epoch';
        for (const d of Object.values(st.decisions)) if (d.status === 'issued') d.status = 'void_by_epoch';
        for (const t of Object.values(st.targets)) Object.assign(t, { quarantinedBy: seq, txQuarantine: true, inTx: null });
        break;
      }
      case 'approval_issued': st.approvals[b.doc.payload.approval_id] = { status: 'issued', doc: b.doc, revision: 0, temps: {}, issuedSeq: seq }; break;
      case 'consuming': {
        const a = st.approvals[b.approval_id];
        Object.assign(a, { status: 'consuming', consumingSeq: seq, basis: b.basis_seq });
        for (const t of a.doc.payload.targets) Object.assign(tgt(t.target_key), { generation: tgt(t.target_key).generation + 1, inTx: b.approval_id });
        break;
      }
      case 'temp_ready': st.approvals[b.approval_id].temps[`${b.purpose}:${b.target_key}`] = b.file_id; break;
      case 'needs_decision': st.approvals[b.approval_id].status = 'needs_decision'; break;
      case 'recovery_segment_start': Object.assign(st.approvals[b.approval_id], { status: `recovering_${b.direction}`, segment: { direction: b.direction, basis: b.basis_seq } }); break;
      case 'decision_issued': st.decisions[b.doc.payload.decision_id] = { status: 'issued', doc: b.doc, issuedSeq: seq }; break;
      case 'decision_superseded': st.decisions[b.decision_id].status = 'superseded'; break;
      case 'decision_consumed': {
        st.decisions[b.decision_id].status = 'consumed';
        const a = st.approvals[b.approval_id];
        Object.assign(a, { status: `recovering_${b.segment.direction}`, segment: { direction: b.segment.direction, basis: b.segment.basis_seq }, revision: a.revision + 1 });
        break;
      }
      case 'applied': case 'cancelled': {
        const a = st.approvals[b.approval_id];
        a.status = b.type;
        for (const r of b.results) Object.assign(tgt(r.target_key), { sha: r.sha, fileId: r.file_id, tombstone: r.sha === null && b.type === 'cancelled', inTx: null });
        break;
      }
      case 'conflict': case 'uncertain': {
        const a = st.approvals[b.approval_id];
        a.status = b.type;
        for (const t of a.doc.payload.targets) {
          const x = tgt(t.target_key);
          Object.assign(x, { quarantinedBy: seq, txQuarantine: true, inTx: null, generation: b.type === 'uncertain' ? x.generation + 1 : x.generation });
        }
        break;
      }
      case 'drift': Object.assign(tgt(b.target_key), { quarantinedBy: seq, txQuarantine: false }); break;
      case 'expired': case 'refused': case 'revoked': st.approvals[b.approval_id].status = b.type === 'refused' ? 'refused_after_stop' : b.type; break;
      case 'adopt_consumed': case 'reconcile_consumed': {
        st.decisions[b.decision_id].status = 'consumed';
        const x = tgt(b.target_key);
        Object.assign(x, { sha: b.baseline.sha, fileId: b.baseline.file_id, generation: x.generation + 1, quarantinedBy: null, txQuarantine: false, tombstone: false });
        break;
      }
      default: break;
    }
  }
  return st;
}

/** Highest sequence number of an authorization event for this incident (or a global one, such as a new epoch). */
export const latestAuth = (st, incident) => st.auth.filter((e) => e.incident === incident || e.incident === '*').reduce((m, e) => Math.max(m, e.seq), 0);
const authEventsAfter = (st, incident, after) => st.auth.filter((e) => (e.incident === incident || e.incident === '*') && e.seq > after).map((e) => e.seq);
const pendingTx = (st) => Object.entries(st.approvals).find(([, a]) => PENDING.has(a.status))?.[0] ?? null;
const unresolved = (st) => pendingTx(st) !== null || Object.values(st.targets).some((t) => t.quarantinedBy !== null && t.txQuarantine);

// ------------------------------------------------------------------------------------------------- startup

/**
 * §4 startup order. Returns a context { v, st, append } for the command. Nothing is written before the ledger has
 * been verified; a corrupt ledger is never written to.
 */
export function startup(env, command) {
  let v = verifyLedger(env.store.bytes);
  if (v.status === 'corrupt') refuse(`corrupt ledger (${v.reason}); only diagnose may run`);
  if (v.status === 'torn') {
    if (v.records.length === 0) refuse('a torn first record; the ledger must be re-created');
    const tornOffset = v.tornOffset, torn = Buffer.from(env.store.bytes.subarray(tornOffset));
    env.disk.evidence.push({ kind: 'torn_tail', offset: tornOffset, bytes: torn }); // preserved BEFORE truncation
    env.store.bytes = env.store.bytes.subarray(0, tornOffset);
    v = verifyLedger(env.store.bytes);
    if (v.status !== 'intact') refuse('ledger not intact after preserving the torn tail');
    appendRecord(env.store, v, { type: 'torn_tail_preserved', offset: tornOffset, length: torn.length, bytes_sha256: sha(torn) });
    v = verifyLedger(env.store.bytes); // re-verify before anything else is appended
    if (v.status !== 'intact') refuse('ledger not intact after recording the torn tail');
  }
  if (v.records.length === 0 && command !== 'init') refuse('no ledger: only init may run');
  const st = replay(v.records);
  const open = st.sessions.at(-1);
  if (open && !open.ended && open.boot !== env.boot && command !== 'new-epoch') {
    refuse('the machine restarted during an authority command: only recover --new-epoch may run');
  }
  const ctx = { v, st, append: (body) => { const seq = appendRecord(env.store, ctx.v, body); ctx.st = replay(ctx.v.records); return seq; } };
  if (command !== 'init') ctx.append({ type: 'session_start', boot: env.boot, command });
  return ctx;
}
function finish(ctx) { ctx.append({ type: 'session_end' }); }
/** Run one command: startup, the work, session_end. */
export function run(env, command, work) {
  const ctx = startup(env, command);
  let out;
  try { out = work(ctx); } catch (e) {
    if (!e.crash) finish(ctx); // a refusal is an orderly end; a simulated crash leaves the session open, like a kill
    throw e;
  }
  finish(ctx);
  return out;
}

// ------------------------------------------------------------------------------------------------- documents

function verifyDoc(env, doc) {
  try { return verify(null, Buffer.from(canonical(doc.payload)), createPublicKey(env.publicKeyPem), Buffer.from(doc.signature, 'base64')); } catch { return false; }
}
function checkDocCommon(env, st, doc, kind) {
  if (!doc?.payload || doc.payload.kind !== kind || doc.payload.policy_version !== 2) refuse(`not a ${kind} document`);
  if (!verifyDoc(env, doc)) refuse('signature does not verify');
  if (doc.payload.authority_epoch !== st.epoch) refuse(`document is from authority epoch ${doc.payload.authority_epoch}; current is ${st.epoch}`);
}
const expired = (env, p) => env.now() >= new Date(p.expires_at);
/** The scope facts for an incident: can it authorize `action` right now? */
function incidentAuthorizes(env, st, incident, action) {
  const s = st.scopes[incident];
  if (st.stopped[incident]) return false;
  if (st.denied[incident]?.actions.includes(action)) return false;
  return Boolean(s && s.permits.includes(action) && env.now() < new Date(s.expires_at));
}

// ------------------------------------------------------------------------------------------------- disk helpers

// M3: a restore-tree target's state is its FOLDER's (tree hash of its members, folder id); a file's is its own.
const diskState = (env, key) => {
  env.disk.dirs ??= new Map();
  if (isTreeKey(key)) return treeState(env.disk, key);
  const f = env.disk.files.get(key); return f ? { sha: sha(f.bytes), id: f.id } : { sha: null, id: null };
};
/** Hash of the staged content for a target: a file's bytes, or a tree's canonical listing. */
const stagedSha = (staged, key) => { const v = staged?.get(key); if (v instanceof Map) { try { return treeHash(listingOf(v)); } catch { return null; } } return v ? sha(v) : null; };
// M1-F1: a target is at its prior or proposed state only if BOTH its bytes and its file identity match a durable
// record. Prior identity = the approval's prior_file_id, or the id of a cancel-restoration temp recorded by
// temp_ready{purpose: cancel}. Proposed identity = the id recorded by temp_ready{purpose: forward}. Matching bytes
// with an unknown id (a substituted file) is neither, so recovery fails closed (conflict).
const isAtPrior = (a, t, d) => d.sha === (t.prior === 'absent' ? null : t.prior)
  && (d.id === (t.prior_file_id ?? null) || (d.id !== null && d.id === a.temps[`cancel:${t.target_key}`]));
const isAtProposed = (a, t, d) => d.sha === t.proposed_sha256 && d.id !== null && d.id === a.temps[`forward:${t.target_key}`];
// A real-filesystem backend (authority/m3/fs_backend.mjs) supplies writeTemp/mkdir/renameDir so that file and folder
// identities come from the operating system; the simulated disk assigns them itself.
function writeTemp(env, bytes) { if (env.disk.writeTemp) return env.disk.writeTemp(bytes); const id = env.disk.nextId++; return { bytes: Buffer.from(bytes), id }; }
function makeDir(env, key) { if (env.disk.mkdir) return env.disk.mkdir(key); const id = env.disk.nextId++; env.disk.dirs.set(key, { id }); return id; }

// ------------------------------------------------------------------------------------------------- commands

export function init(env, { targets = [] } = {}) {
  const ctx = startup(env, 'init');
  if (ctx.v.records.length) refuse('already initialized');
  ctx.append({ type: 'genesis', authority_epoch: 1, key_epoch: 1 });
  for (const [key, f] of targets) { env.disk.files.set(key, f); ctx.append({ type: 'target_registered', target_key: key, sha: sha(f.bytes), file_id: f.id }); }
}

export const commitScope = (env, s) => run(env, 'scope', (ctx) => ctx.append({ type: 'scope_committed', ...s }));
export const stop = (env, incident) => run(env, 'stop', (ctx) => ctx.append({ type: 'stop', incident }));
export const deny = (env, incident, actions) => run(env, 'deny', (ctx) => ctx.append({ type: 'deny', incident, actions }));
export function revokeChange(env, approvalId) {
  return run(env, 'revoke-change', (ctx) => {
    const a = ctx.st.approvals[approvalId] ?? refuse('unknown approval');
    const incident = a.doc.payload.incident_id;
    if (a.status === 'issued') return ctx.append({ type: 'revoked', approval_id: approvalId, incident });
    if (PENDING.has(a.status)) return ctx.append({ type: 'revoke_requested', approval_id: approvalId, incident });
    return refuse(`approval is ${a.status}`);
  });
}

/** T1. All checks re-run at commit, on the fresh ledger. */
export function approveCommit(env, doc) {
  return run(env, 'approve-change', (ctx) => {
    const { st } = ctx, p = doc.payload;
    checkDocCommon(env, st, doc, 'change-approval');
    if (st.approvals[p.approval_id]) refuse('approval id already used');
    if (expired(env, p)) refuse('approval already expired');
    if (unresolved(st)) refuse('an unresolved transaction blocks new approvals');
    checkIssuable(env, st, p);
    return ctx.append({ type: 'approval_issued', doc });
  });
}
/** The scope permission an operation needs (§7): registers → update_records; restore trees → stage_restore. */
export const permissionFor = (operation) => (operation === 'restore.stage' ? 'stage_restore' : 'update_records');

function checkIssuable(env, st, p) {
  const action = permissionFor(p.operation);
  if (!incidentAuthorizes(env, st, p.incident_id, action)) refuse('the incident cannot authorize this (stopped, denied, expired or no scope)');
  if (st.scopes[p.incident_id].serial !== p.scope_serial) refuse('scope serial is not the latest committed');
  for (const t of p.targets) {
    const x = st.targets[t.target_key] ?? { generation: 0, sha: null, fileId: null };
    if (x.quarantinedBy !== null && x.quarantinedBy !== undefined) refuse(`${t.target_key} is quarantined`);
    if (x.inTx) refuse(`${t.target_key} is in a transaction`);
    if (x.generation !== t.prior_generation) refuse(`${t.target_key}: generation ${x.generation} ≠ ${t.prior_generation}`);
    if ((t.prior === 'absent' ? null : t.prior) !== x.sha || (t.prior_file_id ?? null) !== x.fileId) refuse(`${t.target_key}: prior does not match the ledger`);
    // M2-F1: the target ON DISK must also match the ledger, bytes AND identity, at issuance. A same-content file
    // with an unknown identity (replaced outside the authority) never receives an approval. An absent target
    // must still be absent (create).
    const d = diskState(env, t.target_key);
    if (d.sha !== x.sha || d.id !== x.fileId) refuse(`${t.target_key}: the target on disk does not match the ledger (content or file identity); resolve the drift first`);
  }
}

/** §11: apply = verify → journal → consume → per target (authorization re-check → temp → re-hash → rename → verify) → applied. */
export function apply(env, approvalId) {
  return run(env, 'apply', (ctx) => {
    const a = ctx.st.approvals[approvalId] ?? refuse('unknown approval');
    // M1-F2: the same GLOBAL predicate as approveCommit: any pending transaction, or any quarantine caused by a
    // transaction (conflict, uncertain, new epoch), blocks every new apply until each member is adopted or reconciled.
    if (unresolved(ctx.st)) refuse(pendingTx(ctx.st) ? `a pending transaction (${pendingTx(ctx.st)}) must be recovered first` : 'an unresolved transaction blocks every new apply until each quarantined member is adopted or reconciled');
    if (a.status !== 'issued') refuse(`approval is ${a.status}`);
    const p = a.doc.payload;
    if (!verifyDoc(env, a.doc) || p.authority_epoch !== ctx.st.epoch) refuse('approval document does not verify for this epoch');
    if (expired(env, p)) { ctx.append({ type: 'expired', approval_id: approvalId }); return 'expired'; }
    if (!incidentAuthorizes(env, ctx.st, p.incident_id, permissionFor(p.operation)) || ctx.st.scopes[p.incident_id]?.serial !== p.scope_serial) {
      ctx.append({ type: 'refused', approval_id: approvalId, incident: p.incident_id }); return 'refused_after_stop';
    }
    const staged = env.disk.staging.get(approvalId) ?? refuse('staged content missing');
    for (const t of p.targets) {
      const d = diskState(env, t.target_key);
      const priorSha = t.prior === 'absent' ? null : t.prior;
      if (d.sha === t.proposed_sha256 && d.sha !== priorSha) { ctx.append({ type: 'uncertain', approval_id: approvalId }); return 'uncertain'; }
      if (d.sha !== priorSha || d.id !== (t.prior_file_id ?? null)) { ctx.append({ type: 'drift', target_key: t.target_key, observed: d }); return 'drift'; }
      if (stagedSha(staged, t.target_key) !== t.proposed_sha256) refuse('staged content does not match the approval');
      if (isTreeKey(t.target_key) && (env.disk.dirs.has(tmpKey(approvalId)) || env.disk.dirs.has(cancelKey(approvalId)))) refuse('a leftover temporary or cancellation folder exists for this approval');
    }
    checkIssuable(env, ctx.st, p);
    env.disk.journal.set(approvalId, new Map(p.targets.map((t) => [t.target_key, !isTreeKey(t.target_key) && env.disk.files.get(t.target_key) ? { ...env.disk.files.get(t.target_key) } : null])));
    env.fault('after_journal');
    ctx.append({ type: 'consuming', approval_id: approvalId, basis_seq: latestAuth(ctx.st, p.incident_id) });
    env.fault('after_consuming');
    return forward(env, ctx, approvalId, ctx.st.approvals[approvalId].basis);
  });
}

/** Write every target not yet at its proposed content, re-checking authorization before each write. */
function forward(env, ctx, approvalId, basis) {
  const a = ctx.st.approvals[approvalId], p = a.doc.payload, staged = env.disk.staging.get(approvalId);
  for (const [i, t] of p.targets.entries()) {
    if (isTreeKey(t.target_key)) { const r = forwardTree(env, ctx, approvalId, t, i, basis); if (r) return r; continue; }
    if (isAtProposed(a, t, diskState(env, t.target_key))) continue;
    if (latestAuth(ctx.st, p.incident_id) > basis) { ctx.append({ type: 'needs_decision', approval_id: approvalId }); return 'needs_decision'; }
    const temp = writeTemp(env, staged.get(t.target_key));
    ctx.append({ type: 'temp_ready', approval_id: approvalId, target_key: t.target_key, file_id: temp.id, sha: sha(temp.bytes), purpose: 'forward' });
    env.fault(`after_temp_ready:${i}`);
    if (!isAtPrior(a, t, diskState(env, t.target_key))) refuse('target changed before rename'); // the pre-rename re-hash, identity included
    env.disk.files.set(t.target_key, temp);
    env.fault(`after_rename:${i}`);
    if (diskState(env, t.target_key).sha !== t.proposed_sha256) refuse('verification after rename failed');
  }
  env.fault('before_applied');
  ctx.append({ type: 'applied', approval_id: approvalId, results: p.targets.map((t) => ({ target_key: t.target_key, sha: t.proposed_sha256, file_id: diskState(env, t.target_key).id })) });
  return 'applied';
}

/**
 * M3: where a restore tree stands. 'absent' | 'tmp' (temporary folder, owned, a subset of the listed files) |
 * 'final' (published and complete) | 'cancel' (being removed, owned, a subset) | { conflict: reason }.
 * Ownership = the folder id recorded by temp_ready{purpose: forward} BEFORE any file was written into it.
 */
function treeClassify(env, a, t) {
  env.disk.dirs ??= new Map();
  const id = a.doc.payload.approval_id, owned = a.temps[`forward:${t.target_key}`];
  const present = [['final', finalKey(id)], ['tmp', tmpKey(id)], ['cancel', cancelKey(id)]].filter(([, k]) => env.disk.dirs.has(k));
  if (present.length === 0) return 'absent';
  if (present.length > 1) return { conflict: `more than one of the final, temporary and cancellation folders exists (${present.map(([n]) => n).join(', ')})` };
  const [state, dirKey] = present[0];
  if (env.disk.dirs.get(dirKey).id !== owned) return { conflict: `${dirKey} has a folder identity the ledger did not record` };
  const cmp = compareMembership(env.disk, dirKey, t.files, id);
  if (cmp.problem) return { conflict: `${dirKey}: ${cmp.problem}` };
  if (state === 'final' && !cmp.complete) return { conflict: `${dirKey} was published but is incomplete` };
  return state;
}

/** M3 forward for one tree: temporary folder (ownership first) → files → manifest last → verify → one rename. */
function forwardTree(env, ctx, approvalId, t, i, basis) {
  const a = ctx.st.approvals[approvalId], p = a.doc.payload, files = env.disk.staging.get(approvalId).get(t.target_key);
  const blocked = () => latestAuth(ctx.st, p.incident_id) > basis;
  const needs = () => { ctx.append({ type: 'needs_decision', approval_id: approvalId }); return 'needs_decision'; };
  let state = treeClassify(env, a, t);
  if (state.conflict) refuse(state.conflict);
  if (state === 'final') return null;
  if (state === 'cancel') refuse('a cancellation of this tree is in progress; it cannot be completed forward');
  const tmp = tmpKey(approvalId);
  if (state === 'absent') {
    if (blocked()) return needs();
    const dirId = makeDir(env, tmp);
    ctx.append({ type: 'temp_ready', approval_id: approvalId, target_key: t.target_key, file_id: dirId, sha: t.proposed_sha256, purpose: 'forward', tree: true });
    env.fault(`after_tree_dir:${i}`);
  }
  let n = 0;
  for (const f of t.files) {
    if (env.disk.files.has(`${tmp}/${f.relpath}`)) continue;
    if (blocked()) return needs();
    env.disk.files.set(`${tmp}/${f.relpath}`, writeTemp(env, files.get(f.relpath)));
    env.fault(`after_tree_file:${i}:${n++}`);
  }
  if (!env.disk.files.has(`${tmp}/${MANIFEST}`)) {
    if (blocked()) return needs();
    env.disk.files.set(`${tmp}/${MANIFEST}`, writeTemp(env, manifestBytes(approvalId, t.files)));
    env.fault(`after_tree_manifest:${i}`);
  }
  const cmp = compareMembership(env.disk, tmp, t.files, approvalId);
  if (!cmp.complete) refuse(`the temporary folder is not complete: ${cmp.problem ?? `missing ${cmp.missing.join(', ')}`}`);
  ctx.append({ type: 'tree_ready', approval_id: approvalId, target_key: t.target_key, dir_id: env.disk.dirs.get(tmp).id, tree_sha256: t.proposed_sha256 });
  if (blocked()) return needs();
  renameDir(env.disk, tmp, finalKey(approvalId)); // publication: one atomic folder rename
  env.fault(`after_tree_rename:${i}`);
  // Re-read the approval: the ownership record (temp_ready) was appended after `a` was taken.
  state = treeClassify(env, ctx.st.approvals[approvalId], t);
  if (state !== 'final') refuse('verification after publication failed');
  return null;
}

/** M3 cancellation for one tree: rename a published tree aside, then delete ONLY listed files at their signed hash. */
function backTree(env, ctx, approvalId, t, i, basis) {
  const a = ctx.st.approvals[approvalId], p = a.doc.payload;
  const blocked = () => latestAuth(ctx.st, p.incident_id) > basis;
  const needs = () => { ctx.append({ type: 'needs_decision', approval_id: approvalId }); return 'needs_decision'; };
  let state = treeClassify(env, a, t);
  if (state.conflict) refuse(state.conflict);
  if (state === 'absent') return null;
  if (state === 'final') {
    if (blocked()) return needs();
    renameDir(env.disk, finalKey(approvalId), cancelKey(approvalId));
    ctx.append({ type: 'cancel_renamed', approval_id: approvalId, target_key: t.target_key });
    env.fault(`after_cancel_rename:${i}`);
    state = 'cancel';
  }
  const dirKey = state === 'tmp' ? tmpKey(approvalId) : cancelKey(approvalId);
  const listed = new Map(t.files.map((f) => [f.relpath, f.sha256]));
  const manifest = manifestBytes(approvalId, t.files);
  let n = 0;
  for (const [rel, f] of members(env.disk, dirKey)) {
    const owned = rel === MANIFEST ? f.bytes.equals(manifest) : listed.get(rel) === sha(f.bytes);
    if (!owned) refuse(`${dirKey}/${rel} is not a listed file at its signed hash; nothing more is deleted`);
    if (blocked()) return needs();
    env.disk.files.delete(`${dirKey}/${rel}`);
    env.fault(`after_cancel_delete:${i}:${n++}`);
  }
  env.disk.dirs.delete(dirKey);
  return null;
}

/** Restore priors (journal) or remove created targets (ownership evidence), re-checking authorization before each. */
function back(env, ctx, approvalId, basis) {
  const a = ctx.st.approvals[approvalId], p = a.doc.payload, journal = env.disk.journal.get(approvalId);
  for (const [i, t] of p.targets.entries()) {
    if (isTreeKey(t.target_key)) { const r = backTree(env, ctx, approvalId, t, i, basis); if (r) return r; continue; }
    const d = diskState(env, t.target_key);
    if (isAtPrior(a, t, d)) continue;
    if (latestAuth(ctx.st, p.incident_id) > basis) { ctx.append({ type: 'needs_decision', approval_id: approvalId }); return 'needs_decision'; }
    if (t.prior === 'absent') {
      if (d.id !== a.temps[`forward:${t.target_key}`]) refuse('ownership evidence does not match; not deleting'); // checked in classify too
      env.disk.files.delete(t.target_key);
    } else {
      const temp = writeTemp(env, journal.get(t.target_key).bytes);
      ctx.append({ type: 'temp_ready', approval_id: approvalId, target_key: t.target_key, file_id: temp.id, sha: sha(temp.bytes), purpose: 'cancel' });
      env.disk.files.set(t.target_key, temp);
    }
    env.fault(`after_cancel_step:${i}`);
  }
  ctx.append({ type: 'cancelled', approval_id: approvalId, results: p.targets.map((t) => ({ target_key: t.target_key, sha: t.prior === 'absent' ? null : t.prior, file_id: diskState(env, t.target_key).id })) });
  return 'cancelled';
}

/** §12.2: classify every member target BEFORE any recovery write. Returns null when all inputs are valid. */
function classify(env, a) {
  const p = a.doc.payload, journal = env.disk.journal.get(a.doc.payload.approval_id), staged = env.disk.staging.get(p.approval_id);
  const observed = [];
  let problem = null;
  for (const t of p.targets) {
    const d = diskState(env, t.target_key);
    observed.push({ target_key: t.target_key, sha: d.sha, file_id: d.id });
    if (isTreeKey(t.target_key)) {
      // M3: every tree state is checked before any recovery write; an unowned folder, an unlisted entry or a wrong
      // hash is a conflict (evidence retained). Partial temporary/cancellation folders are valid progress.
      const s = treeClassify(env, a, t);
      if (s.conflict) problem ??= s.conflict;
      if (stagedSha(staged, t.target_key) !== t.proposed_sha256) problem ??= 'staged content missing or altered';
      continue;
    }
    const atPrior = isAtPrior(a, t, d);
    const atProposed = isAtProposed(a, t, d);
    if (!atPrior && !atProposed) problem ??= `${t.target_key} is in neither expected state`;
    if (!staged || sha(staged.get(t.target_key) ?? Buffer.alloc(0)) !== t.proposed_sha256) problem ??= 'staged content missing or altered';
    if (t.prior !== 'absent' && (!journal?.get(t.target_key) || sha(journal.get(t.target_key).bytes) !== t.prior)) problem ??= 'journal copy missing or altered';
  }
  return { observed, problem };
}

/**
 * §12: recover the pending transaction. Without a decision: automatic forward completion only when no
 * authorization event is newer than the basis; otherwise needs_decision. With a decision: it is verified and
 * consumed in ONE record that also starts its segment (conditions 2: basis = the current latest event).
 */
export function recover(env, { decisionId = null } = {}) {
  return run(env, 'recover', (ctx) => {
    const id = pendingTx(ctx.st);
    if (!id) return 'nothing pending';
    const a = ctx.st.approvals[id], p = a.doc.payload;
    if (!verifyDoc(env, a.doc)) refuse('the pending approval no longer verifies'); // signature re-verified on recovery
    const { observed, problem } = classify(env, a);
    if (problem) { ctx.append({ type: 'conflict', approval_id: id, observed, reason: problem }); return 'conflict'; }
    const latest = latestAuth(ctx.st, p.incident_id);
    if (decisionId) {
      const d = ctx.st.decisions[decisionId] ?? refuse('decision is not in the ledger');
      if (d.status !== 'issued') refuse(`decision is ${d.status}`);
      const q = d.doc.payload;
      checkDocCommon(env, ctx.st, d.doc, 'recovery-decision');
      if (q.approval_id !== id || q.tx_seq !== a.consumingSeq) refuse('decision is for another transaction');
      if (q.recovery_revision !== a.revision) refuse('decision is for an earlier recovery revision');
      if (expired(env, q)) refuse('decision expired before first use');
      if (canonical(q.observed) !== canonical(observed)) refuse('observed state no longer matches');
      const events = authEventsAfter(ctx.st, p.incident_id, a.consumingSeq);
      if (canonical([...q.overrides].sort((x, y) => x - y)) !== canonical(events)) { ctx.append({ type: 'decision_superseded', decision_id: decisionId }); return 'superseded'; }
      // A decision says "complete" or "cancel"; the segment it starts runs "forward" or "back". Anything else is refused.
      const direction = { complete: 'forward', cancel: 'back' }[q.direction] ?? refuse(`unknown decision direction ${JSON.stringify(q.direction)}`);
      env.fault('before_decision_consumed');
      ctx.append({ type: 'decision_consumed', decision_id: decisionId, approval_id: id, segment: { direction, basis_seq: latest } });
      env.fault('after_decision_consumed');
    } else if (a.status === 'consuming') {
      if (latest > a.basis) { ctx.append({ type: 'needs_decision', approval_id: id }); return 'needs_decision'; }
      ctx.append({ type: 'recovery_segment_start', approval_id: id, direction: 'forward', mode: 'auto', basis_seq: latest });
    } else if (a.status === 'needs_decision') {
      return 'needs_decision';
    } else if (latest > a.segment.basis) { // T13b: a resumed segment re-checks its basis
      ctx.append({ type: 'needs_decision', approval_id: id }); return 'needs_decision';
    }
    const seg = ctx.st.approvals[id].segment;
    return seg.direction === 'forward' ? forward(env, ctx, id, seg.basis) : back(env, ctx, id, seg.basis);
  });
}

/** Record a signed decision document (recovery-decision, adopt or reconcile) as issued, embedded in the ledger. */
export function issueDecision(env, doc) {
  return run(env, 'issue-decision', (ctx) => {
    if (!['recovery-decision', 'adopt', 'reconcile'].includes(doc?.payload?.kind)) refuse('unknown decision kind');
    checkDocCommon(env, ctx.st, doc, doc.payload.kind);
    if (ctx.st.decisions[doc.payload.decision_id]) refuse('decision id already used');
    return ctx.append({ type: 'decision_issued', doc });
  });
}

/** T17: adopt a quarantined target while its incident CAN authorize. One record spends it and applies the baseline. */
export function adopt(env, decisionId) {
  return run(env, 'adopt', (ctx) => {
    const { st } = ctx, d = st.decisions[decisionId] ?? refuse('decision is not in the ledger');
    const q = d.doc.payload;
    if (q.kind !== 'adopt' || d.status !== 'issued') refuse(`not an issued adopt (${d.status})`);
    checkDocCommon(env, st, d.doc, 'adopt');
    commonQuarantineChecks(env, st, q, ctx.v.records);
    if (!incidentAuthorizes(env, st, q.incident_id, isTreeKey(q.target_key) ? 'stage_restore' : 'update_records') || st.scopes[q.incident_id].serial !== q.scope_serial) refuse('the incident cannot authorize adopt; use reconcile');
    return ctx.append({ type: 'adopt_consumed', decision_id: decisionId, target_key: q.target_key, baseline: { sha: q.observed.sha, file_id: q.observed.file_id } });
  });
}

/** T19 (condition 3): reconcile, bound to VERIFIABLE facts, rechecked at consumption. Writes no target bytes. */
export function reconcile(env, decisionId) {
  return run(env, 'reconcile', (ctx) => {
    const { st } = ctx, d = st.decisions[decisionId] ?? refuse('decision is not in the ledger');
    const q = d.doc.payload;
    if (q.kind !== 'reconcile' || d.status !== 'issued') refuse(`not an issued reconcile (${d.status})`);
    checkDocCommon(env, st, d.doc, 'reconcile');
    commonQuarantineChecks(env, st, q, ctx.v.records);
    if (q.basis === 'epoch') {
      const rec = ctx.v.records.find((r) => r.seq === q.quarantine_seq);
      if (rec?.body.type !== 'new_epoch') refuse('quarantine_seq is not a new-epoch record');
    } else if (q.basis === 'incident_unauthorizable') {
      if (incidentAuthorizes(env, st, q.incident_id, isTreeKey(q.target_key) ? 'stage_restore' : 'update_records')) { ctx.append({ type: 'decision_superseded', decision_id: decisionId }); return 'superseded (use adopt)'; }
      const f = q.fact;
      const rec = (s) => ctx.v.records.find((r) => r.seq === s)?.body;
      const holds = (f.kind === 'stopped' && rec(f.event_seq)?.type === 'stop' && rec(f.event_seq).incident === q.incident_id)
        || (f.kind === 'denied' && rec(f.event_seq)?.type === 'deny' && rec(f.event_seq).incident === q.incident_id && rec(f.event_seq).actions.includes('update_records'))
        || (f.kind === 'scope_expired' && st.scopes[q.incident_id]?.serial === f.scope_serial && st.scopes[q.incident_id].expires_at === f.scope_expires_at && env.now() >= new Date(f.scope_expires_at))
        || (f.kind === 'no_scope' && f.latest_scope_serial === null && !st.scopes[q.incident_id]);
      if (!holds) { ctx.append({ type: 'decision_superseded', decision_id: decisionId }); return 'superseded (bound fact no longer holds)'; }
    } else refuse('unknown reconcile basis');
    return ctx.append({ type: 'reconcile_consumed', decision_id: decisionId, target_key: q.target_key, baseline: { sha: q.observed.sha, file_id: q.observed.file_id } });
  });
}
function commonQuarantineChecks(env, st, q, records) {
  const x = st.targets[q.target_key] ?? refuse('unknown target');
  if (x.quarantinedBy === null) refuse('target is not quarantined');
  if (x.quarantinedBy !== q.quarantine_seq) refuse('quarantine event does not match');
  // No cross-incident resolution: a quarantine caused by a transaction can only be resolved under that incident.
  const cause = records.find((r) => r.seq === q.quarantine_seq)?.body;
  const txIncident = cause?.approval_id ? st.approvals[cause.approval_id]?.doc.payload.incident_id : null;
  if (txIncident && q.basis !== 'epoch' && q.incident_id !== txIncident) refuse('the quarantine belongs to another incident');
  if (x.generation !== q.target_generation) refuse('generation does not match');
  if (expired(env, q)) refuse('decision expired before first use');
  const dsk = diskState(env, q.target_key);
  if (dsk.sha !== q.observed.sha || dsk.id !== q.observed.file_id) refuse('observed state no longer matches');
}

/** T18: a signed new-epoch voids every unspent approval and decision and quarantines every target. */
export function newEpoch(env, doc) {
  return run(env, 'new-epoch', (ctx) => {
    if (doc?.payload?.kind !== 'new-epoch' || !verifyDoc(env, doc)) refuse('not a valid new-epoch document');
    if (doc.payload.new_authority_epoch !== ctx.st.epoch + 1) refuse('wrong epoch number');
    const head = ctx.v.records.at(-2); // the record before this command's session_start
    if (doc.payload.ledger_head_seq !== head.seq) refuse('signed against a different ledger head');
    return ctx.append({ type: 'new_epoch', authority_epoch: doc.payload.new_authority_epoch });
  });
}

/** Read-only diagnosis (§12.1): verifies and replays; writes nothing. */
export function diagnose(env) {
  const v = verifyLedger(env.store.bytes);
  const st = v.status === 'corrupt' ? null : replay(v.records);
  return { ledger: v.status, reason: v.reason ?? null, pending: st ? pendingTx(st) : null, quarantined: st ? Object.entries(st.targets).filter(([, t]) => t.quarantinedBy !== null).map(([k]) => k) : [] };
}
