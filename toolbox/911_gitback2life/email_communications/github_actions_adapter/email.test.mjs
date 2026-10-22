import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {seal,unseal,normalizeDraft} from './crypto.mjs';
import {makeComment,parseComment,envelopeForEvent} from './request.mjs';
import {requestedMode,parsePolicy,assertSendContext,assertMainOnlyDeployment} from './policy.mjs';
import {sendOnce,mimeMessage,verifyEnvironment,reserveAttempt,verifyCurrentOwnerMode,summarizeGoogleError} from './send.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
const draft={to:'rescue@example.org',subject:'Harmless test',body:'A harmless synthetic request',incident_id:'SYNTHETIC'};
const sealed=()=>seal(draft,pair.publicKey);
const repo='gitback2life-art/gitback2life',owner='gitback2life-art';
const manual={version:1,mode:'approval_required',owner,requester:owner,sender:'gitback2life.ai@gmail.com',daily_limit:3};
const auto={...manual,mode:'auto_send',daily_limit:2};
const gh={repo,sha:'a'.repeat(40),githubToken:'synthetic-test-token'};
const oauth={clientId:'x',clientSecret:'y',refreshToken:'z'};
const response=(status,obj)=>({status,ok:status>=200&&status<300,json:async()=>obj});
function stub({mode='approval_required',liveMode=mode,used=[],gmailStatus=200,gmailError=null,timeout=false,envReview=(mode==='approval_required'),oauthStatus=200,branch='main',branchTotal=1}={}){
  const seen=[];
  const req=async(url,opts={})=>{
    seen.push({url,method:opts.method||'GET'});
    if(url.includes('/deployment-branch-policies'))return response(200,{total_count:branchTotal,branch_policies:[{name:branch,type:'branch'}]});
    if(url.includes('/environments/'))return response(200,{can_admins_bypass:false,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:envReview?[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:owner}}]}]:[]});
    if(url.includes('/actions/variables/GB2L_EMAIL_MODE'))return response(200,{value:liveMode});
    if(url.includes('openidconnect.googleapis.com'))return response(200,{email:'gitback2life.ai@gmail.com',email_verified:true});
    if(url.includes('oauth2.googleapis.com'))return response(oauthStatus,{access_token:'mock-access'});
    if(url.includes('/matching-refs/'))return response(200,used.map(ref=>({ref})));
    if(url.endsWith('/git/refs'))return response(201,{});
    if(url.includes('gmail.googleapis.com')){if(timeout)throw Error('network lost');return response(gmailStatus,gmailError??{id:'gmail-test-id'});}
    throw Error('Unexpected HTTP call '+url);
  };
  return {seen,req};
}
const run=async(s,{mode='approval_required',p=mode==='auto_send'?auto:manual,...opts}={})=>sendOnce({envelope:sealed(),privateKey:pair.privateKey,oauth,github:gh,mode,policy:JSON.stringify(p),requestActor:owner,request:s.req,now:()=>new Date('2026-10-22T00:00:00Z'),...opts});
test('sealed email contains no plaintext message or recipient',()=>{const e=sealed();assert.deepEqual(unseal(e,pair.privateKey),{id:e.id,...draft});assert.ok(!JSON.stringify(e).includes('rescue@example.org'));});
test('comment round trip is ciphertext only',()=>{const x=sealed();const comment=makeComment(x);assert.deepEqual(parseComment(comment),x);assert.ok(!comment.includes(draft.subject));});
test('comment cannot be arbitrary plaintext',()=>{assert.throws(()=>parseComment('Please send mail!'));});
test('unsafe recipient and header injection rejected',()=>{for(const d of [{...draft,to:'x@x\nBcc: bad'},{...draft,subject:'X\rBcc: bad'},{...draft,body:''}])assert.throws(()=>normalizeDraft(d));});
test('default is manual approval and unknown modes fail closed',()=>{assert.equal(requestedMode(''),'approval_required');assert.throws(()=>requestedMode('autonomous'));});
test('public or untrusted comment cannot trigger send',()=>{
 const comment=makeComment(sealed());
 const base={action:'created',issue:{number:17,pull_request:{url:'https://x'}},comment:{body:comment,user:{login:'random'}},sender:{login:'random'}};
 const common={eventName:'issue_comment',event:base,actor:owner,requestPr:'17',repo};
 assert.throws(()=>envelopeForEvent(common),/Untrusted/);
 assert.throws(()=>envelopeForEvent({...common,event:{...base,sender:{login:owner}}}),/Untrusted/);
 assert.throws(()=>envelopeForEvent({...common,event:{...base,issue:{number:17}}}),/designated/);
});
test('trusted owner comment is accepted only for designated PR',()=>{
 const comment=makeComment(sealed());const event={action:'created',issue:{number:17,pull_request:{}},comment:{body:comment,user:{login:owner}},sender:{login:owner}};
 assert.throws(()=>envelopeForEvent({eventName:'issue_comment',event,actor:owner,requestPr:'18',repo}),/designated/);
 assert.equal(envelopeForEvent({eventName:'issue_comment',event,actor:owner,requestPr:'17',repo}).transport,'owner_comment');
});
test('changing a repository file or issue cannot enable mode by itself',()=>{
 assert.throws(()=>assertSendContext({mode:'auto_send',actor:owner,policy:JSON.stringify(manual),recipient:draft.to}),/mismatch/);
 assert.throws(()=>parsePolicy('', 'auto_send',owner));
 assert.throws(()=>assertSendContext({mode:'disabled',actor:owner,policy:JSON.stringify(auto),recipient:draft.to}),/Emergency stop/);
});
test('wrong actor, owner or sender rejected even when sealed content valid',()=>{
 for(const p of [{...auto,requester:'attacker'},{...auto,owner:'attacker'},{...auto,sender:'attacker@example.org'}])assert.throws(()=>parsePolicy(JSON.stringify(p),'auto_send',owner));
});
test('domain and recipient restrictions enforce owner scope',()=>{
 assert.throws(()=>assertSendContext({mode:'auto_send',actor:owner,policy:JSON.stringify({...auto,domains:['restricted.example']}),recipient:draft.to}),/domain/);
 assert.throws(()=>assertSendContext({mode:'auto_send',actor:owner,policy:JSON.stringify({...auto,recipients:['other@example.org']}),recipient:draft.to}),/Recipient/);
 assert.ok(assertSendContext({mode:'auto_send',actor:owner,policy:JSON.stringify({...auto,domains:['example.org']}),recipient:draft.to}));
});
test('both modes produce correct MIME sender and single recipient',()=>{const m=mimeMessage({id:'a'.repeat(32),...draft});assert.match(m,/From: gitback2life.ai@gmail.com/);assert.match(m,/To: rescue@example.org/);assert.doesNotMatch(m,/Bcc:/);});
test('approval_required uses genuine required-reviewer environment before Gmail',async()=>{const s=stub();const r=await run(s);assert.equal(r.status,'provider_accepted');assert.ok(s.seen.some(x=>x.url.includes('/gb2l-email-send')));assert.equal(s.seen.filter(x=>x.url.includes('gmail.googleapis.com')).length,1);});
test('approval_required rejects missing owner review gate',async()=>{const s=stub({envReview:false});await assert.rejects(run(s),/approval gate/);assert.ok(!s.seen.some(x=>x.url.includes('gmail.googleapis.com')));});
test('auto_send reaches Gmail WITHOUT required-reviewer gate when owner policy enabled',async()=>{const s=stub({mode:'auto_send'});const r=await run(s,{mode:'auto_send'});assert.equal(r.status,'provider_accepted');assert.ok(s.seen.some(x=>x.url.includes('/gb2l-email-auto')));assert.equal(s.seen.filter(x=>x.url.includes('gmail.googleapis.com')).length,1);});
test('auto_send refuses environment misconfigured with mandatory reviewer',async()=>{const s=stub({mode:'auto_send',envReview:true});await assert.rejects(run(s,{mode:'auto_send'}),/per-message review gate/);assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);});
test('daily quota exhaustion fails before email',async()=>{const s=stub({mode:'auto_send',used:['refs/tags/gb2l-email-attempt-20261022-'+'a'.repeat(32),'refs/tags/gb2l-email-attempt-20261022-'+'b'.repeat(32)]});await assert.rejects(run(s,{mode:'auto_send'}),/quota exhausted/);assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);});
test('a duplicate cannot be re-sent',async()=>{const env=sealed();const s=stub({mode:'auto_send',used:[`refs/tags/gb2l-email-attempt-20261022-${env.id}`]});await assert.rejects(sendOnce({envelope:env,privateKey:pair.privateKey,oauth,github:gh,mode:'auto_send',policy:JSON.stringify(auto),requestActor:owner,request:s.req,now:()=>new Date('2026-10-22T00:00:00Z')}),/already reserved/);assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);});
test('Gmail timeout after reservation is uncertain and never automatically retried',async()=>{const s=stub({mode:'auto_send',timeout:true});const result=await run(s,{mode:'auto_send'});assert.equal(result.status,'uncertain_delivery');assert.equal(s.seen.filter(x=>x.url.includes('gmail.googleapis.com')).length,1);assert.equal(s.seen.filter(x=>x.url.endsWith('/git/refs')).length,1);});
test('Gmail 403 reports safe Google error fields without exposing emails or tokens',async()=>{
 const s=stub({gmailStatus:403,gmailError:{error:{code:403,status:'PERMISSION_DENIED',message:'Request rejected for test.user@example.org Bearer ya29.private-token GOCSPX-private-secret',errors:[{domain:'global',reason:'insufficientPermissions'}]}}});
 const r=await run(s);
 assert.equal(r.status,'uncertain_delivery');
 assert.match(r.note,/Gmail HTTP 403/);
 assert.match(r.note,/reason=insufficientPermissions/);
 assert.match(r.note,/domain=global/);
 assert.match(r.note,/status=PERMISSION_DENIED/);
 assert.match(r.note,/\[email redacted\]/);
 assert.doesNotMatch(r.note,/test.user@example.org|ya29.private-token|GOCSPX-private-secret/);
 assert.match(r.note,/no automatic retry/);
});
test('Google diagnostic summary refuses arbitrary fields and redacts sensitive strings',()=>{
 const details=summarizeGoogleError({error:{status:'PERMISSION_DENIED',message:'Denied to test.user@example.org; Bearer ya29.secret; GOCSPX-secret',errors:[{domain:'global',reason:'accessNotConfigured'}],refreshToken:'do-not-log'}});
 assert.match(details,/reason=accessNotConfigured/);
 assert.match(details,/\[email redacted\]/);
 assert.doesNotMatch(details,/test.user@example.org|ya29.secret|GOCSPX-secret|do-not-log|refreshToken/);
});
test('OAuth failure never reserves an attempt',async()=>{const s=stub({oauthStatus:401});await assert.rejects(run(s),/authorization unavailable/);assert.ok(!s.seen.some(x=>x.url.endsWith('/git/refs')));});
test('GitHub environment API error fails closed',async()=>{const s={seen:[],req:async()=>response(403,{})};await assert.rejects(run(s),/Cannot verify GitHub sending environment/);});
test('GitHub reservation 422 fails closed',async()=>{const s=stub();const old=s.req;s.req=async(url,opts)=>url.endsWith('/git/refs')?response(422,{}):old(url,opts);await assert.rejects(run(s),/already reserved/);});
test('config set to manual again blocks auto environment policy',()=>assert.throws(()=>assertSendContext({mode:'approval_required',actor:owner,policy:JSON.stringify(auto),recipient:draft.to}),/mismatch/));

test('public commitment resists offline guesses without private 256-bit nonce',()=>{
 const x=sealed(),y=seal(draft,pair.publicKey,x.id);
 assert.notEqual(x.commitment,y.commitment,'same predictable message and ID cannot produce same public commitment');
 assert.match(x.private_receipt.commitment_nonce,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(x).includes(x.private_receipt.commitment_nonce));
 assert.ok(!makeComment(x).includes(x.private_receipt.commitment_nonce));
 assert.equal(x.schema,'gb2l-email-sealed-v2');
 assert.throws(()=>parseComment('GB2L_EMAIL_V1:'+Buffer.from(JSON.stringify({...x,schema:'gb2l-email-sealed-v1'})).toString('base64url')),/Invalid/);
});
test('tampered nonce or substituted commitment fails even after decryption',()=>{
 const x=sealed();const y=sealed();
 assert.throws(()=>unseal({...x,commitment:y.commitment},pair.privateKey),/Commitment mismatch/);
});
test('autonomous only-main deployment policy rejects wildcard, tags, and protected-all',()=>{
 const cfg={deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}};
 assert.equal(assertMainOnlyDeployment(cfg,{total_count:1,branch_policies:[{name:'main',type:'branch'}]}),true);
 for(const name of ['main*','releases/*','develop'])assert.throws(()=>assertMainOnlyDeployment(cfg,{total_count:1,branch_policies:[{name,type:'branch'}]}));
 assert.throws(()=>assertMainOnlyDeployment(cfg,{total_count:2,branch_policies:[{name:'main'},{name:'dev'}]}));
 assert.throws(()=>assertMainOnlyDeployment(cfg,{total_count:1,branch_policies:[{name:'main',type:'tag'}]}));
 assert.throws(()=>assertMainOnlyDeployment({deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}},{total_count:1,branch_policies:[{name:'main'}]}));
});
test('autonomous environment fails closed when branch rule is not precisely main',async()=>{
 const s=stub({mode:'auto_send',branch:'feature/*'});
 await assert.rejects(run(s,{mode:'auto_send'}),/main only/);
 assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);
});
test('owner mode changed to disabled while job runs stops before Gmail',async()=>{
 const s=stub({mode:'auto_send',liveMode:'disabled'});
 await assert.rejects(run(s,{mode:'auto_send'}),/changed or disabled/);
 assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);
});
test('owner mode query failure blocks send closed',async()=>{
 const s=stub({mode:'auto_send'}),base=s.req;
 s.req=(u,o)=>u.includes('/actions/variables/GB2L_EMAIL_MODE')?response(403,{}):base(u,o);
 await assert.rejects(run(s,{mode:'auto_send'}),/Cannot read current owner email mode/);
});
test('quota scans every item in unpaginated matching-refs response',async()=>{
 const used=Array.from({length:100},(_,i)=>`refs/tags/gb2l-email-attempt-20261001-${i.toString(16).padStart(32,'0')}`);
 used.push('refs/tags/gb2l-email-attempt-20261022-'+'e'.repeat(32),'refs/tags/gb2l-email-attempt-20261022-'+'f'.repeat(32));
 const s=stub({mode:'auto_send',used});
 await assert.rejects(run(s,{mode:'auto_send'}),/quota exhausted/);
 const calls=s.seen.filter(x=>x.url.includes('/matching-refs/'));
 assert.equal(calls.length,1);assert.ok(!calls[0].url.includes('?'));
 assert.equal(s.seen.some(x=>x.url.includes('gmail.googleapis.com')),false);
});

test('actual inspection script can process a trusted encrypted GitHub comment without plaintext leak',async()=>{
 const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'gb2l-mail-test-'));
 try{
  const envelope=sealed();const event={action:'created',issue:{number:17,pull_request:{}},comment:{body:makeComment(envelope),user:{login:owner}},sender:{login:owner}};
  writeFileSync(join(dir,'event.json'),JSON.stringify(event));
  const res=spawnSync(process.execPath,['tools/gb2l-email/inspect.mjs'],{cwd:new URL('../..',import.meta.url),env:{...process.env,GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_EVENT_NAME:'issue_comment',GITHUB_REPOSITORY:repo,GB2L_REQUEST_ACTOR:owner,GB2L_REQUEST_PR:'17',GB2L_EMAIL_MODE:'auto_send',GITHUB_OUTPUT:join(dir,'output'),GITHUB_STEP_SUMMARY:join(dir,'summary')},encoding:'utf8'});
  assert.equal(res.status,0,res.stderr);
  const output=readFileSync(join(dir,'output'),'utf8');
  assert.match(output,/ready=yes/);assert.ok(!output.includes(draft.to));assert.ok(!output.includes(draft.body));
  const decoded=output.match(/envelope=([^\n]+)/)[1];assert.equal(JSON.parse(Buffer.from(decoded,'base64url').toString()).id,envelope.id);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('manual environment also refuses non-main branch policy',async()=>{
 const s=stub({branch:'feature'});await assert.rejects(run(s),/main only/);
 assert.ok(!s.seen.some(x=>x.url.includes('oauth2.googleapis.com')));
});
test('ledger 404 fails closed rather than assuming no previous sends',async()=>{
 const s=stub(),base=s.req;s.req=(u,o)=>u.includes('/matching-refs/')?response(404,{}):base(u,o);
 await assert.rejects(run(s),/Cannot check duplicate/);
 assert.ok(!s.seen.some(x=>x.url.includes('gmail.googleapis.com')));
});
test('separate read token is used for current owner settings',async()=>{
 let authorization;
 await verifyCurrentOwnerMode({...gh,controlToken:'read-only-settings'},'disabled',async(u,o)=>{authorization=o.headers.Authorization;return response(200,{value:'disabled'});});
 assert.equal(authorization,'Bearer read-only-settings');
});
test('push authenticates sender, never spoofable pusher name',()=>{
 const envelope=sealed(),path=`mail/outbox/${envelope.id}.sealed.json`;
 const common={eventName:'push',actor:owner,repo,changedFiles:[path],loadFile:()=>JSON.stringify(envelope)};
 assert.throws(()=>envelopeForEvent({...common,event:{ref:'refs/heads/main',pusher:{name:owner},sender:{login:'attacker'}}}),/Untrusted/);
 assert.equal(envelopeForEvent({...common,event:{ref:'refs/heads/main',sender:{login:owner}}}).transport,'main_push');
});
