// M2 (design revision 3.3, §13): the review display. Every untrusted string is escaped to printable ASCII; trusted
// formatting is limited to printable ASCII, the glyphs "│" and "↪", LF, and the authority's fence lines. Nothing an
// untrusted string contains can reach the terminal as a control sequence. Over-long reviews are refused, never cut.
import { randomBytes } from 'node:crypto';

export const WRAP = 160;
export const MAX_LINES = 2000;
export class RenderRefused extends Error { constructor(m) { super(`review refused: ${m}`); this.render = true; } }

/** Strict UTF-8: invalid sequences, overlong forms and surrogates are refused, never replaced. */
export function decodeStrict(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RenderRefused('content is not valid UTF-8'); }
}

/** Printable ASCII stays (except "\" → "\\"); everything else, CR / ESC / bidi / zero-width included, → \u{XXXX}. */
export function escapeText(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x5c) out += '\\\\';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += `\\u{${c.toString(16).toUpperCase().padStart(4, '0')}}`;
  }
  return out;
}

/**
 * Render a review. `sections` = [{ title (trusted, printable ASCII), lines?: [trusted line], untrusted?: { label, text } }].
 * Returns the full text. Throws RenderRefused when the untrusted content exceeds MAX_LINES display lines
 * (continuations counted), or when trusted text is not printable ASCII (a programming error caught early).
 */
export function renderReview(sections, { tag = () => randomBytes(3).toString('hex').slice(0, 4).toUpperCase() } = {}) {
  const out = [];
  let untrustedLines = 0;
  const trusted = (s) => { if (!/^[\x20-\x7e]*$/.test(s)) throw new Error('trusted text must be printable ASCII'); out.push(s); };
  for (const sec of sections) {
    trusted(`== ${sec.title} ==`);
    for (const l of sec.lines ?? []) trusted(l);
    if (sec.untrusted) {
      const t = tag();
      const lbl = sec.untrusted.label.replace(/[^A-Za-z0-9 _-]/g, '_');
      out.push(`BEGIN UNTRUSTED ${lbl} ${t}`);
      const lines = sec.untrusted.text.split('\n');
      lines.forEach((line, i) => {
        const esc = escapeText(line);
        const chunks = esc.length ? esc.match(new RegExp(`.{1,${WRAP}}`, 'g')) : [''];
        chunks.forEach((c, j) => {
          untrustedLines++;
          if (untrustedLines > MAX_LINES) throw new RenderRefused(`the change is longer than ${MAX_LINES} display lines; split this change`);
          out.push(j === 0 ? `${String(i + 1).padStart(5, ' ')} │ ${c}` : `    ↪ │ ${c}`);
        });
      });
      out.push(`END UNTRUSTED ${lbl} ${t}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** A line diff (LCS) of two texts, as "+ ", "- " and "  " prefixed lines, for the register display. */
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  if (n * m > 4_000_000) throw new RenderRefused('the change is too large to review; split this change');
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`); else out.push(`+ ${y[j++]}`); }
  while (i < n) out.push(`- ${x[i++]}`); while (j < m) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}
