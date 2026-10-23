#!/usr/bin/env node
// notice_drafter: draft ONE calm, accurate message from an evidence ledger. It never sends anything.
// Confirmed observations are stated as facts with their source and time; reports say "it was reported";
// unknowns are listed honestly. Contact details are removed. Verdict-sounding words block the draft.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fail, isMain, safeWrite } from '../_shared/common.mjs';
import { plainText, SHARING_CHECKLIST } from '../_shared/output.mjs';
import { requireSameIncident, requireScope } from '../_shared/scope.mjs';
import { LOADED_TERMS } from '../decision_summary/decision_summary.mjs';
import { validateLedger } from '../evidence_ledger/ledger.mjs';

export const AUDIENCES = {
  organization: {
    subject: (org) => `A possible issue with ${org ?? 'your'} website listing, for your review`,
    why: 'I noticed something that may affect how people reach you online, and wanted you to have the details.',
    ask: (urls) => urls.length
      ? `If it helps, could someone check whether ${urls.join(' and ')} is still your correct web address, and whether the domain registration is current?`
      : 'If it helps, could someone check that your website and domain registration look the way you expect?',
  },
  maintainer: {
    subject: (org) => `Directory check results${org ? ` for ${org}` : ''}, for your review`,
    why: 'I looked into the recent automated check results and wanted to share what the evidence does and does not show.',
    ask: () => 'Could you take a look when convenient? I am happy to share the evidence packet or a proposed test.',
  },
  registrar: {
    subject: (org) => `Request for review of a domain${org ? ` used by ${org}` : ''}`,
    why: 'I am helping a nonprofit understand a change to how its domain behaves. The organization itself should make any account requests.',
    ask: () => 'Could you advise what information the domain holder should provide so you can review this with them?',
  },
  host: {
    subject: (org) => `Request for review of a hosted site${org ? ` used by ${org}` : ''}`,
    why: 'I am helping a nonprofit understand an unexpected change to its website. The organization itself should make any account requests.',
    ask: () => 'Could you advise how the account holder can review recent configuration changes with you?',
  },
};

// Shared output guard: secrets, contact details and secret-looking URL parameters are removed.
export const scrub = (text) => plainText(text);

export function draftNotice(ledger, { audience = 'organization', org = null, fromRole = 'a volunteer who helps animal rescues with technical problems', maxItems = 5 } = {}) {
  const a = AUDIENCES[audience];
  if (!a) throw new Error(`audience must be one of: ${Object.keys(AUDIENCES).join(', ')}`);
  const items = ledger.items.filter((i) => !org || !i.org || i.org === org);
  const confirmed = items.filter((i) => i.label === 'confirmed_observation').slice(0, maxItems);
  const reported = items.filter((i) => i.label === 'source_report').slice(0, maxItems);
  const urls = [...new Set(items.filter((i) => i.requested_url && i.page_role === 'primary').map((i) => i.requested_url))];
  const unknowns = ledger.not_checked.slice(0, 3);
  const explanations = ledger.hypotheses.filter((h) => h.status !== 'ruled_out').slice(0, 4);
  const L = [`Subject: ${a.subject(org)}`, '', 'Hello,', '', `I'm writing as ${fromRole}. ${a.why}`, ''];
  if (confirmed.length) {
    L.push('What I observed directly:');
    for (const i of confirmed) L.push(`- ${i.text} (seen ${i.retrieved_at}; source: ${i.source_url})`);
    L.push('');
  }
  if (reported.length) {
    L.push('What has been reported, and not yet independently confirmed:');
    for (const i of reported) L.push(`- It was reported that: ${i.text} (source: ${i.source_url ?? i.source_ref})`);
    L.push('');
  }
  if (explanations.length) {
    L.push('There are several possible explanations, and the evidence so far does not settle which applies:');
    for (const h of explanations) L.push(`- ${h.statement}`);
    L.push('');
  }
  if (unknowns.length) {
    L.push('Still unknown:');
    for (const u of unknowns) L.push(`- ${u}`);
    L.push('');
  }
  L.push('What I have not done: I have not changed anything, logged in to anything, tested anything against your systems, or contacted anyone else about this.', '');
  L.push(a.ask(urls), '');
  L.push('I can share a short evidence packet (links, times and file fingerprints) if that would be useful. No reply is needed if this is already known.', '');
  L.push('Thank you for the work you do.', '');
  L.push('----', 'DRAFT: not sent. Review every line before sending; send one message to one contact.', 'Before sending, a person must check (the tool cannot detect these reliably):', ...SHARING_CHECKLIST.map((c) => `  [ ] ${c}`));
  const text = scrub(L.join('\n'));
  const warnings = LOADED_TERMS.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));
  return { text, warnings };
}

const HELP = `notice_drafter: draft one calm, accurate message from an evidence ledger. Never sends anything.

  node notice_drafter.mjs <ledger.json> [--to organization|maintainer|registrar|host] [--org "Name"]
       [--from "a volunteer ..."] [--save FILE.txt] [--overwrite]

Refuses to produce a draft containing verdict words (${LOADED_TERMS.join(', ')}); fix the ledger wording first.`;

export function main(argv) {
  const { values: o, positionals: [file] } = parseArgs({ args: argv, allowPositionals: true, options: {
    to: { type: 'string' }, org: { type: 'string' }, from: { type: 'string' }, save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    scope: { type: 'string' },
  } });
  const scope = o.save ? requireScope(o.scope, { action: 'save_local' }) : null;
  if (!file || o.help) return console.log(HELP);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  requireSameIncident(scope, ledger?.incident_id, 'the ledger'); // V4-07
  const errors = validateLedger(ledger);
  if (errors.length) throw new Error(`ledger is invalid:\n  ${errors.join('\n  ')}`);
  const { text, warnings } = draftNotice(ledger, { audience: o.to, org: o.org, ...(o.from ? { fromRole: o.from } : {}) });
  if (warnings.length) throw new Error(`draft not produced: it would contain verdict words (${warnings.join(', ')}). Reword the ledger items first.`);
  if (o.save) console.log(`saved ${safeWrite(o.save, text + '\n', { overwrite: o.overwrite })}`);
  else console.log(text);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
