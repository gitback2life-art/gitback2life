// Independent, encrypted inbox REQUEST protocol. The existing outbound email
// crypto.mjs and GB2L_EMAIL_V1 send protocol are intentionally unchanged.
import {createHash,createPublicKey,randomBytes,sign,verify,
  createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,constants} from 'node:crypto';
import {normalizeInboxQuery} from './receive.mjs';

export const INBOX_REQUEST_PREFIX='GB2L_INBOX_V1:';
export const INBOX_RESPONSE_PREFIX='GB2L_INBOX_RESULT_V1:';
const REQUEST_SCHEMA='gb2l-inbox-request-v1';
const ID=/^[a-f0-9]{32}$/;
const HEX=/^[a-f0-9]{64}$/;
const B64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RSA_PADDING={padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
function err(code){const e=new Error(code);e.code=code;return e;}
function publicKey(pem){
  const pk=createPublicKey(pem);
  if(pk.asymmetricKeyType!=='rsa'||(pk.asymmetricKeyDetails?.modulusLength||0)<3072)
    throw err('UNSAFE_RSA_KEY');
  return pk;
}
export function fingerprint(pem){return createHash('sha256').update(publicKey(pem).export({type:'spki',format:'der'})).digest('hex');}
function validateB64(s,max){return typeof s==='string' && s.length>0 && s.length<=max && B64.test(s);}
export function validateInboxRequestEnvelope(e){
  if(!e||Object.getPrototypeOf(e)!==Object.prototype||e.schema!==REQUEST_SCHEMA||!ID.test(e.request_id||'')||!HEX.test(e.key_fingerprint||''))throw err('INVALID_INBOX_REQUEST');
  for(const [k,max] of Object.entries({iv:32,tag:32,key:1024,data:16000})){
    if(!validateB64(e[k],max))throw err('INVALID_INBOX_REQUEST');
  }
  if(Buffer.from(e.iv,'base64').length!==12||Buffer.from(e.tag,'base64').length!==16||Buffer.from(e.key,'base64').length>512)
    throw err('INVALID_INBOX_REQUEST');
  return e;
}
export function sealInboxRequest({from,after,limit=3,return_public_key,request_id},inboxPublicPem){
  const normalized=normalizeInboxQuery({from,after,limit});
  const id=request_id||randomBytes(16).toString('hex');
  if(!ID.test(id))throw err('INVALID_REQUEST_ID');
  const replyKey=publicKey(return_public_key);
  const query={from,limit:normalized.limit,...(after?{after}:{}),
    return_public_key:replyKey.export({type:'spki',format:'pem'}).toString(),
    return_key_fingerprint:fingerprint(return_public_key)};
  const serverKey=publicKey(inboxPublicPem);
  const aes=randomBytes(32),iv=randomBytes(12);
  const c=createCipheriv('aes-256-gcm',aes,iv);
  c.setAAD(Buffer.from(REQUEST_SCHEMA+':'+id));
  const data=Buffer.concat([c.update(JSON.stringify(query),'utf8'),c.final()]);
  return {schema:REQUEST_SCHEMA,request_id:id,key_fingerprint:fingerprint(inboxPublicPem),
    iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),
    key:publicEncrypt({key:serverKey,...RSA_PADDING},aes).toString('base64'),data:data.toString('base64')};
}
export function unsealInboxRequest(envelope,inboxPrivatePem){
  const e=validateInboxRequestEnvelope(envelope);
  if(fingerprint(inboxPrivatePem)!==e.key_fingerprint)throw err('INBOX_KEY_MISMATCH');
  try{
    const aes=privateDecrypt({key:inboxPrivatePem,...RSA_PADDING},Buffer.from(e.key,'base64'));
    if(aes.length!==32)throw err('INVALID_INBOX_REQUEST');
    const d=createDecipheriv('aes-256-gcm',aes,Buffer.from(e.iv,'base64'));
    d.setAAD(Buffer.from(REQUEST_SCHEMA+':'+e.request_id));
    d.setAuthTag(Buffer.from(e.tag,'base64'));
    const data=JSON.parse(Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()]).toString('utf8'));
    const norm=normalizeInboxQuery(data);
    const returnKey=publicKey(data.return_public_key);
    if(fingerprint(data.return_public_key)!==data.return_key_fingerprint)throw err('RETURN_KEY_MISMATCH');
    return {request_id:e.request_id,filter:{from:data.from,...(data.after?{after:data.after}:{}),limit:norm.limit},
      return_public_key:returnKey.export({type:'spki',format:'pem'}).toString(),return_key_fingerprint:data.return_key_fingerprint};
  }catch{throw err('INBOX_DECRYPTION_FAILED');}
}
export function encodeInboxComment(envelope,prefix=INBOX_REQUEST_PREFIX){
  validateInboxRequestEnvelope(envelope);
  return prefix+Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
export function decodeInboxComment(body){
  if(typeof body!=='string'||!body.startsWith(INBOX_REQUEST_PREFIX)||body.length>30000)throw err('INVALID_INBOX_PREFIX');
  const encoded=body.slice(INBOX_REQUEST_PREFIX.length);
  if(!/^[A-Za-z0-9_-]{100,28000}$/.test(encoded))throw err('INVALID_INBOX_ENCODING');
  let e;try{e=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{throw err('INVALID_INBOX_ENCODING');}
  return validateInboxRequestEnvelope(e);
}
function signedBytes(e){return Buffer.from(['gb2l-inbox-signed-response-v1',e.schema,e.request_id,e.recipient_fingerprint,e.iv,e.tag,e.key,e.data].join('\n'),'utf8');}
export function signInboxResponse(envelope,signingPrivateKey){
  if(envelope?.schema!=='gb2l-inbox-return-v1'||!ID.test(envelope.request_id||''))throw err('INVALID_INBOX_RESPONSE');
  const signature=sign('sha256',signedBytes(envelope),{key:signingPrivateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString('base64');
  return {...envelope,signature};
}
export function verifyInboxResponse(envelope,signingPublicKey){
  if(!envelope||!validateB64(envelope.signature,1024))throw err('MISSING_INBOX_SIGNATURE');
  let valid=false;
  try{valid=verify('sha256',signedBytes(envelope),{key:publicKey(signingPublicKey),padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(envelope.signature,'base64'));}catch{}
  if(!valid)throw err('UNTRUSTED_INBOX_RESPONSE');
  return true;
}
export function encodeInboxResponse(envelope){
  if(envelope?.schema!=='gb2l-inbox-return-v1'||!ID.test(envelope.request_id||''))throw err('INVALID_INBOX_RESPONSE');
  return INBOX_RESPONSE_PREFIX+Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
export function decodeInboxResponse(comment){
  if(typeof comment!=='string'||!comment.startsWith(INBOX_RESPONSE_PREFIX)||comment.length>400000)throw err('INVALID_INBOX_RESPONSE');
  const encoded=comment.slice(INBOX_RESPONSE_PREFIX.length);
  if(!/^[A-Za-z0-9_-]{100,390000}$/.test(encoded))throw err('INVALID_INBOX_RESPONSE');
  try{
    const e=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(e?.schema!=='gb2l-inbox-return-v1'||!ID.test(e.request_id||'')||!HEX.test(e.recipient_fingerprint||'')||!validateB64(e.signature,1024))throw err('INVALID_INBOX_RESPONSE');
    for(const [k,max] of Object.entries({iv:32,tag:32,key:1024,data:250000}))if(!validateB64(e[k],max))throw err('INVALID_INBOX_RESPONSE');
    return e;
  }catch{throw err('INVALID_INBOX_RESPONSE');}
}
export function validateOwnerInboxEvent(event,env){
  if(env.GITHUB_REPOSITORY!=='gitback2life-art/gitback2life'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1')throw err('UNTRUSTED_INBOX_CONTEXT');
  if(env.GB2L_INBOX_ENABLED!=='true')throw err('INBOX_DISABLED');
  if(env.GITHUB_EVENT_NAME!=='issue_comment'||event?.action!=='created'||!event?.issue?.pull_request || event?.issue?.state!=='open')throw err('UNTRUSTED_INBOX_EVENT');
  const actor=env.GB2L_INBOX_ACTOR;
  if(actor!=='gitback2life-art'||env.GITHUB_ACTOR!==actor||event?.comment?.user?.login!==actor)throw err('UNAUTHORIZED_INBOX_ACTOR');
  if(!/^\d{1,10}$/.test(env.GB2L_INBOX_REQUEST_PR||'')||String(event?.issue?.number)!==env.GB2L_INBOX_REQUEST_PR)throw err('WRONG_INBOX_REQUEST_PR');
  if(!Number.isSafeInteger(event?.comment?.id)||event.comment.id<1)throw err('MISSING_COMMENT_ID');
  return decodeInboxComment(event.comment.body);
}
