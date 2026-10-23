#!/usr/bin/env node
// account_recovery_guide: plain-language recovery checklists for an organization's OWN authorized people.
// Offline. Points to each provider's official help site rather than repeating procedures that change often.
// Helpers never file recovery requests, contact providers, or log in on anyone's behalf.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fail, isMain, safeWrite } from '../_shared/common.mjs';

export const GUIDES = JSON.parse(readFileSync(new URL('./guides.json', import.meta.url), 'utf8'));

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
const checks = (items) => items.map((x) => `- [ ] ${x}`).join('\n');

export function renderGeneral(g = GUIDES.general) {
  return [
    '# Account recovery: before you start', '', `> ${g.who_this_is_for}`, '',
    '## Who and how', checks(g.before_you_start), '',
    '## Gather this proof first', checks(g.proof_checklist), '',
    '## If a domain has expired', bullets(g.expired_domain), '',
    '## After you get back in', checks(g.after_recovery), '',
    '## What helpers never do', bullets(g.what_helpers_never_do), '',
  ].join('\n');
}

export function renderProvider(key, guides = GUIDES) {
  const p = guides.providers[key];
  if (!p) throw new Error(`unknown provider "${key}". Known: ${Object.keys(guides.providers).join(', ')}`);
  return [
    `# Recovering access: ${p.name}`, '', `> ${guides.general.who_this_is_for}`, '',
    '## Steps',
    checks([
      'Confirm who is authorized to recover this account (see "Who and how" below).',
      'Gather the proof listed below before contacting the provider.',
      `Go to the official help site: ${p.help_url}`,
      `Search there for: ${p.search_terms.map((s) => `"${s}"`).join(', ')}`,
      'Follow the provider\'s own recovery process. Submit proof only through its official forms or uploads.',
      'Keep a dated note of what was submitted and any case or ticket number (no passwords or ID copies in the note).',
    ]), '',
    `**About ${p.name}:** ${p.notes}`, '',
    '## Who and how', checks(guides.general.before_you_start), '',
    '## Proof to gather', checks(guides.general.proof_checklist), '',
    '## After you get back in', checks(guides.general.after_recovery), '',
    '## What helpers never do', bullets(guides.general.what_helpers_never_do), '',
    '_Provider processes change. If anything here disagrees with the official help site, follow the help site._', '',
  ].join('\n');
}

const HELP = `account_recovery_guide: recovery checklists for the organization's own authorized people (offline).

  list                         providers covered
  general                      before-you-start checklist, proof to gather, expired domains, after recovery
  show <provider>              full checklist for one provider
  ... [--save FILE.md] [--overwrite]   save inside this toolkit (to print or hand to the organization)`;

export function main(argv) {
  const { values: o, positionals: [cmd, key] } = parseArgs({ args: argv, allowPositionals: true, options: {
    save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!cmd || o.help) return console.log(HELP);
  let text;
  if (cmd === 'list') text = Object.entries(GUIDES.providers).map(([k, p]) => `${k.padEnd(18)} ${p.name}`).join('\n') + '\n';
  else if (cmd === 'general') text = renderGeneral();
  else if (cmd === 'show') text = renderProvider(key);
  else throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  if (o.save) console.log(`saved ${safeWrite(o.save, text, { overwrite: o.overwrite })}`);
  else console.log(text);
}

if (isMain(import.meta)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(e.message); }
}
