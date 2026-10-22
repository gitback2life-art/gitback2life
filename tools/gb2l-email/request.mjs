import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {validateEnvelope} from './crypto.mjs';
import {OWNER} from './policy.mjs';
export const PREFIX='GB2L_EMAIL_V1:';
export function makeComment(envelope){
  validateEnvelope(envelope);
  return PREFIX+Buffer.from(JSON.stringify(envelope),'utf8').toString('base64url');
}
export function parseComment(body){
  if(typeof body!=='string'||body.length>75000||!body.startsWith(PREFIX)||!/^[A-Za-z0-9_-]+$/.test(body.slice(PREFIX.length)))throw new Error('Not a sealed GitBack2Life mail request');
  const raw=Buffer.from(body.slice(PREFIX.length),'base64url');
  if(raw.length>60000)throw new Error('Encrypted request too large');
  const e=JSON.parse(raw.toString('utf8'));
  return validateEnvelope(e);
}
export function envelopeForEvent({eventName,event,actor,requestPr,repo,loadFile,changedFiles}){
  if(repo!=='gitback2life-art/gitback2life')throw new Error('Unexpected GitHub repository');
  if(eventName==='issue_comment'){
    if(event.action!=='created'||!event.issue?.pull_request||!Number.isSafeInteger(Number(requestPr))||Number(requestPr)<1||event.issue.number!==Number(requestPr))throw new Error('Not the owner designated mail-request PR');
    if(!actor||event.comment?.user?.login!==actor||event.sender?.login!==actor)throw new Error('Untrusted request principal');
    return {envelope:parseComment(event.comment.body),transport:'owner_comment'};
  }
  if(eventName==='push'){
    if(!event.ref||event.ref!=='refs/heads/main'||event.pusher?.name!==actor)throw new Error('Untrusted push event');
    if(!Array.isArray(changedFiles)||changedFiles.length!==1||!/^mail\/outbox\/[a-f0-9]{32}\.sealed\.json$/.test(changedFiles[0]))throw new Error('One encrypted draft per push, no code/config changes');
    const path=changedFiles[0];const env=validateEnvelope(JSON.parse(loadFile(path)));
    if(path!==`mail/outbox/${env.id}.sealed.json`)throw new Error('Draft filename mismatch');
    return {envelope:env,transport:'main_push'};
  }
  throw new Error('Unsupported request event');
}
export function fromRunnerEnvironment(env=process.env){
  const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  let changedFiles;
  if(env.GITHUB_EVENT_NAME==='push')changedFiles=execFileSync('git',['diff','--name-only','HEAD^1','HEAD'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  return envelopeForEvent({eventName:env.GITHUB_EVENT_NAME,event,actor:env.GB2L_REQUEST_ACTOR||OWNER,requestPr:env.GB2L_REQUEST_PR,repo:env.GITHUB_REPOSITORY,changedFiles,loadFile:(p)=>readFileSync(p,'utf8')});
}
