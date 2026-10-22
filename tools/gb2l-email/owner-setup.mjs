#!/usr/bin/env node
// One-time owner-only setup. Use outside public AI chat. Never records refresh tokens on disk.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
const idx=args.indexOf('--credentials');
const filename=idx>=0?args[idx+1]:null;
const ri=args.indexOf('--repo');const repo=ri>=0?args[ri+1]:'gitback2life-art/gitback2life';
if(!filename||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw new Error('Usage: node tools/gb2l-email/owner-setup.mjs --credentials C:\\path\\client_secret.json --repo owner/repo');
const cfg=JSON.parse(readFileSync(filename,'utf8')).installed;
if(!cfg||typeof cfg.client_id!=='string'||typeof cfg.client_secret!=='string')throw new Error('Only Google Desktop OAuth JSON supported. No credentials imported.');
// This preflight MUST run before touching any GitHub secret, token, or mode setting.
const publicKeyPath=new URL('./public-key.pem',import.meta.url);
if(existsSync(publicKeyPath))throw new Error('Existing public-key.pem found. Refusing to rotate GitHub private-key secrets or modify mode during setup rerun. Use a separately reviewed key-rotation procedure.');
// Refuse to proceed unless GitHub's official CLI is available and owner logged in.
try{execFileSync('gh',['auth','status'],{stdio:'ignore'});}catch{throw new Error('Install free GitHub CLI from https://cli.github.com/ then run gh auth login with your REPOSITORY OWNER account; retry setup.');}
const status=spawnSync('gh',['repo','view',repo,'--json','viewerPermission','--jq','.viewerPermission'],{encoding:'utf8'});
if(status.status!==0||status.stdout.trim()!=='ADMIN')throw new Error('GitHub CLI must be authenticated as a repo administrator / maintainer.');
// Verify project safety controls BEFORE Google consent or secret provisioning.
const ghApi=(endpoint)=>{
 const r=spawnSync('gh',['api',endpoint],{encoding:'utf8'});
 if(r.status!==0)throw new Error('Repository protections not readable. Configure both GitHub environments and protect main before OAuth setup.');
 try{return JSON.parse(r.stdout)}catch{throw new Error('Invalid GitHub protections response')}
};
const branch=ghApi(`repos/${repo}/branches/main/protection`);
if(!branch?.required_pull_request_reviews?.require_code_owner_reviews || !(branch.required_pull_request_reviews.required_approving_review_count>=1))throw new Error('Main branch must require CODEOWNER approval before provisioning email secrets.');
const manualEnv=ghApi(`repos/${repo}/environments/gb2l-email-send`);
if(!manualEnv.protection_rules?.some(x=>x.type==='required_reviewers'&&x.reviewers?.some(y=>y.reviewer?.login==='gitback2life-art')))throw new Error('gb2l-email-send must require GitBack2Life owner review.');
const autoEnv=ghApi(`repos/${repo}/environments/gb2l-email-auto`);
if(autoEnv.protection_rules?.some(x=>x.type==='required_reviewers'))throw new Error('gb2l-email-auto must not inherit a per-message reviewer gate. Keep it disabled using owner-controlled mode settings.');

const verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const state=randomBytes(24).toString('hex');
const server=createServer();
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
const callback=`http://127.0.0.1:${server.address().port}/`;
const params=new URLSearchParams({client_id:cfg.client_id,redirect_uri:callback,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.send',access_type:'offline',prompt:'consent',code_challenge:challenge,code_challenge_method:'S256',state});
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
 if(!token.refresh_token)throw new Error('Google did not issue an offline refresh token. Revoke/retry with consent and ensure Gmail send scope.');
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const set=(name,value,environment)=>{
   const r=spawnSync('gh',['secret','set',name,'--env',environment,'--repo',repo],{input:value,encoding:'utf8',stdio:['pipe','pipe','pipe']});
   if(r.status!==0)throw new Error('Could not securely add GitHub environment secret '+name+'. Confirm the environment exists and your GitHub account has permission.');
 };
 for(const environment of ['gb2l-email-send','gb2l-email-auto']){
   set('GMAIL_CLIENT_ID',cfg.client_id,environment);
   set('GMAIL_CLIENT_SECRET',cfg.client_secret,environment);
   set('GMAIL_REFRESH_TOKEN',token.refresh_token,environment);
   set('GB2L_MAIL_PRIVATE_KEY',privateKey,environment);
 }
 const policy={version:1,mode:'approval_required',owner:'gitback2life-art',requester:'gitback2life-art',sender:'gitback2life.ai@gmail.com',daily_limit:3};
 set('GB2L_EMAIL_POLICY',JSON.stringify(policy),'gb2l-email-send');
 // Auto policy is NOT enabled at setup. The owner must separately configure and
 // enable it through owner-mode.mjs after branch/environment protections are checked.
 const setVar=(name,value)=>{
   const r=spawnSync('gh',['variable','set',name,'--repo',repo],{input:value,encoding:'utf8',stdio:['pipe','pipe','pipe']});
   if(r.status!==0)throw new Error('Could not set owner repository variable '+name);
 };
 setVar('GB2L_EMAIL_MODE','approval_required');
 setVar('GB2L_REQUEST_ACTOR','gitback2life-art');
 writeFileSync(publicKeyPath,publicKey,{flag:'wx'});
 console.log('\nPrivate OAuth information stored as GitHub environment secrets. No refresh token or private key written to disk.');
 console.log('Now ask the AI to commit ONLY tools/gb2l-email/public-key.pem on a reviewable pull request.');
 console.log('Mode: approval_required. Autonomous credentials were staged in the separate gb2l-email-auto environment but autonomous policy is NOT configured and auto sending is disabled.');
 console.log('REQUIRED: Protect main/workflows with code-owner review and configure owner review on gb2l-email-send before using sender.');
 console.log('To enable autonomous mode in the future, use owner-mode.mjs with the owner GitHub account.');
 console.log('Sender configured: gitback2life.ai@gmail.com. First email must be a harmless owner-approved test.');
}finally{if(timeoutId)clearTimeout(timeoutId);server.close();}
