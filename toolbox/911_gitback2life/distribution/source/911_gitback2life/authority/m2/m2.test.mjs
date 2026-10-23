// M2 focused tests (design revision 3.3; §20 groups F, G and end-to-end). Synthetic Ed25519 key generated here,
// the M1 simulated disk, the G0a frame reader with an in-memory sink. The renderer's output is inspected as text;
// test inputs use harmless non-printing characters only (tab, CR, NUL, other C0 controls, DEL, Unicode format marks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { maskStoredText, TOOLBOX_ROOT } from '../../_shared/common.mjs';
import { buildFrame, FrameReader } from '../g0a/request_pipe.mjs';
import { canonical, verifyLedger } from '../m1/ledger.mjs';
import * as E from '../m1/engine.mjs';
import { approveChange } from './commands.mjs';
import { registerUpdate, validateRegister } from './register_rules.mjs';
import { decodeStrict, escapeText, MAX_LINES, renderReview } from './renderer.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // synthetic test key only
const signer = (bytes) => sign(null, bytes, privateKey).toString('base64');
const SERVICES = 'registers/services.json', DATA = 'registers/personal_data.json';
const SERVICE = { id: 'domain_main', service: 'domain_registrar', provider: 'Example Registrar', domain_or_account: 'example-rescue.org', account_owner_role: 'board_secretary',
  renews_on: '2027-03-01', auto_renew: true, mfa_enabled: null, recovery_contact_reviewed: null, review_date: null, evidence: null, status: 'unresolved' };
const DATAREC = { id: 'adoption_applications', category: 'adopter_contact_details', purpose: 'process_adoptions', location: 'forms_platform', provider: 'Example Forms',
  owner: 'adoption_coordinator', persistence: 'unknown', retention_days: null, oldest_record_at: null, review_date: null, legal_hold: false, evidence: null, status: 'unresolved' };
const ACCESS = { id: 'domain_board_secretary', system: 'domain_main', role: 'board_secretary', access_level: 'owner', mfa_enabled: true, still_needed: true,
  state: 'active', last_reviewed: null, evidence: null, status: 'unresolved' };
// Harmless non-printing characters: tab, CR, NUL, SOH, BEL, DEL, zero-width space, BOM, line separator, soft hyphen.
const NONPRINTING = ['\t', '\r', '\0', '\x01', '\x07', '\x7f', '​', '﻿', ' ', '­'];

function world() {
  const disk = { files: new Map(), nextId: 1, staging: new Map(), journal: new Map(), evidence: [] };
  const env = { store: { bytes: Buffer.alloc(0) }, disk, boot: 'boot-1', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    now: () => new Date('2026-10-18T12:00:00Z'), fault: () => {} };
  const reg = Buffer.from(`${JSON.stringify({ schema_version: 1, records: [SERVICE], history: [] }, null, 2)}\n`);
  E.init(env, { targets: [[SERVICES, { bytes: reg, id: disk.nextId++ }]] });
  E.commitScope(env, { incident: 'inc-1', serial: 1, expires_at: '2099-01-01T00:00:00Z', permits: ['update_records'] });
  return env;
}
/** The request as the exporter would send it, parsed by the real G0a frame reader (in-memory sink). */
function ingest(request) {
  const code = randomBytes(16);
  const frame = buildFrame({ code, operation: request.operation, entries: [{ name: 'request.json', data: Buffer.from(JSON.stringify(request)) }] });
  const parts = new Map();
  const reader = new FrameReader({ code, sink: { open: (i) => parts.set(i, []), data: (i, p) => parts.get(i).push(Buffer.from(p)), close: () => {} } });
  reader.feed(frame);
  assert.ok(reader.done);
  return reader.entries.map((e) => ({ name: e.name, data: Buffer.concat(parts.get(e.index)) }));
}
function scriptedConsole(answer) {
  const shown = [];
  return { shown, display: (t) => shown.push(t), confirm: () => (typeof answer === 'function' ? answer(shown) : answer) };
}
const typeTheCode = (shown) => /confirmation code to approve: (\S+)/.exec(shown.at(-1))[1];
const st = (env) => E.replay(verifyLedger(env.store.bytes).records);
const UNTRUSTED_LINE = /^( {0,4}\d+| {4}↪) │ /;

// --------------------------------------------------------------------------------------------------- renderer

test('G: non-printing characters in untrusted text are escaped; every untrusted line is printable ASCII inside a tagged fence', () => {
  const text = NONPRINTING.map((c, i) => `item${i}${c}end`).join('\n') + '\nback\\slash';
  const out = renderReview([{ title: 'Review', lines: ['trusted line'], untrusted: { label: 'reason', text } }], { tag: () => 'T3ST' });
  const lines = out.trimEnd().split('\n');
  const begin = lines.indexOf('BEGIN UNTRUSTED reason T3ST'), end = lines.indexOf('END UNTRUSTED reason T3ST');
  assert.ok(begin > 0 && end > begin, 'fenced with the tag');
  for (const l of lines.slice(begin + 1, end)) {
    assert.match(l, UNTRUSTED_LINE, 'gutter prefix on every untrusted line');
    assert.match(l.replace(UNTRUSTED_LINE, ''), /^[\x20-\x7e]*$/, `escaped text is printable ASCII only: ${JSON.stringify(l)}`);
  }
  for (const c of NONPRINTING) assert.ok(!out.includes(c), `raw ${JSON.stringify(c)} never reaches the output`);
  assert.equal(escapeText('a\tb'), 'a\\u{0009}b');
  assert.equal(escapeText('\r'), '\\u{000D}');
  assert.equal(escapeText('​'), '\\u{200B}');
  assert.equal(escapeText('x\\y'), 'x\\\\y');
  assert.equal(escapeText('é'), '\\u{00E9}', 'non-ASCII letters are escaped too');
  assert.equal(lines.filter((l) => l.startsWith('BEGIN UNTRUSTED')).length, 1);
});

test('G: long lines wrap with counted continuations; more than 2,000 display lines is refused, never truncated', () => {
  const out = renderReview([{ title: 'x', untrusted: { label: 'diff', text: 'a'.repeat(400) } }], { tag: () => 'AAAA' });
  assert.equal(out.split('\n').filter((l) => l.startsWith('    ↪ │ ')).length, 2, '400 characters = 1 line + 2 continuations');
  // 1,000 lines that each wrap once = 2,000 display lines: allowed. One more continuation: refused.
  const ok = Array.from({ length: 1000 }, () => 'b'.repeat(200)).join('\n');
  assert.ok(renderReview([{ title: 'x', untrusted: { label: 'diff', text: ok } }]));
  assert.throws(() => renderReview([{ title: 'x', untrusted: { label: 'diff', text: `${ok}\nc` } }]), /longer than 2000 display lines; split this change/);
  assert.equal(MAX_LINES, 2000);
});

test('G: strict UTF-8 decoding refuses invalid sequences; trusted text must be printable ASCII', () => {
  for (const bad of [[0xc3, 0x28], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xc0, 0xaf]]) assert.throws(() => decodeStrict(Buffer.from(bad)), /not valid UTF-8/);
  assert.equal(decodeStrict(Buffer.from('ok é', 'utf8')), 'ok é');
  assert.throws(() => renderReview([{ title: 'bad\ttitle' }]), /trusted text must be printable ASCII/);
});

// ------------------------------------------------------------------------------------------- register parity

test('F: the authority register rules decide every fixture exactly as the Python originals', () => {
  const kinds = { service: SERVICE, data: DATAREC, access: ACCESS };
  const cases = [];
  for (const [kind, rec] of Object.entries(kinds)) {
    const base = { schema_version: 1, records: [rec], history: [] };
    cases.push([kind, base, { ...rec, status: 'unresolved' }]); // valid replace
    cases.push([kind, base, { ...rec, id: 'second_record' }]); // valid add
    cases.push([kind, base, { ...rec, extra_field: 1 }]); // unknown field
    cases.push([kind, base, { ...rec, id: 'bad id!' }]); // bad identifier
    cases.push([kind, base, { ...rec, status: 'verified' }]); // verified without evidence
    cases.push([kind, base, { ...rec, evidence: 'call 212-555-0100' }]); // contact details
    cases.push([kind, base, { ...rec, evidence: 'line\tbreak' }]); // not a label
  }
  cases.push(['service', { schema_version: 1, records: [SERVICE], history: [] }, { ...SERVICE, service: 'teleporter' }]);
  cases.push(['data', { schema_version: 1, records: [DATAREC], history: [] }, { ...DATAREC, retention_days: -1 }]);
  cases.push(['access', { schema_version: 1, records: [ACCESS], history: [] }, { ...ACCESS, access_level: 'god' }]);
  const js = cases.map(([kind, data, rec]) => { try { const r = registerUpdate(kind, data, rec, 'AT'); return { ok: true, records: r.records }; } catch (e) { return { ok: false, rule: Boolean(e.rule) }; } });
  const py = JSON.parse(execFileSync('python', ['-I', '-c', [
    'import sys, json, importlib.util', 'sys.dont_write_bytecode = True',
    `root = ${JSON.stringify(TOOLBOX_ROOT)}`, 'sys.path.insert(0, root + "/_shared")',
    'def load(n):', '    s = importlib.util.spec_from_file_location(n, f"{root}/{n}/{n}.py"); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m',
    'org, acc = load("org_registers"), load("access_offboarding")', 'out = []',
    'for kind, data, rec in json.load(sys.stdin):',
    '    try:',
    '        r = acc.register_update(data, rec) if kind == "access" else org.register_update(kind, data, rec)',
    '        out.append({"ok": True, "records": r["records"]})',
    '    except Exception:',
    '        out.append({"ok": False})',
    'print(json.dumps(out))'].join('\n')], { input: JSON.stringify(cases), encoding: 'utf8' }));
  assert.equal(js.length, py.length);
  js.forEach((j, i) => {
    assert.equal(j.ok, py[i].ok, `case ${i} (${cases[i][0]}): accept/refuse agrees with Python`);
    if (j.ok) assert.deepEqual(j.records, py[i].records, `case ${i}: identical resulting records`);
    else assert.equal(j.rule, true, `case ${i}: refused as a register rule`);
  });
  assert.doesNotThrow(() => validateRegister('service', { schema_version: 1, records: [SERVICE], history: [] }));
});

// ------------------------------------------------------------------------------------------------ end to end

test('E2E: register.replace through ingestion, review, confirmation, signature, apply; history appended', () => {
  const env = world();
  const reason = `renewal confirmed${NONPRINTING.join('')} by the board`;
  const entries = ingest({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', reason,
    record: { ...SERVICE, mfa_enabled: true, review_date: '2026-10-18', evidence: 'registrar_dashboard_screenshot', status: 'verified' } });
  // A wrong code: nothing is signed, nothing is issued, staging is removed.
  const wrong = scriptedConsole('not-the-code');
  assert.throws(() => approveChange(env, { entries, signer, maskStoredText, ...wrong }), /confirmation code did not match; nothing was signed/);
  assert.equal(Object.keys(st(env).approvals).length, 0);
  assert.equal(env.disk.staging.size, 0);
  // The right code, typed after the review.
  const ok = scriptedConsole(typeTheCode);
  const r = approveChange(env, { entries, signer, maskStoredText, ...ok, apply: true });
  assert.equal(r.result, 'applied');
  assert.ok(ok.shown[0].includes('BEGIN UNTRUSTED register diff') && ok.shown[0].includes('BEGIN UNTRUSTED reason'));
  assert.ok(ok.shown[0].indexOf('Change to approve') < ok.shown[0].indexOf('BEGIN UNTRUSTED'), 'trusted summary first');
  for (const c of NONPRINTING) assert.ok(!ok.shown[0].includes(c), `the review shows ${JSON.stringify(c)} only escaped`);
  assert.match(ok.shown.at(-1), /^Type this confirmation code to approve: [a-z]+(-[a-z]+){5}\n$/, 'code shown after the review');
  const reg = JSON.parse(env.disk.files.get(SERVICES).bytes.toString());
  assert.equal(reg.records[0].status, 'verified');
  assert.equal(reg.history.length, 1);
  assert.deepEqual(reg.history[0].previous, SERVICE);
  assert.equal(reg.history[0].at, '2026-10-18T12:00:00.000Z');
  const s = st(env);
  assert.equal(s.approvals[r.approvalId].status, 'applied');
  assert.equal(s.targets[SERVICES].sha, sha(env.disk.files.get(SERVICES).bytes));
});

test('E2E: register.create, then a replace of the created register, both end to end', () => {
  const env = world();
  const created = approveChange(env, { entries: ingest({ schema: 1, operation: 'register.create', register_key: DATA, incident_id: 'inc-1',
    register: { schema_version: 1, records: [DATAREC], history: [] } }), signer, maskStoredText, ...scriptedConsole(typeTheCode), apply: true });
  assert.equal(created.result, 'applied');
  assert.match(created.review, /prior: {8}absent/);
  const replaced = approveChange(env, { entries: ingest({ schema: 1, operation: 'register.replace', register_key: DATA, incident_id: 'inc-1',
    record: { ...DATAREC, persistence: 'intended_none' } }), signer, maskStoredText, ...scriptedConsole(typeTheCode), apply: true });
  assert.equal(replaced.result, 'applied');
  assert.equal(JSON.parse(env.disk.files.get(DATA).bytes.toString()).records[0].persistence, 'intended_none');
  assert.equal(st(env).targets[DATA].generation, 2);
});

test('E2E: refusals happen before anything is signed or staged', () => {
  const env = world();
  const run = (request, answer = typeTheCode) => {
    const con = scriptedConsole(answer);
    assert.throws(() => approveChange(env, { entries: ingest(request), signer, maskStoredText, ...con }), E.Refused);
    return con;
  };
  // A record with contact details is refused by the register rules, before any review is shown.
  const contact = run({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', record: { ...SERVICE, evidence: 'call 212-555-0100' } });
  assert.equal(contact.shown.length, 0, 'no review shown');
  // Secret-shaped content that the label rules allow is refused by the masked-storage check, not transformed.
  run({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', record: { ...SERVICE, evidence: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
  // Unknown register, missing scope, create over an existing register, replace of an absent one.
  run({ schema: 1, operation: 'register.replace', register_key: 'registers/other.json', incident_id: 'inc-1', record: SERVICE });
  run({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-none', record: SERVICE });
  run({ schema: 1, operation: 'register.create', register_key: SERVICES, incident_id: 'inc-1', register: { schema_version: 1, records: [SERVICE], history: [] } });
  run({ schema: 1, operation: 'register.replace', register_key: DATA, incident_id: 'inc-1', record: DATAREC });
  assert.equal(Object.keys(st(env).approvals).length, 0, 'nothing was issued');
  assert.equal(env.disk.staging.size, 0, 'nothing left staged');
  // Drift: the register changed on disk after the ledger recorded it.
  env.disk.files.set(SERVICES, { bytes: Buffer.from('{}\n'), id: 4242 });
  assert.throws(() => approveChange(env, { entries: ingest({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', record: SERVICE }),
    signer, maskStoredText, ...scriptedConsole(typeTheCode) }), /does not match the ledger \(drift/);
});

test('M2-F1 (v13 review): same bytes with a different file identity is refused at issuance; the normal case and create still work', () => {
  // The review's reproduction: the register is replaced by an object with IDENTICAL bytes but file id 9999.
  const env = world();
  const original = env.disk.files.get(SERVICES);
  env.disk.files.set(SERVICES, { bytes: Buffer.from(original.bytes), id: 9999 });
  const request = { schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', record: { ...SERVICE, mfa_enabled: true } };
  assert.throws(() => approveChange(env, { entries: ingest(request), signer, maskStoredText, ...scriptedConsole(typeTheCode) }), /file identity/);
  assert.equal(Object.keys(st(env).approvals).length, 0, 'no approval issued');
  assert.equal(env.disk.files.get(SERVICES).id, 9999, 'no target change');
  // Enforced at the M1 issuance boundary too, not only in the command wrapper: a correctly signed approval for the
  // ledger's prior is refused while the disk identity differs.
  const s = st(env), t = s.targets[SERVICES];
  const payload = { kind: 'change-approval', policy_version: 2, authority_epoch: s.epoch, key_epoch: 1, approval_id: randomBytes(16).toString('hex'),
    operation: 'register.replace', incident_id: 'inc-1', scope_serial: 1,
    targets: [{ target_key: SERVICES, prior: t.sha, prior_generation: t.generation, prior_file_id: t.fileId, proposed_sha256: sha(Buffer.from('x')), proposed_size: 1 }],
    staged_sha256: sha(Buffer.from('x')), issued_at: '2026-10-18T12:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' };
  assert.throws(() => E.approveCommit(env, { payload, signature: signer(Buffer.from(canonical(payload))) }), /file identity/, 'refused for the identity, with a valid signature');
  // Normal control: with the original identity restored, the same request is approved.
  env.disk.files.set(SERVICES, original);
  assert.equal(approveChange(env, { entries: ingest(request), signer, maskStoredText, ...scriptedConsole(typeTheCode) }).result, 'issued');
  // Create when absent still works (absent on disk and in the ledger).
  const created = approveChange(env, { entries: ingest({ schema: 1, operation: 'register.create', register_key: DATA, incident_id: 'inc-1',
    register: { schema_version: 1, records: [DATAREC], history: [] } }), signer, maskStoredText, ...scriptedConsole(typeTheCode) });
  assert.equal(created.result, 'issued');
});

test('E2E: a signature from another key is refused by the M1 commit; the approval is not issued', () => {
  const env = world();
  const other = generateKeyPairSync('ed25519').privateKey; // a second synthetic key, not the authority's
  const wrongSigner = (bytes) => sign(null, bytes, other).toString('base64');
  assert.throws(() => approveChange(env, { entries: ingest({ schema: 1, operation: 'register.replace', register_key: SERVICES, incident_id: 'inc-1', record: SERVICE }),
    signer: wrongSigner, maskStoredText, ...scriptedConsole(typeTheCode) }), /signature does not verify/);
  assert.equal(Object.keys(st(env).approvals).length, 0);
  assert.equal(env.disk.staging.size, 0);
});
