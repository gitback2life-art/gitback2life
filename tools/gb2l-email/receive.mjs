// Bounded, read-only Gmail fetch logic. PRIVATE DATA: never log or publish return values.
// NOT WIRED TO GITHUB ACTIONS: no trusted ChatGPT return path has been verified.
import {createHash,createCipheriv,createDecipheriv,randomBytes,createPublicKey,
  publicEncrypt,privateDecrypt,constants} from 'node:crypto';

export const READ_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const BASE='https://gmail.googleapis.com/gmail/v1/users/me/messages';
const MAX_MESSAGES=5, MAX_TEXT=12000, MAX_ENCODED_BODY=131072;
const EMAIL=/^[A-Za-z0-9.!#$%&'*+\/?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*\.)*[A-Za-z0-9-]+$/;
function fail(code){const e=new Error(code);e.code=code;return e;}

export function assertInboxScope(tokeninfo,clientId){
  if (!tokeninfo||typeof tokeninfo!=='object'||!(tokeninfo.aud===clientId||tokeninfo.azp===clientId))
    throw fail('OAUTH_CLIENT_MISMATCH');
  const scopes=String(tokeninfo.scope||'').split(/\s+/).filter(Boolean);
  if (!scopes.includes(READ_SCOPE)) throw fail('INBOX_SCOPE_MISSING');
  // This credential is inbox-only. Reject any broader or additional Gmail
  // permission even if gmail.readonly is also present in the same token.
  const gmailScopes=scopes.filter(s=>s==='https://mail.google.com/'||/^https:\/\/www\.googleapis\.com\/auth\/gmail\./.test(s));
  if (gmailScopes.some(s=>s!==READ_SCOPE)) throw fail('INBOX_SCOPE_TOO_BROAD');
  return true;
}
export function normalizeInboxQuery({from,after,limit=3}={}){
  if(typeof from!=='string'||from!==from.trim()||!from||from.length>254||!EMAIL.test(from)||from.includes('..'))
    throw fail('INVALID_SENDER_FILTER');
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_MESSAGES)throw fail('INVALID_LIMIT');
  if(after!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(after)||!validDate(after)))throw fail('INVALID_DATE');
  // Bounded inbox-only query. No arbitrary Gmail search string supplied by caller.
  return {q:'in:inbox from:'+from.trim()+(after?' after:'+after.replaceAll('-','/'):'') ,limit};
}
function validDate(s){const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().startsWith(s);}
function cleanHeader(s,max=512){return typeof s==='string'?s.replace(/[\r\n\0\x01-\x1f\x7f]/g,' ').slice(0,max):'';}
function decodedWord(charset,encoding,text){
  try{
    let bytes;
    if(encoding.toUpperCase()==='B')bytes=Buffer.from(text,'base64');
    else {const a=text.replaceAll('_',' ');const b=[];for(let i=0;i<a.length;i++){
      if(a[i]==='='&&/^[0-9a-fA-F]{2}$/.test(a.slice(i+1,i+3))){b.push(parseInt(a.slice(i+1,i+3),16));i+=2;}else b.push(a.charCodeAt(i));
    }bytes=Buffer.from(b);}
    return new TextDecoder(charset.toLowerCase(),{fatal:false}).decode(bytes);
  }catch{return '[undecodable header]';}
}
function headerText(s){
  return cleanHeader(s).replace(/=\?([a-zA-Z0-9_-]+)\?([bBqQ])\?([^?]*)\?=/g,(_,cs,e,body)=>decodedWord(cs,e,body));
}
function decodeBody(data){
  if(typeof data!=='string'||!data||data.length>MAX_ENCODED_BODY||!/^[A-Za-z0-9_\-]*={0,2}$/.test(data))return null;
  try{return Buffer.from(data,'base64url').toString('utf8').replace(/\0/g,'').slice(0,MAX_TEXT)}catch{return null;}
}
function plainPart(payload){
  const queue=[payload];let steps=0;
  while(queue.length&&++steps<=50){
    const p=queue.shift();if(!p||typeof p!=='object')continue;
    // Never fetch attachmentId or decode text/html/script.
    if(String(p.mimeType||'').toLowerCase()==='text/plain'&&p.body?.data&&!p.filename){
      const s=decodeBody(p.body.data);if(s!==null)return s;
    }
    if(Array.isArray(p.parts))queue.push(...p.parts.slice(0,20));
  }
  return null;
}
export function parseGmailMessage(m){
  if(!m||!/^[-\w]{1,256}$/.test(m.id||'')||!m.payload)throw fail('INVALID_GMAIL_MESSAGE');
  const hdr=Array.isArray(m.payload.headers)?m.payload.headers:[];
  const get=name=>headerText(hdr.find(h=>String(h.name||'').toLowerCase()===name)?.value||'');
  const body=plainPart(m.payload);
  return Object.freeze({trust:'untrusted_email_content',message_id:m.id,
    thread_id:typeof m.threadId==='string'?m.threadId.slice(0,256):'',
    from:get('from'),subject:get('subject'),date:get('date'),
    body_text:body??'',body_available:body!==null,body_truncated:body!==null&&body.length>=MAX_TEXT});
}
async function getJSON(url,token,http){
  let r;
  try{r=await http(url,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(20000)})}
  catch{throw fail('GMAIL_NETWORK_UNAVAILABLE');}
  if(!r?.ok)throw fail('GMAIL_READ_HTTP_'+(Number.isInteger(r?.status)?r.status:'ERROR'));
  // Gmail `format=full` can include very large unwanted MIME/HTML parts.
  // Bound the actual response bytes before JSON parsing; attachments are never fetched.
  try{
    const advertised=Number(r.headers?.get?.('content-length'));
    if(Number.isFinite(advertised)&&advertised>1_500_000)throw fail('GMAIL_RESPONSE_TOO_LARGE');
    if(r.body?.getReader){
      const reader=r.body.getReader(); const chunks=[];let bytes=0;
      try{
        while(true){const {value,done}=await reader.read();if(done)break;
          bytes+=value.byteLength;if(bytes>1_500_000)throw fail('GMAIL_RESPONSE_TOO_LARGE');chunks.push(value);
        }
      }finally{reader.releaseLock()}
      return JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8'));
    }
    return await r.json(); // unit-test mock responses without streaming interface
  }catch(e){if(e?.code==='GMAIL_RESPONSE_TOO_LARGE')throw e;throw fail('GMAIL_BAD_RESPONSE')}
}
export async function readInbox({accessToken,clientId,filter,http=fetch}={}){
  if(typeof accessToken!=='string'||!accessToken)throw fail('MISSING_ACCESS_TOKEN');
  if(typeof clientId!=='string'||!clientId)throw fail('MISSING_OAUTH_CLIENT_ID');
  const {q,limit}=normalizeInboxQuery(filter);
  // Verify the actual Google token, not a caller-provided `scopeVerified` flag.
  let tokenResponse;
  try {tokenResponse=await http('https://oauth2.googleapis.com/tokeninfo',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({access_token:accessToken}),signal:AbortSignal.timeout(20000)
  });} catch {throw fail('OAUTH_SCOPE_CHECK_UNAVAILABLE');}
  if(!tokenResponse?.ok)throw fail('OAUTH_SCOPE_CHECK_FAILED');
  let tokeninfo;
  try {tokeninfo=await tokenResponse.json();} catch {throw fail('OAUTH_SCOPE_CHECK_INVALID');}
  assertInboxScope(tokeninfo,clientId);
  const listUrl=new URL(BASE);listUrl.searchParams.set('q',q);listUrl.searchParams.set('maxResults',String(limit));
  const found=await getJSON(listUrl.href,accessToken,http);
  if(!found||!Array.isArray(found.messages)&&found.messages!==undefined)throw fail('GMAIL_BAD_LIST');
  const unique=[...new Set((found.messages||[]).map(x=>x?.id).filter(x=>typeof x==='string'&&/^[-\w]{1,256}$/.test(x)))].slice(0,limit);
  const messages=[];
  for(const id of unique){
    const url=new URL(BASE+'/'+encodeURIComponent(id));url.searchParams.set('format','full');
    messages.push(parseGmailMessage(await getJSON(url.href,accessToken,http)));
  }
  return {status:messages.length?'found':'no_matches',trust:'untrusted_email_content',count:messages.length,messages};
}

// Encrypt ONLY for a trusted, authenticated recipient with an ephemeral RSA key.
// No plaintext result may ever be emitted to Actions logs, public comments, or artifacts.
export function encryptInboxReturn(result,recipientPublicKey,requestId){
  if(!/^[a-f0-9]{32}$/.test(requestId||''))throw fail('INVALID_REQUEST_ID');
  const pk=createPublicKey(recipientPublicKey);
  if(pk.asymmetricKeyType!=='rsa'||(pk.asymmetricKeyDetails?.modulusLength||0)<3072)throw fail('UNSAFE_RETURN_KEY');
  const aes=randomBytes(32),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',aes,iv);cipher.setAAD(Buffer.from(requestId));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(result),'utf8'),cipher.final()]);
  const wrapped=publicEncrypt({key:pk,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},aes);
  return {schema:'gb2l-inbox-return-v1',request_id:requestId,
    recipient_fingerprint:createHash('sha256').update(pk.export({type:'spki',format:'der'})).digest('hex'),
    iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),
    key:wrapped.toString('base64'),data:ciphertext.toString('base64')};
}
export function decryptInboxReturn(envelope,recipientPrivateKey){
  if(envelope?.schema!=='gb2l-inbox-return-v1'||!/^[a-f0-9]{32}$/.test(envelope.request_id||''))throw fail('INVALID_RETURN_ENVELOPE');
  const pk=createPublicKey(recipientPrivateKey);
  if(createHash('sha256').update(pk.export({type:'spki',format:'der'})).digest('hex')!==envelope.recipient_fingerprint)throw fail('RETURN_RECIPIENT_MISMATCH');
  try{
    const aes=privateDecrypt({key:recipientPrivateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.key,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',aes,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(Buffer.from(envelope.request_id));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
  }catch{throw fail('RETURN_DECRYPTION_FAILED')}
}
