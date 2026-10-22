#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {validateEnvelope} from './crypto.mjs';
const changed=execFileSync('git',['diff','--name-only','HEAD^1','HEAD'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
if(changed.length!==1||!/^mail\/outbox\/[a-f0-9]{32}\.sealed\.json$/.test(changed[0]))throw new Error('Email commits must contain exactly one sealed draft, no code/config changes');
const path=changed[0];
const env=validateEnvelope(JSON.parse(readFileSync(path,'utf8')));
if(path!==`mail/outbox/${env.id}.sealed.json`)throw new Error('Draft filename mismatch');
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`file=${path}\n`);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `\n### Sealed email awaiting owner approval\nDraft ID: \`${env.id}\`\nExact-content SHA-256 commitment: \`${env.commitment}\`\n\n**Approve only after reviewing the complete plaintext privately and comparing this hash with the AI's draft receipt.** No email content is stored in GitHub.\n`);
console.log('Sealed draft validated. ID:',env.id,'commitment:',env.commitment);
