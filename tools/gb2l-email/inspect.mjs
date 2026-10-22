#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {fromRunnerEnvironment} from './request.mjs';
import {requestedMode} from './policy.mjs';
const mode=requestedMode(process.env.GB2L_EMAIL_MODE);
if(mode==='disabled'){
  console.log('Owner email emergency stop active; no message will be sent.');
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'ready=no\n');
}else{
  const {envelope,transport}=fromRunnerEnvironment();
  // Validated ciphertext only. No plaintext draft enters GitHub actions logs or history.
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`ready=yes\nenvelope=${Buffer.from(JSON.stringify(envelope)).toString('base64url')}\n`);
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n### GitBack2Life encrypted email request\nTransport: ${transport}\nID: \`${envelope.id}\`\nCommitment: \`${envelope.commitment}\`\nMode: **${mode}**\n${mode==='approval_required'?'Owner must review exact plaintext privately and approve the protected environment job.':'Owner-authorized autonomous policy and requester restrictions will be verified before transmission.'}\n`);
  console.log('Encrypted mail request accepted. Mode:',mode,'ID:',envelope.id);
}
