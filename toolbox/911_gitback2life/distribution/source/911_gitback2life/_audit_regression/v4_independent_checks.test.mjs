// Adapted copy of the fourth (v4) independent review's checks
// (original: D:\CRTS apps\MY_tools\gitback2life_audit_v4\independent_checks.mjs, preserved unchanged).
// Adaptations: imports point at the working toolbox; fixtures live in .test_tmp/v4-<uuid> and are removed afterwards.
// Assertions are unchanged.
import test,{afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {template,requireScope,clearActiveScope} from '../_shared/scope.mjs';
import {configurePolite,resetPolite,politeFetch,cached,readCache} from '../_shared/polite.mjs';
import {safeWrite,TOOLBOX_ROOT as root} from '../_shared/common.mjs';
import {checkIsolation,EXPECTED_RULES} from '../_shared/isolation.mjs';
import {BLOCKED_RANGES} from '../sandbox_setup/sandbox_setup.mjs';
import {commandProblems,resolveRunner,splitCommand,offlineEnv} from '../regression_harness/run_offline.mjs';
import {createLedger} from '../evidence_ledger/ledger.mjs';
import {fileProblems} from '../case_packet/case_packet.mjs';
const base=join(root,'.test_tmp',`v4-${randomUUID()}`);fs.mkdirSync(base,{recursive:true});
after(()=>{clearActiveScope();fs.rmSync(base,{recursive:true,force:true});try{fs.rmdirSync(join(root,'.test_tmp'))}catch{}});
afterEach(()=>clearActiveScope());
function init(name,change={}){clearActiveScope();resetPolite();const dir=join(base,name);fs.mkdirSync(dir);let t=Date.now();configurePolite({dir,clock:()=>t,wait:async ms=>{t+=ms}});const s={...template(),incident_id:'incident-alpha',targets:['alpha.example','owner/fake'],disclosures:['rdap'],persistence:'local',...change};const p=join(dir,'scope.json');fs.writeFileSync(p,JSON.stringify(s));return {dir,s,p};}
const response=(status=200,location)=>new Response('',{status,headers:location?{location}:undefined});
for(const destination of ['https://unrelated.example/rdap/domain/alpha.example','https://rdap.unrelated.example/domain/alpha.example'])test('V4-01 RDAP redirect refuses unrelated '+destination,async()=>{const {p}=init('rdap-'+(destination.includes('/rdap/')?'path':'host'));requireScope(p,{action:'passive_lookup',target:'alpha.example',services:['rdap']});const sent=[];try{await politeFetch('https://rdap.org/domain/alpha.example',{}, {fetchImpl:async u=>{sent.push(u.href);if(u.pathname==='/robots.txt')return response();return u.hostname==='rdap.org'?response(302,destination):response();}})}catch{}assert.equal(sent.some(u=>u.includes('unrelated.example')),false,JSON.stringify(sent));});
test('V4-02 revoking save_local stops already-authorized write',()=>{const {p,s,dir}=init('save');s.permissions.save_local=true;fs.writeFileSync(p,JSON.stringify(s));requireScope(p,{action:'passive_lookup',target:'alpha.example',services:['rdap']});requireScope(p,{action:'save_local'});s.permissions.save_local=false;fs.writeFileSync(p,JSON.stringify(s));assert.throws(()=>safeWrite(join(dir,'report.json'),'{}'),/scope|permitted/);});
test('V4-02 transient edit prevents result-cache persistence',async()=>{const {p,s}=init('cache');s.permissions.save_local=true;fs.writeFileSync(p,JSON.stringify(s));requireScope(p,{action:'passive_lookup',target:'alpha.example',services:['rdap']});await cached('synthetic-result',async()=>{s.persistence='transient';s.permissions.save_local=false;fs.writeFileSync(p,JSON.stringify(s));return {synthetic:'evidence'};}).catch(()=>{});assert.equal(readCache('synthetic-result'),null);});
test('V4-03 stop during rate wait prevents next unsent request',async()=>{const {p,s,dir}=init('stop');let t=Date.now();configurePolite({dir,clock:()=>t,wait:async ms=>{t+=ms;s.status='stopped';fs.writeFileSync(p,JSON.stringify(s));}});requireScope(p,{action:'passive_lookup',target:'alpha.example',services:['rdap']});const sent=[];try{await politeFetch('https://rdap.org/domain/alpha.example',{}, {fetchImpl:async u=>{sent.push(u.href);return response();}})}catch{}assert.deepEqual(sent,['https://rdap.org/robots.txt']);});
test('V4-04 isolation rejects DNS rule for a different resolver',()=>{const rules=EXPECTED_RULES.inspect.map(e=>({...e,program:'Any',profile:'Any',remoteAddress:e.remoteAddress==='blocked-ranges'?BLOCKED_RANGES:e.remoteAddress==='resolver'?['8.8.8.8']:e.remoteAddress}));const state={platform:'win32',username:'WDAGUtilityAccount',profiles:['Domain','Private','Public'].map(name=>({name,enabled:true,defaultOutbound:'Block'})),rules,otherAllow:0,adaptersUp:1,resolverAddresses:['172.20.0.1']};assert.equal(checkIsolation('inspect',{env:{GITBACK2LIFE_ISOLATED:'inspect'},state}).isolated,false);});
test('V4-04 unreadable block-rule profile must fail closed',()=>{const rules=EXPECTED_RULES.inspect.map(e=>({...e,program:'Any',profile:'Any',remoteAddress:e.remoteAddress==='blocked-ranges'?BLOCKED_RANGES:e.remoteAddress==='resolver'?['172.20.0.1']:e.remoteAddress}));delete rules.at(-1).profile;const state={platform:'win32',username:'WDAGUtilityAccount',profiles:['Domain','Private','Public'].map(name=>({name,enabled:true,defaultOutbound:'Block'})),rules,otherAllow:0,adaptersUp:1};assert.equal(checkIsolation('inspect',{env:{GITBACK2LIFE_ISOLATED:'inspect'},state}).isolated,false);});
test('V4-05 runner refuses lifecycle flag override (no child executed)',()=>{const cmd='npm test --ignore-scripts=false';const result={problems:commandProblems(cmd),runner:resolveRunner(splitCommand(cmd))};assert.notEqual(result.problems.length,0,JSON.stringify(result));});
test('V4-06 supplied child probe inherits dead proxy rather than isolating OS boundary',()=>{const env=offlineEnv({});assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:9');const src=fs.readFileSync(join(root,'regression_harness/containment_probe/probe.test.mjs'),'utf8');assert.match(src,/spawnSync\(curl/);assert.doesNotMatch(src,/--noproxy|--proxy|env\s*:/);});
test('V4-07 cross-incident ledger export is refused',()=>{const {p,s,dir}=init('cross');s.permissions.save_local=true;fs.writeFileSync(p,JSON.stringify(s));const ledger=createLedger('unrelated-incident-beta');const input=join(dir,'ledger.json'),output=join(dir,'export.md');fs.writeFileSync(input,JSON.stringify(ledger));const r=spawnSync(process.execPath,['--import',pathToFileURL(join(root,'regression_harness/network_guard.mjs')).href,join(root,'evidence_ledger/ledger.mjs'),'render',input,'--scope',p,'--save',output],{encoding:'utf8',timeout:10000});assert.equal(fs.existsSync(output),false,'CLI exit='+r.status);});
test('V4-08 shortcut-reference Markdown image is rejected',()=>{assert.notDeepEqual(fileProblems('evidence.md',Buffer.from('![beacon]\n\n[beacon]: https://tracking.example/pixel.png')),[]);});
