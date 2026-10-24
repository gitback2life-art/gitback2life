// Public/no-secret preflight: no Gmail calls and no private email contents printed.
import {readFileSync,appendFileSync} from 'node:fs';
import {validateOwnerInboxEvent} from './inbox-transport.mjs';
try{
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
 const e=validateOwnerInboxEvent(event,process.env);
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'ready=yes\n');
 console.log('Encrypted inbox request validated. ID:',e.request_id);
}catch(e){console.error('Inbox request ignored:',e.code||'INVALID_INBOX_EVENT');process.exitCode=1;}
