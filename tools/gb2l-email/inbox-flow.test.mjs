import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {sealInboxRequest,unsealInboxRequest,encodeInboxComment,decodeInboxComment,
  validateOwnerInboxEvent,signInboxResponse,verifyInboxResponse,
  encodeInboxResponse,decodeInboxResponse} from './inbox-transport.mjs';
import {encryptInboxReturn,decryptInboxReturn} from './receive.mjs';
import {assertInboxPrivateKeyMatches,boundInboxResult,runInboxRequest} from './inbox-run.mjs';
const key=()=>generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const server=key(),receiver=key();
const requestId='a'.repeat(32);
const filter={from:'somebody@example.org',after:'2026-10-20',limit:2};
const make=()=>sealInboxRequest({...filter,return_public_key:receiver.publicKey,request_id:requestId},server.publicKey);
const event=(body=encodeInboxComment(make()))=>({action:'created',issue:{number:35,state:'open',pull_request:{url:'https://api.github.com/repos/.../pulls/35'}},comment:{id:88,user:{login:'gitback2life-art'},body}});
const env={GITHUB_REPOSITORY:'gitback2life-art/gitback2life',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'issue_comment',GITHUB_ACTOR:'gitback2life-art',GB2L_INBOX_ENABLED:'true',GB2L_INBOX_ACTOR:'gitback2life-art',GB2L_INBOX_REQUEST_PR:'35',GITHUB_TOKEN:'test-github',GB2L_INBOX_REQUEST_PRIVATE_KEY:server.privateKey,GMAIL_INBOX_CLIENT_ID:'test-client',GMAIL_INBOX_CLIENT_SECRET:'secret-not-logged',GMAIL_INBOX_REFRESH_TOKEN:'refresh-not-logged',GITHUB_SHA:'f'.repeat(40)};
const reply=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
const marker='SYNTHETIC-INBOX-TEST-314159';
const msg={id:'msg01',threadId:'thread01',payload:{headers:[{name:'From',value:filter.from},{name:'Subject',value:'Test reply'},{name:'Date',value:'Fri, 23 Oct 2026 21:00:00 +0000'}],mimeType:'text/plain',body:{data:Buffer.from(marker).toString('base64url')}}};
function mock(calls,{scope=true,returnList=true}={}){
 return async (url,opts={})=>{
  const parsed=new URL(url);calls.push({url,method:opts.method||'GET',body:opts.body});
  if(url.includes('/environments/gb2l-inbox-read'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}],deployment_branch_policy:{protected_branches:true}});
  if(url==='https://oauth2.googleapis.com/token')return reply(200,{access_token:'private-access-token'});
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return reply(200,{email:'gitback2life.ai@gmail.com',email_verified:true});
  if(url.includes('/git/refs'))return reply(201,{});
  if(url==='https://oauth2.googleapis.com/tokeninfo')return reply(200,{aud:env.GMAIL_INBOX_CLIENT_ID,scope:scope?'openid email https://www.googleapis.com/auth/gmail.readonly':'openid email'});
  if(parsed.pathname==='/gmail/v1/users/me/messages')return reply(200,{messages:returnList?[{id:'msg01'}]:[]});
  if(parsed.pathname==='/gmail/v1/users/me/messages/msg01')return reply(200,msg);
  if(url.endsWith('/issues/35/comments'))return reply(201,{id:1234});
  throw Error('Unexpected endpoint '+url);
 };
}
test('inbox reader requires a real matching RSA private key',()=>{
 assert.equal(assertInboxPrivateKeyMatches(server.privateKey,server.publicKey),true);
 assert.throws(()=>assertInboxPrivateKeyMatches(server.publicKey,server.publicKey),/INBOX_PRIVATE_KEY_INVALID/);
 assert.throws(()=>assertInboxPrivateKeyMatches(receiver.privateKey,server.publicKey),/INBOX_PRIVATE_KEY_MISMATCH/);
});
test('encrypted query hides sender and is bound to ephemeral return key',()=>{
 const e=make(),encoded=encodeInboxComment(e);
 assert.ok(!encoded.includes(filter.from));
 assert.deepEqual(unsealInboxRequest(decodeInboxComment(encoded),server.privateKey).filter,filter);
 const altered={...e,data:'AAAA'+e.data.slice(4)};
 assert.throws(()=>unsealInboxRequest(altered,server.privateKey),/INBOX_DECRYPTION_FAILED/);
});
test('rejects untrusted actors, other channels, wrong issue/PR kind, disabled mode and reruns',()=>{
 const variants=[{...env,GITHUB_ACTOR:'attacker'},{...env,GB2L_INBOX_ENABLED:'false'},{...env,GB2L_INBOX_REQUEST_PR:'36'},{...env,GITHUB_RUN_ATTEMPT:'2'}];
 for(const bad of variants)assert.throws(()=>validateOwnerInboxEvent(event(),bad));
 assert.throws(()=>validateOwnerInboxEvent({...event(),issue:{number:35,state:'open'}},env));
 assert.throws(()=>validateOwnerInboxEvent({...event(),comment:{...event().comment,user:{login:'attacker'}}},env));
});
test('signed response can be decrypted only by designated recipient; forged/tampered responses rejected',()=>{
 const result={status:'found',messages:[{body_text:marker,trust:'untrusted_email_content'}]};
 const signed=signInboxResponse(encryptInboxReturn(result,receiver.publicKey,requestId),server.privateKey);
 const wire=encodeInboxResponse(signed),back=decodeInboxResponse(wire);
 assert.equal(verifyInboxResponse(back,server.publicKey),true);
 assert.equal(decryptInboxReturn(back,receiver.privateKey).messages[0].body_text,marker);
 assert.throws(()=>verifyInboxResponse({...back,data:'AAAA'+back.data.slice(4)},server.publicKey),/UNTRUSTED_INBOX_RESPONSE/);
 assert.throws(()=>decryptInboxReturn(back,key().privateKey));
 assert.throws(()=>verifyInboxResponse(back,key().publicKey));
});
test('inbox response enforces bounded result size',()=>{
 const b=boundInboxResult({status:'found',messages:[{body_text:'x'.repeat(40000),body_truncated:false}]});
 assert.equal(b.messages[0].body_text.length,6500);assert.equal(b.messages[0].body_truncated,true);
});
test('mocked owner-approved workflow posts ciphertext only and never calls send',async()=>{
 const calls=[];let resultComment;
 const http=async(url,opts)=>{
   const r=await mock(calls)(url,opts);
   if(url.endsWith('/issues/35/comments'))resultComment=JSON.parse(opts.body).body;
   return r;
 };
 const result=await runInboxRequest({event:event(),env,http,inboxPublishedPublicKey:server.publicKey});
 assert.equal(result.status,'encrypted_return_posted');
 assert.ok(resultComment.startsWith('GB2L_INBOX_RESULT_V1:'));
 assert.ok(!resultComment.includes(marker));assert.ok(!resultComment.includes(filter.from));
 const signed=decodeInboxResponse(resultComment);verifyInboxResponse(signed,server.publicKey);
 const decrypted=decryptInboxReturn(signed,receiver.privateKey);
 assert.equal(decrypted.status,'found');assert.equal(decrypted.messages[0].body_text,marker);
 assert.equal(calls.filter(x=>x.url.includes('gmail.googleapis.com')).length,2);
 assert.equal(calls.filter(x=>x.url.includes('/messages/send')).length,0);
});
test('missing read scope returns encrypted error; no email content exposed',async()=>{
 const calls=[];let response;
 const http=async(url,opts)=>{
  const r=await mock(calls,{scope:false})(url,opts);
  if(url.endsWith('/issues/35/comments'))response=JSON.parse(opts.body).body;
  return r;
 };
 const outcome=await runInboxRequest({event:event(),env,http,inboxPublishedPublicKey:server.publicKey});
 assert.equal(outcome.status,'private_error_returned');
 const e=decodeInboxResponse(response);verifyInboxResponse(e,server.publicKey);
 assert.equal(decryptInboxReturn(e,receiver.privateKey).error_code,'INBOX_SCOPE_MISSING');
 assert.equal(calls.some(x=>x.url.includes('gmail.googleapis.com')),false);
});
test('missing environment owner review fails before Google',async()=>{
 let calls=[];
 const http=async(url)=>{calls.push(url);return reply(200,{protection_rules:[],deployment_branch_policy:{protected_branches:true}})};
 await assert.rejects(runInboxRequest({event:event(),env,http,inboxPublishedPublicKey:server.publicKey}),/INBOX_OWNER_APPROVAL_NOT_CONFIGURED/);
 assert.equal(calls.length,1);
});
test('duplicate reservation prevents inbox read',async()=>{
 let calls=[];
 const http=async(url,opts)=>{calls.push(url);if(url.includes('/git/refs'))return reply(422,{});return mock([])(url,opts)};
 await assert.rejects(runInboxRequest({event:event(),env,http,inboxPublishedPublicKey:server.publicKey}),/INBOX_REQUEST_ALREADY_USED/);
 assert.equal(calls.some(u=>u.includes('gmail.googleapis.com')),false);
});

const pythonAvailable=spawnSync(process.env.PYTHON||'python3',['-c','import cryptography'],{stdio:'ignore'}).status===0;
test('Python assistant ephemeral key survives connector-style exchange and decrypts signed synthetic reply',{skip:!pythonAvailable},async()=>{
 const python=process.env.PYTHON||'python3';
 const script=`import os,sys,json,base64\nfrom assistant_inbox_session import InboxSession\npub=base64.b64decode(os.environ['INBOX_TEST_PUB']).decode()\ns=InboxSession()\nprint(s.prepare_request(pub,from_address='somebody@example.org',after='2026-10-20',limit=2),flush=True)\nreply=sys.stdin.readline().strip()\nr=s.read_response(reply,pub)\nprint(json.dumps({'status':r['status'],'marker':r['messages'][0]['body_text']}),flush=True)\n`;
 const child=spawn(python,['-c',script],{cwd:new URL('.',import.meta.url).pathname,env:{...process.env,INBOX_TEST_PUB:Buffer.from(server.publicKey).toString('base64')},stdio:['pipe','pipe','pipe']});
 const rl=createInterface({input:child.stdout});
 let resolveLine;let nextLine=new Promise(resolve=>resolveLine=resolve);
 rl.on('line',line=>{resolveLine(line);nextLine=new Promise(resolve=>resolveLine=resolve)});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString()});
 const timeout=ms=>new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Python response timeout: '+stderr)),ms);t.unref();});
 try{
  const requestComment=await Promise.race([nextLine,timeout(30000)]);
  assert.ok(requestComment.startsWith('GB2L_INBOX_V1:'));
  assert.ok(!requestComment.includes(filter.from));
  const parsed=unsealInboxRequest(decodeInboxComment(requestComment),server.privateKey);
  assert.equal(parsed.filter.from,filter.from);
  const signed=signInboxResponse(encryptInboxReturn({status:'found',messages:[{body_text:marker}]},parsed.return_public_key,parsed.request_id),server.privateKey);
  child.stdin.write(encodeInboxResponse(signed)+'\n');
  const result=JSON.parse(await Promise.race([nextLine,timeout(30000)]));
  assert.deepEqual(result,{status:'found',marker});
 }finally{child.stdin.end();child.kill();rl.close();}
});

test('Python assistant defaults to a bounded all-senders inbox request', {skip:!pythonAvailable},()=>{
 const python=process.env.PYTHON||'python3';
 const script=[
  "import os,base64",
  "from assistant_inbox_session import InboxSession",
  "pub=base64.b64decode(os.environ['INBOX_TEST_PUB']).decode()",
  "s=InboxSession()",
  "print(s.prepare_request(pub),flush=True)"
 ].join('\n');
 const run=spawnSync(python,['-c',script],{cwd:new URL('.',import.meta.url).pathname,env:{...process.env,INBOX_TEST_PUB:Buffer.from(server.publicKey).toString('base64')},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const wire=run.stdout.trim();
 assert.ok(wire.startsWith('GB2L_INBOX_V1:'));
 const parsed=unsealInboxRequest(decodeInboxComment(wire),server.privateKey);
 assert.equal(parsed.filter.from,undefined);
 assert.equal(parsed.filter.after,undefined);
 assert.equal(parsed.filter.limit,5);
});
test('custom environment branch allowlist must contain exactly main',async()=>{
 const http=async url=>{
  if(url.endsWith('/environments/gb2l-inbox-read'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}],deployment_branch_policy:{custom_branch_policies:true}});
  if(url.includes('/deployment-branch-policies'))return reply(200,{branch_policies:[{name:'preview',type:'branch'}]});
  throw Error('Unexpected URL');
 };
 const {assertInboxEnvironment}=await import('./inbox-run.mjs');
 await assert.rejects(assertInboxEnvironment('token',http),/INBOX_BRANCH_POLICY_MISSING/);
});
