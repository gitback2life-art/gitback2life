#!/usr/bin/env node
// Evidence ledger: one place for observations, reports, inferences and hypotheses, each labeled and sourced.
// Ledgers are plain JSON files you edit or build up; this tool writes a file only when you pass --save.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LABELS, PAGE_ROLES, VERDICTS, fail, isMain, nowUtc, redact, safeWrite } from '../_shared/common.mjs';
import { mdText, mdUrl } from '../_shared/output.mjs';
import { requireSameIncident, requireScope, targetKey } from '../_shared/scope.mjs';

// What an item says it shows. Kept coarse on purpose; the text carries the detail.
export const SIGNALS = Object.freeze([
  'none',                        // checked, nothing notable
  'redirect_off_domain',         // a requested URL ended on a different site
  'dns_or_registration_change',  // nameservers, registrar, expiry or address changed
  'reputation_flag',             // an existing third-party verdict flags the URL/domain
  'malicious_content',           // content shown to be harmful (by an independent source)
  'compromise_confirmed',        // account/DNS/site compromise independently confirmed
]);
const CONFIDENCE = ['low', 'medium', 'high'];
const HYP_STATUS = ['open', 'supported', 'weakened', 'ruled_out'];
const SOURCED = new Set(['confirmed_observation', 'source_report']);

// Signals that describe a specific asset must say which asset, and who controls it.
export const ASSET_SIGNALS = new Set(['compromise_confirmed', 'malicious_content', 'dns_or_registration_change', 'reputation_flag']);
export const ASSET_KINDS = Object.freeze(['domain', 'website', 'email', 'account', 'server', 'service']);
export const CONTROLLERS = Object.freeze(['organization', 'third_party', 'unknown']);
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const isWebUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };
const controlledByOrg = (i) => i.asset?.controlled_by === 'organization';

export function createLedger(incidentId) {
  return {
    schema: 1, incident_id: incidentId, created_at: nowUtc(),
    checked: [], not_checked: [], items: [], hypotheses: [], verdicts: {},
    risk: '', next_step: { action: '', permission_needed: '' },
  };
}

/**
 * Structural checks only. Whether the evidence is TRUE stays a human verification responsibility.
 */
export function itemErrors(it, { now = Date.now() } = {}) {
  const e = [];
  if (!LABELS.includes(it?.label)) e.push(`label must be one of: ${LABELS.join(', ')}`);
  if (typeof it?.text !== 'string' || !it.text.trim()) e.push('text is required');
  // Sources: confirmed observations need a real web address; reports may instead cite a non-web source_ref.
  if (it?.source_url !== undefined && !isWebUrl(it.source_url)) e.push('source_url must be an http(s) web address (use source_ref for non-web sources)');
  if (it?.label === 'confirmed_observation' && !isWebUrl(it.source_url)) e.push('confirmed_observation needs source_url (an http(s) address you checked)');
  if (it?.label === 'source_report' && !isWebUrl(it.source_url) && !(typeof it.source_ref === 'string' && it.source_ref.trim())) {
    e.push('source_report needs source_url, or source_ref naming a non-web source');
  }
  if (it?.source_ref !== undefined && it.label === 'confirmed_observation') e.push('source_ref is only for reports; a confirmed observation needs a web source_url');
  // Times: a real UTC timestamp, not in the future.
  if (it?.label === 'confirmed_observation' && !it.retrieved_at) e.push('confirmed_observation needs retrieved_at (UTC time you observed it)');
  if (it?.retrieved_at !== undefined && it.retrieved_at !== null) {
    if (!UTC_ISO.test(String(it.retrieved_at)) || Number.isNaN(Date.parse(it.retrieved_at))) e.push('retrieved_at must be a UTC timestamp like 2026-10-09T14:30:00Z');
    else if (Date.parse(it.retrieved_at) > now + FUTURE_TOLERANCE_MS) e.push('retrieved_at is in the future');
  }
  for (const k of ['requested_url', 'final_url']) if (it?.[k] !== undefined && !isWebUrl(it[k])) e.push(`${k} must be an http(s) web address`);
  // Who and what: a warning signal must name the organization; asset signals must name the asset and its controller.
  const warning = SOURCED.has(it?.label) && it?.signal && it.signal !== 'none';
  if (warning && !(typeof it.org === 'string' && it.org.trim())) e.push(`signal ${it.signal} needs org (which organization the evidence is about)`);
  if (warning && ASSET_SIGNALS.has(it.signal)) {
    const a = it.asset;
    if (!a || typeof a !== 'object') e.push(`signal ${it.signal} needs asset {kind, id, controlled_by}`);
    else {
      if (!ASSET_KINDS.includes(a.kind)) e.push(`asset.kind must be one of ${ASSET_KINDS.join('|')}`);
      if (!(typeof a.id === 'string' && a.id.trim())) e.push('asset.id must name the asset (e.g. the domain or service)');
      if (!CONTROLLERS.includes(a.controlled_by)) e.push(`asset.controlled_by must be one of ${CONTROLLERS.join('|')}`);
    }
  }
  if (it?.requested_url && !PAGE_ROLES.includes(it.page_role)) e.push(`requested_url needs page_role (${PAGE_ROLES.join('|')})`);
  if (it?.page_role !== undefined && !PAGE_ROLES.includes(it.page_role)) e.push(`page_role must be one of ${PAGE_ROLES.join('|')}`);
  if (it?.hops !== undefined && !Array.isArray(it.hops)) e.push('hops must be an array of {url, status, method, at}');
  if (it?.signal !== undefined && !SIGNALS.includes(it.signal)) e.push(`signal must be one of ${SIGNALS.join(', ')}`);
  if (it?.confidence !== undefined && !CONFIDENCE.includes(it.confidence)) e.push('confidence must be low|medium|high');
  return e;
}

export function addItem(ledger, item) {
  const errs = itemErrors(item);
  if (errs.length) throw new Error(`invalid item: ${errs.join('; ')}`);
  const id = item.id ?? `E${ledger.items.length + 1}`;
  if (ledger.items.some((i) => i.id === id)) throw new Error(`duplicate item id ${id}`);
  const stored = { ...item, id, text: redact(item.text) };
  ledger.items.push(stored);
  return stored;
}

export function addHypothesis(ledger, h) {
  if (!h?.id || !h.statement) throw new Error('hypothesis needs id and statement');
  if (!HYP_STATUS.includes(h.status ?? 'open')) throw new Error(`status must be ${HYP_STATUS.join('|')}`);
  for (const ref of [...(h.supporting ?? []), ...(h.against ?? [])]) {
    if (!ledger.items.some((i) => i.id === ref)) throw new Error(`hypothesis ${h.id} cites unknown evidence ${ref}`);
  }
  ledger.hypotheses.push({ status: 'open', supporting: [], against: [], ...h });
}

/** Reasons a verdict for `subject` may not rest on these evidence items (empty = OK). */
export function verdictBasisErrors(ledger, subject, verdict, basis) {
  const errors = [];
  const items = [];
  for (const id of basis) {
    const it = ledger.items.find((i) => i.id === id);
    if (!it) { errors.push(`unknown evidence id ${id}`); continue; }
    if (it.org !== subject) errors.push(`evidence ${id} is about "${it.org ?? 'no organization'}", not "${subject}"`);
    for (const e of itemErrors(it)) errors.push(`evidence ${id}: ${e}`);
    items.push(it);
  }
  if (verdict !== 'no evidence found' && basis.length === 0) errors.push(`"${verdict}" needs at least one evidence id`);
  if (verdict === 'independent evidence of compromise'
    && !items.some((i) => i.label === 'confirmed_observation' && i.signal === 'compromise_confirmed' && i.org === subject && controlledByOrg(i))) {
    errors.push(`"independent evidence of compromise" requires a confirmed_observation with signal compromise_confirmed about an asset that "${subject}" itself controls`);
  }
  return errors;
}

export function setVerdict(ledger, subject, verdict, basis = []) {
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of: ${VERDICTS.join(' | ')}`);
  const errors = verdictBasisErrors(ledger, subject, verdict, basis);
  if (errors.length) throw new Error(errors.join('; '));
  ledger.verdicts[subject] = { verdict, basis, set_at: nowUtc() };
}

export function validateLedger(l) {
  const errors = [];
  if (l?.schema !== 1) errors.push('schema must be 1');
  for (const k of ['checked', 'not_checked', 'items', 'hypotheses']) if (!Array.isArray(l?.[k])) errors.push(`${k} must be an array`);
  if (errors.length) return errors;
  const ids = new Set();
  for (const it of l.items) {
    if (!it.id) errors.push('every item needs an id');
    else if (ids.has(it.id)) errors.push(`duplicate id ${it.id}`);
    ids.add(it.id);
    for (const e of itemErrors(it)) errors.push(`${it.id ?? '?'}: ${e}`);
  }
  for (const h of l.hypotheses) {
    if (!HYP_STATUS.includes(h.status)) errors.push(`${h.id}: bad status`);
    for (const ref of [...(h.supporting ?? []), ...(h.against ?? [])]) if (!ids.has(ref)) errors.push(`${h.id}: unknown evidence ${ref}`);
  }
  for (const [subject, v] of Object.entries(l.verdicts ?? {})) {
    if (!VERDICTS.includes(v.verdict)) errors.push(`verdict for ${subject} is not one of the allowed verdicts`);
    // A hand-edited ledger gets the same checks as setVerdict: evidence must be about this organization.
    for (const e of verdictBasisErrors(l, subject, v.verdict, v.basis ?? [])) errors.push(`verdict for ${subject}: ${e}`);
  }
  return errors;
}

/** Normalized host for a domain or URL (lowercase, no www., no trailing dot), or null for anything else. */
export function hostOf(raw) {
  const k = targetKey(raw);
  return k?.type === 'host' ? k.key : null;
}

/** Hosts the primary site's redirects actually reached: every hop after the first, and the final URL. */
function redirectDestinations(primaryRedirects) {
  const hosts = new Set();
  for (const r of primaryRedirects) {
    for (const u of [...(r.hops ?? []).slice(1).map((h) => h?.url), r.final_url]) { const h = hostOf(u); if (h) hosts.add(h); }
  }
  return hosts;
}

/**
 * F10: may this confirmed reputation flag corroborate the primary-site redirect? Only evidence ABOUT the
 * redirect may: a flag on some unrelated site says nothing about where this organization's site went.
 *   flag          the reputation_flag item (flag.asset = { kind, id, controlled_by })
 *   flagHost      hostOf(flag.asset.id): the flagged site's normalized host, or null if the id is not a domain/URL
 *   destinations  Set of normalized hosts the primary site's redirects actually reached
 *   ownHosts      Set of normalized hosts of the organization's own primary pages (their requested_url)
 */
function flagCorroborates(flag, flagHost, destinations, ownHosts) {
  if (!flagHost) return false; // no domain/URL identity: nothing links it to this redirect
  // Exact host only: a flag on a parent domain (often a shared hosting platform) does not implicate every tenant.
  if (destinations.has(flagHost)) return true; // the place the primary site actually went
  return ownHosts.has(flagHost) && flag.asset?.controlled_by === 'organization'; // the organization's own site
}

/**
 * Suggest (never set) a verdict for ONE organization from its ledger items.
 * Pass { subject } to consider only that organization's items (items about other organizations are ignored).
 * Output: { verdict: one of VERDICTS, reason: short string }.
 */
export function suggestVerdict(allItems, { subject } = {}) {
  const items = subject === undefined ? allItems : allItems.filter((i) => i.org === subject);
  // Only sourced evidence counts; inferences and hypotheses never raise a verdict on their own.
  const sourced = items.filter((i) => SOURCED.has(i.label) && i.signal && i.signal !== 'none');
  // Redirects from intake/source/contact pages say nothing about the primary site moving.
  const relevant = sourced.filter((i) => i.signal !== 'redirect_off_domain' || !i.page_role || i.page_role === 'primary');
  const ids = (list) => list.map((i) => i.id).join(', ');
  const seen = (signal) => relevant.filter((i) => i.label === 'confirmed_observation' && i.signal === signal);

  // A confirmed compromise only reaches the top verdict when it affects an asset the organization itself controls.
  // A compromised third-party service (e.g. a forms provider) or an asset of unknown ownership stays reviewable.
  const ownCompromise = seen('compromise_confirmed').filter(controlledByOrg);
  if (ownCompromise.length) {
    return { verdict: 'independent evidence of compromise', reason: `confirmed: ${ids(ownCompromise)}` };
  }
  // Page-level signals only implicate the organization when seen on its own primary site; elsewhere they stay reviewable.
  const onPrimary = (signal) => seen(signal).filter((i) => i.page_role === 'primary');
  const primaryRedirect = onPrimary('redirect_off_domain');
  const primaryMalicious = onPrimary('malicious_content').filter(controlledByOrg);
  // A DNS/registration change only corroborates when it is the organization's own domain. A reputation flag only
  // corroborates when flagCorroborates() links it to this redirect (F10).
  const destinations = redirectDestinations(primaryRedirect);
  const ownHosts = new Set(primaryRedirect.map((r) => hostOf(r.requested_url)).filter(Boolean));
  const linkedFlags = seen('reputation_flag').filter((f) => flagCorroborates(f, hostOf(f.asset?.id), destinations, ownHosts) === true);
  const corroboration = [...linkedFlags, ...seen('dns_or_registration_change').filter(controlledByOrg), ...primaryMalicious];
  if (primaryMalicious.length || (primaryRedirect.length && corroboration.length)) {
    return { verdict: 'suspicious indicators', reason: `confirmed: ${ids([...primaryRedirect, ...corroboration])}` };
  }
  if (relevant.length) {
    const notOwn = relevant.filter((i) => ASSET_SIGNALS.has(i.signal) && i.signal !== 'reputation_flag' && !controlledByOrg(i));
    return { verdict: 'needs review', reason: `unconfirmed or uncorroborated: ${ids(relevant)}${notOwn.length ? `; not (known to be) the organization's own asset: ${ids(notOwn)}` : ''}` };
  }
  const ignored = sourced.length - relevant.length;
  return { verdict: 'no evidence found', reason: ignored ? `${ignored} secondary-page redirect(s) not counted` : 'no sourced warning signals' };
}

// Ledger values may be hand-edited or quote untrusted evidence: sanitize and escape every cell.
const cell = (v) => mdText(v);

export function toMarkdown(l) {
  const out = [`# Evidence ledger: ${cell(l.incident_id)}`, '', `Created ${cell(l.created_at)}. ${l.items.length} item(s).`, ''];
  out.push('| ID | Label | Org | Role | Requested → Final | Source | Retrieved | Text |', '|---|---|---|---|---|---|---|---|');
  for (const i of l.items) {
    const chainCell = i.requested_url ? `${mdUrl(i.requested_url)} → ${i.final_url ? mdUrl(i.final_url) : '(unverified)'}` : '';
    const sourceCell = i.source_url ? mdUrl(i.source_url) : cell(i.source_ref);
    out.push(`| ${[cell(i.id), cell(i.label), cell(i.org), cell(i.page_role), chainCell, sourceCell, cell(i.retrieved_at ?? 'not re-fetched'), cell(i.text)].join(' | ')} |`);
  }
  if (l.hypotheses.length) {
    out.push('', '## Hypotheses');
    for (const h of l.hypotheses) out.push(`- **${cell(h.id)}** \\[${cell(h.status)}\\] ${cell(h.statement)}${h.discriminating_evidence ? `\n  - would discriminate: ${cell(h.discriminating_evidence)}` : ''}`);
  }
  return out.join('\n') + '\n';
}

const HELP = `evidence_ledger: labeled, sourced evidence for one incident.

  new <incident_id> [--save FILE]     start an empty ledger
  validate <FILE>                     check labels, sources, page roles and references
  render <FILE> [--save FILE.md]      evidence table + hypotheses as Markdown

Labels: ${LABELS.join(', ')}
Verdicts: ${VERDICTS.join(' | ')}`;

export function main(argv) {
  const { values: o, positionals: [cmd, arg] } = parseArgs({ args: argv, allowPositionals: true, options: {
    save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' }, scope: { type: 'string' },
  } });
  const scope = o.save ? requireScope(o.scope, { action: 'save_local' }) : null;
  if (!cmd || o.help) return console.log(HELP);
  const emit = (text) => (o.save ? console.log(`saved ${safeWrite(o.save, text, { overwrite: o.overwrite })}`) : process.stdout.write(text));
  if (cmd === 'new') {
    const id = arg ?? fail('incident_id required');
    requireSameIncident(scope, id, 'the new ledger'); // V4-07
    return emit(JSON.stringify(createLedger(id), null, 2) + '\n');
  }
  const ledger = JSON.parse(readFileSync(arg ?? fail('FILE required'), 'utf8'));
  requireSameIncident(scope, ledger?.incident_id, 'the ledger'); // V4-07: before anything is rendered or saved
  const errors = validateLedger(ledger);
  if (cmd === 'validate') {
    if (errors.length) { errors.forEach((e) => console.log(`  ✗ ${e}`)); process.exitCode = 1; } else console.log('ledger OK');
  } else if (cmd === 'render') {
    if (errors.length) fail(`ledger is invalid:\n  ${errors.join('\n  ')}`);
    emit(toMarkdown(ledger));
  } else fail(`unknown command "${cmd}"`);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
