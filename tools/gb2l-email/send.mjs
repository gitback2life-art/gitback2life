#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unseal,validateEnvelope} from './crypto.mjs';
const SENDER='gitback2life.ai@gmail.com';
const OAUTH='https://oauth2.googleapis.com/token';
const GMAIL='https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const API='https://api.github.com';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const encHeader=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${b64(s)}?=`;
export function mimeMessage(d){
  // One recipient only; no arbitrary headers or attachments.
  const body=Buffer.from(d.body.replace(/\r?\n/g,'\r\n'),'utf8').toString('base64').replace(/.{1,76}/g,'$&\r\n');
  return [`From: ${SENDER}`,`To: ${d.to}`,`Subject: ${encHeader(d.subject)}`,
  `Message-ID: <${d.id}@gmail.com>`, 'MIME-Version: 1.0','Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: base64','',body].join('\r\n');
}
async function textOf(res){try{return (await res.text()).slice(0,300)}catch{return 'unavailable'}}
export async function refreshAccessToken({clientId,clientSecret,refreshToken},http=fetch){
  if(!clientId||!clientSecret||!refreshToken)throw new Error('Missing Gmail OAuth secret');
  const form=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const r=await http(OAUTH,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Gmail authorization unavailable; no send attempted (HTTP '+r.status+')');
  const data=await r.json();if(typeof data.access_token!=='string'||!data.access_token)throw new Error('No access token returned; no send attempted');
  return data.access_token;
}
export async function verifyOwnerReviewGate({repo,githubToken},http=fetch){
  if(repo!=='gitback2life-art/gitback2life'||!githubToken)throw new Error('Unapproved repository');
  const res=await http(`${API}/repos/${repo}/environments/gb2l-email-send`,{
    headers:{Authorization:`Bearer ${githubToken}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw new Error('Cannot verify owner approval gate; refusing to send');
  const env=await res.json();
  const reviewed=Array.isArray(env.protection_rules)&&env.protection_rules.some(r=>r.type==='required_reviewers'&&Array.isArray(r.reviewers)&&r.reviewers.some(v=>v.reviewer?.login==='gitback2life-art'));
  if(!reviewed)throw new Error('Owner required reviewer is not configured; refusing to send');
  return true;
}
export async function reserveAttempt({repo,sha,githubToken,id},http=fetch){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!/^[a-f0-9]{40}$/.test(sha)||!/^[a-f0-9]{32}$/.test(id)||!githubToken)throw new Error('Invalid GitHub dispatch context');
  const tag='refs/tags/gb2l-email-attempt-'+id;
  const r=await http(`${API}/repos/${repo}/git/refs`,{method:'POST',headers:{Authorization:`Bearer ${githubToken}`,'Content-Type':'application/json','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify({ref:tag,sha}),signal:AbortSignal.timeout(20000)});
  if(r.status===422)throw new Error('Sending has already been attempted for this draft. No automatic resend.');
  if(!r.ok)throw new Error('Could not reserve one-time send marker; no send attempted (HTTP '+r.status+')');
  return tag;
}
export async function sendOnce({envelope,privateKey,oauth,github,request=fetch}){
  validateEnvelope(envelope);
  const d=unseal(envelope,privateKey);
  if(d.id!==envelope.id)throw new Error('Invalid draft');
  // Fail closed if GitHub environment is not actually configured to require the repo owner.
  await verifyOwnerReviewGate(github,request);
  // Acquire Google access token before marking, so OAuth failures are safely retryable.
  const access=await refreshAccessToken(oauth,request);
  // Permanent marker MUST precede any Gmail network attempt. If anything fails after this
  // point, do not retry automatically. GitHub ref creation is atomic and survives reruns.
  await reserveAttempt({...github,id:d.id},request);
  const raw=Buffer.from(mimeMessage(d),'utf8').toString('base64url');
  try{
    const r=await request(GMAIL,{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(20000)});
    if(!r.ok){return {status:'uncertain_delivery',draft_id:d.id,note:'Gmail returned HTTP '+r.status+' after attempt marker; do not retry automatically.'}}
    const data=await r.json();
    if(typeof data.id!=='string'||!data.id)return {status:'uncertain_delivery',draft_id:d.id,note:'No Gmail message ID returned; do not retry.'};
    return {status:'provider_accepted',draft_id:d.id,note:'Gmail accepted the request. Delivery to recipient is not independently proven.'};
  }catch{return {status:'uncertain_delivery',draft_id:d.id,note:'Unknown result after Gmail request. Do not retry.'}}
}
async function main(){
  const path=process.argv[2];
  if(!path||!/^mail\/outbox\/[a-f0-9]{32}\.sealed\.json$/.test(path))throw new Error('Expected one sealed outbox path');
  const draft=JSON.parse(readFileSync(path,'utf8'));
  if(path!==`mail/outbox/${draft.id}.sealed.json`)throw new Error('Path/draft mismatch');
  const privateKey=process.env.GB2L_MAIL_PRIVATE_KEY?.replace(/\\n/g,'\n');
  const oauth={clientId:process.env.GMAIL_CLIENT_ID,clientSecret:process.env.GMAIL_CLIENT_SECRET,refreshToken:process.env.GMAIL_REFRESH_TOKEN};
  const github={repo:process.env.GITHUB_REPOSITORY,sha:process.env.GITHUB_SHA,githubToken:process.env.GITHUB_TOKEN};
  if(!privateKey)throw new Error('Missing encrypted draft decryption secret');
  const result=await sendOnce({envelope:draft,privateKey,oauth,github});
  // Never put recipient, subject, body, tokens or provider ID into public Actions logs.
  console.log('Draft ID:',result.draft_id,'Status:',result.status,'-',result.note);
  if(process.env.GITHUB_STEP_SUMMARY){
    const {appendFileSync}=await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\nEmail send outcome: **${result.status}**. ${result.note}\n`);
  }
  if(result.status!=='provider_accepted')process.exitCode=1;
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error('Mail sender refused: '+e.message);process.exitCode=1});
