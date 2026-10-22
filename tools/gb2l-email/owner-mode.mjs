#!/usr/bin/env node
// Administrative mode switch. Requires repository admin; no mode-setting PR or public issue.
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {parsePolicy,assertMainOnlyDeployment,OWNER,REPO,SENDER} from './policy.mjs';
import {assertOwner,assertSoloProtection,assertManualEnvironment} from './setup-checks.mjs';
const [mode,...flags]=process.argv.slice(2);
if(!['approval_required','auto_send','disabled'].includes(mode))throw Error('Usage: node tools/gb2l-email/owner-mode.mjs approval_required|auto_send|disabled [--daily=3] [--actor=gitback2life-art] [--domain=example.org]');
const opts={};for(const f of flags){const m=/^--(daily|actor|domain|recipient)=([\w@.\-]+)$/.exec(f);if(!m)throw Error('Unknown mode setting');opts[m[1]]=m[2];}
const run=(args,data)=>{const p=spawnSync('gh',args,{input:data,encoding:'utf8',stdio:['pipe','pipe','pipe']});if(p.status!==0)throw Error('GitHub owner permission/configuration check failed: '+args.slice(0,3).join(' '));return p.stdout.trim();};
if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)throw Error('Remove token overrides and sign in with the owner account');
assertOwner(JSON.parse(run(['api','user'])),JSON.parse(run(['api',`repos/${REPO}`])));
const variable=(name,value)=>run(['variable','set',name,'--repo',REPO],value);
function audit(nextMode,actor){
  // A mode-change record contains only mode, owner identity, and timestamp. No mail content.
  const head=JSON.parse(run(['api',`repos/${REPO}/git/ref/heads/main`]));
  const sha=head?.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Cannot verify main HEAD for audit record');
  const stamp=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  const ref=`refs/tags/gb2l-mail-mode-${stamp}-${nextMode}-${actor}`;
  run(['api',`repos/${REPO}/git/refs`,'-X','POST','-f',`ref=${ref}`,'-f',`sha=${sha}`]);
}

if(mode==='disabled'){
  variable('GB2L_EMAIL_MODE','disabled');
  try{audit('disabled',OWNER)}catch{console.log('Warning: emergency stop was set; GitHub mode audit tag could not be created.')}
  console.log('NEW mail jobs disabled. IMMEDIATELY cancel any in-flight email Actions jobs as well; revoke the Gmail token for an emergency credential stop.');
}else if(mode==='approval_required'){
  const environ=JSON.parse(run(['api',`repos/${REPO}/environments/gb2l-email-send`]));
  assertManualEnvironment(environ);
  assertMainOnlyDeployment(environ,JSON.parse(run(['api',`repos/${REPO}/environments/gb2l-email-send/deployment-branch-policies?per_page=100`])));
  assertSoloProtection(JSON.parse(run(['api',`repos/${REPO}/branches/main/protection`])));
  const actor=opts.actor||OWNER;
  if(!/^[A-Za-z0-9-]{1,39}$/.test(actor))throw Error('Invalid authorized GitHub requester');
  const policy={version:1,mode:'approval_required',owner:OWNER,requester:actor,sender:SENDER,daily_limit:3};
  parsePolicy(JSON.stringify(policy),'approval_required',actor);
  run(['secret','set','GB2L_EMAIL_POLICY','--env','gb2l-email-send','--repo',REPO],JSON.stringify(policy));
  variable('GB2L_REQUEST_ACTOR',actor);
  audit('approval_required',actor);
  variable('GB2L_EMAIL_MODE','approval_required');
  console.log('Approval-required mode set for',actor,'. Confirm gb2l-email-send requires owner review.');
}else{
  const branch=JSON.parse(run(['api',`repos/${REPO}/branches/main/protection`]));
  assertSoloProtection(branch);
  const environ=JSON.parse(run(['api',`repos/${REPO}/environments/gb2l-email-auto`]));
  if(environ?.protection_rules?.some(x=>x.type==='required_reviewers'))throw Error('Autonomous environment incorrectly requires per-message approval');
  assertMainOnlyDeployment(environ,JSON.parse(run(['api',`repos/${REPO}/environments/gb2l-email-auto/deployment-branch-policies?per_page=100`])));
  const existing=JSON.parse(run(['api',`repos/${REPO}/environments/gb2l-email-auto/secrets`]));
  const names=new Set((existing.secrets||[]).map(s=>s.name));
  for(const name of ['GB2L_MAIL_PRIVATE_KEY','GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','GB2L_CONTROL_TOKEN'])if(!names.has(name))throw Error('Autonomous environment missing '+name+'; complete the separate autonomous provisioning procedure before enabling');
  if(!input.isTTY)throw Error('Autonomous enable requires an interactive owner confirmation');
  const rl=createInterface({input,output});
  let answer;try{answer=await rl.question('Autonomous Gmail sending permits approved GitHub requester actions without per-message review. Type ENABLE AUTO SENDING: ')}finally{rl.close()}
  if(answer!=='ENABLE AUTO SENDING')throw Error('Owner did not authorize autonomous mode');
  const actor=opts.actor||OWNER,daily=Number(opts.daily||3);
  if(!/^[A-Za-z0-9-]{1,39}$/.test(actor))throw Error('Invalid authorized GitHub requester');
  const policy={version:1,mode:'auto_send',owner:OWNER,requester:actor,sender:SENDER,daily_limit:daily};
  if(opts.domain)policy.domains=[opts.domain.toLowerCase()];
  if(opts.recipient)policy.recipients=[opts.recipient.toLowerCase()];
  parsePolicy(JSON.stringify(policy),'auto_send',actor);
  run(['secret','set','GB2L_EMAIL_POLICY','--env','gb2l-email-auto','--repo',REPO],JSON.stringify(policy));
  variable('GB2L_REQUEST_ACTOR',actor);
  audit('auto_send',actor);
  // Last operation changes the active mode. Earlier incomplete setup can't enable it.
  variable('GB2L_EMAIL_MODE','auto_send');
  console.log('Autonomous mode explicitly enabled for principal',actor,'with daily quota',daily,'and configured recipient restrictions.');
}
