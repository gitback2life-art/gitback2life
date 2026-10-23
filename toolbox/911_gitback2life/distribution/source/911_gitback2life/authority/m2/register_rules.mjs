// M2 (design revision 3.3, §7): the register rules INSIDE the authority. A port of the toolbox's Python validators
// and register_update (org_registers.py, access_offboarding.py, gb2l_core label/identifier/keys), parity-tested
// against them. The authority computes register.replace itself: new register = registerUpdate(prior, record).
// Prototype: NOT installed; in M3 this file is copied into the protected folder and fingerprinted.

export class RuleError extends Error { constructor(m) { super(`register refused: ${m}`); this.rule = true; } }
const require_ = (ok, m) => { if (!ok) throw new RuleError(m); };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE = /(?<!\d)(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/;
const LABEL = /^[A-Za-z0-9_./:# @+\-=(),*~^<>'&]+$/;
export function label(v, limit = 160) {
  require_(typeof v === 'string' && v.length > 0 && v.length <= limit && LABEL.test(v), 'Use bounded metadata labels, not raw content');
  require_(!EMAIL.test(v) && !PHONE.test(v), 'Looks like an email address or phone number; record a role (e.g. board_secretary) instead');
  return v;
}
export const identifier = (v) => { require_(typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v), `Bad identifier: ${JSON.stringify(v)}`); return v; };
function keys(data, required) {
  require_(data && typeof data === 'object' && !Array.isArray(data) && required.every((k) => k in data) && Object.keys(data).every((k) => required.includes(k)),
    `Expected fields ${JSON.stringify([...required].sort())}`);
}
// Date.parse silently rolls impossible dates forward (e.g. 2026-02-31).
// Match Python's strict calendar-day validation used by the ordinary register tools.
const isDate = (v) => {
  if (v === null || v === undefined || v === '') return true;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.toISOString().slice(0, 10) === v;
};
const date = (v) => require_(isDate(v), `Bad date: ${JSON.stringify(v)}`);
const isTimestamp = (v) => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));

const SCHEMAS = {
  service: ['id', 'service', 'provider', 'domain_or_account', 'account_owner_role', 'renews_on', 'auto_renew', 'mfa_enabled', 'recovery_contact_reviewed', 'review_date', 'evidence', 'status'],
  data: ['id', 'category', 'purpose', 'location', 'provider', 'owner', 'persistence', 'retention_days', 'oldest_record_at', 'review_date', 'legal_hold', 'evidence', 'status'],
  access: ['id', 'system', 'role', 'access_level', 'mfa_enabled', 'still_needed', 'state', 'last_reviewed', 'evidence', 'status'],
};
const SERVICES = ['domain_registrar', 'dns', 'web_host', 'email', 'website_builder', 'donation_platform', 'forms', 'social_media', 'code_hosting', 'other'];
const STATUS = ['verified', 'unresolved', 'not_applicable'];

/** The protected register names (design §7: a closed set) and their kinds. */
export const REGISTERS = Object.freeze({ 'registers/services.json': 'service', 'registers/personal_data.json': 'data', 'registers/access.json': 'access' });

export function validateRegister(kind, data) {
  require_(kind in SCHEMAS, 'unknown register kind');
  keys(data, ['schema_version', 'records', 'history']);
  require_(data.schema_version === 1 && Array.isArray(data.records) && Array.isArray(data.history), 'schema_version 1 with records and history lists');
  const seen = new Set();
  for (const r of data.records) {
    keys(r, SCHEMAS[kind]);
    identifier(r.id); require_(!seen.has(r.id), `duplicate id ${r.id}`); seen.add(r.id);
    require_(STATUS.includes(r.status), 'status must be verified, unresolved or not_applicable');
    if (kind === 'access') {
      label(r.system); label(r.role);
      require_(['owner', 'admin', 'editor', 'viewer', 'billing'].includes(r.access_level), 'bad access_level');
      require_(['active', 'pending_removal', 'removed'].includes(r.state), 'bad state');
      for (const k of ['mfa_enabled', 'still_needed']) require_(r[k] === null || typeof r[k] === 'boolean', `${k} must be true, false or null`);
      date(r.last_reviewed);
      if (r.evidence !== null) label(r.evidence, 500);
      continue;
    }
    for (const v of Object.values(r)) {
      if (v === null || typeof v === 'boolean' || Number.isInteger(v)) continue;
      if (Array.isArray(v)) require_(v.length <= 100 && v.every((x) => label(x)), 'bad list');
      else label(v, 500);
    }
    date(r.review_date);
    if (kind === 'service') {
      require_(SERVICES.includes(r.service), 'bad service');
      date(r.renews_on);
      for (const k of ['auto_renew', 'mfa_enabled', 'recovery_contact_reviewed']) require_(r[k] === null || typeof r[k] === 'boolean', `${k} must be true, false or null`);
    } else {
      require_(['intended_none', 'confirmed_retained', 'unknown'].includes(r.persistence), 'bad persistence');
      require_(r.retention_days === null || (Number.isInteger(r.retention_days) && r.retention_days >= 0), 'bad retention_days');
      require_(typeof r.legal_hold === 'boolean', 'legal_hold must be true or false');
      if (r.oldest_record_at) require_(isTimestamp(r.oldest_record_at), 'oldest_record_at needs a timezone');
    }
    if (r.status === 'verified') require_(r.evidence && r.review_date, 'Verified records need evidence and a review date');
    if (r.status === 'not_applicable') require_(r.evidence, 'An exclusion needs evidence');
  }
}

/** register_update: replace or add one record, append the history entry, validate the result. Pure; `at` given. */
export function registerUpdate(kind, data, record, at) {
  const result = structuredClone(data);
  const old = result.records.find((r) => r.id === record?.id) ?? null;
  result.history.push({ at, previous: old, replacement: record });
  result.records = [...result.records.filter((r) => r.id !== record?.id), record];
  validateRegister(kind, result);
  return result;
}

/** The authority's canonical stored form of a register (stable, LF-terminated). */
export const serializeRegister = (data) => Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
