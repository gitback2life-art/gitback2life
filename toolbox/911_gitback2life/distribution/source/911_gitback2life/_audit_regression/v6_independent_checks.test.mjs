// Adapted copy of the v6 independent review's Node checks (original: D:\CRTS apps\MY_tools\gitback2life_audits\gitback2life_audit_v6\independent_v6.test.mjs,
// preserved unchanged). Adaptations: imports point at the working toolbox; fixtures live in .test_tmp and are removed. Assertions unchanged.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {aclProblems,readAcls} from '../_shared/acl_check.mjs';
import {safeWrite} from '../_shared/common.mjs';
import {zipStore,buildPacket} from '../case_packet/case_packet.mjs';
import {createLedger} from '../evidence_ledger/ledger.mjs';
import {_setAuthorityForTests,_resetAuthority,authorityStatus} from '../_shared/authority_link.mjs';
const root=fileURLToPath(new URL('../.test_tmp/',import.meta.url));fs.mkdirSync(root,{recursive:true});
const dir=fs.mkdtempSync(join(root,'independent-v6-'));
after(()=>{fs.rmSync(dir,{recursive:true,force:true});try{fs.rmdirSync(root)}catch{}});
const secret='ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01';
const base={exists:true,reparse:false,owner:'BUILTIN\\Administrators',aces:[{identity:'BUILTIN\\Administrators',rights:'FullControl',type:'Allow'}]};
test('original counterfeit authority is rejected BEFORE executing either module',()=>{
 const d=join(dir,'counterfeit');fs.mkdirSync(d);
 fs.writeFileSync(join(d,'authority_core.mjs'),'globalThis.v6CounterfeitExecuted=true; export const verifyAuthorization=()=>({valid:true});');
 fs.writeFileSync(join(d,'authority_cli.mjs'),'export const readAcl=()=>({}); export const protectionProblems=()=>[];');
 _setAuthorityForTests(d,{checkAcl:true});
 try {assert.equal(authorityStatus().trusted,false);assert.notEqual(globalThis.v6CounterfeitExecuted,true);}finally{_resetAuthority();}
});
test('missing permission entries fail closed',()=>{assert.ok(aclProblems({owner:base.owner}).length);});
for(const rights of ['', '1073741824']) test(`ACL rights ${JSON.stringify(rights)} must not be accepted as safe`,()=>{
 const problems=aclProblems({...base,aces:[...base.aces,{identity:'Everyone',rights,type:'Allow'}]});
 assert.notEqual(problems.length,0);
});
test('ACL subprocess uses a pinned absolute executable',()=>{
 let command;readAcls([],{run:(file)=>{command=file;return '{}';}});
 assert.equal(win32.isAbsolute(command),true,`actual executable: ${command}`);
});
test('a secret in ZIP archive comment cannot persist',()=>{
 const z=zipStore([{name:'safe.txt',data:Buffer.from('safe text')}]);
 z.writeUInt16LE(Buffer.byteLength(secret),z.length-2);
 const withComment=Buffer.concat([z,Buffer.from(secret)]);const out=join(dir,'comment.zip');
 try{safeWrite(out,withComment,{root:dir,binary:'case-packet'});}catch(e){console.log("STORAGE_REFUSAL",e.message);throw e;}
 assert.equal(fs.readFileSync(out).includes(Buffer.from(secret)),false,'raw secret persisted in ZIP comment');
});
test('image trailer must not survive packet construction and disk write',()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=','base64');
 const result=buildPacket(createLedger('synthetic-v6'),[{name:'image.png',data:Buffer.concat([png,Buffer.from(secret)])}],{humanReviewed:true});
 if(result.refused)return;
 const out=join(dir,'image-packet.zip');
 try{safeWrite(out,result.zip,{root:dir,binary:'case-packet'});}catch(e){console.log("STORAGE_REFUSAL",e.message);throw e;}
 assert.equal(fs.readFileSync(out).includes(Buffer.from(secret)),false,'raw secret persisted inside image packet');
});
test('masking a JSON string containing a header preserves valid JSON',()=>{
 const out=join(dir,'report.json');safeWrite(out,JSON.stringify({note:'Authorization: Bearer '+secret}),{root:dir});
 assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(out,'utf8')));
});
test('authority appearance must invalidate cached absent status',()=>{
 const d=join(dir,'appears');_setAuthorityForTests(d,{checkAcl:true});
 try{assert.equal(authorityStatus().installed,false);fs.mkdirSync(d);assert.equal(authorityStatus().installed,true);}finally{_resetAuthority();}
});

