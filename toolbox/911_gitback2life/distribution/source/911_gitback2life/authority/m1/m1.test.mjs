// M1 focused tests (design revision 3.3; §20 groups A, B, D, E, F, I). Synthetic Ed25519 keys generated here,
// a simulated disk, named crash points. No real filesystem target, key, passphrase, elevation or installed authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonical, encodeRecord, MAX_RECORD, verifyLedger } from './ledger.mjs';
import * as A from './engine.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // synthetic test key, discarded after the run
const signDoc = (payload) => ({ payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') });
const T1 = 'registers/services.json', T2 = 'registers/access.json';
const INC = 'inc-1', FAR = '2099-01-01T00:00:00.000Z';

/** A fresh environment: genesis, two registered targets, a scope permitting update_records. */
function world({ targets = [T1, T2] } = {}) {
  let fault = null, clock = new Date('2026-10-18T12:00:00Z');
  const disk = { files: new Map(), nextId: 1, staging: new Map(), journal: new Map(), evidence: [] };
  const env = {
    store: { bytes: Buffer.alloc(0) }, disk, boot: 'boot-1',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    now: () => clock, fault: (p) => { if (p === fault) { fault = null; throw new A.Crash(p); } },
  };
  A.init(env, { targets: targets.map((k) => [k, { bytes: Buffer.from(`${k} v0`), id: disk.nextId++ }]) });
  A.commitScope(env, { incident: INC, serial: 1, expires_at: FAR, permits: ['update_records'] });
  return { env, setFault: (p) => { fault = p; }, setClock: (d) => { clock = new Date(d); } };
}
const st = (env) => A.replay(verifyLedger(env.store.bytes).records);
const lastSeq = (env) => verifyLedger(env.store.bytes).records.at(-1).seq;
const crashes = (fn) => { try { fn(); } catch (e) { if (!e.crash) throw e; return e.crash; } assert.fail('expected a simulated crash'); };

/** Sign, stage and commit an approval changing `keys` to new content. */
function approve(env, keys = [T1, T2], { incident = INC, id = randomBytes(16).toString('hex') } = {}) {
  const s = st(env);
  const staged = new Map(keys.map((k) => [k, Buffer.from(`${k} proposed ${id.slice(0, 6)}`)]));
  env.disk.staging.set(id, staged);
  const p = {
    kind: 'change-approval', policy_version: 2, authority_epoch: s.epoch, key_epoch: 1, approval_id: id,
    operation: 'register.replace', incident_id: incident, scope_serial: s.scopes[incident]?.serial ?? 0,
    targets: keys.map((k) => { const t = s.targets[k] ?? { generation: 0, sha: null, fileId: null };
      return { target_key: k, prior: t.sha ?? 'absent', prior_generation: t.generation, prior_file_id: t.fileId, proposed_sha256: sha(staged.get(k)), proposed_size: staged.get(k).length }; }),
    staged_sha256: sha(Buffer.concat([...staged.values()])), issued_at: env.now().toISOString(), expires_at: FAR,
  };
  A.approveCommit(env, signDoc(p));
  return { id, staged, p };
}
const observed = (env, keys) => keys.map((k) => { const f = env.disk.files.get(k); return { target_key: k, sha: f ? sha(f.bytes) : null, file_id: f ? f.id : null }; });
function decision(env, approvalId, direction, overrides, { revision = null } = {}) {
  const s = st(env), a = s.approvals[approvalId];
  const p = { kind: 'recovery-decision', policy_version: 2, authority_epoch: s.epoch, key_epoch: 1, decision_id: randomBytes(16).toString('hex'),
    approval_id: approvalId, tx_seq: a.consumingSeq, recovery_revision: revision ?? a.revision, direction, overrides,
    observed: observed(env, a.doc.payload.targets.map((t) => t.target_key)), incident_id: a.doc.payload.incident_id, issued_at: env.now().toISOString(), expires_at: FAR };
  A.issueDecision(env, signDoc(p));
  return p.decision_id;
}
function quarantineDoc(env, kind, key, extra) {
  const s = st(env), t = s.targets[key], f = env.disk.files.get(key);
  const p = { kind, policy_version: 2, authority_epoch: s.epoch, key_epoch: 1, decision_id: randomBytes(16).toString('hex'), target_key: key,
    target_generation: t.generation, quarantine_seq: t.quarantinedBy, observed: { sha: f ? sha(f.bytes) : null, file_id: f ? f.id : null },
    issued_at: env.now().toISOString(), expires_at: FAR, ...extra };
  A.issueDecision(env, signDoc(p));
  return p.decision_id;
}
const bytesOf = (env) => [T1, T2].map((k) => env.disk.files.get(k)?.bytes.toString() ?? null);

// --------------------------------------------------------------------------------------------- A: ledger, startup

test('A1: ledger records round-trip; a torn final record at every length is "torn"; damage elsewhere is "corrupt"', () => {
  const { env } = world();
  const full = env.store.bytes, v = verifyLedger(full);
  assert.equal(v.status, 'intact');
  const lastOff = v.records.at(-1).offset;
  for (let cut = lastOff + 1; cut < full.length; cut++) {
    const t = verifyLedger(full.subarray(0, cut));
    assert.equal(t.status, 'torn', `cut at ${cut}`); assert.equal(t.tornOffset, lastOff); assert.equal(t.records.length, v.records.length - 1);
  }
  const lastFlip = Buffer.from(full); lastFlip[full.length - 1] ^= 1;
  assert.equal(verifyLedger(lastFlip).status, 'torn', 'a bad checksum on the FINAL record is a torn append');
  const mid = Buffer.from(full); mid[v.records[1].offset + 50] ^= 1;
  assert.equal(verifyLedger(mid).status, 'corrupt', 'a damaged earlier record is corrupt');
  const gap = Buffer.concat([full, encodeRecord(v.records.length + 2, v.records.at(-1).hash, { type: 'x' })]);
  assert.match(verifyLedger(gap).reason, /sequence gap/);
  const chain = Buffer.concat([full, encodeRecord(v.records.length + 1, Buffer.alloc(32, 7), { type: 'x' })]);
  assert.match(verifyLedger(chain).reason, /broken chain/);
  const huge = Buffer.concat([full, Buffer.from([0x7f, 0xff, 0xff, 0xff])]);
  assert.match(verifyLedger(huge).reason, /out of range/, 'an oversize length is refused from the field alone');
  assert.ok(MAX_RECORD === 1048576);
});

test('I-18: a corrupt ledger is never appended to: every command refuses and the bytes stay identical', () => {
  const { env } = world();
  const v = verifyLedger(env.store.bytes);
  env.store.bytes = Buffer.from(env.store.bytes); env.store.bytes[v.records[1].offset + 50] ^= 1;
  const before = Buffer.from(env.store.bytes);
  for (const cmd of [() => A.stop(env, INC), () => A.recover(env), () => A.commitScope(env, { incident: INC, serial: 2, expires_at: FAR, permits: [] })]) {
    assert.throws(cmd, /corrupt ledger/);
    assert.deepEqual(env.store.bytes, before, 'byte-identical');
  }
  assert.equal(A.diagnose(env).ledger, 'corrupt');
});

test('A: a torn tail is preserved as evidence, truncated, recorded, and only then is session_start appended', () => {
  const { env } = world();
  const intactLen = env.store.bytes.length;
  env.store.bytes = Buffer.concat([env.store.bytes, Buffer.from([0, 0, 0, 200, 1, 2, 3])]); // an interrupted append
  A.stop(env, 'inc-other');
  assert.equal(env.disk.evidence.length, 1);
  assert.deepEqual(env.disk.evidence[0].bytes, Buffer.from([0, 0, 0, 200, 1, 2, 3]));
  const recs = verifyLedger(env.store.bytes).records;
  const torn = recs.find((r) => r.body.type === 'torn_tail_preserved');
  assert.equal(torn.offset, intactLen, 'appended exactly at the verified end');
  assert.equal(recs[recs.indexOf(torn) + 1].body.type, 'session_start', 'session_start comes after the tail handling');
});

test('A: an unclosed session from an earlier boot allows only new-epoch', () => {
  const { env, setFault } = world();
  approve(env, [T1]);
  setFault('after_consuming');
  crashes(() => A.apply(env, Object.keys(st(env).approvals)[0]));
  env.boot = 'boot-2'; // the machine restarted while apply was running
  assert.throws(() => A.recover(env), /restarted during an authority command/);
  const doc = signDoc({ kind: 'new-epoch', policy_version: 2, new_authority_epoch: 2, reason: 'storage_failure_suspected', ledger_head_seq: lastSeq(env) });
  A.newEpoch(env, doc);
  assert.equal(st(env).epoch, 2);
});

// ------------------------------------------------------------------------------------- B, E: apply, single use

test('B: apply succeeds once; reuse is refused; restoring the old bytes does not revive the approval', () => {
  const { env } = world();
  const { id } = approve(env);
  assert.equal(A.apply(env, id), 'applied');
  const s = st(env);
  assert.equal(s.targets[T1].generation, 1);
  assert.throws(() => A.apply(env, id), /approval is applied/);
  env.disk.files.set(T1, { bytes: Buffer.from(`${T1} v0`), id: 1 }); // an Administrator puts the old bytes back
  env.disk.files.set(T2, { bytes: Buffer.from(`${T2} v0`), id: 2 });
  assert.throws(() => A.apply(env, id), /approval is applied/, 'status is final; the bytes do not matter');
});

test('D: a crash at EVERY apply step recovers deterministically; generations never decrease', () => {
  const points = ['after_journal', 'after_consuming', 'after_temp_ready:0', 'after_rename:0', 'after_temp_ready:1', 'after_rename:1', 'before_applied'];
  for (const point of points) {
    const { env, setFault } = world();
    const { id, staged } = approve(env);
    setFault(point);
    assert.equal(crashes(() => A.apply(env, id)), point);
    const genBefore = Object.fromEntries(Object.entries(st(env).targets).map(([k, t]) => [k, t.generation]));
    if (point === 'after_journal') {
      assert.equal(st(env).approvals[id].status, 'issued', 'not consumed before the consuming record');
      assert.equal(A.recover(env), 'nothing pending');
      assert.equal(A.apply(env, id), 'applied', 'retry is allowed: nothing was consumed');
    } else {
      assert.equal(A.recover(env), 'applied', `${point}: automatic completion`);
      assert.equal(A.recover(env), 'nothing pending', 'repeat recovery is a no-op');
    }
    assert.deepEqual(bytesOf(env), [staged.get(T1).toString(), staged.get(T2).toString()], `${point}: every target at proposed`);
    for (const [k, g] of Object.entries(st(env).targets)) assert.ok(g.generation >= genBefore[k], `${point}: ${k} generation never decreases`);
    assert.throws(() => A.apply(env, id), /approval is applied/);
  }
});

test('I-10/R2-03: a stop after consumption blocks automatic completion; a stop during a resumed segment blocks further writes', () => {
  let { env, setFault } = world();
  let { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  A.stop(env, INC);
  const before = bytesOf(env);
  assert.equal(A.recover(env), 'needs_decision');
  assert.deepEqual(bytesOf(env), before, 'no target write without a fresh decision');
  // A crash in the middle of an automatic segment, then a stop, then recovery (T13b):
  ({ env, setFault } = world());
  ({ id } = approve(env));
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  setFault('after_rename:0'); crashes(() => A.recover(env)); // t1 written by the automatic segment
  A.stop(env, INC);
  const mid = bytesOf(env);
  assert.equal(A.recover(env), 'needs_decision');
  assert.deepEqual(bytesOf(env), mid, 'the persisted direction did not substitute for current authorization');
});

// ---------------------------------------------------------------------------------- condition 2, crash window

test('Condition 2: a decision with EMPTY overrides consumes with basis = the current latest event, in ONE record', () => {
  const { env, setFault } = world();
  const { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  const d = decision(env, id, 'cancel', []);
  const latestBefore = A.latestAuth(st(env), INC);
  assert.equal(A.recover(env, { decisionId: d }), 'cancelled');
  const recs = verifyLedger(env.store.bytes).records;
  const consumed = recs.find((r) => r.body.type === 'decision_consumed');
  assert.equal(consumed.body.segment.basis_seq, latestBefore, 'basis defined although overrides is empty');
  assert.equal(recs.filter((r) => r.body.type === 'recovery_segment_start').length, 0, 'no separate segment record');
  assert.deepEqual(bytesOf(env), [`${T1} v0`, `${T2} v0`]);
});

test('Condition 2: with a stop after consumption, overrides must list exactly that event; the basis becomes it', () => {
  const { env, setFault } = world();
  const { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  A.stop(env, INC);
  const stopSeq = verifyLedger(env.store.bytes).records.findLast((r) => r.body.type === 'stop').seq;
  const stale = decision(env, id, 'cancel', []);
  assert.equal(A.recover(env, { decisionId: stale }), 'superseded', 'empty overrides no longer match the events');
  const good = decision(env, id, 'cancel', [stopSeq]);
  assert.equal(A.recover(env, { decisionId: good }), 'cancelled');
  assert.equal(st(env).approvals[id].segment.basis, stopSeq);
});

test('I-20: crash immediately before / after the single decision_consumed record', () => {
  let { env, setFault } = world();
  let { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  let d = decision(env, id, 'cancel', []);
  setFault('before_decision_consumed'); crashes(() => A.recover(env, { decisionId: d }));
  assert.equal(st(env).decisions[d].status, 'issued', 'before: still issued');
  assert.equal(A.recover(env, { decisionId: d }), 'cancelled', 'before: usable exactly once');
  assert.equal(st(env).decisions[d].status, 'consumed');
  assert.equal(A.recover(env, { decisionId: d }), 'nothing pending', 'a second use finds nothing to act on and writes no target');
  ({ env, setFault } = world());
  ({ id } = approve(env));
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  d = decision(env, id, 'cancel', []);
  setFault('after_decision_consumed'); crashes(() => A.recover(env, { decisionId: d }));
  assert.equal(st(env).approvals[id].status, 'recovering_back', 'after: the segment exists');
  assert.throws(() => A.recover(env, { decisionId: d }), /decision is consumed/, 'never consumed twice');
  assert.equal(A.recover(env), 'cancelled', 'resumed through T13 with the basis re-checked');
});

test('Condition 2: a signed "complete" decision after a stop runs FORWARD, and a crash mid-segment resumes forward', () => {
  const { env, setFault } = world();
  const { id, staged } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  A.stop(env, INC);
  const stopSeq = verifyLedger(env.store.bytes).records.findLast((r) => r.body.type === 'stop').seq;
  const d = decision(env, id, 'complete', [stopSeq]);
  setFault('after_rename:0'); crashes(() => A.recover(env, { decisionId: d }));
  assert.equal(st(env).approvals[id].status, 'recovering_forward', 'a pending, recognised state after the crash');
  assert.equal(A.recover(env), 'applied', 'resumed in the decided direction (no newer event since its basis)');
  assert.deepEqual(bytesOf(env), [staged.get(T1).toString(), staged.get(T2).toString()]);
  // An unknown direction is refused at use, and nothing is consumed or written.
  const w2 = world();
  const second = approve(w2.env);
  w2.setFault('after_consuming'); crashes(() => A.apply(w2.env, second.id));
  const sideways = decision(w2.env, second.id, 'sideways', []);
  const before = bytesOf(w2.env);
  assert.throws(() => A.recover(w2.env, { decisionId: sideways }), /unknown decision direction/);
  assert.equal(st(w2.env).decisions[sideways].status, 'issued', 'not consumed');
  assert.deepEqual(bytesOf(w2.env), before, 'nothing written');
});

test('M1-F1 (v12 review): recover refuses a target with the PRIOR bytes but an unknown file identity; valid cancellation still recovers', () => {
  // The review's reproduction: crash after consuming, then the file is replaced by one with the same bytes, id 9999.
  let { env, setFault } = world({ targets: [T1] });
  let { id } = approve(env, [T1]);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  env.disk.files.set(T1, { bytes: Buffer.from(`${T1} v0`), id: 9999 });
  assert.equal(A.recover(env), 'conflict', 'same content, different identity: neither expected state');
  assert.equal(env.disk.files.get(T1).id, 9999, 'the substituted file was not overwritten');
  assert.notEqual(st(env).targets[T1].quarantinedBy, null, 'quarantined for owner resolution');
  // Control: a cancellation that restored the prior with a NEW id (recorded by temp_ready{cancel}) still recovers.
  ({ env, setFault } = world({ targets: [T1] }));
  ({ id } = approve(env, [T1]));
  setFault('after_rename:0'); crashes(() => A.apply(env, id));
  const d = decision(env, id, 'cancel', []);
  setFault('after_cancel_step:0'); crashes(() => A.recover(env, { decisionId: d }));
  assert.equal(env.disk.files.get(T1).bytes.toString(), `${T1} v0`, 'prior bytes restored under a new, recorded id');
  assert.equal(A.recover(env), 'cancelled', 'the recorded restoration identity is accepted');
});

test('M1-F2 (v12 review): a quarantined conflict blocks an unrelated pre-issued apply until every member is resolved', () => {
  const T3 = 'registers/personal_data.json';
  const { env, setFault } = world({ targets: [T1, T3] });
  const unrelated = approve(env, [T3]); // issued BEFORE the conflict
  const conflicting = approve(env, [T1]);
  setFault('after_consuming'); crashes(() => A.apply(env, conflicting.id));
  env.disk.files.set(T1, { bytes: Buffer.from('unexpected'), id: 8888 });
  assert.equal(A.recover(env), 'conflict');
  const before = env.disk.files.get(T3);
  assert.throws(() => A.apply(env, unrelated.id), /unresolved transaction blocks every new apply/);
  assert.equal(env.disk.files.get(T3), before, 'the unrelated target was not touched');
  assert.equal(st(env).approvals[unrelated.id].status, 'issued', 'and its approval was not consumed');
  A.adopt(env, quarantineDoc(env, 'adopt', T1, { incident_id: INC, scope_serial: 1 }));
  assert.equal(A.apply(env, unrelated.id), 'applied', 'allowed once every quarantined member is resolved');
});

// ---------------------------------------------------------------------------------- create, conflict, reconcile

test('R2-05: create published before "applied", then cancelled: deleted only by recorded ownership; tombstone blocks the old approval', () => {
  const { env, setFault } = world({ targets: [T1] });
  const { id } = approve(env, [T2]); // T2 does not exist: a create
  setFault('after_rename:0'); crashes(() => A.apply(env, id));
  assert.ok(env.disk.files.has(T2));
  const d = decision(env, id, 'cancel', []);
  assert.equal(A.recover(env, { decisionId: d }), 'cancelled');
  assert.ok(!env.disk.files.has(T2), 'the created file was removed using the file id recorded before the rename');
  const t = st(env).targets[T2];
  assert.equal(t.tombstone, true); assert.equal(t.generation, 1);
  const staleCreate = { ...st(env).approvals[id].doc.payload, approval_id: randomBytes(16).toString('hex') };
  env.disk.staging.set(staleCreate.approval_id, env.disk.staging.get(id));
  assert.throws(() => A.approveCommit(env, signDoc(staleCreate)), /generation 1 ≠ 0/);
});

test('R2-05: conflict writes nothing, blocks new work globally until EVERY member is adopted', () => {
  const { env, setFault } = world();
  const { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  env.disk.files.set(T1, { bytes: Buffer.from('changed by someone else'), id: 999 });
  const before = bytesOf(env);
  assert.equal(A.recover(env), 'conflict');
  assert.deepEqual(bytesOf(env), before, 'nothing written');
  assert.throws(() => approve(env, [T1]), /unresolved transaction/);
  A.adopt(env, quarantineDoc(env, 'adopt', T1, { incident_id: INC, scope_serial: 1 }));
  assert.throws(() => approve(env, [T1]), /unresolved transaction/, 'one member resolved is not enough');
  A.adopt(env, quarantineDoc(env, 'adopt', T2, { incident_id: INC, scope_serial: 1 }));
  assert.ok(approve(env, [T1]).id, 'new work allowed once every member is resolved');
  assert.throws(() => A.adopt(env, quarantineDoc(env, 'adopt', T1, { incident_id: INC, scope_serial: 1 })), /not quarantined/);
});

test('Condition 3: reconcile binds verifiable scope facts and rechecks them when consumed', () => {
  // scope_expired: the incident cannot authorize, so adopt is refused and reconcile is the path.
  let w = world(); let { env, setFault } = w;
  let { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  env.disk.files.set(T1, { bytes: Buffer.from('other'), id: 900 });
  A.recover(env); // conflict, both quarantined
  A.commitScope(env, { incident: INC, serial: 2, expires_at: '2026-10-18T13:00:00.000Z', permits: ['update_records'] });
  w.setClock('2026-10-18T14:00:00Z'); // serial 2 has expired
  assert.throws(() => A.adopt(env, quarantineDoc(env, 'adopt', T1, { incident_id: INC, scope_serial: 2 })), /use reconcile/);
  const fact = { kind: 'scope_expired', scope_serial: 2, scope_expires_at: '2026-10-18T13:00:00.000Z' };
  const r1 = quarantineDoc(env, 'reconcile', T1, { basis: 'incident_unauthorizable', incident_id: INC, fact });
  const r2 = quarantineDoc(env, 'reconcile', T2, { basis: 'incident_unauthorizable', incident_id: INC, fact });
  A.reconcile(env, r1);
  assert.equal(st(env).targets[T1].quarantinedBy, null, 'reconciled');
  // A newer committed (also expired) serial means the bound fact no longer holds: superseded, nothing changes.
  A.commitScope(env, { incident: INC, serial: 3, expires_at: '2026-10-18T13:30:00.000Z', permits: ['update_records'] });
  assert.match(A.reconcile(env, r2), /superseded/);
  assert.notEqual(st(env).targets[T2].quarantinedBy, null);
  assert.throws(() => A.reconcile(env, r1), /not an issued reconcile/, 'single use');

  // no_scope: a drift quarantine for an incident that has no scope at all.
  ({ env, setFault } = world());
  ({ id } = approve(env, [T1]));
  env.disk.files.set(T1, { bytes: Buffer.from('drifted'), id: 901 });
  assert.equal(A.apply(env, id), 'drift');
  const ns = quarantineDoc(env, 'reconcile', T1, { basis: 'incident_unauthorizable', incident_id: 'inc-none', fact: { kind: 'no_scope', latest_scope_serial: null } });
  A.commitScope(env, { incident: 'inc-none', serial: 1, expires_at: '2026-10-18T12:30:00.000Z', permits: [] });
  assert.match(A.reconcile(env, ns), /superseded/, 'a scope committed after issue: the no_scope fact no longer holds');
  const ns2 = quarantineDoc(env, 'reconcile', T1, { basis: 'incident_unauthorizable', incident_id: 'inc-stopped', fact: { kind: 'stopped', event_seq: 1 } });
  assert.match(A.reconcile(env, ns2), /superseded/, 'a fact pointing at a record that is not a stop does not hold');
  A.stop(env, 'inc-stopped');
  const stopSeq = verifyLedger(env.store.bytes).records.findLast((r) => r.body.type === 'stop').seq;
  A.reconcile(env, quarantineDoc(env, 'reconcile', T1, { basis: 'incident_unauthorizable', incident_id: 'inc-stopped', fact: { kind: 'stopped', event_seq: stopSeq } }));
  assert.equal(st(env).targets[T1].quarantinedBy, null);
});

test('T18/T19: a new epoch voids unspent approvals and quarantines every target; reconcile works even if the incident is stopped', () => {
  const { env } = world();
  const { id } = approve(env);
  A.stop(env, INC);
  A.newEpoch(env, signDoc({ kind: 'new-epoch', policy_version: 2, new_authority_epoch: 2, reason: 'backup_restored', ledger_head_seq: lastSeq(env) }));
  const s = st(env);
  assert.equal(s.approvals[id].status, 'void_by_epoch');
  // While every target is quarantined by the epoch, the global block (M1-F2) refuses first.
  assert.throws(() => A.apply(env, id), /unresolved transaction blocks every new apply/);
  assert.ok([T1, T2].every((k) => s.targets[k].quarantinedBy !== null));
  for (const k of [T1, T2]) A.reconcile(env, quarantineDoc(env, 'reconcile', k, { basis: 'epoch' }));
  assert.ok([T1, T2].every((k) => st(env).targets[k].quarantinedBy === null), 'resolved without the (stopped) incident');
  assert.throws(() => A.apply(env, id), /approval is void_by_epoch/, 'once resolved, the voided approval is still refused');
  assert.deepEqual(bytesOf(env), [`${T1} v0`, `${T2} v0`], 'reconcile wrote no bytes');
  const old = signDoc({ ...st(env).approvals[id].doc.payload, approval_id: randomBytes(16).toString('hex') });
  assert.throws(() => A.approveCommit(env, old), /authority epoch 1; current is 2/);
});

test('E: decisions are bound: unknown, reused, other transaction, wrong revision, wrong epoch, stale observed state', () => {
  const { env, setFault } = world();
  const { id } = approve(env);
  setFault('after_consuming'); crashes(() => A.apply(env, id));
  assert.throws(() => A.recover(env, { decisionId: 'f'.repeat(32) }), /not in the ledger/);
  const wrongRev = decision(env, id, 'cancel', [], { revision: 5 });
  assert.throws(() => A.recover(env, { decisionId: wrongRev }), /earlier recovery revision/);
  const stale = decision(env, id, 'cancel', []);
  env.disk.files.set(T1, env.disk.files.get(T1)); // unchanged reference: still valid
  env.disk.files.set(T2, { bytes: Buffer.from(`${T2} v0`), id: 777 }); // same bytes, different file id
  // M1-F1: identity is part of the state, so this is a conflict (fail closed), and the decision is not consumed.
  assert.equal(A.recover(env, { decisionId: stale }), 'conflict');
  assert.equal(st(env).decisions[stale].status, 'issued', 'the decision was not consumed');
  const s = st(env);
  const foreign = signDoc({ kind: 'recovery-decision', policy_version: 2, authority_epoch: 9, key_epoch: 1, decision_id: randomBytes(16).toString('hex') });
  assert.throws(() => A.issueDecision(env, foreign), /authority epoch 9/);
  assert.ok(s.decisions[wrongRev].status === 'issued', 'a refused use does not consume');
});
