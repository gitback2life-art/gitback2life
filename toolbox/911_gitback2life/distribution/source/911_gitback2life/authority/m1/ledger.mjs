// M1 (design revision 3.3, §4): the append-only ledger. Pure functions over bytes; no filesystem access.
// NOT installed and not used by the production authority.
//
// Record:  LEN (u32 BE, whole record, 76..1 MiB, checked BEFORE slicing) | SEQ (u64 BE) | PREV_SHA256 (32)
//          | BODY (canonical JSON, UTF-8) | SHA256 over everything before it (32)
// Verification is read-only and classifies the whole ledger as intact, torn (only the FINAL record is incomplete
// or fails its checksum: an interrupted append, under the flush contract A5) or corrupt (anything else).
import { createHash } from 'node:crypto';

export const MAX_RECORD = 1024 * 1024;
const MIN_RECORD = 4 + 8 + 32 + 2 + 32; // at least "{}" as the body
const ZERO = Buffer.alloc(32);
const sha = (b) => createHash('sha256').update(b).digest();

/** Canonical JSON (sorted keys), the same form the authority signs. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function encodeRecord(seq, prevHash, body) {
  const bodyBuf = Buffer.from(canonical(body), 'utf8');
  const len = 4 + 8 + 32 + bodyBuf.length + 32;
  if (len > MAX_RECORD) throw new Error(`ledger record of ${len} bytes exceeds the ${MAX_RECORD}-byte limit`);
  const head = Buffer.alloc(44);
  head.writeUInt32BE(len, 0);
  head.writeBigUInt64BE(BigInt(seq), 4);
  prevHash.copy(head, 12);
  const pre = Buffer.concat([head, bodyBuf]);
  return Buffer.concat([pre, sha(pre)]);
}

/**
 * Verify the whole ledger without writing. Returns { status, records, end, tornOffset?, reason? }.
 * `end` is the offset just after the last intact record: the only place an append may happen.
 */
export function verifyLedger(buf) {
  const records = [];
  let off = 0, prev = ZERO, seq = 0;
  const result = (status, extra = {}) => ({ status, records, end: off, ...extra });
  while (off < buf.length) {
    if (buf.length - off < 4) return result('torn', { tornOffset: off, reason: 'final length field incomplete' });
    const len = buf.readUInt32BE(off); // the bound is checked before anything of that size is touched
    if (len < MIN_RECORD || len > MAX_RECORD) return result('corrupt', { reason: `record length ${len} out of range at offset ${off}` });
    if (off + len > buf.length) return result('torn', { tornOffset: off, reason: 'final record incomplete' });
    const rec = buf.subarray(off, off + len);
    const final = off + len === buf.length;
    if (!sha(rec.subarray(0, len - 32)).equals(rec.subarray(len - 32))) {
      return final ? result('torn', { tornOffset: off, reason: 'final record checksum mismatch' }) : result('corrupt', { reason: `checksum mismatch at offset ${off}` });
    }
    const s = Number(rec.readBigUInt64BE(4));
    if (s !== seq + 1) return result('corrupt', { reason: `sequence gap: expected ${seq + 1}, found ${s}` });
    if (!rec.subarray(12, 44).equals(prev)) return result('corrupt', { reason: `broken chain at record ${s}` });
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rec.subarray(44, len - 32))); } catch { return result('corrupt', { reason: `undecodable body at record ${s}` }); }
    records.push({ seq: s, body, hash: rec.subarray(len - 32), offset: off });
    prev = rec.subarray(len - 32); seq = s; off += len;
  }
  return result('intact');
}

/** Append to a VERIFIED ledger at its verified end. `store` = { bytes }. Returns the new record's sequence number. */
export function appendRecord(store, verified, body) {
  if (verified.status !== 'intact' || verified.end !== store.bytes.length) throw new Error('append refused: the ledger was not verified intact at this length');
  const last = verified.records.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  const rec = encodeRecord(seq, last?.hash ?? ZERO, body);
  store.bytes = Buffer.concat([store.bytes, rec]);
  verified.records.push({ seq, body: JSON.parse(canonical(body)), hash: rec.subarray(rec.length - 32), offset: verified.end });
  verified.end = store.bytes.length;
  return seq;
}
