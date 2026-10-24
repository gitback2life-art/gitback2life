import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHandler,TOOL} from './inbox-gateway.mjs';

test('exposes only bounded read-only email tool',()=>{
 assert.equal(TOOL.name,'read_emails');
 assert.equal(TOOL.inputSchema.properties.limit.maximum,5);
});
test('authentication and MCP discovery with mocked read',async()=>{
 const server=createServer(createHandler({accessToken:'test-token'},async()=>({status:'no_matches',count:0,messages:[]})));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  const call=(message,token)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(message)});
  let r=await call({jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(r.status,401);
  r=await call({jsonrpc:'2.0',id:2,method:'tools/list'},'test-token');
  assert.equal((await r.json()).result.tools[0].name,'read_emails');
  r=await call({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_emails',arguments:{limit:1}}},'test-token');
  assert.equal((await r.json()).result.structuredContent.status,'no_matches');
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('MCP ping and initialization notification are supported',async()=>{
 const server=createServer(createHandler({accessToken:'test-token'},async()=>({status:'no_matches',count:0,messages:[]})));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  const call=message=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-token'},body:JSON.stringify(message)});
  let r=await call({jsonrpc:'2.0',id:4,method:'ping'});
  assert.deepEqual((await r.json()).result,{});
  r=await call({jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(r.status,202);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('full synthetic encrypted request and signed response round trip',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {decodeInboxComment,unsealInboxRequest,signInboxResponse,encodeInboxResponse}=await import('./inbox-transport.mjs');
 const {encryptInboxReturn}=await import('./receive.mjs');
 const {requestEmails}=await import('./inbox-gateway.mjs');
 const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 let comments=[],posted=false;
 const mock=async(url,options)=>{
  if(options.method==='POST'){
   const body=JSON.parse(options.body).body;
   const sealed=decodeInboxComment(body);
   const query=unsealInboxRequest(sealed,keys.privateKey);
   assert.equal(query.filter.limit,2);
   const payload={status:'found',messages:[{from:'sample@example.test',subject:'Synthetic example',date:'test',body_text:'Mock data, no actual Gmail access',message_id:'mock1'}]};
   const response=signInboxResponse(encryptInboxReturn(payload,query.return_public_key,query.request_id),keys.privateKey);
   comments=[{id:101,user:{login:'github-actions[bot]'},body:encodeInboxResponse(response)}];
   posted=true;
   return {ok:true,json:async()=>({id:100,user:{login:'gitback2life-art'},created_at:'2026-10-24T00:00:00Z'})};
  }
  assert.ok(posted);
  return {ok:true,json:async()=>comments};
 };
 const result=await requestEmails({limit:2},{publicKeyPem:keys.publicKey,githubToken:'mock-token',accessToken:'mock-access-token',timeoutMs:10000},mock,async()=>{});
 assert.equal(result.status,'found');
 assert.equal(result.messages[0].subject,'Synthetic example');
 assert.equal(result.messages[0].trust,'untrusted_email_content');
});
