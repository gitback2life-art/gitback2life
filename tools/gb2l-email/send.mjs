#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {unseal,validateEnvelope} from './crypto.mjs';
import {assertSendContext,requestedMode,REPO,SENDER} from './policy.mjs';
import {fromRunnerEnvironment} from './request.mjs';
const OAUTH='https://oauth2.googleapis.com/token';
const GMAIL='https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const API='https://api.github.com';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const encHeader=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${b64(s)}?=`;
export function mimeMessage(d){
  const body=Buffer.from(d.body.replace(/\r?\n/g,'\r\n'),'utf8').toString('base64').replace(/.{1,76}/g,'$&\r\n');
  return [`From: ${SENDER}`,`To: ${d.to}`,`Subject: ${encHeader(d.subject)}`,`Message-ID: <${d.id}@gmail.com>`,
    'MIME-Version: 1.0','Content-Type: text/plain; charset="UTF-8"','Content-Transfer-Encoding: base64','',body].join('\r\n');
}
const headers=token=>({Authorization:`Bearer ${token}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
const repoOk=({repo,githubToken,sha})=>repo===REPO&&/^[a-f0-9]{40}$/.test(sha||'')&&typeof githubToken==='string'&&githubToken.length>0;
export async function refreshAccessToken({clientId,clientSecret,refreshToken},http=fetch){
  if(!clientId||!clientSecret||!refreshToken)throw new Error('Missing Gmail OAuth secret');
  const form=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const r=await http(OAUTH,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Gmail authorization unavailable; no send attempted (HTTP '+r.status+')');
  const data=await r.json();if(!data?.access_token||typeof data.access_token!=='string')throw new Error('Missing Gmail access token; no send attempted');
  return data.access_token;
}
// Environmental protection is checked by the GitHub runner BEFORE it releases secrets;
// this independent runtime verification fails closed on inaccessible or wrong metadata.
export async function verifyEnvironment({repo,githubToken},mode,http=fetch){
  if(repo!==REPO||!githubToken)throw new Error('Invalid trusted GitHub sender context');
  const name=mode==='auto_send'?'gb2l-email-auto':'gb2l-email-send';
  const r=await http(`${API}/repos/${repo}/environments/${name}`,{headers:headers(githubToken),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Cannot verify GitHub sending environment; refusing to send');
  const data=await r.json();
  const ownerReview=Array.isArray(data.protection_rules)&&data.protection_rules.some(x=>x.type==='required_reviewers'&&x.reviewers?.some(y=>y.reviewer?.login==='gitback2life-art'));
  const anyReview=Array.isArray(data.protection_rules)&&data.protection_rules.some(x=>x.type==='required_reviewers');
  if(mode==='approval_required'&&!ownerReview)throw new Error('Owner approval gate missing; refusing to send');
  if(mode==='auto_send'&&anyReview)throw new Error('Autonomous environment has per-message review gate; refusing to claim autonomy');
  return true;
}
// Quotas use Git refs; workflow concurrency serializes the count and reservation.
// An already reserved attempt stays reserved on timeout, failed delivery or rerun.
export async function reserveAttempt({repo,sha,githubToken,id,dailyLimit,utcDay},http=fetch){
  if(!repoOk({repo,sha,githubToken})||!/^[a-f0-9]{32}$/.test(id)||!Number.isSafeInteger(dailyLimit)||dailyLimit<1||dailyLimit>20||!/^[0-9]{8}$/.test(utcDay))throw new Error('Invalid send reservation context');
  const url=`${API}/repos/${repo}/git/matching-refs/tags/gb2l-email-attempt-`;
  const existing=await http(url,{headers:headers(githubToken),signal:AbortSignal.timeout(20000)});
  if(!existing.ok && existing.status!==404)throw new Error('Cannot check duplicate/quota state; no message sent');
  const all=existing.status===404?[]:await existing.json();
  if(!Array.isArray(all))throw new Error('Invalid GitHub quota ledger');
  if(all.length>10000)throw new Error('Quota ledger unexpectedly large; fail closed');
  const matching=all.map(x=>x?.ref).filter(x=>typeof x==='string'&&/^refs\/tags\/gb2l-email-attempt-(?:\d{8}-)?[a-f0-9]{32}$/.test(x));
  if(matching.some(x=>x.endsWith('-'+id)))throw new Error('Email attempt already reserved; will not resend');
  const used=matching.filter(x=>x.startsWith(`refs/tags/gb2l-email-attempt-${utcDay}-`)).length;
  if(used>=dailyLimit)throw new Error('Owner daily sending quota exhausted');
  const tag=`refs/tags/gb2l-email-attempt-${utcDay}-${id}`;
  const response=await http(`${API}/repos/${repo}/git/refs`,{method:'POST',headers:{...headers(githubToken),'Content-Type':'application/json'},body:JSON.stringify({ref:tag,sha}),signal:AbortSignal.timeout(20000)});
  if(response.status===422)throw new Error('Email attempt already reserved; will not resend');
  if(!response.ok)throw new Error('Cannot create permanent one-time send marker; no message sent');
  return tag;
}
export async function sendOnce({envelope,privateKey,oauth,github,mode,policy,requestActor,request=fetch,now=()=>new Date()}){
  validateEnvelope(envelope);
  const d=unseal(envelope,privateKey);
  if(!repoOk(github)||!requestActor)throw new Error('Unknown authenticated GitHub requester');
  const effective=requestedMode(mode);
  const p=assertSendContext({mode:effective,actor:requestActor,policy,recipient:d.to});
  await verifyEnvironment(github,effective,request);
  // OAuth must be valid before reserving an attempt so transient OAuth errors are retryable.
  const access=await refreshAccessToken(oauth,request);
  // Immediately preceding Gmail, recheck the owner-managed effective policy & mode.
  assertSendContext({mode:effective,actor:requestActor,policy,recipient:d.to});
  const utcDay=now().toISOString().slice(0,10).replaceAll('-','');
  await reserveAttempt({...github,id:d.id,dailyLimit:p.daily_limit,utcDay},request);
  // From this point on, NEVER automatically resend, even if network returns 500/timeout.
  try{
    const raw=Buffer.from(mimeMessage(d),'utf8').toString('base64url');
    const r=await request(GMAIL,{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(20000)});
    if(!r.ok)return {status:'uncertain_delivery',draft_id:d.id,note:`Gmail HTTP ${r.status} after reserved attempt; no automatic retry.`};
    const result=await r.json();
    if(!result||typeof result.id!=='string'||!result.id)return {status:'uncertain_delivery',draft_id:d.id,note:'Gmail did not return a message identifier; no automatic retry.'};
    return {status:'provider_accepted',draft_id:d.id,note:'Gmail accepted email; recipient delivery/read status is not verified.'};
  }catch{return {status:'uncertain_delivery',draft_id:d.id,note:'Unknown Gmail result after reservation; no automatic retry.'}}
}
async function main(){
  const env=process.env;
  const {envelope}=fromRunnerEnvironment(env); // repeat trust check in privileged job
  const mode=requestedMode(env.GB2L_EMAIL_MODE);
  if(mode!==env.GB2L_EXPECTED_MODE)throw new Error('GitHub job mode mismatch');
  const privateKey=env.GB2L_MAIL_PRIVATE_KEY?.replace(/\\n/g,'\n');
  if(!privateKey)throw new Error('Decryption key unavailable; no send attempted');
  const oauth={clientId:env.GMAIL_CLIENT_ID,clientSecret:env.GMAIL_CLIENT_SECRET,refreshToken:env.GMAIL_REFRESH_TOKEN};
  const github={repo:env.GITHUB_REPOSITORY,sha:env.GITHUB_SHA,githubToken:env.GITHUB_TOKEN};
  const result=await sendOnce({envelope,privateKey,oauth,github,mode,policy:env.GB2L_EMAIL_POLICY,requestActor:env.GITHUB_ACTOR});
  console.log('Draft ID:',result.draft_id,'Result:',result.status,'-',result.note);
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,`\nEmail send: **${result.status}**, draft \`${result.draft_id}\`. ${result.note}\n`);
  if(result.status!=='provider_accepted')process.exitCode=1;
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error('Mail sender refused: '+e.message);process.exitCode=1});
