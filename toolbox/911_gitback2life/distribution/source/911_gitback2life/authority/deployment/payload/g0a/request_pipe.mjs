// G0a prototype (design revision 3.1, §6): request ingestion over a one-time LOCAL named pipe, as framed bytes.
// NOT installed. This is the protocol half only, tested same-integrity and non-elevated. The privilege boundary
// (first-instance flag, DACL, remote-client rejection, medium-integrity client check by impersonation) belongs to
// the protected PowerShell helper and is gate G0b (owner-run); it is NOT implemented or claimed here.
//
// Frame:  "GB2LREQ1" | code (16) | header length (u32 BE, <= 65,536) | header JSON {schema, operation, count, total}
//         | count x [ name length (u16 BE, 1..255) | name (UTF-8, validated) | size (u32 BE, <= 10 MB) | sha256 (32)
//         | bytes ] | trailer sha256 (32) over everything before it.
// Every length is checked BEFORE anything of that size is allocated; entry bytes are streamed to their staging file
// and hashed incrementally, never held whole in memory.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';

export const LIMITS = Object.freeze({ header: 65_536, name: 255, entries: 1000, entry: 10 * 1024 * 1024, total: 100 * 1024 * 1024 });
export const MAGIC = Buffer.from('GB2LREQ1', 'ascii');
export const OPERATIONS = Object.freeze(['register.create', 'register.replace', 'restore.stage']);
const PIPE = /^\\\\\.\\pipe\\gb2l-[0-9a-f]{32}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;
const fail = (why) => { const e = new Error(`request refused: ${why}`); e.refusal = true; throw e; };

/** Entry names (§7, §14.3): "request.json" first, then (restore.stage only) "files/<relpath>". */
export function checkName(name) {
  if (name === 'request.json') return;
  if (!name.startsWith('files/')) fail(`entry name not allowed: ${JSON.stringify(name)}`);
  const rel = name.slice('files/'.length);
  const segs = rel.split('/');
  if (rel.length > 200 || segs.length > 8) fail('entry path too long or too deep');
  for (const s of segs) {
    if (!SEGMENT.test(s) || s.endsWith('.') || DEVICE.test(s)) fail(`entry path segment not allowed: ${JSON.stringify(s)}`);
  }
  if (rel === 'restore_manifest.json') fail('RESTORE_MANIFEST.json is reserved');
}

/** Incremental frame reader. feed() bytes as they arrive; the sink receives entry data in pieces. */
export class FrameReader {
  constructor({ code, sink, limits = LIMITS }) {
    this.code = code; this.sink = sink; this.limits = limits;
    this.whole = createHash('sha256');
    this.state = 'magic'; this.need = 8; this.buf = Buffer.alloc(0);
    this.entries = []; this.names = new Set(); this.dirs = new Set(); this.sum = 0; this.done = false;
  }

  feed(chunk) {
    let off = 0;
    while (off < chunk.length) {
      if (this.done) fail('bytes after the trailer');
      if (this.state === 'data') {
        const take = Math.min(this.remaining, chunk.length - off);
        const piece = chunk.subarray(off, off + take);
        this.whole.update(piece); this.entryHash.update(piece); this.sink.data(this.index, piece);
        this.remaining -= take; off += take;
        if (this.remaining === 0) this.endEntry();
        continue;
      }
      const take = Math.min(this.need - this.buf.length, chunk.length - off);
      this.buf = Buffer.concat([this.buf, chunk.subarray(off, off + take)]); off += take;
      if (this.buf.length === this.need) { const field = this.buf; this.buf = Buffer.alloc(0); this.field(field); }
    }
  }

  field(b) {
    if (this.state !== 'trailer') this.whole.update(b);
    switch (this.state) {
      case 'magic': if (!b.equals(MAGIC)) fail('not a request frame'); return this.next('code', 16);
      case 'code': if (!b.equals(this.code)) fail('wrong one-time code'); return this.next('hlen', 4);
      case 'hlen': { const n = b.readUInt32BE(0); if (n < 2 || n > this.limits.header) fail(`header length ${n} out of range`); return this.next('header', n); }
      case 'header': return this.header(b);
      case 'nlen': { const n = b.readUInt16BE(0); if (n < 1 || n > this.limits.name) fail(`entry name length ${n} out of range`); return this.next('name', n); }
      case 'name': {
        let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { fail('entry name is not valid UTF-8'); }
        checkName(name);
        if (this.entries.length === 0 && name !== 'request.json') fail('the first entry must be request.json');
        if (this.entries.length > 0 && this.op !== 'restore.stage') fail(`${this.op} carries only request.json`);
        if (this.names.has(name) || this.dirs.has(name)) fail(`duplicate or colliding entry ${name}`);
        const parts = name.split('/');
        for (let i = 1; i < parts.length; i++) if (this.names.has(parts.slice(0, i).join('/'))) fail(`entry ${name} collides with a file used as a folder`);
        for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
        this.names.add(name); this.name = name; return this.next('size', 4);
      }
      case 'size': {
        const n = b.readUInt32BE(0);
        if (n > this.limits.entry) fail(`entry size ${n} over the ${this.limits.entry}-byte limit`);
        if (this.sum + n > this.total) fail('entries exceed the declared total');
        this.size = n; return this.next('sha', 32);
      }
      case 'sha': return this.startEntry(b);
      case 'trailer': {
        if (!b.equals(this.whole.digest())) fail('trailer hash mismatch');
        this.done = true; return undefined;
      }
      default: return fail('internal state');
    }
  }

  next(state, need) { this.state = state; this.need = need; }

  header(b) {
    let h; try { h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { fail('header is not valid JSON'); }
    if (!h || h.schema !== 1 || !OPERATIONS.includes(h.operation)) fail('unknown schema or operation');
    if (!Number.isInteger(h.count) || h.count < 1 || h.count > this.limits.entries) fail(`entry count ${h.count} out of range`);
    if (!Number.isInteger(h.total) || h.total < 0 || h.total > this.limits.total) fail(`declared total ${h.total} out of range`);
    if (h.operation !== 'restore.stage' && h.count !== 1) fail(`${h.operation} carries exactly one entry`);
    this.op = h.operation; this.count = h.count; this.total = h.total;
    return this.next('nlen', 2);
  }

  startEntry(sha) {
    this.index = this.entries.length; this.expected = sha; this.entryHash = createHash('sha256'); this.remaining = this.size;
    this.sink.open(this.index);
    if (this.size === 0) this.endEntry(); else { this.state = 'data'; }
  }

  endEntry() {
    if (!this.entryHash.digest().equals(this.expected)) fail(`hash mismatch in ${this.name}`);
    this.sink.close(this.index);
    this.entries.push({ name: this.name, size: this.size, sha256: this.expected.toString('hex'), index: this.index });
    this.sum += this.size;
    if (this.entries.length === this.count) {
      if (this.sum !== this.total) fail('entries do not add up to the declared total');
      this.next('trailer', 32);
    } else this.next('nlen', 2);
  }
}

/** Build a frame (exporter side, and for tests). `entries` = [{ name, data }]. */
export function buildFrame({ code, operation, entries }) {
  const parts = [MAGIC, code];
  const header = Buffer.from(JSON.stringify({ schema: 1, operation, count: entries.length, total: entries.reduce((n, e) => n + e.data.length, 0) }));
  const hlen = Buffer.alloc(4); hlen.writeUInt32BE(header.length);
  parts.push(hlen, header);
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), nlen = Buffer.alloc(2), size = Buffer.alloc(4);
    nlen.writeUInt16BE(name.length); size.writeUInt32BE(e.data.length);
    parts.push(nlen, name, size, createHash('sha256').update(e.data).digest(), e.data);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}

/**
 * Receive exactly one request on a fresh local pipe. Entries are written (exclusive create, flushed) to
 * <stagingDir>\incoming\entry-NNNN. On ANY refusal the incoming folder is deleted and the promise rejects.
 */
export function receiveRequest({ pipe, code, stagingDir, idleMs = 30_000, totalMs = 300_000, eofMs = 2000, limits = LIMITS, write = writeSync }) {
  if (!PIPE.test(pipe)) throw new Error('only a local \\\\.\\pipe\\gb2l-<32 hex> name is accepted');
  const incoming = join(stagingDir, 'incoming');
  mkdirSync(incoming); // fails if it already exists
  const fds = new Map();
  const sink = {
    open: (i) => fds.set(i, openSync(join(incoming, `entry-${String(i).padStart(4, '0')}`), 'wx')),
    // G0a-F2: writeSync may store fewer bytes than asked. Loop until the whole piece is on disk; a write that makes
    // no progress refuses the request (and the whole incoming folder is removed by finish()).
    data: (i, piece) => {
      for (let off = 0; off < piece.length;) {
        const n = write(fds.get(i), piece, off, piece.length - off);
        if (!Number.isInteger(n) || n <= 0) fail('a staging write made no progress');
        off += n;
      }
    },
    close: (i) => { const fd = fds.get(i); fsyncSync(fd); closeSync(fd); fds.delete(i); },
  };
  const reader = new FrameReader({ code, sink, limits });
  return new Promise((resolve, reject) => {
    let settled = false, connections = 0, sock = null, idle = null, eof = null;
    const total = setTimeout(() => finish(new Error('request refused: total time limit')), totalMs);
    const server = createServer((s) => {
      connections++;
      if (connections > 1) { s.destroy(); finish(new Error('request refused: a second connection')); return; }
      sock = s;
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => finish(new Error('request refused: idle time limit')), idleMs); };
      touch();
      s.on('data', (chunk) => {
        if (settled) return;
        try { reader.feed(chunk); } catch (e) { finish(e); return; }
        touch();
        if (reader.done && !eof) eof = setTimeout(() => finish(new Error('request refused: no end of stream after the trailer')), eofMs);
      });
      s.on('end', () => { if (reader.done) finish(null); else finish(new Error('request refused: stream ended early')); });
      s.on('error', (e) => finish(e));
    });
    function finish(err) {
      if (settled) return;
      settled = true;
      [total, idle, eof].forEach((t) => clearTimeout(t));
      sock?.destroy(); server.close();
      for (const fd of fds.values()) { try { closeSync(fd); } catch { /* already closed */ } }
      if (err) { rmSync(incoming, { recursive: true, force: true }); reject(err); } else resolve({ entries: reader.entries, incoming, operation: reader.op });
    }
    server.on('error', (e) => finish(e));
    server.listen(pipe);
  });
}

/** Exporter-side send. Resolves when the bytes are written and the stream is ended. */
export function sendRequest(pipe, bytes) {
  if (!PIPE.test(pipe)) return Promise.reject(new Error('only a local gb2l pipe name is accepted'));
  return new Promise((resolve, reject) => {
    const s = connect(pipe, () => s.end(bytes, resolve));
    s.on('error', reject);
  });
}
