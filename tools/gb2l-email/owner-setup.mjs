#!/usr/bin/env node
import {verifySenderIdentity} from './identity.mjs';
// One-time owner-only setup. Use outside public AI chat. Never records refresh tokens on disk.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {assertMainOnlyDeployment,REPO} from './policy.mjs';
import {assertOwner,assertSoloMainRuleset,assertManualEnvironment,assertKeyPair,assertGmailSendGranted} from './setup-checks.mjs';
const args=process.argv.slice(2);
const idx=args.indexOf('--credentials');
const filename=idx>=0?args[idx+1]:null;
const ri=args.indexOf('--repo');const repo=ri>=0?args[ri+1]:'gitback2life-art/gitback2life';
const ki=args.indexOf('--private-key');const keyFile=ki>=0?args[ki+1]:null;
if(!filename||!keyFile||repo!==REPO)throw new Error('Usage: node tools/gb2l-email/owner-setup.mjs --credentials C:\\path\\client_secret.json --private-key /PRIVATE/gb2l.private.pem');
const cfg=JSON.parse(readFileSync(filename,'utf8')).installed;
if(!cfg||typeof cfg.client_id!=='string'||typeof cfg.client_secret!=='string')throw new Error('Only Google Desktop OAuth JSON supported. No credentials imported.');
// This preflight MUST run before touching any GitHub secret, token, or mode setting.
const publicKeyPath=new URL('./public-key.pem',import.meta.url);
if(!existsSync(publicKeyPath))throw Error('Prepare and publish the public key before Gmail authorization; see OWNER_SETUP.md');
const privateKey=readFileSync(keyFile,'utf8');
assertKeyPair(readFileSync(publicKeyPath,'utf8'),privateKey);
// Refuse to proceed unless GitHub's official CLI is available and owner logged in.
try{execFileSync('gh',['auth','status'],{stdio:'ignore'});}catch{throw new Error('Install free GitHub CLI from https://cli.github.com/ then run gh auth login with your REPOSITORY OWNER account; retry setup.');}
if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)throw new Error('GH_TOKEN/GITHUB_TOKEN overrides local browser sign-in. Remove it first; no Gmail authorization attempted.');
// Verify project safety controls BEFORE Google consent or secret provisioning.
const ghApi=(endpoint)=>{
 const r=spawnSync('gh',['api',endpoint],{encoding:'utf8'});
 if(r.status!==0)throw new Error('Repository protections not readable. Configure the manual environment and solo main protection before OAuth setup.');
 try{return JSON.parse(r.stdout)}catch{throw new Error('Invalid GitHub protections response')}
};
assertOwner(ghApi('user'),ghApi(`repos/${repo}`));
const listedRulesets=ghApi(`repos/${repo}/rulesets?includes_parents=true`);
if(!Array.isArray(listedRulesets))throw Error('Cannot verify branch rulesets.');
assertSoloMainRuleset(listedRulesets.map(item=>ghApi(`repos/${repo}/rulesets/${item.id}`)));
const manualEnv=ghApi(`repos/${repo}/environments/gb2l-email-send`);
assertManualEnvironment(manualEnv);
assertMainOnlyDeployment(manualEnv,ghApi(`repos/${repo}/environments/gb2l-email-send/deployment-branch-policies?per_page=100`));
const published=ghApi(`repos/${repo}/contents/tools/gb2l-email/public-key.pem?ref=main`);
assertKeyPair(Buffer.from(published.content,'base64').toString('utf8'),privateKey);
const current=ghApi(`repos/${repo}/actions/variables/GB2L_EMAIL_MODE`);
if(current.value!=='disabled')throw Error('Set mode disabled before credential provisioning');
const head=ghApi(`repos/${repo}/git/ref/heads/main`);
const proof=ghApi(`repos/${repo}/actions/workflows/gb2l-email-preflight.yml/runs?head_sha=${head.object.sha}&status=success&event=workflow_dispatch&per_page=100`);
if(!proof.workflow_runs?.some(r=>r.head_sha===head.object.sha&&r.conclusion==='success'&&r.actor?.login==='gitback2life-art'))throw Error('Run no-send preflight on current main before Gmail setup');

const verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const state=randomBytes(24).toString('hex');
const server=createServer();
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
const callback=`http://127.0.0.1:${server.address().port}/`;
const params=new URLSearchParams({client_id:cfg.client_id,redirect_uri:callback,response_type:'code',scope:'openid email https://www.googleapis.com/auth/gmail.send',access_type:'offline',prompt:'consent',code_challenge:challenge,code_challenge_method:'S256',state});
const authorization=`https://accounts.google.com/o/oauth2/v2/auth?${params}`;
console.log('\nOpen this Google link in your browser; sign in ONLY as gitback2life.ai@gmail.com:');
console.log('\n'+authorization+'\n');
console.log('The authorization callback will be processed on THIS COMPUTER ONLY. No paid web server required.');
let timeoutId;
try{
 const code=await new Promise((resolve,reject)=>{
   timeoutId=setTimeout(()=>reject(new Error('Google authorization expired; restart setup')),300000);
   server.on('request',(req,res)=>{
     const u=new URL(req.url,callback);
     if(req.method!=='GET'||u.pathname!=='/'||u.searchParams.get('state')!==state){res.writeHead(403).end('Request rejected');return;}
     const err=u.searchParams.get('error');const authCode=u.searchParams.get('code');
     if(err||!authCode){res.writeHead(400).end('Gmail authorization declined');reject(new Error('Google authorization declined'));return;}
     res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end('GitBack2Life authorization received. You may close this browser tab.');resolve(authCode);
   });
 });
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:cfg.client_id,client_secret:cfg.client_secret,redirect_uri:callback,grant_type:'authorization_code',code_verifier:verifier}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Google token exchange failed (HTTP '+response.status+')');
 const token=await response.json();
 assertGmailSendGranted(token); // before identity check and before any GitHub secret is written
 await verifySenderIdentity(token.access_token);
 if(!token.refresh_token)throw new Error('Google did not issue an offline refresh token. Revoke/retry with consent and ensure Gmail send scope.');

 const set=(name,value,environment)=>{
   const r=spawnSync('gh',['secret','set',name,'--env',environment,'--repo',repo],{input:value,encoding:'utf8',stdio:['pipe','pipe','pipe']});
   if(r.status!==0)throw new Error('Could not securely add GitHub environment secret '+name+'. Confirm the environment exists and your GitHub account has permission.');
 };
 for(const environment of ['gb2l-email-send']){
   set('GMAIL_CLIENT_ID',cfg.client_id,environment);
   set('GMAIL_CLIENT_SECRET',cfg.client_secret,environment);
   set('GMAIL_REFRESH_TOKEN',token.refresh_token,environment);
   set('GB2L_MAIL_PRIVATE_KEY',privateKey,environment);
 }
 const policy={version:1,mode:'approval_required',owner:'gitback2life-art',requester:'gitback2life-art',sender:'gitback2life.ai@gmail.com',daily_limit:10};
 set('GB2L_EMAIL_POLICY',JSON.stringify(policy),'gb2l-email-send');
 // Auto policy is NOT enabled at setup. The owner must separately configure and
 // enable it through owner-mode.mjs after branch/environment protections are checked.
 const setVar=(name,value)=>{
   const r=spawnSync('gh',['variable','set',name,'--repo',repo],{input:value,encoding:'utf8',stdio:['pipe','pipe','pipe']});
   if(r.status!==0)throw new Error('Could not set owner repository variable '+name);
 };
 // Deliberately leave disabled until explicit owner mode selection after setup.
 setVar('GB2L_REQUEST_ACTOR','gitback2life-art');
 console.log('Manual environment credentials provisioned. Mode remains disabled; no email was sent.');
 console.log('After reviewing setup, owner-mode.mjs approval_required enables the owner deployment approval path.');

}finally{if(timeoutId)clearTimeout(timeoutId);server.close();}
