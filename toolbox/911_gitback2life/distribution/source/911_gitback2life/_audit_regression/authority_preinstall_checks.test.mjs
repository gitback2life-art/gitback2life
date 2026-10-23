// Adapted copy of the authority pre-install review's checks (original: D:\CRTS apps\MY_tools\authority_preinstall\checks.mjs,
// preserved unchanged). Adaptations: imports are relative; the fixture folder lives in .test_tmp and is removed. Assertions unchanged.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_setAuthorityForTests,_resetAuthority,authorityStatus} from '../_shared/authority_link.mjs';
import {protectionProblems} from '../authority/authority_cli.mjs';
const base=new URL('../.test_tmp/',import.meta.url);fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(join(fileURLToPath(base),'preinstall-'));
after(()=>{fs.rmSync(dir,{recursive:true,force:true});try{fs.rmdirSync(fileURLToPath(base))}catch{}});
test('untrusted authority code must not run or self-certify before external ACL validation',()=>{
 fs.writeFileSync(join(dir,'authority_core.mjs'),'globalThis.syntheticAuthorityLoaded = true; export const verifyAuthorization = () => ({valid:true});');
 fs.writeFileSync(join(dir,'authority_cli.mjs'),'export const readAcl = () => ({}); export const protectionProblems = () => [];');
 _setAuthorityForTests(dir,{checkAcl:true});
 try{const s=authorityStatus();console.log(JSON.stringify({syntheticCodeExecuted:globalThis.syntheticAuthorityLoaded,trusted:s.trusted}));assert.equal(s.trusted,false);}finally{_resetAuthority();}
});
test('missing ACL entries must fail closed',()=>{assert.notEqual(protectionProblems({owner:'BUILTIN\\Administrators'}).length,0);});
