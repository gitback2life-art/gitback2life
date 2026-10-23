#!/usr/bin/env node
// Incident intake and scope guard: capture what is being investigated, what is allowed, and when to stop.
// The checks themselves live in _shared/scope.mjs and are enforced by every tool that goes online or saves
// incident data (they require --scope).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fail, isMain, nowUtc, printJson, safeWrite } from '../_shared/common.mjs';
import {
  ACTIONS, ALWAYS_ASK, authorize, inScope, ScopeError, SERVICES, stopScope, template, validateScope,
} from '../_shared/scope.mjs';
import { CACHE_DIR, pruneState, stateSummary } from '../_shared/polite.mjs';

export { ACTIONS, ALWAYS_ASK, authorize, template, validateScope };

/**
 * Build an operator attestation for one always-ask action on one exact target. It records the operator's
 * statement; it does not prove that a person made it (F01): anything that can write the scope file can write one.
 */
export function makeApproval(scope, { action, target, detail, now = nowUtc() }) {
  if (!ALWAYS_ASK.has(action)) throw new ScopeError(`"${action}" does not need approvals; set its permission in the scope instead`);
  if (!inScope(scope, target)) throw new ScopeError(`"${target}" is not one of the scope's targets`);
  return { action, target, attested_at: now, attested_by: 'operator', detail: detail ?? `${action} ${target}` };
}

/**
 * Record an attestation from an interactive terminal after the exact target is typed again. The terminal check and
 * the retyping guard against recording one BY ACCIDENT; they are not a security boundary and say nothing about who typed.
 */
async function approveInteractively(file, { action, target, detail }, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ScopeError('attestations are recorded from an interactive terminal (an accident guard, not proof of a person); no terminal is attached, so nothing was recorded');
  }
  const scope = JSON.parse(readFileSync(file, 'utf8'));
  const errors = validateScope(scope);
  if (errors.length) throw new ScopeError(`scope file is invalid: ${errors.join('; ')}`);
  const approval = makeApproval(scope, { action, target, detail });
  stdout.write(`\nScope: ${scope.incident_id}\nAction: ${action} (${ACTIONS[action]})\nTarget: ${target}\nValid for 24 hours, for this exact target only.\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Type the exact target again to attest that you approve it (anything else cancels): ');
  rl.close();
  if (answer.trim() !== target) { stdout.write('Cancelled. Nothing was recorded.\n'); return null; }
  scope.approvals = [...(scope.approvals ?? []), approval];
  safeWrite(file, JSON.stringify(scope, null, 2) + '\n', { overwrite: true });
  stdout.write(`Operator attestation recorded in ${file}\n`);
  return approval;
}

const HELP = `incident_intake: the incident scope. Tools that go online or save case data require --scope <file>.

  template [--save FILE]                       blank scope (open, expires in 7 days, no results or reports kept by
                                               default; safety state such as daily counters is always kept)
  check FILE                                   validate a scope file
  authorize FILE ACTION [--target T] [--services a,b]   would this be allowed? (exit 0 yes, 1 no)
  approve FILE --action A --target T [--detail TEXT]    record an operator attestation for an always-ask action on one
                                               exact target (24h). Interactive terminal only, as an accident guard;
                                               an attestation is your statement, not proof that a person approved
  stop FILE                                    mark the incident stopped (stopping condition met); all tools then refuse
  state [--clear-results]                      what the toolkit has stored in _shared/.polite_cache; --clear-results removes
                                               cached lookup results and robots.txt policies now (daily counters and
                                               live-check cool-downs are safety limits and only expire on their own)
  actions | services                           list known actions / outside services

Always-ask actions: ${[...ALWAYS_ASK].join(', ')}`;

export async function main(argv) {
  const { values: o, positionals: [cmd, file, actionArg] } = parseArgs({ args: argv, allowPositionals: true, options: {
    save: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' }, 'clear-results': { type: 'boolean' },
    action: { type: 'string' }, target: { type: 'string' }, services: { type: 'string' }, detail: { type: 'string' },
  } });
  if (!cmd || o.help) return console.log(HELP);
  const load = () => JSON.parse(readFileSync(file ?? fail('scope FILE is required'), 'utf8'));
  if (cmd === 'template') {
    const text = JSON.stringify(template(), null, 2) + '\n';
    if (o.save) console.log(`saved ${safeWrite(o.save, text, { overwrite: o.overwrite })}`);
    else process.stdout.write(text);
  } else if (cmd === 'check') {
    const errors = validateScope(load());
    if (errors.length) { errors.forEach((e) => console.log(`  ✗ ${e}`)); process.exitCode = 1; } else console.log('scope OK');
  } else if (cmd === 'authorize') {
    const r = authorize(load(), { action: actionArg, target: o.target, services: (o.services ?? '').split(',').filter(Boolean) });
    console.log(r.allowed ? 'ALLOWED' : `BLOCKED:\n  - ${r.reasons.join('\n  - ')}`);
    process.exitCode = r.allowed ? 0 : 1;
  } else if (cmd === 'approve') {
    if (!o.action || !o.target) throw new ScopeError('approve needs --action and --target');
    await approveInteractively(file, { action: o.action, target: o.target, detail: o.detail });
  } else if (cmd === 'stop') {
    const stopped = stopScope(load());
    safeWrite(file, JSON.stringify(stopped, null, 2) + '\n', { overwrite: true });
    console.log(`stopped at ${stopped.stopped_at}. Every tool will now refuse this scope.`);
  } else if (cmd === 'state') {
    const expired = pruneState();
    const cleared = o['clear-results'] ? pruneState({ results: true }) : null;
    printJson({ folder: CACHE_DIR, expired_entries_removed: expired, ...(cleared ? { cleared_now: cleared } : {}), stored_now: stateSummary() });
  } else if (cmd === 'actions') printJson(ACTIONS);
  else if (cmd === 'services') printJson(SERVICES);
  else throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
}

if (isMain(import.meta)) main(process.argv.slice(2)).catch((e) => fail(e.message));
