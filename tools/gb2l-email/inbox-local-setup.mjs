#!/usr/bin/env node
// Owner-local Gmail OAuth setup. The refresh token remains on this computer.
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {assertOutsideRepository,securePrivateKeyFile} from './prepare-key.mjs';
import {READ_SCOPE,assertInboxScope} from './receive.mjs';
import {fingerprint} from './inbox-transport.mjs';
import {verifySenderIdentity} from './identity.mjs';

const REPO='gitback2life-art/gitback2life';
function arg(args,name){const i=args.indexOf(name);return i<0?null:args[i+1];}
export function localConfigPath(){
  const base=process.env.LOCALAPPDATA||resolve(homedir(),'.config');
  return resolve(base,process.env.LOCALAPPDATA?'GitBack2Life/inbox-oauth.json':'gitback2life/inbox-oauth.json');
}
function openBrowser(url){
  try{
    let child;
    if(process.platform==='win32'){
      child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Process -LiteralPath $env:GB2L_OAUTH_URL'],
        {env:{...process.env,GB2L_OAUTH_URL:url},stdio:'ignore',windowsHide:true});
    }else if(process.platform==='darwin'){
      child=spawn('open',[url],{stdio:'ignore'});
    }else{
      child=spawn('xdg-open',[url],{stdio:'ignore'});
    }
    child.unref();
  }catch{}
}
async function main(args=process.argv.slice(2)){
  if(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true')throw Error('This setup must run locally on the mailbox owner computer, never in CI.');
  const credentials=arg(args,'--credentials');
  const privatePath=resolve(arg(args,'--private-key')||resolve(homedir(),'gb2l.inbox.private.pem'));
  if(!credentials)throw Error('Choose the Google Desktop OAuth JSON file with --credentials.');
  const credentialJson=JSON.parse(readFileSync(resolve(credentials),'utf8'));
  const cfg=credentialJson?.installed;
  if(typeof cfg?.client_id!=='string'||typeof cfg?.client_secret!=='string')throw Error('Expected Google Desktop OAuth client JSON.');
  const repoRoot=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
  const out=localConfigPath();
  assertOutsideRepository(repoRoot,privatePath);
  assertOutsideRepository(repoRoot,out);
  if(!existsSync(privatePath))throw Error('Inbox private key not found at '+privatePath+'. Keep it outside the repository.');
  const privatePem=readFileSync(privatePath,'utf8');
  const publicPem=readFileSync(new URL('./inbox-public-key.pem',import.meta.url),'utf8');
  if(fingerprint(privatePem)!==fingerprint(publicPem))throw Error('Local inbox private key does not match the public key on main.');
  if(existsSync(out))throw Error('Local inbox authorization already exists. No credentials were changed. Config path: '+out);
  mkdirSync(dirname(out),{recursive:true,mode:0o700});
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const state=randomBytes(24).toString('hex');
  const server=createServer();
  await new Promise((resolveListen,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolveListen));
  const redirect='http://127.0.0.1:'+server.address().port+'/';
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({
    client_id:cfg.client_id,redirect_uri:redirect,response_type:'code',
    scope:'openid email '+READ_SCOPE,access_type:'offline',prompt:'consent',
    code_challenge:challenge,code_challenge_method:'S256',state
  }))url.searchParams.set(k,v);
  console.log('Requesting ONLY gmail.readonly for '+REPO+'.');
  console.log('The Google refresh token will be stored locally, not in GitHub Actions.');
  console.log('If Google displays its unverified-app warning, proceed only if you understand this is your own personal-use app.');
  console.log('Opening Google consent in your browser.');
  openBrowser(url.href);
  console.log('If the browser did not open, copy this address into your browser:\n'+url.href);
  let timeout;
  try{
    const code=await new Promise((resolveCode,reject)=>{
      timeout=setTimeout(()=>reject(Error('Google authorization expired. Run setup again if needed.')),300000);
      server.on('request',(req,res)=>{
        const u=new URL(req.url,redirect);
        if(req.method!=='GET'||u.pathname!=='/'||u.searchParams.get('state')!==state){
          res.writeHead(403).end('Rejected');return;
        }
        if(u.searchParams.get('error')||!u.searchParams.get('code')){
          res.writeHead(400).end('Google authorization declined.');reject(Error('Google authorization declined.'));return;
        }
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end('GitBack2Life read-only authorization received. You can close this tab.');
        resolveCode(u.searchParams.get('code'));
      });
    });
    const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:cfg.client_id,client_secret:cfg.client_secret,redirect_uri:redirect,
        code,grant_type:'authorization_code',code_verifier:verifier}),
      signal:AbortSignal.timeout(20000)
    });
    if(!tokenResponse.ok)throw Error('Google token exchange failed; no local credentials were stored.');
    const token=await tokenResponse.json();
    if(typeof token.refresh_token!=='string'||!token.refresh_token||typeof token.access_token!=='string')
      throw Error('Google did not issue an offline read-only grant; no local credentials were stored.');
    const infoResponse=await fetch('https://oauth2.googleapis.com/tokeninfo',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({access_token:token.access_token}),signal:AbortSignal.timeout(20000)
    });
    if(!infoResponse.ok)throw Error('Could not inspect the Google grant; no local credentials were stored.');
    assertInboxScope(await infoResponse.json(),cfg.client_id);
    await verifySenderIdentity(token.access_token);
    writeFileSync(out,'',{flag:'wx',mode:0o600});
    securePrivateKeyFile(out);
    try{
      writeFileSync(out,JSON.stringify({client_id:cfg.client_id,client_secret:cfg.client_secret,
        refresh_token:token.refresh_token,account:'gitback2life.ai@gmail.com'},null,2)+'\n',{flag:'w',mode:0o600});
      securePrivateKeyFile(out);
    }catch(e){throw Error('Could not securely store local inbox credentials. No secret was printed. '+e.message);}
    console.log('Local read-only Gmail authorization saved securely.');
    console.log('Path: '+out);
    console.log('No Gmail messages were read. Nothing was uploaded to GitHub.');
  }finally{
    if(timeout)clearTimeout(timeout);
    server.close();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(e=>{console.error('Local inbox setup refused: '+e.message);process.exitCode=1;});
}
