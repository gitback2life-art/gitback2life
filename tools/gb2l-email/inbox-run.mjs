// Privileged inbox reader, separate from outgoing send.mjs. No mail modification.
import {readFileSync,appendFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateOwnerInboxEvent,unsealInboxRequest,encodeInboxResponse,fingerprint,signInboxResponse} from './inbox-transport.mjs';
import {readInbox,encryptInboxReturn} from './receive.mjs';
import {verifySenderIdentity} from './identity.mjs';
import {refreshAccessToken} from './send.mjs';

const REPO='gitback2life-art/gitback2life';
const API='https://api.github.com';
const GH_HEADERS=token=>({Authorization:'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
function fail(code){const e=new Error(code);e.code=code;return e;}
async function safeJSON(r){if(!r?.ok)throw fail('GITHUB_REQUEST_FAILED');try{return await r.json()}catch{throw fail('GITHUB_INVALID_RESULT')}}

export function assertInboxPrivateKeyMatches(privatePem, publishedPublicPem){
  let privateKey;
  try { privateKey=createPrivateKey(privatePem); }
  catch { throw fail('INBOX_PRIVATE_KEY_INVALID'); }
  if(privateKey.asymmetricKeyType!=='rsa'||(privateKey.asymmetricKeyDetails?.modulusLength||0)<3072)
    throw fail('INBOX_PRIVATE_KEY_UNSAFE');
  let derived;
  try { derived=createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString(); }
  catch { throw fail('INBOX_PRIVATE_KEY_INVALID'); }
  if(fingerprint(derived)!==fingerprint(publishedPublicPem))throw fail('INBOX_PRIVATE_KEY_MISMATCH');
  return true;
}
export async function assertInboxEnvironment(token,http=fetch){
  const env=await safeJSON(await http(`${API}/repos/${REPO}/environments/gb2l-inbox-read`,
    {headers:GH_HEADERS(token),signal:AbortSignal.timeout(15000)}));
  const hasOwnerReview=Array.isArray(env.protection_rules)&&env.protection_rules.some(p=>p.type==='required_reviewers'&&Array.isArray(p.reviewers)&&p.reviewers.some(r=>r.reviewer?.login==='gitback2life-art'));
  if(!hasOwnerReview)throw fail('INBOX_OWNER_APPROVAL_NOT_CONFIGURED');
  if(env.deployment_branch_policy?.protected_branches===true)return true;
  if(env.deployment_branch_policy?.custom_branch_policies===true){
    const policies=await safeJSON(await http(`${API}/repos/${REPO}/environments/gb2l-inbox-read/deployment-branch-policies?per_page=100`,
      {headers:GH_HEADERS(token),signal:AbortSignal.timeout(15000)}));
    if(Array.isArray(policies.branch_policies)&&policies.branch_policies.length===1 && policies.branch_policies[0].name==='main' && policies.branch_policies[0].type==='branch')return true;
  }
  throw fail('INBOX_BRANCH_POLICY_MISSING');
}
export async function reserveInboxRequest(id,sha,token,http=fetch){
  if(!/^[a-f0-9]{32}$/.test(id||'')||!/^[a-f0-9]{40}$/.test(sha||''))throw fail('INVALID_INBOX_RESERVATION');
  let r;
  try{r=await http(`${API}/repos/${REPO}/git/refs`,{method:'POST',headers:{...GH_HEADERS(token),'Content-Type':'application/json'},
    body:JSON.stringify({ref:'refs/tags/gb2l-inbox-attempt-'+id,sha}),signal:AbortSignal.timeout(15000)});}catch{throw fail('INBOX_RESERVATION_UNAVAILABLE')}
  if(r?.status===422)throw fail('INBOX_REQUEST_ALREADY_USED');
  if(!r?.ok)throw fail('INBOX_RESERVATION_FAILED');
}
// Bound total response to fit a single ciphertext-only GitHub issue comment.
export function boundInboxResult(result){
  if(!result || !Array.isArray(result.messages)||result.messages.length>5)throw fail('INVALID_INBOX_RESULT');
  const messages=[];
  let total=0;
  for(const m of result.messages){
    const copied={...m};
    const body=String(m.body_text??'');
    // Cap by UTF-8 bytes, not JS code units. Preserve a clear truncation marker.
    const available=Math.min(6500,Math.max(0,18000-total));
    const buf=Buffer.from(body,'utf8');
    copied.body_text=buf.subarray(0,available).toString('utf8').replace(/\ufffd$/,'');
    copied.body_truncated=Boolean(m.body_truncated)||buf.length>available;
    total+=Buffer.byteLength(copied.body_text,'utf8');
    messages.push(copied);
  }
  return {...result,messages};
}
export async function postInboxReturn({requestId,issueNumber,response,returnPublicKey,signingPrivateKey,githubToken,http=fetch}){
  const envelope=signInboxResponse(encryptInboxReturn(response,returnPublicKey,requestId),signingPrivateKey);
  const body=encodeInboxResponse(envelope);
  if(body.length>62000)throw fail('INBOX_ENCRYPTED_RESULT_TOO_LARGE');
  let r;
  try{r=await http(`${API}/repos/${REPO}/issues/${issueNumber}/comments`,{
    method:'POST',headers:{...GH_HEADERS(githubToken),'Content-Type':'application/json'},
    body:JSON.stringify({body}),signal:AbortSignal.timeout(20000)});}catch{throw fail('INBOX_RETURN_POST_FAILED')}
  if(!r?.ok)throw fail('INBOX_RETURN_POST_FAILED');
  // ID is safe for audit; never log message headers/bodies/queries or response ciphertext.
  return {status:response.status==='error'?'private_error_returned':'encrypted_return_posted',request_id:requestId};
}
export async function runInboxRequest({event,env,http=fetch,inboxPublishedPublicKey}={}){
  const envelope=validateOwnerInboxEvent(event,env);
  const privateKey=env.GB2L_INBOX_REQUEST_PRIVATE_KEY?.replace(/\\n/g,'\n');
  const token=env.GITHUB_TOKEN;
  if(!token||!privateKey||!env.GMAIL_INBOX_CLIENT_ID||!env.GMAIL_INBOX_CLIENT_SECRET||!env.GMAIL_INBOX_REFRESH_TOKEN)throw fail('INBOX_SECRETS_MISSING');
  const publicKey=inboxPublishedPublicKey??readFileSync(new URL('./inbox-public-key.pem',import.meta.url),'utf8');
  assertInboxPrivateKeyMatches(privateKey,publicKey);
  const request=unsealInboxRequest(envelope,privateKey);
  // The fine-grained control token is used only to inspect protected environment policy;
  // the short-lived workflow GITHUB_TOKEN handles the one-use tag and encrypted comment.
  await assertInboxEnvironment(env.GB2L_CONTROL_TOKEN||token,http);
  const accessToken=await refreshAccessToken({clientId:env.GMAIL_INBOX_CLIENT_ID,
    clientSecret:env.GMAIL_INBOX_CLIENT_SECRET,refreshToken:env.GMAIL_INBOX_REFRESH_TOKEN},http);
  await verifySenderIdentity(accessToken,http);
  // One durable reservation prevents replay and repeated disclosure from old comments.
  await reserveInboxRequest(request.request_id,env.GITHUB_SHA,token,http);
  let result;
  try{
    result=boundInboxResult(await readInbox({accessToken,clientId:env.GMAIL_INBOX_CLIENT_ID,filter:request.filter,http}));
  }catch(e){
    // Error code is safe inside encryption, including network/scope failures.
    result={status:'error',error_code:typeof e.code==='string'&&/^[A-Z0-9_]{3,64}$/.test(e.code)?e.code:'INBOX_CHECK_FAILED',messages:[]};
  }
  return postInboxReturn({requestId:request.request_id,issueNumber:Number(env.GB2L_INBOX_REQUEST_PR),
    response:result,returnPublicKey:request.return_public_key,signingPrivateKey:privateKey,githubToken:token,http});
}

async function main(){
  try{
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    const result=await runInboxRequest({event,env:process.env});
    console.log('Inbox workflow outcome:',result.status,'request ID:',result.request_id);
    if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\nEncrypted inbox response: **${result.status}**. No plaintext email was logged.\n`);
  }catch(e){
    // Only controlled codes/errors, never raw OAuth, GitHub or Gmail response bodies.
    console.error('Inbox check refused:',e.code||'INBOX_CHECK_FAILED');
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
