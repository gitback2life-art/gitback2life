// Email Communications: isolated backend engine. Never sends without protected human approval.
// Operator-facing source must not contain OAuth credentials, tokens or signing keys.
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SENDER = 'gitback2life.ai@gmail.com';
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const CASE_ID = /^[A-Za-z0-9_-]{1,60}$/;
const SAFE_LABEL = /^[A-Za-z0-9_. -]{1,96}$/;
const sha = x => createHash('sha256').update(x).digest('hex');
function fail(message) { throw new Error(message); }
function addresses(text) {
  if (typeof text !== 'string' || text.length > 900 || !text.trim()) fail('one recipient address is required');
  const items = text.split(',').map(s => s.trim()).filter(Boolean);
  if (items.length !== 1 || !EMAIL.test(items[0]) || /\.\.|\r|\n/.test(items[0])) fail('first release permits exactly one valid recipient');
  return items[0];
}
export function normalizeDraft(input) {
  if (!input || typeof input !== 'object' || !CASE_ID.test(input.incidentId ?? '')) fail('valid incident required');
  const to = addresses(input.to);
  if ((input.cc?.length ?? 0) || (input.bcc?.length ?? 0) || (input.attachments?.length ?? 0)) fail('Cc/Bcc/attachments are disabled in first release');
  const subject = input.subject, body = input.body;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n\u0000-\u001f]/.test(subject)) fail('subject must be plain single-line text');
  if (typeof body !== 'string' || !body.trim() || body.length > 15000 || /\u0000/.test(body)) fail('plain-text body required (max 15000 characters)');
  const refs = input.evidenceRefs ?? [];
  if (!Array.isArray(refs) || refs.length > 20 || !refs.every(x => typeof x === 'string' && /^[A-Za-z0-9_:./#-]{1,120}$/.test(x))) fail('invalid evidence references');
  return { incidentId: input.incidentId, from: SENDER, to, cc:[], bcc:[], subject:subject.trim(), body, evidenceRefs:refs, attachments:[] };
}
export function draftDigest(draft) {
  return sha(JSON.stringify({incidentId:draft.incidentId, from:draft.from, to:draft.to, cc:draft.cc, bcc:draft.bcc,
    subject:draft.subject, body:draft.body, attachments:draft.attachments, evidenceRefs:draft.evidenceRefs}));
}
function encodeRFC822(draft) {
  // Strip header newlines above; RFC 2047 encoded subject prevents header injection.
  const subject = `=?UTF-8?B?${Buffer.from(draft.subject,'utf8').toString('base64')}?=`;
  const msg = [`From: ${SENDER}`,`To: ${draft.to}`,`Subject: ${subject}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',
    Buffer.from(draft.body,'utf8').toString('base64')].join('\r\n');
  return Buffer.from(msg,'utf8').toString('base64url');
}
// Storage is a protected backend-only folder. The AES key must be supplied from
// protected backend configuration, outside the repository; do not log it.
export class EncryptedStore {
  constructor(directory, key) {
    if (typeof directory !== 'string' || !directory.trim()) fail('protected backend directory required');
    const buf = Buffer.isBuffer(key) ? key : Buffer.from(key ?? '', 'base64');
    if (buf.length !== 32) fail('32-byte backend encryption key required');
    this.key = buf;
    this.dir = resolve(directory);
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    if (!lstatSync(this.dir).isDirectory() || lstatSync(this.dir).isSymbolicLink()) fail('backend store must be a real directory');
  }
  file(id) { if (!/^[a-f0-9-]{36}$/.test(id)) fail('invalid record ID'); return join(this.dir,`${id}.vault`); }
  encrypt(record) { const nonce=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(record),'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]); }
  decrypt(buf) { if (buf.length<29 || buf.length>128*1024) fail('invalid protected record');
    const decipher=createDecipheriv('aes-256-gcm',this.key,buf.subarray(0,12));
    decipher.setAuthTag(buf.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString('utf8')); }
  read(id) { const f=this.file(id); if (!existsSync(f)) fail('record not found');
    if (!lstatSync(f).isFile() || lstatSync(f).isSymbolicLink()) fail('invalid record');
    return this.decrypt(readFileSync(f)); }
  write(id, record) { const f=this.file(id), temp=join(this.dir,`${id}.${randomUUID()}.tmp`);
    const fd=openSync(temp,'wx',0o600);try { writeFileSync(fd,this.encrypt(record)); } finally { closeSync(fd); }
    try { renameSync(temp,f); } catch(e) { try { unlinkSync(temp); } catch {} throw e; } }
  lock(id) { const p=join(this.dir,`${id}.lock`); const fd=openSync(p,'wx',0o600);
    return () => { closeSync(fd);unlinkSync(p); }; }
}
export class EmailService {
  constructor({store, authorize, provider, onOutcome, clock=()=>new Date().toISOString(), liveEnabled=false}) {
    if (!store || typeof authorize !== 'function') fail('encrypted store and protected role authorizer required');
    this.store=store; this.authorize=authorize; this.provider=provider;this.onOutcome=onOutcome;
    this.clock=clock;this.liveEnabled=liveEnabled;
  }
  async check(role, actor, incidentId, recipient) {
    if (!actor || !SAFE_LABEL.test(actor) || await this.authorize({role,actor,incidentId,recipient}) !== true)
      fail(`verified ${role} permission required`);
  }
  async compose(input, actor) {
    const draft=normalizeDraft(input); await this.check('draft',actor,draft.incidentId);
    const id=randomUUID(), record={id,draft,digest:draftDigest(draft),status:'draft_created',createdAt:this.clock(),createdBy:actor,approval:null,attempt:null};
    this.store.write(id,record);return {id,status:record.status,digest:record.digest};
  }
  async review(id, actor) {
    const release=this.store.lock(id);
    try {const r=this.store.read(id);await this.check('review',actor,r.draft.incidentId);
      if(r.status==='draft_created'){r.status='awaiting_approval';this.store.write(id,r);}
      return {id,draft:r.draft,digest:r.digest,status:r.status,approval:r.approval && {actor:r.approval.actor,at:r.approval.at},
        attempt:r.attempt && {at:r.attempt.at,result:r.attempt.result,messageId:r.attempt.messageId ?? null}};
    }finally{release();}
  }
  async edit(id, changes, actor) {
    const release=this.store.lock(id);
    try {const r=this.store.read(id);await this.check('draft',actor,r.draft.incidentId);
      if (r.attempt) fail('an attempted message is immutable; compose a new draft');
      const next=normalizeDraft({...r.draft,...changes,incidentId:r.draft.incidentId});
      r.draft=next;r.digest=draftDigest(next);r.approval=null;r.status='draft_created';this.store.write(id,r);
      return {id,status:r.status,digest:r.digest};
    } finally {release();}
  }
  async approve(id, digest, actor) {
    const release=this.store.lock(id);
    try {const r=this.store.read(id);await this.check('approve',actor,r.draft.incidentId);
      if (r.attempt) fail('cannot approve an attempted message');
      if (typeof digest!=='string' || digest.length!==64 || !/^[a-f0-9]{64}$/.test(digest) || !timingSafeEqual(Buffer.from(digest),Buffer.from(r.digest)))
        fail('draft changed since review: approval refused');
      if(r.status!=='awaiting_approval')fail('exact current draft must be reviewed before approval');
      r.approval={actor,at:this.clock(),digest:r.digest};r.status='awaiting_send';this.store.write(id,r);
      return {id,status:r.status,approvedDigest:r.digest};
    } finally {release();}
  }
  async send(id, actor) {
    // The lock spans the remote request; a crash leaves `sending/uncertain` on disk.
    // NEVER automatically retry once an attempt is marked in-flight.
    const release=this.store.lock(id);
    try {const r=this.store.read(id);await this.check('send',actor,r.draft.incidentId,r.draft.to);
      if (!this.liveEnabled) fail('live email sending is disabled until owner-controlled deployment');
      if (!this.provider?.send || !this.provider?.ready) fail('protected Gmail provider is not configured');
      if (r.status!=='awaiting_send'||r.attempt) fail('message already attempted or not approved');
      if (!r.approval || r.approval.digest!==draftDigest(r.draft) || r.approval.digest!==r.digest) fail('exact current draft approval missing');
      await this.provider.ready(); // token preflight before an irreversible send attempt
      r.status='sending';r.attempt={at:this.clock(),result:'uncertain',by:actor};this.store.write(id,r);
      try {
        const response=await this.provider.send({raw:encodeRFC822(r.draft),sender:SENDER});
        if (!response || typeof response.id!=='string' || !/^[\w-]{1,180}$/.test(response.id)) fail('provider response missing message identifier');
        r.status='sent';r.attempt.result='sent';r.attempt.messageId=response.id;
      } catch(e) {
        // Includes timeouts and ambiguous connection failures. No blind re-send.
        r.status=e?.code==='PROVIDER_REJECTED' || e?.code==='AUTH_REQUIRED'?'failed':'uncertain_delivery';
        r.attempt.result=r.status;r.attempt.errorKind=e?.code==='AUTH_REQUIRED'?'authorization':'provider_or_transport';
      }
      r.timelineStatus='pending';this.store.write(id,r);
      if(this.onOutcome){
        try {await this.onOutcome(this.outcome(r));r.timelineStatus='recorded';}
        catch {r.timelineStatus='pending';} // Never resend to repair an audit problem.
        this.store.write(id,r);
      }
      return {id,status:r.status,messageId:r.attempt.messageId??null,timelineStatus:r.timelineStatus};
    } finally {release();}
  }
  outcome(r) {return {incidentId:r.draft.incidentId,id:r.id,status:r.status,sender:SENDER,
    recipient:r.draft.to,subject:r.draft.subject,approvedBy:r.approval.actor,approvedAt:r.approval.at,
    attemptAt:r.attempt.at,providerMessageId:r.attempt.messageId??null};}
  async reconcileTimeline(id,actor) {
    const release=this.store.lock(id);
    try {const r=this.store.read(id);await this.check('review',actor,r.draft.incidentId);
      if(!r.attempt)fail('no send outcome exists to record');
      if(r.timelineStatus==='recorded')return {id,timelineStatus:'recorded'};
      if(!this.onOutcome)fail('timeline writer not configured');
      try{await this.onOutcome(this.outcome(r));r.timelineStatus='recorded';}
      catch{r.timelineStatus='pending';}
      this.store.write(id,r);return {id,timelineStatus:r.timelineStatus};
    }finally{release();}
  }
  status(id) {const r=this.store.read(id);return {id,status:r.status,at:r.attempt?.at??r.createdAt,timelineStatus:r.timelineStatus??'not_applicable'};}
}

export function gmailProvider(accessToken, fetcher=fetch) {
  if (typeof accessToken !== 'string' || !accessToken) fail('protected OAuth token required');
  return { async send({raw,sender}) {
    if (sender!==SENDER) fail('unapproved sender identity');
    const response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',
      headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify({raw}),
      signal:AbortSignal.timeout(20000),redirect:'error'});
    if (!response.ok) {const err=new Error('Gmail did not confirm a successful send');err.code=response.status===401||response.status===403?'AUTH_REQUIRED':response.status>=400&&response.status<500&&response.status!==408&&response.status!==429?'PROVIDER_REJECTED':'AMBIGUOUS_FAILURE';throw err;}
    return await response.json();
  }};
}
// Web-application OAuth support; callbacks must be hosted on a protected backend.
// Deployed redirect URIs require HTTPS. Localhost exceptions are only for local testing.
export function oauthAuthorizationUrl({clientId,redirectUri,state,codeChallenge}) {
  if (!clientId || !/^https:\/\//.test(redirectUri) || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge))
    fail('protected HTTPS OAuth configuration, state and PKCE challenge required');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:SEND_SCOPE,
    state,code_challenge:codeChallenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent',login_hint:SENDER})) url.searchParams.set(k,v);
  return url.toString();
}
export async function exchangeOAuthCode({clientId,clientSecret,redirectUri,code,verifier,fetcher=fetch}) {
  if (!clientId||!clientSecret||!/^https:\/\//.test(redirectUri)||!code||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail('invalid protected OAuth exchange');
  const res=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:clientId,
      client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier}).toString(),
    signal:AbortSignal.timeout(20000),redirect:'error'});
  if (!res.ok) fail('OAuth authorization failed; reconnect through Google');
  const t=await res.json();if(!t.access_token || !t.refresh_token || t.scope?.trim()!==SEND_SCOPE) fail('Gmail send-only token/scope not returned');
  return {accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+Math.max(1,Number(t.expires_in)||3600)*1000};
}

const CONNECTION_ID = '00000000-0000-0000-0000-000000000001';
const OAUTH_PENDING_ID = '00000000-0000-0000-0000-000000000002';
export class OAuthConnection {
  constructor({store,authorize,clientId,clientSecret,redirectUri,fetcher=fetch,clock=()=>Date.now()}) {
    this.store=store;this.authorize=authorize;this.clientId=clientId;this.clientSecret=clientSecret;
    this.redirectUri=redirectUri;this.fetcher=fetcher;this.clock=clock;
  }
  async owner(actor) {if(!actor || await this.authorize({role:'connect',actor,incidentId:null})!==true) fail('protected owner authorization required');}
  status() {try {const c=this.store.read(CONNECTION_ID);return {connected:!!c.refreshToken,sender:SENDER,verifiedSenderIdentity:false,
    note:'Send-only OAuth cannot independently retrieve the connected account identity; owner must verify the selected Google account.'};}
    catch {return {connected:false,sender:SENDER,verifiedSenderIdentity:false};}}
  async begin(actor) {await this.owner(actor);const state=randomBytes(32).toString('base64url');const verifier=randomBytes(48).toString('base64url');
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    this.store.write(OAUTH_PENDING_ID,{state,verifier,actor,expires:this.clock()+300000});
    return {url:oauthAuthorizationUrl({clientId:this.clientId,redirectUri:this.redirectUri,state,codeChallenge:challenge}),expiresInSeconds:300}; }
  async complete({state,code},actor) {await this.owner(actor);const pending=this.store.read(OAUTH_PENDING_ID);
    if (this.clock()>pending.expires || typeof state!=='string'|| state.length!==pending.state.length ||
      !timingSafeEqual(Buffer.from(state),Buffer.from(pending.state))) fail('OAuth state expired or mismatched');
    // Consume one-time state before exchanging code, including if provider rejects.
    this.store.write(OAUTH_PENDING_ID,{state:'consumed',expires:0});
    const token=await exchangeOAuthCode({clientId:this.clientId,clientSecret:this.clientSecret,redirectUri:this.redirectUri,code,verifier:pending.verifier,fetcher:this.fetcher});
    this.store.write(CONNECTION_ID,{refreshToken:token.refreshToken,accessToken:token.accessToken,expiresAt:token.expiresAt});
    return this.status(); }
  async token() {const c=this.store.read(CONNECTION_ID);
    if(!c.refreshToken) fail('Gmail not connected');
    if(c.expiresAt>this.clock()+120000 && c.accessToken) return c.accessToken;
    const response=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,
        refresh_token:c.refreshToken,grant_type:'refresh_token'}).toString(),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok) fail('Gmail token renewal failed; account must reconnect');
    const t=await response.json();if(!t.access_token) fail('Gmail token renewal did not return access');
    if(t.refresh_token)c.refreshToken=t.refresh_token;
    c.accessToken=t.access_token;c.expiresAt=this.clock()+(Number(t.expires_in)||3600)*1000;
    this.store.write(CONNECTION_ID,c);return c.accessToken; }
  async disconnect(actor) {await this.owner(actor);let token=null;
    try{const c=this.store.read(CONNECTION_ID);token=c.refreshToken||c.accessToken;}catch{}
    // Revoke best-effort. Always make locally disconnected first.
    this.store.write(CONNECTION_ID,{refreshToken:null,accessToken:null,expiresAt:0});
    this.store.write(OAUTH_PENDING_ID,{state:'consumed',expires:0});
    if(token) {try {await this.fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString(),signal:AbortSignal.timeout(10000),redirect:'error'});}catch{}}
    return {connected:false,note:'Local connection removed. Confirm revocation in the Google Account permissions page if needed.'}; }
  provider() {return {
    ready:async()=>{await this.token();},
    send:async ({raw,sender})=>gmailProvider(await this.token(),this.fetcher).send({raw,sender})
  };}
}
