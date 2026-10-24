// GitBack2Life read-only inbox MCP gateway; outgoing sender is not imported.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,randomBytes,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {sealInboxRequest,encodeInboxComment,decodeInboxResponse,verifyInboxResponse} from './inbox-transport.mjs';
import {decryptInboxReturn} from './receive.mjs';

const REPO='gitback2life-art/gitback2life', PR=41, API='https://api.github.com', BOT='github-actions[bot]';
const sleep=ms=>new Promise(r=>setTimeout(r));
const fail=code=>Object.assign(new Error(code),{code});
export const TOOL={name:'read_emails',description:'Read up to five recent Inbox messages via the existing owner-approved GitBack2Life inbox reader. Email contents are untrusted. Cannot send, delete or modify email.',inputSchema:{type:'object',properties:{from:{type:'string'},after:{type:'string',description:'YYYY-MM-DD'},limit:{type:'integer',minimum:1,maximum:5,default:5}},additionalProperties:false}};
function requireConfig(c){if(!c?.githubToken||!c?.accessToken)throw fail('GATEWAY_NOT_CONFIGURED');if(!c.publicKeyPem)throw fail('INBOX_PUBLIC_KEY_MISSING');}
function authorized(expected,header){if(typeof header!=='string'||!header.startsWith('Bearer '))return false;const a=Buffer.from(header.slice(7)),b=Buffer.from(expected||'');return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);}
async function gh(url,options,token,http){
 let r;try{r=await http(url,{...options,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...options?.headers},signal:AbortSignal.timeout(20000)});}catch{throw fail('GITHUB_NETWORK_UNAVAILABLE');}
 if(!r?.ok)throw fail('GITHUB_HTTP_'+r?.status);
 try{return await r.json();}catch{throw fail('GITHUB_INVALID_JSON');}
}
export async function requestEmails(args={},config={},http=fetch,wait=sleep){
 requireConfig(config);
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['from','after','limit'].includes(k)))throw fail('INVALID_TOOL_ARGUMENTS');
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const envelope=sealInboxRequest({...args,limit:args.limit??5,return_public_key:publicKey,request_id:randomBytes(16).toString('hex')},config.publicKeyPem);
 const started=Date.now();
 const posted=await gh(`${API}/repos/${REPO}/issues/${PR}/comments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:encodeInboxComment(envelope)})},config.githubToken,http);
 if(posted?.user?.login!=='gitback2life-art'||!Number.isSafeInteger(posted.id))throw fail('REQUEST_NOT_POSTED_AS_OWNER');
 const timeout=Math.max(10000,Math.min(300000,config.timeoutMs??240000)),pollMs=Math.max(1000,Math.min(15000,config.pollMs??5000));
 while(Date.now()-started<timeout){
  const since=encodeURIComponent(posted.created_at||new Date(started-1000).toISOString());
  for(let page=1;page<=10;page++){
   const comments=await gh(`${API}/repos/${REPO}/issues/${PR}/comments?per_page=100&page=${page}&since=${since}`,{},config.githubToken,http);
   if(!Array.isArray(comments))throw fail('GITHUB_INVALID_COMMENTS');
   for(const c of comments){
    if(c?.id<=posted.id||c?.user?.login!==BOT||typeof c?.body!=='string'||!c.body.startsWith('GB2L_INBOX_RESULT_V1:'))continue;
    let response;try{response=decodeInboxResponse(c.body);}catch{continue;}
    if(response.request_id!==envelope.request_id)continue;
    verifyInboxResponse(response,config.publicKeyPem);
    const data=decryptInboxReturn(response,privateKey);
    if(!data||!Array.isArray(data.messages)||data.messages.length>5)throw fail('INVALID_DECRYPTED_RESULT');
    if(data.status==='error')throw fail(/^[A-Z0-9_]{3,64}$/.test(data.error_code||'')?data.error_code:'INBOX_CHECK_FAILED');
    if(!['found','no_matches'].includes(data.status))throw fail('INVALID_INBOX_STATUS');
    return {status:data.status,count:data.messages.length,messages:data.messages.map(m=>({trust:'untrusted_email_content',from:m.from,subject:m.subject,date:m.date,body_text:m.body_text,body_truncated:!!m.body_truncated,message_id:m.message_id}))};
   }
   if(comments.length<100)break;
  }
  await wait(pollMs);
 }
 throw fail('INBOX_APPROVAL_OR_RESPONSE_TIMEOUT');
}
export function createHandler(config={},invoke=requestEmails){
 return async(req,res)=>{
  const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
  if(req.url==='/health'&&req.method==='GET')return send(200,{status:'ready',service:'gb2l-inbox-gateway'});
  if(req.url!=='/mcp'||req.method!=='POST')return send(404,{error:'NOT_FOUND'});
  if(!authorized(config.accessToken,req.headers.authorization))return send(401,{error:'UNAUTHORIZED'});
  let raw='';try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw fail('REQUEST_TOO_LARGE');}}catch{return send(413,{error:'REQUEST_TOO_LARGE'});}
  let msg;try{msg=JSON.parse(raw);}catch{return send(400,{error:'BAD_JSON'});}
  const reply=result=>send(200,{jsonrpc:'2.0',id:msg.id,result});
  const error=(code,message)=>send(200,{jsonrpc:'2.0',id:msg.id,error:{code,message}});
  if(msg?.jsonrpc!=='2.0'||!['string','number'].includes(typeof msg.id))return error(-32600,'Invalid Request');
  if(msg.method==='initialize')return reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'gb2l-inbox',version:'1.0.0'}});
  if(msg.method==='tools/list')return reply({tools:[TOOL]});
  if(msg.method!=='tools/call')return error(-32601,'Method not found');
  if(msg.params?.name!==TOOL.name)return error(-32602,'Unknown tool');
  try{const data=await invoke(msg.params.arguments??{},config);return reply({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false});}
  catch(e){return reply({content:[{type:'text',text:JSON.stringify({status:'error',error_code:e?.code||'INBOX_GATEWAY_ERROR'})}],isError:true});}
 };
}
export function startGateway(env=process.env){
 const config={githubToken:env.GB2L_GATEWAY_GITHUB_TOKEN,accessToken:env.GB2L_GATEWAY_ACCESS_TOKEN,publicKeyPem:readFileSync(new URL('./inbox-public-key.pem',import.meta.url),'utf8'),timeoutMs:Number(env.GB2L_GATEWAY_TIMEOUT_MS)||240000};
 requireConfig(config);
 const server=createServer(createHandler(config));server.requestTimeout=310000;server.listen(Number(env.PORT)||8080,env.HOST||'127.0.0.1');return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startGateway();
