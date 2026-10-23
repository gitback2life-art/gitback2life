// M3 (design revision 3.4, §§3, 4, 11, 14.3): the REAL-filesystem backend for the M1 engine. Same interface as the
// simulated disk, so the engine and its state machine are unchanged; identities come from the operating system.
// Prototype only: it works under the root it is GIVEN (tests: temporary folders). It is NOT pointed at the protected
// authority folder by anything in this toolbox; the production root is supplied only by the installed launcher (M4).
//
// Layout under <root>:  ledger/ledger.log   data/registers/…   data/restores/…   data/.work/ (temporary files, same
//                       volume)   staging/<approval>.json   journal/<approval>.json   evidence/<n>.json
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export class BackendRefused extends Error { constructor(m) { super(`refused: ${m}`); this.refused = true; } }
const refuse = (m) => { throw new BackendRefused(m); };

function statIfPresent(p) {
  try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function ordinaryDirectoryIfPresent(p) {
  const st = statIfPresent(p);
  if (st && (!st.isDirectory() || st.isSymbolicLink())) refuse(`unsafe folder at ${p}`);
  return st;
}
/**
 * Genesis preflight happens BEFORE mkdir. A missing ledger in an existing v7 or other
 * populated root may mean lost history and must not be replaced with a fresh genesis.
 * Only an empty synthetic root or the known empty M3/predeployment layout is eligible.
 * Production still requires separate owner gates; this is NOT a migration path.
 */
function inspectFreshGenesisLayout(root) {
  if (!ordinaryDirectoryIfPresent(root)) return;
  const allowedRoot = new Set(['ledger', 'data', 'staging', 'journal', 'evidence',
    'm1', 'm2', 'm3', 'g0a', 'launch_scratch', 'authority.cmd', 'bootstrap.mjs', 'installed_manifest.json']);
  const knownFiles = new Set(['authority.cmd', 'bootstrap.mjs', 'installed_manifest.json']);
  const emptyFolders = new Set(['staging', 'journal', 'evidence', 'launch_scratch']);
  for (const entry of readdirSync(root)) {
    if (!allowedRoot.has(entry)) refuse(`first-time initialization refused: unknown existing root entry ${entry}; possible prior authority state`);
    const path = join(root, entry), st = lstatSync(path);
    if (st.isSymbolicLink()) refuse(`first-time initialization refused: link in root ${entry}`);
    if (knownFiles.has(entry)) {
      if (!st.isFile() || st.nlink !== 1) refuse(`first-time initialization refused: invalid root file ${entry}`);
    } else if (!st.isDirectory()) refuse(`first-time initialization refused: non-directory root entry ${entry}`);
    if (emptyFolders.has(entry) && readdirSync(path).length) refuse(`first-time initialization refused: ${entry} holds state`);
  }
  const ledger = join(root, 'ledger');
  if (ordinaryDirectoryIfPresent(ledger)) {
    const contents = readdirSync(ledger);
    if (contents.some((name) => name !== 'authority.lock')) refuse('first-time initialization refused: ledger folder already holds history');
    if (contents.length) {
      const lock = lstatSync(join(ledger, 'authority.lock'));
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || lock.size !== 0)
        refuse('first-time initialization refused: unexpected lock file');
    }
  }
  const data = join(root, 'data');
  if (ordinaryDirectoryIfPresent(data)) {
    for (const name of readdirSync(data)) {
      if (!['registers', 'restores', '.work'].includes(name)) refuse(`first-time initialization refused: unknown data state ${name}`);
      const child = join(data, name);
      ordinaryDirectoryIfPresent(child);
      if (readdirSync(child).length) refuse(`first-time initialization refused: ${name} already holds state`);
    }
  }
}

/** Write a whole buffer and flush it (a write loop: short writes are completed, a zero write is refused). */
function writeAllSync(fd, bytes) {
  for (let off = 0; off < bytes.length;) { const n = writeSync(fd, bytes, off, bytes.length - off); if (n <= 0) refuse('a write made no progress'); off += n; }
  fsyncSync(fd);
}

/**
 * The ledger as a real file. The engine only ever (a) appends records at the verified end or (b) truncates a torn
 * tail; anything else is refused. Every change is flushed (FlushFileBuffers) before returning (§4 write-ahead).
 *
 * Opening never creates (§§4, 14.2): a missing ledger is lost history and is refused, never silently replaced by an
 * empty one. A new ledger is made only by createNew(), the explicit first-time initialization path.
 */
/**
 * Hold the identity of the opened ledger and revalidate both the pathname and
 * the handle before any write. Opening with O_APPEND alone would CREATE a
 * disappeared ledger; O_WRONLY | O_APPEND intentionally refuses that case.
 * O_NOFOLLOW is defense in depth on platforms that implement it. Windows still
 * requires owner-controlled reparse/hardlink acceptance before production.
 */
function checkedLedgerFd(path, flags, identity = null) {
  const st = lstatSync(path, { bigint: true });
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n) refuse('ledger pathname is not one ordinary file');
  if (identity && (st.dev !== identity.dev || st.ino !== identity.ino)) refuse('ledger pathname identity changed');
  const fd = openSync(path, flags | (fsConstants.O_NOFOLLOW || 0));
  try {
    const actual = fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n || actual.dev !== st.dev || actual.ino !== st.ino)
      refuse('ledger handle identity changed while opening');
    if (identity && (actual.dev !== identity.dev || actual.ino !== identity.ino))
      refuse('ledger handle does not match pinned identity');
    return { fd, identity: { dev: actual.dev, ino: actual.ino } };
  } catch (e) { closeSync(fd); throw e; }
}

export class FileLedgerStore {
  constructor(path) {
    this.path = path;
    ordinaryDirectoryIfPresent(dirname(path));
    ordinaryDirectoryIfPresent(dirname(dirname(path)));
    if (!statIfPresent(path)) refuse(`the ledger ${path} is missing: its history may be lost; treat as corrupt (§14.2), never re-create it on open`);
    const { fd, identity } = checkedLedgerFd(path, fsConstants.O_RDONLY);
    try { this._bytes = readFileSync(fd); } finally { closeSync(fd); }
    this._identity = identity;
  }

  /** Explicit first-time initialization; never intended for implicit recovery. */
  static createNew(path) {
    const dir = dirname(path), root = dirname(dir);
    if (path !== join(root, 'ledger', 'ledger.log')) refuse('first-time initialization refused: unexpected ledger path');
    inspectFreshGenesisLayout(root);
    mkdirSync(dir, { recursive: true });
    const fd = openSync(path, 'wx');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return new FileLedgerStore(path);
  }
  get bytes() { return this._bytes; }
  set bytes(next) {
    const old = this._bytes;
    if (next.length >= old.length && next.subarray(0, old.length).equals(old)) {
      // No O_CREAT: a vanished ledger must never be silently replaced.
      const { fd } = checkedLedgerFd(this.path, fsConstants.O_WRONLY | fsConstants.O_APPEND, this._identity);
      try { writeAllSync(fd, next.subarray(old.length)); } finally { closeSync(fd); }
    } else if (next.length < old.length && old.subarray(0, next.length).equals(next)) {
      const { fd } = checkedLedgerFd(this.path, fsConstants.O_RDWR, this._identity);
      try { ftruncateSync(fd, next.length); fsyncSync(fd); } finally { closeSync(fd); }
    } else refuse('the ledger may only be appended to or have a torn tail truncated');
    this._bytes = Buffer.from(next);
  }
}

/** A JSON map persisted per entry (staging, journal): every set is written to a new file, flushed, then renamed. */
class DurableJsonMap {
  constructor(dir, encode, decode, { readOnly = false } = {}) {
    this.dir = dir; this.encode = encode; this.decode = decode; this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dir, { recursive: true });
  }
  file(id) { if (!/^[0-9a-f]{32}$/.test(id)) refuse('bad approval id'); return join(this.dir, `${id}.json`); }
  set(id, value) {
    if (this.readOnly) refuse('read-only diagnostics cannot stage or replace entries');
    const tmp = `${this.file(id)}.${randomBytes(4).toString('hex')}.tmp`, fd = openSync(tmp, 'wx');
    try { writeAllSync(fd, Buffer.from(JSON.stringify(this.encode(value)))); } finally { closeSync(fd); }
    renameSync(tmp, this.file(id));
    return this;
  }
  checkedFile(id) {
    const f = this.file(id);
    if (!ordinaryDirectoryIfPresent(this.dir)) return null;
    const st = statIfPresent(f);
    if (!st) return null;
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) refuse('unsafe staging/journal entry');
    return f;
  }
  get(id) { const f = this.checkedFile(id); return f ? this.decode(JSON.parse(readFileSync(f, 'utf8'))) : undefined; }
  has(id) { return !!this.checkedFile(id); }
  delete(id) { if (this.readOnly) refuse('read-only diagnostics cannot delete entries'); rmSync(this.file(id), { force: true }); return true; }
  get size() { return ordinaryDirectoryIfPresent(this.dir) ? readdirSync(this.dir).filter((n) => n.endsWith('.json')).length : 0; }
}
const b64 = (b) => b.toString('base64'), unb64 = (s) => Buffer.from(s, 'base64');

/**
 * The disk: `files`, `dirs`, `writeTemp`, `mkdir`, `renameDir`, `staging`, `journal`, `evidence`, keyed exactly like
 * the simulated disk ("registers/services.json", "restores/<id>/<rel>"). Every access refuses links and junctions on
 * the path, non-regular files, and files with more than one name.
 */
export class RealDisk {
  constructor(root, { readOnly = false } = {}) {
    this.root = root;
    this.readOnly = readOnly;
    this.data = join(root, 'data');
    this.work = join(this.data, '.work');
    if (!readOnly) {
      for (const p of [root, this.data, this.work, join(root, 'staging'), join(root, 'journal'), join(root, 'evidence')]) ordinaryDirectoryIfPresent(p);
      mkdirSync(this.work, { recursive: true });
    }
    const disk = this;
    this.files = {
      get: (key) => disk.readFile(key),
      has: (key) => disk.readFile(key) !== undefined,
      set: (key, f) => { if (readOnly) refuse('read-only diagnostics cannot place files'); disk.placeFile(key, f); return disk.files; },
      delete: (key) => { if (readOnly) refuse('read-only diagnostics cannot delete files'); const p = disk.path(key); disk.checkPath(p); if (existsSync(p)) unlinkSync(p); return true; },
      *[Symbol.iterator]() { yield* disk.walk(); },
    };
    this.dirs = {
      get: (key) => disk.readDir(key),
      has: (key) => disk.readDir(key) !== undefined,
      set: (key) => { if (readOnly) refuse('read-only diagnostics cannot create folders'); disk.mkdir(key); return disk.dirs; },
      delete: (key) => { if (readOnly) refuse('read-only diagnostics cannot delete folders'); const p = disk.path(key); disk.checkPath(p); rmdirSync(p); return true; },
    };
    this.staging = new DurableJsonMap(join(root, 'staging'),
      (m) => Object.fromEntries([...m].map(([k, v]) => [k, v instanceof Map ? { tree: Object.fromEntries([...v].map(([r, b]) => [r, b64(b)])) } : { file: b64(v) }])),
      (o) => new Map(Object.entries(o).map(([k, v]) => [k, v.tree ? new Map(Object.entries(v.tree).map(([r, s]) => [r, unb64(s)])) : unb64(v.file)])), { readOnly });
    this.journal = new DurableJsonMap(join(root, 'journal'),
      (m) => Object.fromEntries([...m].map(([k, v]) => [k, v ? { bytes: b64(v.bytes), id: v.id } : null])),
      (o) => new Map(Object.entries(o).map(([k, v]) => [k, v ? { bytes: unb64(v.bytes), id: v.id } : null])), { readOnly });
    const evDir = join(root, 'evidence');
    if (!readOnly) mkdirSync(evDir, { recursive: true });
    this.evidence = { push: (e) => { if (readOnly) refuse('read-only diagnostics cannot write evidence'); const n = readdirSync(evDir).length; const fd = openSync(join(evDir, `${String(n).padStart(6, '0')}.json`), 'wx');
      try { writeAllSync(fd, Buffer.from(JSON.stringify({ ...e, bytes: e.bytes ? b64(e.bytes) : undefined }))); } finally { closeSync(fd); } }, get length() { return ordinaryDirectoryIfPresent(evDir) ? readdirSync(evDir).length : 0; } };
  }

  /** Key → path under data/. Keys are authority-generated; anything that could escape is refused. */
  path(key) {
    if (typeof key !== 'string' || !/^(registers|restores)\/[A-Za-z0-9._/-]+$/.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..')) refuse(`bad target key ${JSON.stringify(key)}`);
    return join(this.data, ...key.split('/'));
  }
  /** No link or junction on any EXISTING component from data/ down to the path itself. */
  checkPath(p) {
    const rel = relative(this.data, p);
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) refuse('outside the data folder');
    // The data directory itself is a security boundary, not just its children.
    // Without this check a junction at <root>/data would redirect read-only diagnostics elsewhere.
    for (const base of [this.root, this.data]) {
      let st; try { st = lstatSync(base); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      if (!st.isDirectory() || st.isSymbolicLink()) refuse(`${relative(this.root, base) || 'root'} is not an ordinary directory`);
    }
    let cur = this.data;
    for (const part of rel.split(sep)) {
      cur = join(cur, part);
      let st; try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      if (st.isSymbolicLink()) refuse(`${relative(this.root, cur)} is a link or junction`);
    }
  }
  readFile(key) {
    const p = this.path(key);
    this.checkPath(p);
    let st; try { st = lstatSync(p, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    if (!st.isFile()) refuse(`${key} is not a regular file`);
    if (st.nlink !== 1n) refuse(`${key} has more than one name (hard link)`);
    return { bytes: readFileSync(p), id: String(st.ino) };
  }
  readDir(key) {
    const p = this.path(key);
    this.checkPath(p);
    let st; try { st = lstatSync(p, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    if (!st.isDirectory()) refuse(`${key} is not a folder`);
    return { id: String(st.ino) };
  }
  /** A new temporary file in data/.work (exclusive create, complete write, flush). Its identity is the OS file id. */
  writeTemp(bytes) {
    if (this.readOnly) refuse('read-only diagnostics cannot create temporary files');
    const tempPath = join(this.work, `t-${randomBytes(12).toString('hex')}`), fd = openSync(tempPath, 'wx');
    try { writeAllSync(fd, Buffer.from(bytes)); } finally { closeSync(fd); }
    return { bytes: Buffer.from(bytes), id: String(lstatSync(tempPath, { bigint: true }).ino), tempPath };
  }
  /** Rename a temporary file into place (same volume: the file id is kept). */
  placeFile(key, f) {
    if (this.readOnly) refuse('read-only diagnostics cannot publish files');
    const p = this.path(key);
    this.checkPath(p);
    if (!f?.tempPath) refuse('only files created by writeTemp can be placed');
    mkdirSync(dirname(p), { recursive: true });
    this.checkPath(p);
    renameSync(f.tempPath, p);
  }
  mkdir(key) { if (this.readOnly) refuse('read-only diagnostics cannot create folders'); const p = this.path(key); this.checkPath(p); mkdirSync(dirname(p), { recursive: true }); mkdirSync(p); return this.readDir(key).id; }
  renameDir(from, to) { if (this.readOnly) refuse('read-only diagnostics cannot rename folders'); const a = this.path(from), b = this.path(to); this.checkPath(a); this.checkPath(b); if (existsSync(b)) refuse(`${to} already exists`); renameSync(a, b); }
  /** Every file under data/ (except the temporary area) as [key, {bytes, id}]. */
  *walk() {
    const stack = ['registers', 'restores'];
    while (stack.length) {
      const key = stack.pop(), p = join(this.data, ...key.split('/'));
      this.checkPath(p);
      if (!existsSync(p)) continue;
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const k = `${key}/${e.name}`;
        if (e.isSymbolicLink()) refuse(`${k} is a link or junction`);
        if (e.isDirectory()) stack.push(k);
        else if (e.isFile()) yield [k, this.readFile(k)];
        else refuse(`${k} is not an ordinary file or directory`);
      }
    }
  }
}
