import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {seal,unseal,normalizeDraft,validateEnvelope} from './crypto.mjs';
import {mimeMessage,sendOnce} from './send.mjs';
const kp=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const draft={to:'example@example.org',subject:'A test',body:'This is harmless test content',incident_id:'SYNTHETIC'};
const good=()=>seal(draft,kp.publicKey);
test('round trip without plaintext in public sealed envelope',()=>{const e=good();assert.deepEqual(unseal(e,kp.privateKey),{id:e.id,...draft});assert.ok(!JSON.stringify(e).includes(draft.body));});
test('rejects invalid recipient, injected headers, empty body',()=>{
  for(const x of [{...draft,to:'a@b\r\nBcc: c@d'},{...draft,subject:'hi\nBcc: bad'},{...draft,body:''}])assert.throws(()=>normalizeDraft(x));
});
test('reject ciphertext tampering',()=>{const e=good();e.data='AAAA'+e.data.slice(4);assert.throws(()=>unseal(e,kp.privateKey));});
test('reject metadata tampering',()=>{const e=good();e.commitment='0'.repeat(64);assert.throws(()=>unseal(e,kp.privateKey));});
test('validate schema refuses malformed envelope',()=>assert.throws(()=>validateEnvelope({schema:'bad'})));
test('MIME includes explicit sender, single recipient, encoded message',()=>{
 const msg=mimeMessage({id:'a'.repeat(32),...draft});assert.match(msg,/From: gitback2life.ai@gmail.com/);assert.match(msg,/To: example@example.org/);assert.doesNotMatch(msg,/Bcc:/);
});
const github={repo:'gitback2life-art/gitback2life',sha:'f'.repeat(40),githubToken:'test-token'};
const oauth={clientId:'client',clientSecret:'secret',refreshToken:'refresh'};
const reply=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body,text:async()=>JSON.stringify(body)});
test('approved send reserves once BEFORE Gmail POST',async()=>{
 const calls=[];const http=async(url,opts)=>{calls.push({url,opts});if(url.includes('/environments/'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}]});if(url.includes('oauth2'))return reply(200,{access_token:'access'});if(url.includes('/git/refs'))return reply(201,{});if(url.includes('gmail/v1'))return reply(200,{id:'msg-123'});throw Error('Unexpected URL')};
 const result=await sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:http});
 assert.equal(result.status,'provider_accepted');assert.deepEqual(calls.map(x=>new URL(x.url).host),['api.github.com','oauth2.googleapis.com','api.github.com','gmail.googleapis.com']);
});
test('existing durable marker blocks ALL Gmail attempts',async()=>{
 const urls=[];const http=async(url)=>{urls.push(url);if(url.includes('/environments/'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}]});if(url.includes('oauth2'))return reply(200,{access_token:'access'});return reply(422,{message:'already exists'})};
 await assert.rejects(sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:http}),/already been attempted/);
 assert.equal(urls.some(x=>x.includes('gmail.googleapis.com')),false);
});
test('OAuth failure blocks reservation and Gmail call',async()=>{
 let count=0;await assert.rejects(sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:async url=>{count++;return url.includes('/environments/')?reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}]}):reply(401,{})}}),/authorization unavailable/);assert.equal(count,2);
});
test('ambiguous Gmail timeout is not retried',async()=>{
 let sends=0;const http=async url=>{
  if(url.includes('/environments/'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}]});if(url.includes('oauth2'))return reply(200,{access_token:'access'});if(url.includes('/git/refs'))return reply(201,{});sends++;throw Error('timeout');};
 const r=await sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:http});assert.equal(r.status,'uncertain_delivery');assert.equal(sends,1);
});
test('non-success Gmail status is uncertain, not silently retried',async()=>{
 let sends=0;const http=async url=>{
  if(url.includes('/environments/'))return reply(200,{protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:'gitback2life-art'}}]}]});if(url.includes('oauth2'))return reply(200,{access_token:'access'});if(url.includes('/git/refs'))return reply(201,{});sends++;return reply(500,{})};
 const r=await sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:http});assert.equal(r.status,'uncertain_delivery');assert.equal(sends,1);
});

test('no environment required-reviewer fails closed before OAuth or Gmail',async()=>{
  const visited=[];
  await assert.rejects(sendOnce({envelope:good(),privateKey:kp.privateKey,oauth,github,request:async url=>{visited.push(url);return reply(200,{protection_rules:[]})}}),/required reviewer/);
  assert.equal(visited.length,1);
});
