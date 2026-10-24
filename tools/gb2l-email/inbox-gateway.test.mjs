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
