// V6-02: images are REBUILT from a strict parse, never passed through. Hidden bytes (unknown chunks or segments,
// metadata anywhere, data after the image ends, data after the compressed stream) cannot survive.
//   PNG:  every chunk's length and CRC checked; only IHDR, PLTE, tRNS and the pixel data are kept; the pixel data is
//         decompressed, checked to be EXACTLY the size the header implies (with valid row filters), and recompressed.
//         Interlaced, truncated, trailing-byte, unknown-critical-chunk and inconsistent images are refused.
//         v7 review: rows are unfiltered and re-emitted with filter 0 and zeroed padding bits; a palette is kept only
//         for palette images; transparency must be its exact size and range. V8-01: every palette entry no pixel
//         uses (below the highest used index too) is set to black and its transparency to opaque; the unused tail is
//         trimmed. Indices are unchanged, so every pixel renders exactly as before. V8-02: decompression is bounded.
//   JPEG: rebuilt from the core segments only (frame, tables, restart interval, scans, end), each checked to be
//         EXACTLY its structure (v7 review: no extra bytes after the declared fields). All APPn segments (including
//         JFIF) and comments are dropped wherever they appear; unknown segments and bytes after the end are refused.
// Limit (stated, not hidden): the pixel values themselves are not inspected. Visible content, and anything encoded
// AS pixels, still needs a person's review. JPEG quantization and Huffman table VALUES, and the choices made inside
// the compressed streams, are decoding data that is validated structurally but not re-derived.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 50_000_000;
// V8-02: decoded-byte budget, checked BEFORE decompression and enforced DURING it. It bounds the decompressed output
// (height x (1 + bytes per row), filter bytes included), not total process memory: the compressed input, chunk copies
// and the unfiltered/canonical/recompressed buffers come on top (roughly three buffers of up to this size at once).
// Examples that fit: 4096 x 4095 RGBA (67,096,575 bytes) or a 4K 3840 x 2160 RGBA screenshot (about 33 MB). 4096 x 4096
// RGBA does NOT fit (67,112,960 bytes, 4,096 over), nor does an 8K RGB screenshot (about 99.5 MB): they are refused.
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const fail = (why) => { throw new Error(`image refused: ${why}`); };

function pngChunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Undo PNG row filters: returns the plain pixel rows (height x stride bytes, no filter bytes). */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.alloc(height * stride);
  for (let r = 0; r < height; r++) {
    const f = raw[r * (stride + 1)];
    if (f > 4) fail('invalid row filter');
    const src = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
    const cur = out.subarray(r * stride, (r + 1) * stride);
    const prev = r ? out.subarray((r - 1) * stride, r * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = (src[x] + p) & 0xff;
    }
  }
  return out;
}

/**
 * Strict parse of a PNG into its canonical parts (v7 review): the pixel rows unfiltered with padding bits zeroed, a
 * palette only where it IS pixel data (colour type 3) and trimmed to the entries actually used, and transparency only
 * in its exact size and value range. `hidden` lists anything the canonical form removes (for exact backups).
 */
export function parsePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) fail('not a PNG');
  const chunks = [];
  let i = 8;
  for (;;) {
    if (i + 12 > buf.length) fail('truncated chunk');
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) fail('malformed chunk type');
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length) fail('truncated chunk');
    const data = buf.subarray(i + 8, i + 8 + len);
    if ((crc32(buf.subarray(i + 4, i + 8 + len)) >>> 0) !== buf.readUInt32BE(i + 8 + len)) fail(`bad checksum in ${type}`);
    chunks.push({ type, data });
    i = end;
    if (type === 'IEND') break;
  }
  if (i !== buf.length) fail('bytes after the end of the image');
  if (chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13) fail('first chunk must be a valid IHDR');
  if (chunks.at(-1).data.length !== 0) fail('IEND must be empty');
  const h = chunks[0].data;
  const width = h.readUInt32BE(0), height = h.readUInt32BE(4), depth = h[8], colorType = h[9];
  if (h[10] !== 0 || h[11] !== 0) fail('unknown compression or filter method');
  if (h[12] !== 0) fail('interlaced PNGs are not accepted');
  if (!width || !height || width * height > MAX_PIXELS) fail('image size out of range');
  const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colorType];
  if (!allowedDepths?.includes(depth)) fail('invalid colour type / bit depth');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  for (const c of chunks.slice(1, -1)) if (/^[A-Z]/.test(c.type) && !['PLTE', 'IDAT'].includes(c.type)) fail(`unknown critical chunk ${c.type}`);
  const idatIdx = chunks.map((c, k) => (c.type === 'IDAT' ? k : -1)).filter((k) => k >= 0);
  if (!idatIdx.length || idatIdx.at(-1) - idatIdx[0] !== idatIdx.length - 1) fail('pixel data missing or not contiguous');
  const once = (type) => { const found = chunks.filter((c) => c.type === type); if (found.length > 1) fail(`more than one ${type}`); return found[0]?.data ?? null; };
  const plte = once('PLTE'), trns = once('tRNS');
  const hidden = chunks.slice(1, -1).filter((c) => !['PLTE', 'tRNS', 'IDAT'].includes(c.type)).map((c) => c.type);
  const compressed = Buffer.concat(idatIdx.map((k) => chunks[k].data));
  const stride = Math.ceil((width * depth * channels) / 8);
  const expected = height * (1 + stride); // known from the header BEFORE anything is decompressed (V8-02)
  if (expected > MAX_DECODED_BYTES) fail(`decoded image would exceed the ${MAX_DECODED_BYTES}-byte limit`);
  let raw;
  try {
    // maxOutputLength stops decompression as soon as the output would pass the size the header implies.
    const { buffer, engine } = inflateSync(compressed, { info: true, maxOutputLength: expected });
    if (engine.bytesWritten !== compressed.length) fail('data after the compressed pixel stream');
    raw = buffer;
  } catch (e) {
    if (e.message.startsWith('image refused')) throw e;
    if (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) fail('pixel data is larger than the header says (stopped at the limit)');
    fail('pixel data does not decompress');
  }
  if (raw.length !== expected) fail('pixel data is not the size the header says');
  const pixels = unfilter(raw, height, stride, Math.max(1, (depth * channels) >> 3));
  const rem = (width * depth * channels) % 8;
  if (rem) { // bits after the last pixel of each row are not pixel data: zeroed
    const keep = (0xff << (8 - rem)) & 0xff;
    for (let r = 0; r < height; r++) { const k = r * stride + stride - 1; if (pixels[k] & ~keep & 0xff) { pixels[k] &= keep; if (!hidden.includes('row padding bits')) hidden.push('row padding bits'); } }
  }
  let palette = null, alpha = null;
  if (colorType === 3) {
    if (!plte || !plte.length || plte.length % 3 || plte.length > 768) fail('palette missing or invalid');
    if (trns && trns.length > plte.length / 3) fail('transparency has more entries than the palette');
    const used = new Uint8Array(256);
    let max = 0;
    for (let r = 0; r < height; r++) for (let x = 0; x < width; x++) {
      const bit = x * depth, byte = pixels[r * stride + (bit >> 3)];
      const index = depth === 8 ? byte : (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      used[index] = 1; if (index > max) max = index;
    }
    if (max >= plte.length / 3) fail('pixel uses a palette entry that does not exist');
    // V8-01: EVERY entry no pixel references is not pixel data, wherever it sits (below the highest used index too).
    // Indices are kept (so each pixel renders exactly as before); unused entries become black, and their
    // transparency fully opaque, the value omitted entries have anyway. Then the unused tail is trimmed.
    palette = Buffer.from(plte.subarray(0, (max + 1) * 3));
    let unusedPalette = palette.length < plte.length && plte.subarray(palette.length).some((v) => v !== 0);
    for (let k = 0; k <= max; k++) if (!used[k] && (palette[3 * k] | palette[3 * k + 1] | palette[3 * k + 2])) { palette.fill(0, 3 * k, 3 * k + 3); unusedPalette = true; }
    if (unusedPalette) hidden.push('unused palette entries');
    if (trns) {
      const a = Buffer.from(trns.subarray(0, Math.min(trns.length, max + 1)));
      let unusedAlpha = trns.subarray(a.length).some((v) => v !== 255);
      for (let k = 0; k < a.length; k++) if (!used[k] && a[k] !== 255) { a[k] = 255; unusedAlpha = true; }
      if (unusedAlpha) hidden.push('unused transparency entries');
      let n = a.length;
      while (n && a[n - 1] === 255) n--; // trailing opaque entries carry nothing: omitted entries are opaque
      alpha = n ? a.subarray(0, n) : null;
    }
  } else {
    if (plte && (colorType === 0 || colorType === 4)) fail('a palette is not allowed for this colour type');
    if (plte) hidden.push('suggested palette'); // colour types 2 and 6: optional, not pixel data
    if (trns) {
      if (colorType === 4 || colorType === 6) fail('a transparency chunk is not allowed with an alpha channel');
      const n = colorType === 0 ? 1 : 3;
      if (trns.length !== 2 * n) fail('transparency chunk has the wrong size');
      for (let k = 0; k < n; k++) if (trns.readUInt16BE(2 * k) >= 2 ** depth) fail('transparency value out of range');
      alpha = trns;
    }
  }
  const rows = Buffer.alloc(height * (stride + 1)); // canonical: filter type 0 on every row
  for (let r = 0; r < height; r++) pixels.copy(rows, r * (stride + 1) + 1, r * stride, (r + 1) * stride);
  return { ihdr: h, palette, alpha, rows, hidden };
}

export function sanitizePng(buf) {
  const { ihdr, palette, alpha, rows } = parsePng(buf);
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), ...(palette ? [pngChunk('PLTE', palette)] : []), ...(alpha ? [pngChunk('tRNS', alpha)] : []),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * v7 review: every kept segment must be EXACTLY its structure (no extra bytes after the declared fields), with each
 * field in range. Frame (SOF0-2), quantization tables, Huffman tables, restart interval and scan headers.
 */
function checkSegment(m, body) {
  const bad = (what) => fail(`malformed ${what}`);
  if (m >= 0xc0 && m <= 0xc2) {
    const nf = body[5];
    if (body.length < 6 || body.length !== 6 + 3 * nf || nf < 1 || nf > 4) bad('frame header');
    if (body[0] !== 8 && !(m !== 0xc0 && body[0] === 12)) bad('frame header (precision)');
    if (!body.readUInt16BE(1) || !body.readUInt16BE(3)) bad('frame header (size)');
    for (let k = 0; k < nf; k++) {
      const hv = body[7 + 3 * k], tq = body[8 + 3 * k];
      if ((hv >> 4) < 1 || (hv >> 4) > 4 || (hv & 15) < 1 || (hv & 15) > 4 || tq > 3) bad('frame header (component)');
    }
  } else if (m === 0xdb) {
    let p = 0;
    if (!body.length) bad('quantization table');
    while (p < body.length) {
      const pq = body[p] >> 4, tq = body[p] & 15, size = 64 * (pq + 1);
      if (pq > 1 || tq > 3 || p + 1 + size > body.length) bad('quantization table');
      for (let k = 0; k < 64; k++) if (!(pq ? body.readUInt16BE(p + 1 + 2 * k) : body[p + 1 + k])) bad('quantization table (zero value)');
      p += 1 + size;
    }
  } else if (m === 0xc4) {
    let p = 0;
    if (!body.length) bad('Huffman table');
    while (p < body.length) {
      if (p + 17 > body.length || (body[p] >> 4) > 1 || (body[p] & 15) > 3) bad('Huffman table');
      let total = 0;
      for (let k = 1; k <= 16; k++) total += body[p + k];
      if (!total || total > 256 || p + 17 + total > body.length) bad('Huffman table');
      p += 17 + total;
    }
  } else if (m === 0xdd) {
    if (body.length !== 2) bad('restart interval');
  } else if (m === 0xda) {
    const ns = body[0];
    if (ns < 1 || ns > 4 || body.length !== 4 + 2 * ns) bad('scan header');
    for (let k = 0; k < ns; k++) if ((body[2 + 2 * k] >> 4) > 3 || (body[2 + 2 * k] & 15) > 3) bad('scan header (tables)');
    const ss = body[1 + 2 * ns], se = body[2 + 2 * ns], a = body[3 + 2 * ns];
    if (ss > 63 || se > 63 || ss > se || (a >> 4) > 13 || (a & 15) > 13) bad('scan header (spectral selection)');
  }
}

export function sanitizeJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) fail('not a JPEG');
  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2, sawFrame = false, sawScan = false;
  for (;;) {
    if (i >= buf.length || buf[i] !== 0xff) fail('malformed segment');
    while (buf[i + 1] === 0xff) i++; // fill bytes
    const m = buf[i + 1];
    if (m === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); i += 2; break; }
    if (i + 4 > buf.length) fail('truncated segment');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) fail('truncated segment');
    const seg = buf.subarray(i, i + 2 + len);
    i += 2 + len;
    // Application segments (JFIF, EXIF, XMP, ICC, Adobe…) and comments: dropped. Decoders do not need the JFIF
    // header, and its version and density fields would otherwise be bytes kept without being pixel data.
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) continue;
    if ([0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda].includes(m)) checkSegment(m, seg.subarray(4));
    if ([0xc0, 0xc1, 0xc2].includes(m)) { if (sawFrame) fail('more than one frame header'); sawFrame = true; out.push(seg); continue; }
    if ([0xc4, 0xdb, 0xdd].includes(m)) { out.push(seg); continue; }
    if (m === 0xda) {
      if (!sawFrame) fail('scan before frame header');
      sawScan = true;
      let j = i;
      while (j < buf.length) {
        if (buf[j] === 0xff && j + 1 < buf.length) {
          const n = buf[j + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j >= buf.length) fail('scan data runs off the end');
      out.push(seg, buf.subarray(i, j));
      i = j;
      continue;
    }
    fail(`unknown segment 0x${m.toString(16)}`);
  }
  if (i !== buf.length) fail('bytes after the end of the image');
  if (!sawFrame || !sawScan) fail('no image data');
  return Buffer.concat(out);
}

/** A PNG or JPEG rebuilt as above, or an error (anything else, or anything malformed). Idempotent. */
export function sanitizeImage(buf) {
  if (buf.subarray(0, 8).equals(PNG_SIG)) return sanitizePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return sanitizeJpeg(buf);
  return fail('only PNG and JPEG images are accepted');
}

export const looksLikeImage = (buf) => buf.subarray(0, 8).equals(PNG_SIG) || (buf[0] === 0xff && buf[1] === 0xd8);
