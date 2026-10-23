import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {EncryptedStore,EmailService,oauthAuthorizationUrl,exchangeOAuthCode,OAuthConnection,gmailProvider,SENDER,SEND_SCOPE} from './email_service.mjs';
const specimen={incidentId:'test_001',to:'test-recipient@example.org',subject:'Request for review',
  body:'Direct observation: one public webpage did not load. This does not establish why.',evidenceRefs:['E1']};
function sample({liveEnabled=false,provider,onOutcome}={}){
 const dir=mkdtempSync(join(tmpdir(),'gb2l-email-'));const key=randomBytes(32);
 const store=new EncryptedStore(dir,key);const roles=[];
 const authorize=async query=>{roles.push(query);return ['draft','review','approve','send','connect'].includes(query.role)};
 const service=new EmailService({store,authorize,provider,liveEnabled,onOutcome});
 return {dir,store,service,roles,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('drafts are encrypted; full review includes exact sender, recipient, subject and message',async()=>{
 const x=sample();try{
 const d=await x.service.compose(specimen,'operator');const review=await x.service.review(d.id,'operator');
 assert.deepEqual(review.draft.from,SENDER);assert.equal(review.draft.to,specimen.to);
 assert.equal(review.draft.subject,specimen.subject);assert.equal(review.draft.body,specimen.body);
 const bytes=readFileSync(x.store.file(d.id)).toString('utf8');
 assert.ok(!bytes.includes(specimen.to)&&!bytes.includes(specimen.body));
 assert.match(JSON.stringify(review),/awaiting_approval/);
 }finally{x.close();}
});
test('first release rejects cc bcc, attachments, bulk recipients and header injection',()=>{
 const x=sample();try{
 for(const bad of [{to:'a@b.org,c@d.org'}, {cc:['copied@b.org']}, {bcc:['blind@b.org']},
   {attachments:['file.txt']},{subject:'Hi\r\nBcc: victim@example.org'}, {to:'invalid'}])
   assert.rejects(x.service.compose({...specimen,...bad},'owner'));
 }finally{x.close();}
});
test('no approval, no send; live deployment switch is independent of human approval',async()=>{
 const x=sample({provider:{ready:async()=>{},send:async()=>({id:'x'})}});try{
 const d=await x.service.compose(specimen,'operator');await assert.rejects(x.service.send(d.id,'operator'),/disabled/);
 await x.service.review(d.id,'operator');
 await x.service.approve(d.id,d.digest,'operator');
 await assert.rejects(x.service.send(d.id,'operator'),/disabled/);
 }finally{x.close();}
});
test('editing after approval invalidates it; old digest rejected',async()=>{
 let sends=0;const x=sample({liveEnabled:true,provider:{ready:async()=>{},send:async()=>{sends++;return{id:'message1'};}}});
 try{const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 await x.service.edit(d.id,{subject:'Revised subject'},'operator');
 await assert.rejects(x.service.send(d.id,'operator'),/not approved/);
 await assert.rejects(x.service.approve(d.id,d.digest,'operator'),/changed since review/);
 const r=await x.service.review(d.id,'operator');await x.service.approve(d.id,r.digest,'operator');
 const result=await x.service.send(d.id,'operator');assert.equal(result.status,'sent');assert.equal(sends,1);
 await assert.rejects(x.service.send(d.id,'operator'),/already attempted/);
 }finally{x.close();}
});
test('provider timeout remains uncertain and is never retried automatically',async()=>{
 let calls=0;const outcomes=[];
 const x=sample({liveEnabled:true,provider:{ready:async()=>{},send:async()=>{calls++;throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}},
 onOutcome:async r=>outcomes.push(r)});
 try{const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 const result=await x.service.send(d.id,'operator');assert.equal(result.status,'uncertain_delivery');
 assert.equal(outcomes.length,1);assert.ok(!JSON.stringify(outcomes[0]).includes(specimen.body));
 await assert.rejects(x.service.send(d.id,'operator'));assert.equal(calls,1);
 }finally{x.close();}
});
test('explicit provider refusal gives failed without a retry',async()=>{
 const x=sample({liveEnabled:true,provider:{ready:async()=>{},send:async()=>{throw Object.assign(new Error('rejected'),{code:'PROVIDER_REJECTED'});}}});
 try{const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 assert.equal((await x.service.send(d.id,'operator')).status,'failed');
 await assert.rejects(x.service.send(d.id,'operator'));
 }finally{x.close();}
});
test('unauthorized actor denied for draft, review, approval and send',async()=>{
 const x=sample();x.service.authorize=async({role})=>role==='draft';
 try{const d=await x.service.compose(specimen,'author');
 await assert.rejects(x.service.review(d.id,'intruder'));
 await assert.rejects(x.service.approve(d.id,d.digest,'intruder'));
 await assert.rejects(x.service.send(d.id,'intruder'));
 }finally{x.close();}
});
test('Gmail sender endpoint and Authorization are scoped and raw RFC822 encoded',async()=>{
 let requested;
 const provider=gmailProvider('synthetic-access-token',async(url,options)=>{
   requested={url,options};return {ok:true,json:async()=>({id:'gmail-1'})};
 });
 assert.deepEqual(await provider.send({sender:SENDER,raw:'encoded-message'}),{id:'gmail-1'});
 assert.equal(requested.url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
 assert.equal(requested.options.method,'POST');
 assert.deepEqual(JSON.parse(requested.options.body),{raw:'encoded-message'});
 await assert.rejects(provider.send({sender:'other@example.org',raw:'x'}));
});
test('OAuth requests only gmail.send, PKCE and state; rejects unexpected scope',async()=>{
 const state='S'.repeat(44),challenge='C'.repeat(43);
 const url=oauthAuthorizationUrl({clientId:'test-client',redirectUri:'https://backend.example.org/oauth/callback',state,codeChallenge:challenge});
 assert.equal(new URL(url).searchParams.get('scope'),SEND_SCOPE);
 assert.equal(new URL(url).searchParams.get('state'),state);
 assert.equal(new URL(url).searchParams.get('code_challenge_method'),'S256');
 await assert.rejects(exchangeOAuthCode({clientId:'c',clientSecret:'s',redirectUri:'https://backend.example.org/oauth/callback',code:'c',
 verifier:'v'.repeat(43),fetcher:async()=>({ok:true,json:async()=>({access_token:'a',refresh_token:'r',scope:'https://www.googleapis.com/auth/gmail.readonly'})})}));
});
test('OAuth state expires and disconnect deletes local access',async()=>{
 const x=sample();let now=100000;
 try{
 const oauth=new OAuthConnection({store:x.store,authorize:async()=>true,clientId:'test-client',clientSecret:'fake-secret',
 redirectUri:'https://backend.example.org/oauth/callback',clock:()=>now,
 fetcher:async()=>({ok:true,json:async()=>({access_token:'a',refresh_token:'r',scope:SEND_SCOPE,expires_in:3600})})});
 const started=await oauth.begin('owner');const state=new URL(started.url).searchParams.get('state');
 await assert.rejects(oauth.complete({state:'wrong',code:'fake'},'owner'));
 now+=300001;await assert.rejects(oauth.complete({state,code:'fake'},'owner'),/expired/);
 now=100000;await oauth.begin('owner');const state2=x.store.read('00000000-0000-0000-0000-000000000002').state;
 assert.equal((await oauth.complete({state:state2,code:'fake'},'owner')).connected,true);
 assert.equal((await oauth.disconnect('owner')).connected,false);
 assert.equal(oauth.status().connected,false);
 } finally{x.close();}
});
test('persistent sending marker blocks retry even if previous process crashed',async()=>{
 const x=sample({liveEnabled:true,provider:{ready:async()=>{},send:async()=>({id:'m'})}});try{
 const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 const r=x.store.read(d.id);r.status='sending';r.attempt={at:new Date().toISOString(),result:'uncertain'};x.store.write(d.id,r);
 await assert.rejects(x.service.send(d.id,'operator'),/already attempted/);
 }finally{x.close();}
});
test('timeline failure is recorded as pending and can be reconciled without another Gmail send',async()=>{
 let calls=0, writes=0;
 const x=sample({liveEnabled:true,provider:{ready:async()=>{},send:async()=>{calls++;return{id:'gmail-ok'};}},
 onOutcome:async()=>{writes++;if(writes===1)throw new Error('case timeline unavailable');}});
 try{const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 const result=await x.service.send(d.id,'operator');assert.equal(result.status,'sent');assert.equal(result.timelineStatus,'pending');
 const update=await x.service.reconcileTimeline(d.id,'operator');assert.equal(update.timelineStatus,'recorded');
 assert.equal(calls,1);assert.equal(writes,2);
 }finally{x.close();}
});
test('send preflight failure does not record a provider attempt, so the operator can resolve authorization',async()=>{
 let sends=0;const x=sample({liveEnabled:true,provider:{ready:async()=>{throw new Error('disconnected');},send:async()=>{sends++;return{id:'m'};}}});
 try{const d=await x.service.compose(specimen,'operator');await x.service.review(d.id,'operator');await x.service.approve(d.id,d.digest,'operator');
 await assert.rejects(x.service.send(d.id,'operator'),/disconnected/);assert.equal(x.service.status(d.id).status,'awaiting_send');
 assert.equal(sends,0);
 }finally{x.close();}
});
