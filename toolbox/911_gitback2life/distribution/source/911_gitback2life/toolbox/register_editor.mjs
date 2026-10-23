// Normal-user guided metadata editor. This module prepares reviewable values only.
// It never opens authority data for writing and never applies register changes.
import { validateRegister } from '../authority/m2/register_rules.mjs';

const FIELDS = Object.freeze({
  service: {
    id: 'text', service: 'enum:domain_registrar|dns|web_host|email|website_builder|donation_platform|forms|social_media|code_hosting|other',
    provider: 'text', domain_or_account: 'text', account_owner_role: 'text', renews_on: 'date?',
    auto_renew: 'bool?', mfa_enabled: 'bool?', recovery_contact_reviewed: 'bool?',
    review_date: 'date?', evidence: 'text?', status: 'enum:verified|unresolved|not_applicable'
  },
  data: {
    id: 'text', category: 'text', purpose: 'text', location: 'text', provider: 'text', owner: 'text',
    persistence: 'enum:intended_none|confirmed_retained|unknown', retention_days: 'integer?', oldest_record_at: 'timestamp?',
    review_date: 'date?', legal_hold: 'bool', evidence: 'text?', status: 'enum:verified|unresolved|not_applicable'
  },
  access: {
    id: 'text', system: 'text', role: 'text', access_level: 'enum:owner|admin|editor|viewer|billing',
    mfa_enabled: 'bool?', still_needed: 'bool?', state: 'enum:active|pending_removal|removed',
    last_reviewed: 'date?', evidence: 'text?', status: 'enum:verified|unresolved|not_applicable'
  }
});
const DEFAULTS = Object.freeze({
  service: { service: 'other', auto_renew: null, mfa_enabled: null, recovery_contact_reviewed: null, renews_on: null,
    review_date: null, evidence: null, status: 'unresolved' },
  data: { persistence: 'unknown', retention_days: null, oldest_record_at: null, review_date: null,
    legal_hold: false, evidence: null, status: 'unresolved' },
  access: { access_level: 'viewer', mfa_enabled: null, still_needed: null, state: 'active',
    last_reviewed: null, evidence: null, status: 'unresolved' }
});
const error = (msg) => { throw new Error(msg); };

export function blankRegisterRecord(kind) {
  if (!Object.hasOwn(FIELDS, kind)) error('register kind must be service, data, or access');
  return Object.fromEntries(Object.keys(FIELDS[kind]).map(k => [k, Object.hasOwn(DEFAULTS[kind], k) ? DEFAULTS[kind][k] : '']));
}
export function parseRecordValue(kind, field, raw, current) {
  const spec = FIELDS[kind]?.[field];
  if (!spec) error('unknown register field');
  const optional = spec.endsWith('?');
  // A fresh required text field must not silently remain blank and trigger an
  // opaque whole-record error after a dozen prompts. Existing values stay put.
  if (raw === '') {
    if (!optional && spec === 'text' && (current === '' || current === null || current === undefined))
      error(`${field}: enter a value (or /back to cancel)`);
    return current;
  }
  const value = raw.trim();
  if (optional && value === '-') return null;
  if (spec.startsWith('enum:')) {
    const allowed = spec.slice(5).split('|');
    // Numbered prompts are easier for nontechnical operators, while the
    // on-disk schema continues to receive the exact original enum string.
    const selected = /^\d+$/.test(value) ? allowed[Number(value) - 1] : value;
    if (!allowed.includes(selected)) error(`${field}: choose ${allowed.map((v, i) => `${i + 1}=${v}`).join(', ')}`);
    return selected;
  }
  if (spec.startsWith('bool')) {
    if (['yes', 'true', 'y'].includes(value.toLowerCase())) return true;
    if (['no', 'false', 'n'].includes(value.toLowerCase())) return false;
    error(`${field}: enter yes, no${optional ? ', or - for unknown' : ''}`);
  }
  if (spec.startsWith('integer')) {
    if (!/^(?:0|[1-9]\d{0,8})$/.test(value)) error(`${field}: enter a nonnegative whole number${optional ? ' or - for unknown' : ''}`);
    return Number(value);
  }
  if (spec.startsWith('date')) {
    const format = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const yy = Number(format?.[1]), mm = Number(format?.[2]), dd = Number(format?.[3]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(yy, mm - 1, dd);
    if (!format || yy < 1 || date.toISOString().slice(0, 10) !== value)
      error(`${field}: enter a real calendar date as YYYY-MM-DD${optional ? ' or - for unknown' : ''}`);
  }
  if (spec.startsWith('timestamp') &&
      (!/^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
       !Number.isFinite(Date.parse(value))))
    error(`${field}: enter a valid timezone-bearing ISO timestamp or - for unknown`);
  if (!value && !optional) error(`${field}: a value is required`);
  if (value.length > 500) error(`${field}: input is too long`);
  return value;
}
function display(v) { return v === null ? '(unknown)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v); }
export async function promptRecord(kind, ask, previous = null) {
  let record = previous ? structuredClone(previous) : blankRegisterRecord(kind);
  for (const [field, spec] of Object.entries(FIELDS[kind] ?? {})) {
    if (previous && field === 'id') continue; // never silently rename an existing register record
    const hint = spec.startsWith('enum:') ?
      ` [${spec.slice(5).split('|').map((v, i) => `${i + 1}=${v}`).join(' / ')}]` :
      spec.startsWith('bool') ? ' [yes/no]' : spec.startsWith('date') ? ' [YYYY-MM-DD]' :
      spec.startsWith('timestamp') ? ' [ISO timestamp with timezone]' : spec.startsWith('integer') ? ' [whole number]' : '';
    // Reprompt only the invalid field, rather than losing all preceding work.
    // /back and Ctrl+C propagate out of ask unchanged; no partial record saved.
    while (true) {
      const raw = await ask(`${field} (${display(record[field])})${hint}${spec.endsWith('?') ? ' [- clears]' : ''}: `);
      try {
        record[field] = parseRecordValue(kind, field, raw, record[field]);
        break;
      } catch (e) {
        if (typeof e?.message !== 'string' || !e.message.startsWith(`${field}:`)) throw e;
        // This is only on the local console; never writes a register or a log.
        // Required values and original protected schema are not relaxed.
        process.stdout.write(`${e.message}\n`);
      }
    }
  }
  validateRegister(kind, { schema_version: 1, records: [record], history: [] });
  return record;
}
