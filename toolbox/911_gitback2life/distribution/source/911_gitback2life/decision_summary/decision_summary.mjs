#!/usr/bin/env node
// Turn an evidence ledger into a calm, six-part decision summary. Reads a ledger; writes only with --save.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fail, isMain, safeWrite } from '../_shared/common.mjs';
import { mdText, mdUrl, SHARING_CHECKLIST } from '../_shared/output.mjs';
import { requireSameIncident, requireScope } from '../_shared/scope.mjs';
import { suggestVerdict, validateLedger } from '../evidence_ledger/ledger.mjs';

// Words that sound like verdicts. Flagged for a second look, not forbidden.
export const LOADED_TERMS = ['infected', 'hacked', 'clean', 'false positive', 'vulnerable', 'malware', 'breached'];

export function languageWarnings(l) {
  const texts = [
    ...l.items.map((i) => [i.id, i.text]),
    ...l.hypotheses.map((h) => [h.id, h.statement]),
    ['risk', l.risk], ['next_step', l.next_step?.action],
  ];
  const out = [];
  for (const [where, text] of texts) {
    for (const term of LOADED_TERMS) if (new RegExp(`\\b${term}\\b`, 'i').test(text ?? '')) out.push({ where, term });
  }
  return out;
}

const LABEL_TITLES = {
  confirmed_observation: 'Confirmed observations (seen directly, sourced, timed)',
  source_report: 'Source reports (not independently verified)',
  inference: 'Inferences',
  hypothesis: 'Hypotheses (as evidence items)',
  recommendation: 'Recommendations',
  decision: 'Decisions taken',
};

function suggestionFor(items, org) {
  try { return suggestVerdict(items, { subject: org }); } catch { return null; }
}

// Every value that comes from the ledger (which may be hand-edited, or quote untrusted evidence) goes through
// mdText (sanitized + escaped) or mdUrl (sanitized link) before it reaches the report.
export function renderSummary(l) {
  const t = mdText;
  const ids = (arr) => (arr ?? []).map(t).join(', ');
  const L = [`# Decision summary: ${t(l.incident_id)}`, ''];
  const bullet = (arr, empty) => (arr.length ? arr.map((x) => `- ${t(x)}`) : [`- ${empty}`]);

  L.push('## 1. What was checked, and what was not', '', '**Checked**', ...bullet(l.checked, '(nothing re-verified yet)'), '', '**Not checked**', ...bullet(l.not_checked, '(none recorded)'), '');

  L.push('## 2. Observations', '');
  const obs = l.items.filter((i) => i.label === 'confirmed_observation' || i.label === 'source_report');
  for (const i of obs) {
    const chain = i.requested_url ? ` · ${t(i.page_role)}: ${mdUrl(i.requested_url)} → ${i.final_url ? mdUrl(i.final_url) : '(final URL unverified)'}` : '';
    const source = i.source_url ? mdUrl(i.source_url) : `${t(i.source_ref)} (not a web source)`;
    L.push(`- **${t(i.id)}** (${i.label === 'source_report' ? 'source report' : 'confirmed'}) ${t(i.text)}`,
      `  - source: ${source} · retrieved: ${i.retrieved_at ? t(i.retrieved_at) : 'not re-fetched'}${chain}`);
  }
  if (!obs.length) L.push('- (none)');
  L.push('');

  L.push('## 3. Confirmed versus inferred', '');
  for (const [label, title] of Object.entries(LABEL_TITLES)) {
    const matching = l.items.filter((i) => i.label === label).map((i) => i.id);
    if (matching.length) L.push(`- ${title}: ${ids(matching)}`);
  }
  L.push('');

  L.push('## 4. Explanations still in play', '');
  for (const h of l.hypotheses) {
    L.push(`- **${t(h.id)}** \\[${t(h.status)}\\] ${t(h.statement)}`);
    if (h.supporting?.length || h.against?.length) L.push(`  - for: ${ids(h.supporting) || 'none'} · against: ${ids(h.against) || 'none'}`);
    if (h.discriminating_evidence) L.push(`  - would tell them apart: ${t(h.discriminating_evidence)}`);
  }
  if (!l.hypotheses.length) L.push('- (none recorded)');
  L.push('');

  L.push('## 5. Risk and impact', '', l.risk ? t(l.risk) : '(not assessed)', '');
  const orgs = [...new Set(l.items.map((i) => i.org).filter(Boolean))];
  for (const org of orgs) {
    const set = l.verdicts?.[org];
    const s = suggestionFor(l.items, org);
    L.push(`- **${t(org)}**: verdict ${set ? `"${t(set.verdict)}" (basis ${ids(set.basis)})` : 'not set'}${s ? ` · suggested: "${t(s.verdict)}" (${t(s.reason)})` : ''}`);
  }
  L.push('');

  L.push('## 6. Safe next step', '', `- Action: ${l.next_step?.action ? t(l.next_step.action) : '(none)'}`, `- Permission needed: ${l.next_step?.permission_needed ? t(l.next_step.permission_needed) : '(none stated)'}`, '');

  const warnings = languageWarnings(l);
  if (warnings.length) {
    L.push('---', '', '**Language check:** these words read like verdicts; make sure the evidence supports them.');
    for (const w of warnings) L.push(`- "${t(w.term)}" in ${t(w.where)}`);
    L.push('');
  }
  L.push('---', '', '**Before sharing (a person must check; the tools cannot detect these reliably):**', ...SHARING_CHECKLIST.map((c) => `- [ ] ${c}`), '');
  return L.join('\n');
}

const HELP = `decision_summary: six-part summary from an evidence ledger.

  node decision_summary.mjs <ledger.json> [--save summary.md] [--overwrite]`;

export function main(argv) {
  const { values: o, positionals: [file] } = parseArgs({ args: argv, allowPositionals: true, options: {
    save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' }, scope: { type: 'string' },
  } });
  const scope = o.save ? requireScope(o.scope, { action: 'save_local' }) : null;
  if (!file || o.help) return console.log(HELP);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  requireSameIncident(scope, ledger?.incident_id, 'the ledger'); // V4-07
  const errors = validateLedger(ledger);
  if (errors.length) fail(`ledger is invalid:\n  ${errors.join('\n  ')}`);
  const text = renderSummary(ledger);
  if (o.save) console.log(`saved ${safeWrite(o.save, text, { overwrite: o.overwrite })}`);
  else console.log(text);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
