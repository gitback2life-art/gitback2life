import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {assertOwner,assertSoloProtection,assertManualEnvironment,assertKeyPair} from './setup-checks.mjs';
import {verifySenderIdentity} from './identity.mjs';
import {spawnSync} from 'node:child_process';
const owner='gitback2life-art';
const manual=()=>({can_admins_bypass:false,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:owner}}]}]});
const branch=()=>({enforce_admins:{enabled:true},allow_force_pushes:{enabled:false},allow_deletions:{enabled:false},required_pull_request_reviews:{required_approving_review_count:0,require_code_owner_reviews:false},required_status_checks:{strict:true,contexts:['email-tests']}});
test('solo owner can approve deployments without approving own PR',()=>{assertManualEnvironment(manual());assertSoloProtection(branch());});
test('owner admin required: neither maintainer nor other admin passes',()=>{
 assertOwner({login:owner},{permissions:{admin:true}});
 assert.throws(()=>assertOwner({login:owner},{permissions:{maintain:true}}),/ADMIN/);
 assert.throws(()=>assertOwner({login:'other'},{permissions:{admin:true}}),/ADMIN/);
});
test('manual gate rejects bypass, self-review prevention, teams and extra reviewers',()=>{
 for(const mutate of [x=>x.can_admins_bypass=true,x=>x.protection_rules[0].prevent_self_review=true,x=>x.protection_rules[0].reviewers[0].type='Team',x=>x.protection_rules[0].reviewers.push({type:'User',reviewer:{login:'other'}})]){
  const x=manual();mutate(x);assert.throws(()=>assertManualEnvironment(x),/approval gate/);
 }
});
test('solo protection rejects circular approval and missing enforcement',()=>{
 for(const mutate of [x=>x.required_pull_request_reviews.required_approving_review_count=1,x=>x.required_pull_request_reviews.require_code_owner_reviews=true,x=>x.enforce_admins.enabled=false,x=>x.required_status_checks.contexts=[],x=>x.allow_force_pushes.enabled=true,x=>x.required_pull_request_reviews.bypass_pull_request_allowances={users:[{}]}]){
  const x=branch();mutate(x);assert.throws(()=>assertSoloProtection(x));
 }
});
test('prepared key must match published key; setup cannot silently rotate it',()=>{
 const opts={modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}};
 const a=generateKeyPairSync('rsa',opts),b=generateKeyPairSync('rsa',opts);
 assertKeyPair(a.publicKey,a.privateKey);
 assert.throws(()=>assertKeyPair(a.publicKey,b.privateKey),/does not match/);
});
test('Google identity check refuses wrong, unverified and inaccessible account',async()=>{
 for(const value of [{email:'other@example.org',email_verified:true},{email:'gitback2life.ai@gmail.com',email_verified:false}])await assert.rejects(verifySenderIdentity('synthetic',async()=>({ok:true,json:async()=>value})),/authorized sender/);
 await assert.rejects(verifySenderIdentity('synthetic',async()=>({ok:false})),/Cannot verify/);
 await verifySenderIdentity('synthetic',async()=>({ok:true,json:async()=>({email:'gitback2life.ai@gmail.com',email_verified:true})}));
});
test('no-send preflight CLI exercises real control flow without Google or mail secrets',()=>{
 const fixture=`globalThis.fetch=async(url,opts={})=>{
  if(!url.startsWith('https://api.github.com/repos/gitback2life-art/gitback2life/'))throw Error('Unexpected network destination');
  let value;
  if(url.includes('deployment-branch-policies'))value={total_count:1,branch_policies:[{name:'main',type:'branch'}]};
  else if(url.includes('/environments/'))value=${JSON.stringify(manual())};
  else if(url.includes('/actions/variables/')){if(opts.headers.Authorization!=='Bearer synthetic-read')throw Error('Wrong read token');value={value:'disabled'};}
  else if(url.includes('/matching-refs/'))value=[];
  else if(url.endsWith('/git/refs')){const body=JSON.parse(opts.body);if(!body.ref.startsWith('refs/tags/gb2l-email-preflight-'))throw Error('Not a probe');return {status:201};}
  else throw Error('Unexpected endpoint');
  return {ok:true,json:async()=>value};
 };`;
 const env={...process.env,GITHUB_REPOSITORY:'gitback2life-art/gitback2life',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_TOKEN:'synthetic-write',GB2L_CONTROL_TOKEN:'synthetic-read',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
 for(const key of ['GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','GB2L_MAIL_PRIVATE_KEY'])delete env[key];
 const res=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fixture),'tools/gb2l-email/preflight.mjs'],{cwd:new URL('../..',import.meta.url),env,encoding:'utf8'});
 assert.equal(res.status,0,res.stderr);assert.match(res.stdout,/No-send preflight passed/);
});
test('sender CLI executes on Windows and fails without an event instead of silently succeeding',()=>{
 const res=spawnSync(process.execPath,['tools/gb2l-email/send.mjs'],{cwd:new URL('../..',import.meta.url),env:{...process.env,GITHUB_EVENT_PATH:'nonexistent-synthetic-event.json'},encoding:'utf8'});
 assert.notEqual(res.status,0);assert.match(res.stderr,/Mail sender refused/);
});
