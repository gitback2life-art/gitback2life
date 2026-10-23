// Output guard: the last step before anything leaves a tool as a report, summary, draft or packet.
// It masks what patterns can catch (secrets, email addresses, phone numbers, credentials and secret-looking
// query parameters in URLs) and escapes Markdown/HTML so untrusted evidence text cannot become links,
// headings, images or HTML in a rendered report. Patterns cannot catch names, home addresses or text shown
// inside images: SHARING_CHECKLIST makes that human review step explicit.
import { redact } from './common.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g;
const SENSITIVE_PARAM = /^(?:.*token.*|.*secret.*|.*passw.*|.*session.*|.*auth.*|key|api[-_]?key|apikey|sig|signature|code|otp|email|e-mail|phone|tel|ssn|x-amz-.*|access[-_]?key.*)$/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const TOKEN_SEGMENT = /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})$/;

export const SHARING_CHECKLIST = Object.freeze([
  'No personal names of volunteers, adopters, donors or members of the public (use roles instead)',
  'No home addresses or other location details about people',
  'No faces, name tags, license plates, or readable personal text inside screenshots or photos',
  'Nothing the organization asked to keep private',
  'Every statement labeled as confirmed, reported or unknown is still accurate',
]);

/** Mask secrets and contact details WITHOUT looking for URLs: the safe fallback for text that is not a valid URL. */
const maskPlain = (s) => redact(String(s ?? '')).replace(EMAIL, '[contact detail removed]').replace(PHONE, '[contact detail removed]');

/** Remove credentials and secret-looking query/fragment values from a URL. Non-URLs are returned masked as text. */
export function sanitizeUrl(raw) {
  let u;
  // F08: an unparseable "URL" is masked as plain text; it never goes back through URL detection (no recursion).
  try { u = new URL(String(raw)); } catch { return maskPlain(raw); }
  if (!['http:', 'https:'].includes(u.protocol)) return '[non-web link removed]';
  u.username = ''; u.password = '';
  for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, 'REDACTED');
  // Token-shaped path segments (e.g. /ghp_.../) and any fragment carrying key=value or a secret shape (F07).
  u.pathname = u.pathname.split('/').map((seg) => { let d = seg; try { d = decodeURIComponent(seg); } catch { /* keep raw */ } return TOKEN_SEGMENT.test(d) ? 'REDACTED' : seg; }).join('/');
  if (u.hash && (u.hash.includes('=') || redact(u.hash) !== u.hash)) u.hash = '';
  return u.href;
}

/** True when a URL carries credentials, secret-looking parameters, token-shaped path segments or secret fragments. */
export function hasSecretUrlParts(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  return sanitizeUrl(u.href) !== u.href;
}

/** Mask secrets, email addresses and phone numbers; sanitize any URLs inside the text. */
export function sanitizeText(s) {
  return maskPlain(redact(String(s ?? '')).replace(URL_IN_TEXT, (m) => sanitizeUrl(m)));
}

/**
 * Escape Markdown and HTML so text renders literally. Newlines become spaces, so text can never start a new
 * line (no headings, list items, quotes or tables); escaping [ ] stops links and images; escaping < > & stops
 * HTML and autolinks; * _ ` ~ | stop emphasis, code, strikethrough and table breaks.
 */
export function escapeMarkdown(s) {
  return String(s ?? '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1');
}

/** Untrusted text for a Markdown report: sanitized, then escaped. */
export const mdText = (s) => escapeMarkdown(sanitizeText(s));

/** A URL for a Markdown report: sanitized and shown as an autolink (http/https only), or as escaped text. */
export function mdUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const clean = sanitizeUrl(raw);
  try {
    const u = new URL(clean);
    if (['http:', 'https:'].includes(u.protocol)) return `<${u.href}>`;
  } catch { /* not a URL */ }
  return mdText(clean);
}

/** Plain-text output (drafts, terminals): sanitized but not escaped. */
export const plainText = (s) => sanitizeText(s);
