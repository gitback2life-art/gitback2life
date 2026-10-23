// Protected, self-contained copy of the established toolbox storage-masking policy.
// No imports from the ordinary user-writable toolbox or caller-provided policy hooks.
// Keep in sync with _shared/common.mjs when the storage policy is intentionally revised.

const SECRET_PATTERNS = [
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Secret-looking URL query parameters and fragments (F07), wherever they appear in text.
  [/([?&](?:[^=&#\s]*(?:token|secret|passw|session|auth)[^=&#\s]*|key|api[-_]?key|apikey|sig|signature|code|otp|x-amz-[^=&#\s]*)=)[^&#\s]*/gi, '$1REDACTED'],
  [/#[^\s#]*?(?:access_token|id_token|token|code|secret)=[^\s]*/gi, '#REDACTED'],
];

/** Mask token-, cookie- and key-shaped strings. A safety net, not a guarantee: still avoid fetching secret-bearing output. */
export function redact(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// Owner's decision (#10, option b): NOTHING is stored unmasked. Same patterns as the output guard, plus credentials
// written into URLs (scheme://user:password@host).
const STORE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const STORE_PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g;
const STORE_URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
export const MASKED_NOTICE = 'MODIFIED EVIDENCE: masked before saving (secrets, credentials and contact details removed). This is not the original.';

/** Mask text for storage: secrets, credentials in URLs, secret URL parameters, email addresses and phone numbers. */
export function maskForStorage(text) {
  return redact(String(text ?? ''))
    .replace(STORE_URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(STORE_EMAIL, '[contact detail removed]')
    .replace(STORE_PHONE, '[contact detail removed]');
}


const SENSITIVE_KEY = /^(?:[\w-]*[_-])?(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|credentials?)$/i;
function maskJsonValue(v, key) {
  const sensitive = typeof key === 'string' && SENSITIVE_KEY.test(key);
  // v7 review: under a sensitive key EVERYTHING is replaced whole (strings, numbers, objects, arrays); only null and
  // booleans, which cannot carry a secret, are kept.
  if (sensitive && v !== null && typeof v !== 'boolean') return '[REDACTED]';
  if (typeof v === 'string') return maskForStorage(v);
  if (Array.isArray(v)) return v.map((x) => maskJsonValue(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [maskForStorage(k), maskJsonValue(x, k)]));
  return v;
}

/** Mask text for storage: JSON structurally (V6-06), anything else line by line. */
export function maskStoredText(text) {
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      const masked = maskJsonValue(parsed);
      if (JSON.stringify(masked) === JSON.stringify(parsed)) return text; // nothing to mask: keep the exact bytes
      const indent = /\n( +)\S/.exec(text)?.[1].length ?? 0;
      return JSON.stringify(masked, null, indent) + (text.endsWith('\n') ? '\n' : '');
    }
  }
  return maskForStorage(text);
}

