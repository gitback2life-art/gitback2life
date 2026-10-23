// M3 (design revision 3.4, §§2, 10-12, 14.1): the authority's command entry point, wired to the M1/M2/M3 modules.
// `main(argv, deps)` takes everything environment-specific as `deps` (the environment, console, signer, request
// receiver), so it can be exercised synthetically. The PRODUCTION dependencies are built only by
// createProductionDeps(), which refuses unless it is running from an installed authority folder that carries an
// installed manifest. Nothing in this toolbox calls it; it is PREPARED, NOT RUN (owner gate M4).
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LIMITS } from '../g0a/request_pipe.mjs';
import * as E from '../m1/engine.mjs';
import { verifyLedger } from '../m1/ledger.mjs';
import { approveChange, approveRestore } from '../m2/commands.mjs';
import { FileLedgerStore, RealDisk } from './fs_backend.mjs';

const ARG = /^[a-z0-9-]{1,64}$/;
const COMMANDS = {
  'approve-change': { args: [0, 1], run: (d, [flag]) => approve(d, flag === 'apply') },
  apply: { args: [1, 1], run: (d, [id]) => E.apply(d.env, id) },
  recover: { args: [0, 1], run: (d, [id]) => E.recover(d.env, id ? { decisionId: id } : {}) },
  adopt: { args: [1, 1], run: (d, [id]) => E.adopt(d.env, id) },
  reconcile: { args: [1, 1], run: (d, [id]) => E.reconcile(d.env, id) },
  'revoke-change': { args: [1, 1], run: (d, [id]) => E.revokeChange(d.env, id) },
  stop: { args: [1, 1], run: (d, [incident]) => E.stop(d.env, incident) },
  diagnose: { args: [0, 0], run: (d) => E.diagnose(d.env) }, // read-only: writes nothing, takes no lock
  head: { args: [0, 0], run: (d) => { const v = verifyLedger(d.env.store.bytes); const last = v.records.at(-1); return { ledger: v.status, seq: last?.seq ?? 0, hash: last?.hash.toString('hex') ?? null }; } },
};

/** Verify the one-time receiver's staged bytes and remove only its known files BEFORE any approval commits.
 * Suspicious/missing/replaced/unlisted entries are left for operator inspection rather than deleted recursively.
 */
export function readStagedEntries(delivery) {
  if (!delivery || typeof delivery.incoming !== 'string' || !Array.isArray(delivery.entries)) throw new Error('invalid staged delivery');
  const root = delivery.incoming;
  const dir = lstatSync(root);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('the staging folder is not an ordinary directory');
  if (!delivery.entries.length || delivery.entries.length > LIMITS.entries) throw new Error('invalid staged entry count');
  const expected = delivery.entries.map((e, i) => {
    if (e.index !== i || !Number.isInteger(e.size) || e.size < 0 || e.size > LIMITS.entry ||
        typeof e.name !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error('invalid staged file metadata');
    return `entry-${String(i).padStart(4, '0')}`;
  });
  const actual = readdirSync(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('staging contains missing or unexpected entries; preserved for review');
  let total = 0;
  const snapshots = [];
  const entries = delivery.entries.map((meta, i) => {
    const path = join(root, expected[i]);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== meta.size) throw new Error('unsafe staged file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('staged file changed at open');
      bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('staged file changed while reading');
    } finally { closeSync(fd); }
    total += bytes.length;
    if (total > LIMITS.total || bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('staged file hash/size mismatch');
    snapshots.push({ path, before });
    return { name: meta.name, data: bytes };
  });
  const req = JSON.parse(entries[0].data.toString('utf8'));
  if (entries[0].name !== 'request.json' || typeof req.operation !== 'string' || req.operation !== delivery.operation) {
    throw new Error('the pipe operation and request.json operation do not agree');
  }
  // All checks before cleanup; no unknown path is deleted and no recursive remove is used.
  for (const { path, before } of snapshots) {
    const now = lstatSync(path);
    if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1 || now.dev !== before.dev || now.ino !== before.ino ||
        now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) throw new Error('staged file changed before cleanup');
  }
  for (const { path } of snapshots) unlinkSync(path);
  rmdirSync(root); // refuses unexpected newly inserted files
  return entries;
}

function approve(d, apply) {
  const processDelivery = (delivery) => {
    // Synthetic callers pass in-memory entries; the real local receiver yields verified staged files.
    const entries = Array.isArray(delivery) ? delivery : readStagedEntries(delivery);
    const first = JSON.parse(entries[0].data.toString('utf8'));
    const opts = { entries, signer: d.signer, display: d.display, confirm: d.confirm, apply };
    return first.operation === 'restore.stage' ? approveRestore(d.env, opts) : approveChange(d.env, opts);
  };
  const delivered = d.receive();
  return delivered && typeof delivered.then === 'function' ? delivered.then(processDelivery) : processDelivery(delivered);
}

/** Dispatch one command. argv = [command, ...args]; every argument must match ^[a-z0-9-]{1,64}$ (as the launcher). */
export function main(argv, deps) {
  const [command, ...args] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`unknown command ${JSON.stringify(command)}; known: ${Object.keys(COMMANDS).join(', ')}`);
  if (args.length < spec.args[0] || args.length > spec.args[1] || !args.every((a) => ARG.test(a))) throw new Error(`invalid arguments for ${command}`);
  if (command === 'approve-change' && args[0] !== undefined && args[0] !== 'apply') throw new Error('approve-change takes only the optional word "apply"');
  return spec.run(deps, args);
}


/**
 * OFFLINE PREPARATION ONLY: assemble the actual RealDisk diagnostic view, not a writable test backend.
 * Missing history, links/junctions at the selected root/ledger folder and nonregular ledger files fail closed.
 * No bootstrap invokes this function; protected production dispatch remains disabled pending owner gates.
 */
export function createReadOnlyDiagnosticDeps({ root } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('an explicit diagnostic root is required');
  for (const p of [root, join(root, 'ledger')]) {
    const st = lstatSync(p); // missing paths also refuse; never create them
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('diagnostic path is not an ordinary directory');
  }
  const ledger = new FileLedgerStore(join(root, 'ledger', 'ledger.log'));
  if (ledger.bytes.length === 0) throw new Error('the ledger has no genesis/history; authority is not initialized');
  // Do not expose FileLedgerStore's append/truncate setter through the diagnostic dependencies.
  const store = { get bytes() { return ledger.bytes; }, set bytes(_) { throw new Error('read-only diagnostics cannot change ledger history'); } };
  return { env: { store, disk: new RealDisk(root, { readOnly: true }) } };
}

/** Narrow, read-only dispatcher: no approve/apply/recover/stop/other command can cross this boundary. */
export function diagnosticMain(argv, { root } = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || !['diagnose', 'head'].includes(argv[0])) {
    throw new Error('offline diagnostic entry accepts only diagnose or head, with no arguments');
  }
  return main(argv, createReadOnlyDiagnosticDeps({ root }));
}

/**
 * PREPARED, NOT RUN. Builds production dependencies only inside an installed authority folder: the folder must hold
 * installed_manifest.json (written by the owner-run installer), and the caller supplies the elevated console and
 * passphrase reader. Refuses everywhere else. The toolbox never calls this.
 */
export function createProductionDeps({ root, console: con, readPassphrase, receive }) {
  if (!root || !existsSync(join(root, 'installed_manifest.json'))) throw new Error('the protected authority is not installed here (no installed_manifest.json); production commands are refused until the owner-run installation (M4)');
  if (!con || !readPassphrase || !receive) throw new Error('production commands need the elevated console, the passphrase reader and the pipe receiver');
  throw new Error('production wiring is gated: enable only after G0b and G2 pass and the owner decides M4');
}
