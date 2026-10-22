import { randomBytes, createHash, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, constants, createPublicKey } from 'node:crypto';

const reMail=/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export function normalizeDraft(d) {
  if(!d || typeof d!=='object' || Array.isArray(d)) throw new Error('Draft object required');
  const fields=['to','subject','body'];
  if(fields.some(k=>typeof d[k]!=='string')) throw new Error('Draft must contain to, subject, and body strings');
  const to=d.to.trim();const subject=d.subject.trim();const body=d.body;
  if(!reMail.test(to)||to.length>254||to.includes('..')) throw new Error('Invalid single recipient');
  if(!subject || subject.length>200 ||/[\r\n\0]/.test(subject)) throw new Error('Invalid subject');
  if(!body || body.length>20000 ||body.includes('\0'))throw new Error('Invalid message body');
  const incident_id=d.incident_id===undefined?'':String(d.incident_id);
  if(incident_id.length>100||/[\r\n\0]/.test(incident_id))throw new Error('Invalid incident ID');
  return {to,subject,body,incident_id};
}
export const digest = (v)=>createHash('sha256').update(v).digest('hex');
export function seal(draft, pubPem, providedId=null) {
  const plain=normalizeDraft(draft);const id=providedId||randomBytes(16).toString('hex');
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid draft ID');
  const pub=createPublicKey(pubPem);
  if(pub.asymmetricKeyType!=='rsa'||pub.asymmetricKeyDetails?.modulusLength<3072)throw new Error('RSA key must be >= 3072 bits');
  const key=randomBytes(32),iv=randomBytes(12);
  const c=createCipheriv('aes-256-gcm',key,iv);
  const commitment_nonce=randomBytes(32).toString('hex');
  const json=JSON.stringify({id,...plain,commitment_nonce});
  const cipher=Buffer.concat([c.update(json,'utf8'),c.final()]);
  const wrapped=publicEncrypt({key:pub,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
  const commitment=digest(json);
  const envelope={schema:'gb2l-email-sealed-v2',id,commitment,key_fingerprint:digest(pub.export({format:'der',type:'spki'})),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),key:wrapped.toString('base64'),data:cipher.toString('base64')};
  // Excluded from serialization: private owner receipt NEVER travels to public GitHub.
  Object.defineProperty(envelope,'private_receipt',{value:{id,...plain,commitment_nonce},enumerable:false});
  return envelope;
}
export function validateEnvelope(e) {
  if(!e||typeof e!=='object'||e.schema!=='gb2l-email-sealed-v2'||!/^[a-f0-9]{32}$/.test(e.id)||!/^[a-f0-9]{64}$/.test(e.commitment)||!/^[a-f0-9]{64}$/.test(e.key_fingerprint))throw new Error('Invalid sealed draft metadata');
  for(const [k,max] of Object.entries({iv:32,tag:32,key:1024,data:50000})){
    if(typeof e[k]!=='string'||!e[k]||e[k].length>max||!/^[A-Za-z0-9+/]*={0,2}$/.test(e[k]))throw new Error('Invalid sealed draft '+k);
  }
  return e;
}
export function unseal(envelope,privatePem){
  const e=validateEnvelope(envelope);
  const key=privateDecrypt({key:privatePem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(e.key,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
  decipher.setAuthTag(Buffer.from(e.tag,'base64'));
  const json=Buffer.concat([decipher.update(Buffer.from(e.data,'base64')),decipher.final()]).toString('utf8');
  const data=JSON.parse(json);
  if(typeof data.commitment_nonce!=='string'||!/^[a-f0-9]{64}$/.test(data.commitment_nonce))throw new Error('Private commitment nonce missing');
  if(digest(json)!==e.commitment)throw new Error('Commitment mismatch');
  if(data.id!==e.id)throw new Error('ID mismatch');
  return {id:e.id,...normalizeDraft(data)};
}
