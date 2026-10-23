// Incident scope enforcement, shared by every tool that reaches the network or saves incident data.
// A tool calls requireScope(--scope file, request) BEFORE acting; any failed check blocks the action.
// Checks: valid scope · not stopped · not expired · action permitted · target listed in the scope ·
// each outside service that will see the target is allowed · persistence allows saving ·
// always-ask actions have a fresh OPERATOR ATTESTATION for that exact target. An attestation is the operator's
// recorded statement, not proof that a person approved: anything that can write the scope file can write one
// (F01). A protected approval authority (separate identity or broker process) is not implemented.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MASKED_NOTICE, nowUtc } from './common.mjs';
import { setResultCaching } from './polite.mjs';
import { serviceFor } from './guards.mjs';
import { activeScope, clearActiveScope, setActiveScope } from './active_scope.mjs';
import { checkAuthority } from './authority_link.mjs';

export { clearActiveScope };
const NETWORK_ACTIONS = new Set(['read_public_github', 'passive_lookup', 'live_http_inspection']);

// F12: the contract lives in scope_schema.json, which the Python tools (gb2l_core.validate_scope) read too.
export const SCHEMA = Object.freeze(JSON.parse(readFileSync(new URL('./scope_schema.json', import.meta.url), 'utf8')));
export const ACTIONS = Object.freeze({ ...SCHEMA.actions });
// Outside services that receive the target (domain, URL or repository) when a tool runs.
export const SERVICES = Object.freeze({ ...SCHEMA.services });
// These always need a fresh operator attestation for the exact target, not just a `true` permission.
export const ALWAYS_ASK = new Set(SCHEMA.always_ask);
export const APPROVAL_MAX_AGE_HOURS = SCHEMA.attestation_max_age_hours;
export const DEFAULT_SCOPE_DAYS = 7;

export class ScopeError extends Error {
  constructor(message) { super(message); this.code = 'SCOPE_BLOCKED'; }
}

export function template(now = new Date()) {
  return {
    scope_schema: SCHEMA.scope_schema,
    incident_id: 'short-id-like-org-issue-2026-10',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + DEFAULT_SCOPE_DAYS * 864e5).toISOString(),
    status: 'open',
    question: 'What exactly are we trying to find out?',
    targets: ['example-rescue.org', 'owner/repo'],
    scope: 'What is in scope (repos, domains, records) and what is explicitly not.',
    urgency: 'normal',
    confidence: 'low',
    permissions: Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, ['read_public_github', 'passive_lookup'].includes(a)])),
    disclosures: ['github', 'rdap', 'dns'],
    approvals: [],
    // Executable: always refused, whatever permissions or attestations say. `prohibited` below is prose for people.
    deny_actions: ['external_write', 'contact_third_party', 'publish'],
    allow_derived_lookalikes: false,
    prohibited: [
      'No changes to the organization\'s live data, contacts, or phone numbers',
      'No probing of private/internal networks',
      'No running of downloaded or fetched content',
    ],
    stopping_condition: 'Stop and report when ... (e.g. the redirect origin is identified or 2 hours elapse)',
    persistence: 'transient',
  };
}

/** What a scope target or requested target refers to: a GitHub repository, or a host (domain). */
export function targetKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let u = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { u = new URL(s); } catch { return null; } }
  if (u?.hostname === 'github.com') {
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    return owner && repo ? { type: 'repo', key: `${owner}/${repo}`.toLowerCase() } : { type: 'host', key: 'github.com' };
  }
  if (!u && /^[\w-]+\/[\w.-]+$/.test(s)) return { type: 'repo', key: s.toLowerCase() }; // owner/repo (owners have no dots)
  const host = (u ? u.hostname : s.split('/')[0]).toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  // Each label starts and ends with a letter or digit (no "-bad.org"); same rule as gb2l_core._HOST.
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? { type: 'host', key: host } : null;
}

/** Is `target` covered by the scope? A listed domain also covers its subdomains; www. is ignored. */
export function inScope(scope, target) {
  const want = targetKey(target);
  if (!want) return false;
  return (scope.targets ?? []).map(targetKey).some((t) => t && t.type === want.type
    && (t.key === want.key || (t.type === 'host' && want.key.endsWith(`.${t.key}`))));
}

/**
 * LEGACY, not used for authorization. Earlier versions attached this unkeyed checksum to approvals and described
 * them as human-only; anyone who can read this code can compute it, so it proved nothing (F01). Kept only so the
 * regression tests can build an old-style record and confirm it is refused.
 */
export function approvalCheck(scope, a) {
  return createHash('sha256').update(JSON.stringify(['gitback2life-approval-v1', scope.incident_id, a.action, a.target, a.approved_at, a.approved_via])).digest('hex').slice(0, 32);
}

export function validateScope(s) {
  const errors = [];
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return ['the scope must be a JSON object'];
  if (s.scope_schema !== undefined && s.scope_schema !== SCHEMA.scope_schema) errors.push(`scope_schema ${s.scope_schema} is not supported (this toolbox reads schema ${SCHEMA.scope_schema})`);
  for (const key of SCHEMA.required_text) {
    if (typeof s?.[key] !== 'string' || !s[key].trim()) errors.push(`${key} is required`);
  }
  if (!Array.isArray(s?.targets) || s.targets.length === 0) errors.push('targets must list at least one domain, URL or owner/repo');
  else for (const t of s.targets) if (!targetKey(t)) errors.push(`target "${t}" is not a domain, URL or owner/repo`);
  for (const key of ['status', 'urgency', 'confidence', 'persistence']) {
    if (!SCHEMA[key].includes(s?.[key])) errors.push(`${key} must be ${SCHEMA[key].join('|')}`);
  }
  if (!s?.expires_at || Number.isNaN(Date.parse(s.expires_at))) errors.push('expires_at is required (ISO time); scopes are time-limited');
  if (!Array.isArray(s?.prohibited) || s.prohibited.length === 0) errors.push('prohibited must list at least one action');
  if (s.deny_actions !== undefined && (!Array.isArray(s.deny_actions) || s.deny_actions.some((a) => !(a in ACTIONS)))) errors.push(`deny_actions must list action names (${Object.keys(ACTIONS).join(', ')})`);
  if (s.allow_derived_lookalikes !== undefined && typeof s.allow_derived_lookalikes !== 'boolean') errors.push('allow_derived_lookalikes must be true/false');
  if (!Array.isArray(s?.disclosures)) errors.push('disclosures must list which outside services may see the targets (may be empty)');
  else for (const d of s.disclosures) if (!(d in SERVICES)) errors.push(`unknown disclosure service "${d}" (known: ${Object.keys(SERVICES).join(', ')})`);
  for (const [action, value] of Object.entries(s?.permissions ?? {})) {
    if (!(action in ACTIONS)) errors.push(`unknown permission "${action}"`);
    if (typeof value !== 'boolean') errors.push(`permission ${action} must be true/false`);
  }
  for (const a of s?.approvals ?? []) {
    if (!(a.action in ACTIONS)) errors.push(`attestation for unknown action "${a.action}"`);
    if (typeof a.target !== 'string' || !a.target) errors.push(`attestation for ${a.action} needs the exact target it covers`);
    if (a.approved_via !== undefined || a.check !== undefined) errors.push(`old-style approval for ${a.action} claims human-only approval, which the toolbox cannot verify; replace it with an operator attestation (attested_by: "operator")`);
    if (a.attested_by !== 'operator') errors.push(`attestation for ${a.action} must say attested_by: "operator"`);
    if (!a.attested_at || Number.isNaN(Date.parse(a.attested_at))) errors.push(`attestation for ${a.action} needs attested_at (ISO time)`);
  }
  return errors;
}

/** Decide whether one request may proceed. Returns { allowed, reasons[], basis } (basis: why it was allowed). */
export function authorize(scope, { action, target, services = [], now = new Date() } = {}) {
  const errors = validateScope(scope);
  if (errors.length) return { allowed: false, reasons: [`the scope file is invalid: ${errors.join('; ')}`] };
  const reasons = [];
  const t = now.getTime();
  if (!(action in ACTIONS)) reasons.push(`unknown action "${action}"`);
  if (scope.status === 'stopped') reasons.push(`the incident was stopped${scope.stopped_at ? ` at ${scope.stopped_at}` : ''}; start a new scope to continue`);
  if (Date.parse(scope.expires_at) <= t) reasons.push(`the scope expired at ${scope.expires_at}; start a new scope to continue`);
  if (scope.permissions?.[action] !== true) reasons.push(`"${action}" is not permitted in this scope`);
  if ((scope.deny_actions ?? []).includes(action)) reasons.push(`"${action}" is listed in deny_actions; no permission or attestation overrides that`);
  if (action === 'save_local' && scope.persistence !== 'local') reasons.push('the scope says persistence is "transient": nothing may be saved');
  if (target !== undefined && !inScope(scope, target)) reasons.push(`target "${target}" is not listed in the scope's targets`);
  for (const s of services) if (!scope.disclosures.includes(s)) reasons.push(`the scope does not allow sending the target to ${SERVICES[s] ?? s} (disclosures: ${s})`);
  let basis = 'permitted by the scope';
  if (ALWAYS_ASK.has(action)) {
    const ok = (scope.approvals ?? []).filter((a) => a.action === action && a.target === target && a.attested_by === 'operator'
      && Date.parse(a.attested_at) <= t && (t - Date.parse(a.attested_at)) / 36e5 <= APPROVAL_MAX_AGE_HOURS);
    if (!ok.length) reasons.push(`"${action}" on exactly "${target}" needs a fresh operator attestation (within ${APPROVAL_MAX_AGE_HOURS}h) for that exact target (incident_intake approve)`);
    else basis = `operator attestation recorded ${ok.at(-1).attested_at} (an operator's statement, not proof that a person approved)`;
  }
  return { allowed: reasons.length === 0, reasons, basis };
}

export function loadScope(path) {
  if (!path) throw new ScopeError('no scope given');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new ScopeError(`cannot read scope file ${path}: ${e.message}`); }
}

/** Throw unless the request is allowed; on success, print one line saying which scope allowed it. */
export function requireScope(path, request) {
  if (!path) throw new ScopeError(`this command needs --scope <scope.json> because it ${ACTIONS[request.action] ? `will: ${ACTIONS[request.action].toLowerCase()}` : 'acts on a target'}. Create one with incident_intake template.`);
  const scope = loadScope(path);
  const r = authorize(scope, request);
  if (!r.allowed) throw new ScopeError(`blocked by scope "${scope.incident_id ?? path}":\n  - ${r.reasons.join('\n  - ')}`);
  // F01: with the protected authority installed, the scope must ALSO match its signed authorization, and the
  // protected state (stops, latest serial) must allow it. Without it, attestations remain operator statements.
  const authority = (s) => {
    const a = checkAuthority(path, s);
    if (a.required && !a.valid) throw new ScopeError(`blocked by the protected authority for "${s.incident_id ?? path}":\n  - ${a.reasons.join('\n  - ')}`);
    return a;
  };
  const auth = authority(scope);
  const basis = auth.required ? `signed by the protected authority (serial ${auth.serial})${ALWAYS_ASK.has(request.action) ? '; exact-target grant included in the signature' : ''}`
    : `${r.basis}; protected authority NOT installed (operator attestations only)`;
  // F12: re-read the scope FILE and re-authorize at every network request and every save, so a stop, expiry or
  // edit made while a command is running takes effect at its next request or save (not only at the next command).
  const recheck = () => {
    let fresh;
    try { fresh = loadScope(path); } catch (e) { throw new ScopeError(`scope re-check failed, so nothing more is done: ${e.message}`); }
    const again = authorize(fresh, request);
    if (!again.allowed) throw new ScopeError(`scope "${fresh.incident_id ?? path}" no longer allows this, so nothing more is done:\n  - ${again.reasons.join('\n  - ')}`);
    authority(fresh);
    return fresh;
  };
  // V4-02: saving is its own authorization. Every incident-data write re-reads the scope file and authorizes
  // save_local now (status, expiry, permission, persistence "local", deny_actions), whatever else the command does.
  const authorizeSave = () => {
    let fresh;
    try { fresh = loadScope(path); } catch (e) { throw new ScopeError(`scope re-check failed, so nothing is saved: ${e.message}`); }
    const again = authorize(fresh, { action: 'save_local' });
    if (!again.allowed) throw new ScopeError(`scope "${fresh.incident_id ?? path}" no longer allows this, so nothing is saved:\n  - ${again.reasons.join('\n  - ')}`);
    authority(fresh);
    return fresh;
  };
  const existing = activeScope();
  if (existing && existing.path && existing.path !== path) throw new ScopeError('one command may use only one scope file');
  if (existing && !existing.authorizeSave) existing.authorizeSave = authorizeSave;
  if (NETWORK_ACTIONS.has(request.action)) {
    // Lookup results are investigation data: keep them on disk only if this scope allows saving.
    setResultCaching(scope.persistence === 'local' && scope.permissions?.save_local === true);
    // F02: from now on EVERY request (first, redirects, robots.txt) is checked against this authorization.
    const services = request.services ?? [];
    const derived = new Set(); // generated names this command explicitly authorized (authorizeDerivedTarget)
    setActiveScope({ path, request, scope, recheck, authorizeSave, derived, authorizeHop: (url) => authorizeDestination(recheck(), request, services, url, derived) });
  } else if (!existing) {
    setActiveScope({ path, request, scope, recheck, authorizeSave, authorizeHop: () => { throw new ScopeError(`this command is only authorized for ${request.action}; it may not send network requests`); } });
  }
  console.error(`(scope "${scope.incident_id}": ${request.action}${request.target ? ` on ${request.target}` : ''}${request.services?.length ? ` via ${request.services.join(', ')}` : ''} allowed: ${basis})`);
  return scope;
}

/**
 * May a request for this authorization go to url? Lookup requests may only reach the destinations of a lookup
 * service that the request names AND the scope discloses to. Ordinary websites are never reachable this way:
 * live requests go only through redirect_inspector, which authorizes each exact URL itself.
 */
export function authorizeDestination(scope, request, services, url, derived = new Set()) {
  const u = url instanceof URL ? url : new URL(String(url));
  const svc = serviceFor(u);
  if (!svc) throw new ScopeError(`${u.host} is not a destination of an authorized lookup service; ${request.action} may not send requests to ordinary websites`);
  if (!services.includes(svc)) throw new ScopeError(`${u.host} belongs to the ${svc} service, which this request is not authorized to use (authorized: ${services.join(', ') || 'none'})`);
  if (!scope.disclosures.includes(svc)) throw new ScopeError(`the scope does not allow sending targets to ${svc} (${u.host})`);
  // V4-01 target binding: an RDAP request (including one a registry redirected to) may only ask about a domain this
  // command is authorized for: one the scope covers, or a lookalike authorized with authorizeDerivedTarget().
  if (svc === 'rdap' && u.pathname !== '/robots.txt') {
    const m = /\/domain\/([^/?#]+)$/i.exec(u.pathname);
    const name = m ? decodeURIComponent(m[1]).toLowerCase().replace(/\.$/, '') : null;
    if (!name || !(inScope(scope, name) || derived.has(name))) {
      throw new ScopeError(`RDAP request ${u.host}${u.pathname} is not about a domain this command is authorized for`);
    }
  }
}

/**
 * Authorize one GENERATED name (a lookalike of a listed target) for this command's lookups. Only allowed when the
 * scope sets allow_derived_lookalikes, re-read from the scope file now.
 */
export function authorizeDerivedTarget(name) {
  const ctx = activeScope();
  if (!ctx?.derived) throw new ScopeError('no lookup authorization is active for this command');
  const fresh = ctx.recheck();
  if (fresh.allow_derived_lookalikes !== true) throw new ScopeError('this scope does not allow looking up generated lookalike names (allow_derived_lookalikes)');
  ctx.derived.add(String(name).toLowerCase().replace(/\.$/, ''));
}

/**
 * V4-07: an artifact made from one incident's evidence (a ledger and everything rendered from it) may only be saved
 * under that same incident's scope. `scope` is what requireScope returned (null when nothing is being saved).
 */
export function requireSameIncident(scope, incidentId, what = 'this evidence') {
  if (!scope) return;
  if (typeof incidentId !== 'string' || !incidentId || incidentId !== scope.incident_id) {
    throw new ScopeError(`${what} belongs to incident "${incidentId || '(none)'}", but the scope authorizes incident "${scope.incident_id}"; nothing was saved. Use that incident's own scope.`);
  }
}

/**
 * Provenance stamp for a saved artifact: which incident, which exact scope file (SHA-256 of its bytes now), what was
 * authorized, and when. Saved outputs carry it so a reader can tell which authorization produced them. Throws when no
 * scope is active (every saving tool calls requireScope first).
 */
export function provenance() {
  const ctx = activeScope();
  if (!ctx?.path) throw new ScopeError('cannot stamp provenance: no incident scope is active');
  let bytes;
  try { bytes = readFileSync(ctx.path); } catch (e) { throw new ScopeError(`cannot stamp provenance: ${e.message}`); }
  const scope = JSON.parse(bytes.toString('utf8'));
  return {
    incident_id: scope.incident_id,
    scope_sha256: createHash('sha256').update(bytes).digest('hex'),
    authorized_action: ctx.request?.action ?? null,
    targets: ctx.request?.target ? [ctx.request.target] : [],
    stamped_at: nowUtc(),
    stored_as: MASKED_NOTICE, // #10: everything saved is a masked copy
  };
}

/** Record a stop (a person decided the stopping condition is met). */
export function stopScope(scope, now = nowUtc()) {
  return { ...scope, status: 'stopped', stopped_at: now };
}
