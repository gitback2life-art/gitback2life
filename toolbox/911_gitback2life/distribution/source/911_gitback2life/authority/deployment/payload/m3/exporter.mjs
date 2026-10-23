// M3 (design revision 3.4, §§2, 6): the TOOLBOX side of a change request, run with the owner's NORMAL privileges.
//   buildRequest()     canonical request.json (+ files/<rel> for restores) from a tool's intent
//   writeRequestFolder() / readRequestFolder()  a flat request folder in the user's workspace (regular files only,
//                      bounded, no links followed, exclusive creates)
//   exportRequest()    frame the entries and send them into the authority's one-time local pipe (G0a protocol)
// Nothing here can write protected data: it only produces bytes for the authority to review. Prototype; NOT installed.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../m1/ledger.mjs';
import { buildFrame, checkName, LIMITS, sendRequest } from '../g0a/request_pipe.mjs';

const fail = (m) => { throw new Error(`request not built: ${m}`); };

/** Canonical request entries. intent = { operation, incident_id, reason?, register_key?, record?, register?, files?: Map } */
export function buildRequest(intent) {
  const { operation, incident_id: incidentId, reason } = intent;
  const req = { schema: 1, operation, incident_id: incidentId, ...(reason !== undefined ? { reason } : {}) };
  if (operation === 'register.replace') Object.assign(req, { register_key: intent.register_key, record: intent.record });
  else if (operation === 'register.create') Object.assign(req, { register_key: intent.register_key, register: intent.register });
  else if (operation !== 'restore.stage') fail(`unknown operation ${operation}`);
  const entries = [{ name: 'request.json', data: Buffer.from(`${canonical(req)}\n`, 'utf8') }];
  if (operation === 'restore.stage') {
    if (!(intent.files instanceof Map) || intent.files.size === 0) fail('a restore needs files');
    for (const [rel, data] of [...intent.files].sort(([a], [b]) => (a < b ? -1 : 1))) entries.push({ name: `files/${rel}`, data: Buffer.from(data) });
  }
  return entries;
}

/** Write entries into a NEW request folder (exclusive creates; every file flushed).
 * Validate BEFORE creating a folder: malformed names must not leave partial files behind.
 */
export function writeRequestFolder(dir, entries) {
  if (!Array.isArray(entries) || !entries.length || entries[0]?.name !== 'request.json') fail('first entry must be request.json');
  let operation;
  try { operation = JSON.parse(entries[0].data.toString('utf8')).operation; }
  catch { fail('request.json must be valid JSON'); }
  if (entries.length > LIMITS.entries) fail('too many entries');
  let total = 0;
  const names = new Set(), directories = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !Buffer.isBuffer(entry.data)) fail('entries need names and binary data');
    checkName(entry.name);
    if (Buffer.byteLength(entry.name, 'utf8') > LIMITS.name || entry.data.length > LIMITS.entry) fail('entry exceeds transport size limits');
    total += entry.data.length;
    if (total > LIMITS.total) fail('request is too large');
    if (names.has(entry.name) || directories.has(entry.name)) fail('duplicate or colliding path');
    const segs = entry.name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const directory = segs.slice(0, i).join('/');
      if (names.has(directory)) fail('file collides with a directory');
      directories.add(directory);
    }
    names.add(entry.name);
  }
  if (!['register.create', 'register.replace', 'restore.stage'].includes(operation)) fail('unknown operation');
  if (operation !== 'restore.stage' && entries.length !== 1) fail('register requests must contain only request.json');
  // Transport validation occurs BEFORE any directory or file is created; the dummy code is never sent.
  buildFrame({ code: Buffer.alloc(16), operation, entries });
  mkdirSync(dir); // fails if it exists
  for (const e of entries) {
    const p = join(dir, ...e.name.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    const fd = openSync(p, 'wx');
    try { for (let off = 0; off < e.data.length;) { const n = writeSync(fd, e.data, off, e.data.length - off); if (n <= 0) fail('write made no progress'); off += n; } fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/**
 * Read a request folder with normal privileges: regular files only, nothing followed through links or junctions,
 * sizes bounded as the pipe protocol requires. Returns entries in canonical order (request.json first).
 */
export function readRequestFolder(dir) {
  const out = [];
  let total = 0;
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name), name = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(p, { bigint: true });
      if (st.isSymbolicLink()) fail(`${name} is a link or junction`);
      if (st.isDirectory()) { walk(p, name); continue; }
      if (!st.isFile()) fail(`${name} is not a regular file`);
      if (st.nlink !== 1n) fail(`${name} has more than one name (hard link)`);
      if (st.size > BigInt(LIMITS.entry)) fail(`${name} is larger than ${LIMITS.entry} bytes`);
      total += Number(st.size);
      if (total > LIMITS.total || out.length >= LIMITS.entries) fail('the request exceeds the protocol limits');
      out.push({ name, data: readFileSync(p) });
    }
  };
  walk(dir, '');
  const first = out.findIndex((e) => e.name === 'request.json');
  if (first < 0) fail('no request.json');
  const [req] = out.splice(first, 1);
  return [req, ...out.sort((a, b) => (a.name < b.name ? -1 : 1))];
}

/** Send the entries to the authority's one-time pipe (the authority prints the pipe name and code). */
export function exportRequest(entries, { pipe, code }) {
  const operation = JSON.parse(entries[0].data.toString('utf8')).operation;
  return sendRequest(pipe, buildFrame({ code, operation, entries }));
}
