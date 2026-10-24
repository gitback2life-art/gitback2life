#!/usr/bin/env node
// OPTIONAL, explicit future owner action. Never run as part of deployment or CI.
// Separate gmail.readonly authorization: does not overwrite existing gmail.send grant.
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fingerprint} from './inbox-transport.mjs';
import {verifySenderIdentity} from './identity.mjs';
const REPO='gitback2life-art/gitback2life';
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const args=process.argv.slice(2);
function getArg(name){const i=args.indexOf(name);return i===-1?null:args[i+1];}
function fail(code){throw new Error(code);}
const creds=getArg('--credentials'),privatePath=getArg('--private-key');
if(!creds||!privatePath||!args.includes('--owner-authorized-restricted-scope'))
 fail('Usage: node tools/gb2l-email/inbox-owner-setup.mjs --credentials /PRIVATE/client.json --private-key /PRIVATE/inbox.private.pem --owner-authorized-restricted-scope');
if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)fail('Remove GH_TOKEN/GITHUB_TOKEN overrides; use browser-authenticated owner CLI');
const cfg=JSON.parse(readFileSync(creds,'utf8')).installed;
if(typeof cfg?.client_id!=='string'||typeof cfg?.client_secret!=='string')fail('Expected Google Desktop OAuth JSON');
const privatePem=readFileSync(privatePath,'utf8');
const localFingerprint=fingerprint(privatePem);
function gh(args,input){const res=spawnSync('gh',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});if(res.status!==0)fail('GitHub owner permission/configuration check failed; no Google change');return res.stdout.trim();}
if(gh(['api','user','--jq','.login'])!=='gitback2life-art')fail('GitHub CLI is not the GitBack2Life owner');
const pub=JSON.parse(gh(['api',`repos/${REPO}/contents/tools/gb2l-email/inbox-public-key.pem?ref=main`]));
if(fingerprint(Buffer.from(pub.content,'base64').toString())!==localFingerprint)fail('Inbox private key does not match published main inbox public key');
const env=JSON.parse(gh(['api',`repos/${REPO}/environments/gb2l-inbox-read`]));
if(!env.protection_rules?.some(r=>r.type==='required_reviewers'&&r.reviewers?.some(x=>x.reviewer?.login==='gitback2life-art')))
 fail('Configure gb2l-inbox-read with owner-required deployment review first');
const enabled=JSON.parse(gh(['api',`repos/${REPO}/actions/variables/GB2L_INBOX_ENABLED`]));
if(enabled.value!=='false')fail('Disable inbox requests before OAuth setup');
const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(24).toString('hex');
const server=createServer();
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
const redirect=`http://127.0.0.1:${server.address().port}/`;
const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
for(const [k,v] of Object.entries({client_id:cfg.client_id,redirect_uri:redirect,response_type:'code',scope:'openid email '+SCOPE,access_type:'offline',prompt:'consent',code_challenge:challenge,code_challenge_method:'S256',state}))url.searchParams.set(k,v);
console.log('Authorize ONLY gitback2life.ai@gmail.com in your own browser:');console.log(url.href);
let timeout;
try{
 const code=await new Promise((resolve,reject)=>{
  timeout=setTimeout(()=>reject(Error('Google authorization expired')),300000);
  server.on('request',(req,res)=>{
   const u=new URL(req.url,redirect);
   if(req.method!=='GET'||u.pathname!=='/'||u.searchParams.get('state')!==state){res.writeHead(403).end('Rejected');return;}
   if(u.searchParams.get('error')||!u.searchParams.get('code')){res.writeHead(400).end('Not authorized');reject(Error('Authorization declined'));return;}
   res.writeHead(200,{'Content-Type':'text/plain'}).end('GitBack2Life read-only authorization received. You can close this tab.');resolve(u.searchParams.get('code'));
  });
 });
 const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:cfg.client_id,client_secret:cfg.client_secret,redirect_uri:redirect,code,grant_type:'authorization_code',code_verifier:verifier}),signal:AbortSignal.timeout(20000)});
 if(!tokenResponse.ok)fail('Google OAuth exchange failed');
 const token=await tokenResponse.json();
 if(!token.refresh_token||!token.access_token)fail('Google did not issue an offline grant');
 const infoResponse=await fetch('https://oauth2.googleapis.com/tokeninfo',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_token:token.access_token}),signal:AbortSignal.timeout(20000)});
 if(!infoResponse.ok)fail('Unable to inspect Google grant');
 const info=await infoResponse.json();
 const grantedScopes=String(info.scope||'').split(/\s+/).filter(Boolean);
 if(![info.aud,info.azp].includes(cfg.client_id)||!grantedScopes.includes(SCOPE))fail('Read-only Gmail scope/audience not granted');
 const gmailScopes=grantedScopes.filter(s=>s==='https://mail.google.com/'||/^https:\/\/www\.googleapis\.com\/auth\/gmail\./.test(s));
 if(gmailScopes.some(s=>s!==SCOPE))fail('Inbox OAuth grant includes broader Gmail permissions; no secrets written');
 await verifySenderIdentity(token.access_token);
 const secret=(name,value)=>gh(['secret','set',name,'--repo',REPO,'--env','gb2l-inbox-read'],value);
 secret('GMAIL_INBOX_CLIENT_ID',cfg.client_id);
 secret('GMAIL_INBOX_CLIENT_SECRET',cfg.client_secret);
 secret('GMAIL_INBOX_REFRESH_TOKEN',token.refresh_token);
 secret('GB2L_INBOX_REQUEST_PRIVATE_KEY',privatePem);
 console.log('Separate read-only Gmail credentials stored in protected inbox environment.');
 console.log('Inbox requests remain disabled; no Gmail messages were read or sent.');
}finally{if(timeout)clearTimeout(timeout);server.close();}
