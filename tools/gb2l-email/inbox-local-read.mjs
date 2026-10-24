#!/usr/bin/env node
// Owner-local inbox request processor. Gmail plaintext is fetched only on this computer.
// GitHub receives a signed encrypted response; no message content is logged or sent to Actions.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {securePrivateKeyFile} from './prepare-key.mjs';
import {localConfigPath} from './inbox-local-setup.mjs';
import {READ_SCOPE,assertInboxScope,readInbox,encryptInboxReturn} from './receive.mjs';
import {refreshAccessToken} from './send.mjs';
import {verifySenderIdentity} from './identity.mjs';
import {fingerprint,decodeInboxComment,decodeInboxResponse,unsealInboxRequest,
  signInboxResponse,encodeInboxResponse,INBOX_REQUEST_PREFIX,INBOX_RESPONSE_PREFIX} from './inbox-transport.mjs';

const REPO='gitback2life-art/gitback2life';
const OWNER='gitback2life-art';
const MAX_COMMENT=62000;
function fail(code){const e=new Error(code);e.code=code;return e;}
function gh(args,input){
  const r=spawnSync('gh',args,{input,encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true});
  if(r.error||r.status!==0)throw fail('GITHUB_CLI_FAILED');
  return r.stdout.trim();
}
function ghJSON(args){try{return JSON.parse(gh(args));}catch(e){if(e.code)throw e;throw fail('GITHUB_RESPONSE_INVALID');}}
function ask(question){
  const rl=createInterface({input:process.stdin,output:process.stdout});
  return new Promise(resolve=>rl.question(question,answer=>{rl.close();resolve(answer.trim());}));
}
function boundedResult(result){
  if(!result||!Array.isArray(result.messages)||result.messages.length>5)throw fail('INVALID_INBOX_RESULT');
  let budget=18000;
  const messages=[];
  for(const m of result.messages){
    const copy={...m};
    const original=Buffer.from(String(m.body_text||''),'utf8');
    const take=Math.min(6500,budget);
    copy.body_text=original.subarray(0,take).toString('utf8').replace(/\uFFFD$/,'');
    copy.body_truncated=Boolean(m.body_truncated)||original.length>take;
    budget=Math.max(0,budget-Buffer.byteLength(copy.body_text,'utf8'));
    messages.push(copy);
  }
  return {...result,messages};
}
function postCiphertext(issueNumber,body){
  if(typeof body!=='string'||body.length>MAX_COMMENT)throw fail('ENCRYPTED_RESULT_TOO_LARGE');
  gh(['api','--method','POST','repos/'+REPO+'/issues/'+issueNumber+'/comments','--input','-'],JSON.stringify({body}));
}
function reserve(id,sha){
  const input=JSON.stringify({ref:'refs/tags/gb2l-inbox-attempt-'+id,sha});
  try{gh(['api','--method','POST','repos/'+REPO+'/git/refs','--input','-'],input);}
  catch{throw fail('REQUEST_ALREADY_RESERVED_OR_GITHUB_REF_WRITE_FAILED');}
}
function statusCode(e){
  return typeof e?.code==='string'&&/^[A-Z0-9_]{3,64}$/.test(e.code)?e.code:'LOCAL_INBOX_READ_FAILED';
}
async function main(args=process.argv.slice(2)){
  if(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true')throw fail('LOCAL_ONLY_SCRIPT');
  const privatePath=resolve(args[args.indexOf('--private-key')+1]||resolve(homedir(),'gb2l.inbox.private.pem'));
  const configPath=localConfigPath();
  if(!existsSync(privatePath))throw fail('LOCAL_INBOX_PRIVATE_KEY_MISSING');
  if(!existsSync(configPath))throw fail('LOCAL_INBOX_AUTH_MISSING_RUN_SETUP_FIRST');
  securePrivateKeyFile(privatePath);
  securePrivateKeyFile(configPath);
  const privatePem=readFileSync(privatePath,'utf8');
  const publishedPem=readFileSync(new URL('./inbox-public-key.pem',import.meta.url),'utf8');
  if(fingerprint(privatePem)!==fingerprint(publishedPem))throw fail('LOCAL_INBOX_KEY_MISMATCH');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  if(typeof config.client_id!=='string'||typeof config.client_secret!=='string'||typeof config.refresh_token!=='string'||config.account!=='gitback2life.ai@gmail.com')
    throw fail('LOCAL_INBOX_AUTH_INVALID');
  const login=gh(['api','user','--jq','.login']);
  if(login!==OWNER)throw fail('GITHUB_CLI_WRONG_ACCOUNT');
  const variable=process.env.GB2L_INBOX_REQUEST_PR;
  const issueNumber=variable?Number(variable):41;
  if(!Number.isSafeInteger(issueNumber)||issueNumber<1)throw fail('INBOX_REQUEST_PR_INVALID');
  const raw=gh(['api','--paginate','--slurp','repos/'+REPO+'/issues/'+issueNumber+'/comments?per_page=100']);
  let nested;try{nested=JSON.parse(raw);}catch{throw fail('GITHUB_COMMENTS_INVALID');}
  const comments=Array.isArray(nested)?nested.flat(Infinity):[];
  const answered=new Set();
  for(const c of comments){
    const body=typeof c.body==='string'?c.body:'';
    if(!body.startsWith(INBOX_RESPONSE_PREFIX))continue;
    try{answered.add(decodeInboxResponse(body).request_id);}catch{}
  }
  const seen=new Set();
  const pending=[];
  comments.sort((a,b)=>Date.parse(b.created_at||0)-Date.parse(a.created_at||0));
  for(const c of comments){
    if(c.user?.login!==OWNER||typeof c.body!=='string'||!c.body.startsWith(INBOX_REQUEST_PREFIX))continue;
    try{
      const envelope=decodeInboxComment(c.body);
      if(seen.has(envelope.request_id)||answered.has(envelope.request_id))continue;
      seen.add(envelope.request_id);
      const request=unsealInboxRequest(envelope,privatePem);
      pending.push({envelope,request,commentId:c.id,createdAt:c.created_at});
    }catch{}
  }
  if(!pending.length){
    console.log('No unanswered encrypted inbox request is waiting on PR #'+issueNumber+'.');
    return;
  }
  const selected=pending[0];
  const filter=selected.request.filter;
  console.log('');
  console.log('GitBack2Life inbox request found. Gmail has NOT been read yet.');
  console.log('Sender filter: '+filter.from);
  console.log('Mailbox: inbox only; attachments are not fetched.');
  console.log('Maximum messages: '+filter.limit);
  console.log('Date lower bound: '+(filter.after||'none'));
  console.log('Request ID: '+selected.request.request_id);
  if(pending.length>1)console.log('There are '+pending.length+' unanswered requests; only the newest will be considered. Older requests will not be read.');
  const confirm=await ask('Read these messages locally and post only encrypted results? Type YES to authorize: ');
  if(confirm!=='YES'){
    console.log('Cancelled. No Gmail messages were read.');
    return;
  }
  const token=await refreshAccessToken({clientId:config.client_id,clientSecret:config.client_secret,refreshToken:config.refresh_token});
  await verifySenderIdentity(token);
  const infoResponse=await fetch('https://oauth2.googleapis.com/tokeninfo',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({access_token:token}),signal:AbortSignal.timeout(20000)
  });
  if(!infoResponse.ok)throw fail('OAUTH_SCOPE_CHECK_FAILED');
  assertInboxScope(await infoResponse.json(),config.client_id);
  const mainRef=ghJSON(['api','repos/'+REPO+'/git/ref/heads/main']);
  const sha=mainRef?.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw fail('MAIN_SHA_INVALID');
  reserve(selected.request.request_id,sha);
  let result;
  try{
    result=boundedResult(await readInbox({accessToken:token,clientId:config.client_id,filter,http:fetch}));
  }catch(e){
    result={status:'error',error_code:statusCode(e),messages:[]};
  }
  const encrypted=encryptInboxReturn(result,selected.request.return_public_key,selected.request.request_id);
  const signed=signInboxResponse(encrypted,privatePem);
  const wire=encodeInboxResponse(signed);
  postCiphertext(issueNumber,wire);
  console.log('Encrypted inbox response posted to PR #'+issueNumber+'.');
  console.log('No message text, subject, sender, access token or refresh token was posted or logged.');
  console.log('Response status: '+result.status+'. The active AI session must retrieve and decrypt this response.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(e=>{console.error('Local inbox read stopped: '+(e.code||'LOCAL_INBOX_FAILED'));process.exitCode=1;});
}
