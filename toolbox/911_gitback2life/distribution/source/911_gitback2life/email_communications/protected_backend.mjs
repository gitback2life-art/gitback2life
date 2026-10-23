// Private HTTPS email-only service. No arbitrary command, file or remote-control API.
// Starts only when explicitly configured by a protected administrator.
import {createServer} from 'node:https';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EncryptedStore,EmailService,OAuthConnection} from './email_service.mjs';
import {requireScope,authorize as authorizeScope,clearActiveScope} from '../_shared/scope.mjs';
import {checkAuthority} from '../_shared/authority_link.mjs';
import {addTimelineEvent,createCaseTimeline,caseEvidence} from '../toolbox/toolbox.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const isId=x=>/^[a-f0-9-]{36}$/.test(x||'');
const isCase=x=>/^[A-Za-z0-9_-]{1,60}$/.test(x||'');
function config() {
  const req=['GB2L_EMAIL_STATE_DIR','GB2L_EMAIL_KEY_B64','GB2L_EMAIL_TLS_CERT','GB2L_EMAIL_TLS_KEY',
    'GB2L_EMAIL_OPERATORS_FILE','GB2L_GMAIL_CLIENT_ID','GB2L_GMAIL_CLIENT_SECRET','GB2L_GMAIL_REDIRECT_URI'];
  for(const name of req) if(!process.env[name]) throw new Error(`${name} must be configured on the protected server`);
  const v={};for(const name of req)v[name]=process.env[name];
  if(!v.GB2L_GMAIL_REDIRECT_URI.startsWith('https://')) throw new Error('deployed OAuth callback requires HTTPS');
  return v;
}
const digest=s=>createHash('sha256').update(s).digest('hex');
function tokenAuthorizer(operatorFile) {
  const file=JSON.parse(readFileSync(operatorFile,'utf8'));
  if(!Array.isArray(file.operators)||!file.operators.length)throw new Error('protected operator list missing');
  const entries=file.operators;
  for(const e of entries) if(!/^[A-Za-z0-9_. -]{1,96}$/.test(e.actor)||!/^[a-f0-9]{64}$/.test(e.tokenSha256)||
      !Array.isArray(e.roles)||e.roles.some(r=>!['draft','review','approve','send','connect'].includes(r)))
    throw new Error('invalid protected operator configuration');
  const tokenToActor=token=>{
    if(typeof token!=='string'||token.length<32||token.length>256) return null;
    const h=Buffer.from(digest(token),'hex');
    return entries.find(e=>timingSafeEqual(h,Buffer.from(e.tokenSha256,'hex')))||null;
  };
  const authorize=async ({role,actor,incidentId,recipient})=>{
    const user=entries.find(u=>u.actor===actor);
    if(!user||!user.roles.includes(role))return false;
    if(incidentId && (!isCase(incidentId)|| (user.incidents!=='*' && !(Array.isArray(user.incidents)&&user.incidents.includes(incidentId)))))return false;
    // Stateless per-request authorization: no global activeScope context can leak
    // between different volunteers or different incidents on this long-lived server.
    if(!incidentId)return true;
    const scopePath=join(ROOT,'Cases',incidentId,'scope.json');
    try {
      const scope=JSON.parse(readFileSync(scopePath,'utf8'));
      if(scope.incident_id!==incidentId || !authorizeScope(scope,{action:'save_local'}).allowed)return false;
      if(role!=='send')return true;
      // Both signed protected owner authorization AND exact scoped human contact
      // permission are mandatory. Unprotected operator attestations alone cannot send.
      const domain=typeof recipient==='string'?recipient.split('@')[1]:null;
      if(!domain||!authorizeScope(scope,{action:'contact_third_party',target:domain,services:['gmail']}).allowed)return false;
      const signed=checkAuthority(scopePath,scope);
      return signed.required && signed.valid && scope.status==='open';
    }catch{return false;}
  };
  return {tokenToActor,authorize};
}
function sizeLimitedJson(req,max=32*1024){return new Promise((resolve,reject)=>{
  const parts=[];let n=0;
  req.on('data',p=>{n+=p.length;if(n>max){req.destroy();reject(new Error('request exceeds limit'));}else parts.push(p);});
  req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(new Error('invalid JSON'));}});
  req.on('error',reject);
});}
function reply(res,status,data){const b=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(b)});res.end(b);}
export function createProtectedEmailServer(v=config()) {
  const {tokenToActor,authorize}=tokenAuthorizer(v.GB2L_EMAIL_OPERATORS_FILE);
  const store=new EncryptedStore(v.GB2L_EMAIL_STATE_DIR,v.GB2L_EMAIL_KEY_B64);
  const oauth=new OAuthConnection({store,authorize,clientId:v.GB2L_GMAIL_CLIENT_ID,clientSecret:v.GB2L_GMAIL_CLIENT_SECRET,
    redirectUri:v.GB2L_GMAIL_REDIRECT_URI});
  const service=new EmailService({store,authorize,provider:oauth.provider(),liveEnabled:process.env.GB2L_EMAIL_LIVE_SEND_ENABLED==='1' && process.env.GB2L_EMAIL_VERIFIED_SENDER==='gitback2life.ai@gmail.com',
    onOutcome:async result=>{
      // Minimal reference only. Idempotent audit repair never re-sends Gmail.
      const caseDir=join(ROOT,'Cases',result.incidentId);
      const reference=`email:${result.id} ${result.status}`;
      for(const file of readdirSync(caseDir).filter(n=>/^timeline_\d{4}\.json$/.test(n))) {
        if(JSON.parse(readFileSync(join(caseDir,file),'utf8')).events?.some(e=>e.reference===reference))return;
      }
      const scope=join(caseDir,'scope.json');
      try {
      requireScope(scope,{action:'save_local'});
      try { addTimelineEvent(result.incidentId,'notify_assessment',result.status==='sent'?'confirmed':'unknown',
        reference); }
      catch (err) { if(/no timeline for this case/.test(err.message)){
        createCaseTimeline(result.incidentId,'other','real');
        addTimelineEvent(result.incidentId,'notify_assessment',result.status==='sent'?'confirmed':'unknown',
          reference);
      } else throw err; }
      } finally {clearActiveScope();}
    }});
  const callbackPath=new URL(v.GB2L_GMAIL_REDIRECT_URI).pathname;
  return createServer({cert:readFileSync(v.GB2L_EMAIL_TLS_CERT),key:readFileSync(v.GB2L_EMAIL_TLS_KEY),minVersion:'TLSv1.2'},async(req,res)=>{
    try {
      const url=new URL(req.url,'https://localhost');
      if(url.pathname===callbackPath && req.method==='GET') {
        const state=url.searchParams.get('state'),code=url.searchParams.get('code');
        const pending=store.read('00000000-0000-0000-0000-000000000002');
        await oauth.complete({state,code},pending.actor);
        return reply(res,200,{status:'connected',note:'Return to the Toolbox. The owner must confirm the selected Google account.'});
      }
      const token=(req.headers.authorization||'').match(/^Bearer ([\w.-]{32,256})$/)?.[1];
      const user=tokenToActor(token);
      if(!user)return reply(res,401,{error:'protected operator authorization required'});
      if(url.pathname==='/v1/email/connection' && req.method==='GET'){
        if(!await authorize({role:'connect',actor:user.actor}))return reply(res,403,{error:'not authorized'});
        return reply(res,200,oauth.status());}
      if(url.pathname==='/v1/email/connect' && req.method==='POST')return reply(res,200,await oauth.begin(user.actor));
      if(url.pathname==='/v1/email/disconnect' && req.method==='POST')return reply(res,200,await oauth.disconnect(user.actor));
      if(url.pathname==='/v1/email/drafts' && req.method==='POST'){
        const draft=await sizeLimitedJson(req);
        const valid=new Set(caseEvidence(draft.incidentId).items.map(i=>i.id));
        if((draft.evidenceRefs??[]).some(ref=>!valid.has(ref)))throw new Error('evidence reference missing from this incident');
        return reply(res,201,await service.compose(draft,user.actor));
      }
      const m=/^\/v1\/email\/drafts\/([a-f0-9-]{36})(?:\/(approve|send))?$/.exec(url.pathname);
      if(m && req.method==='GET' && !m[2])return reply(res,200,await service.review(m[1],user.actor));
      if(m && req.method==='PUT' && !m[2])return reply(res,200,await service.edit(m[1],await sizeLimitedJson(req),user.actor));
      if(m && req.method==='POST' && m[2]==='approve')return reply(res,200,await service.approve(m[1],(await sizeLimitedJson(req)).digest,user.actor));
      if(m && req.method==='POST' && m[2]==='send')return reply(res,200,await service.send(m[1],user.actor));
      if(/^\/v1\/email\/drafts\/[a-f0-9-]{36}\/sync$/.test(url.pathname) && req.method==='POST')
        return reply(res,200,await service.reconcileTimeline(url.pathname.split('/')[4],user.actor));
      return reply(res,404,{error:'email operation not found'});
    }catch(err){
      // Never expose credentials, private drafts, OAuth responses or exception stacks.
      const code=/required|refused|missing|disabled|expired|not approved|changed|already|unavailable|not connected|not found|not configured|not permitted|invalid/i.test(err.message)?409:503;
      return reply(res,code,{error:'email operation could not be completed; review authorization, connection and exact draft status'});
    }
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(process.env.GB2L_EMAIL_BACKEND_MODE!=='protected')throw new Error('Protected backend mode is not enabled');
  const port=Number(process.env.GB2L_EMAIL_PORT||8443);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid protected backend port');
  createProtectedEmailServer().listen(port,process.env.GB2L_EMAIL_BIND_HOST||'127.0.0.1',()=>{
    console.log('Protected Email Communications HTTPS service listening (Gmail sends disabled unless separately authorized)');
  });
}
