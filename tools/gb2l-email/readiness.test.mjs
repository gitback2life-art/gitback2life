import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {checkSenderReadiness} from './readiness.mjs';
import {OWNER,REPO,SENDER} from './policy.mjs';

const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const secrets={
  GB2L_CONTROL_TOKEN:'read-only-token-do-not-log',
  GB2L_EMAIL_POLICY:JSON.stringify({version:1,mode:'approval_required',owner:OWNER,requester:OWNER,sender:SENDER,daily_limit:3}),
  GB2L_MAIL_PRIVATE_KEY:pair.privateKey,
  GMAIL_CLIENT_ID:'test-client-id.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET:'test-client-secret-do-not-log',
  GMAIL_REFRESH_TOKEN:'test-refresh-token-do-not-log'
};
const baseEnv={...secrets,GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:OWNER,GB2L_EMAIL_MODE:'disabled',GB2L_REQUEST_ACTOR:OWNER,GB2L_REQUEST_PR:'18'};
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
const goodHttp=async url=>{
 if(url==='https://oauth2.googleapis.com/token')return response(200,{access_token:'test-short-lived-access-token'});
 if(url==='https://openidconnect.googleapis.com/v1/userinfo')return response(200,{email:SENDER,email_verified:true});
 throw Error('Unexpected endpoint '+url);
};

test('readiness verifies configuration and existing Google identity without Gmail send calls',async()=>{
 const calls=[];
 const http=async(url,options)=>{calls.push(url);return goodHttp(url,options)};
 const result=await checkSenderReadiness({env:baseEnv,publicKeyPem:pair.publicKey,http});
 assert.equal(result.modeRemainsDisabled,true);
 assert.equal(result.gmailSendAttempted,false);
 assert.equal(result.publicPrivateKeyMatch,true);
 assert.equal(result.oauthRefreshSucceeded,true);
 assert.equal(result.senderIdentityVerified,SENDER);
 assert.deepEqual(calls,['https://oauth2.googleapis.com/token','https://openidconnect.googleapis.com/v1/userinfo']);
 assert.equal(JSON.stringify(result).includes('test-refresh-token-do-not-log'),false);
});

test('missing secret reports names only and makes no network calls',async()=>{
 let calls=0;
 await assert.rejects(checkSenderReadiness({env:{...baseEnv,GMAIL_REFRESH_TOKEN:''},publicKeyPem:pair.publicKey,http:async()=>{calls++;throw Error('should not call')}}),/GMAIL_REFRESH_TOKEN/);
 assert.equal(calls,0);
});

test('readiness refuses unless email sending is disabled',async()=>{
 let calls=0;
 await assert.rejects(checkSenderReadiness({env:{...baseEnv,GB2L_EMAIL_MODE:'approval_required'},publicKeyPem:pair.publicKey,http:async()=>{calls++;throw Error('should not call')}}),/must remain disabled/);
 assert.equal(calls,0);
});

test('readiness fails before OAuth if the local private key does not match the published public key',async()=>{
 const other=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 let calls=0;
 await assert.rejects(checkSenderReadiness({env:baseEnv,publicKeyPem:other.publicKey,http:async()=>{calls++;throw Error('should not call')}}),/does not match/);
 assert.equal(calls,0);
});

test('readiness refuses unverified or wrong Google sender identity',async()=>{
 const http=async url=>url==='https://oauth2.googleapis.com/token'?response(200,{access_token:'test-access'}):response(200,{email:'wrong@example.com',email_verified:true});
 await assert.rejects(checkSenderReadiness({env:baseEnv,publicKeyPem:pair.publicKey,http}),/not the verified authorized sender/);
});
