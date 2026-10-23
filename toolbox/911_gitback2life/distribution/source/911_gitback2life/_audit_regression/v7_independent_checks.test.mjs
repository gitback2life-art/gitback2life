// Adapted copy of the v7 independent review's Node checks (original: gitback2life_audit_v7\independent_v7.test.mjs,
// preserved unchanged). Adaptations: imports point at the working toolbox; the fixture folder is under .test_tmp and
// removed afterwards. Assertions unchanged.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {safeWrite,prepareForStorage,maskStoredText,zipStore,readStoredZip,TOOLBOX_ROOT} from '../_shared/common.mjs';
import {sanitizeImage} from '../_shared/image_policy.mjs';
const parent=join(TOOLBOX_ROOT,'.test_tmp');fs.mkdirSync(parent,{recursive:true});
const fixture=fs.mkdtempSync(join(parent,'independent-fixture-'));
after(()=>{fs.rmSync(fixture,{recursive:true,force:true});try{if(!fs.readdirSync(parent).length)fs.rmSync(parent,{recursive:true});}catch{}});
const secret='ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01';
const chunk=(type,data)=>{const t=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};
const png=(extra=[])=>{const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),...extra,chunk('IDAT',deflateSync(Buffer.from([0,1,2,3]))),chunk('IEND',Buffer.alloc(0))]);};
test('control: clean PNG is accepted and ordinary JSON header remains valid and masked',()=>{
 assert.ok(sanitizeImage(png()).length);
 const out=maskStoredText(JSON.stringify({note:'Authorization: Bearer '+secret}));
 assert.equal(typeof JSON.parse(out).note,'string');assert.equal(out.includes(secret),false);
});
test('control: old ZIP-comment leak is removed by rebuild',()=>{
 const z=zipStore([{name:'safe.txt',data:Buffer.from('safe')}]);z.writeUInt16LE(secret.length,z.length-2);
 const out=prepareForStorage(Buffer.concat([z,Buffer.from(secret)]),{binary:'case-packet'});
 assert.equal(out.includes(Buffer.from(secret)),false);assert.equal(readStoredZip(out).entries.length,1);
});
test('PNG invalid transparency payload must not preserve a secret',()=>{
 const out=join(fixture,'transparency.png');
 try{safeWrite(out,png([chunk('tRNS',Buffer.from(secret))]),{root:fixture,binary:'image'});}catch(e){if(/image refused|refusing to save/.test(e.message))return;throw e;}
 assert.equal(fs.readFileSync(out).includes(Buffer.from(secret)),false,'unvalidated non-pixel tRNS bytes persisted');
});
const seg=(marker,data)=>{const h=Buffer.from([255,marker,0,0]);h.writeUInt16BE(data.length+2,2);return Buffer.concat([h,data]);};
test('JPEG frame-header extra bytes must not preserve a secret',()=>{
 const sof=Buffer.concat([Buffer.from([8,0,1,0,1,1,1,17,0]),Buffer.from(secret)]);
 const jpeg=Buffer.concat([Buffer.from([255,216]),seg(192,sof),seg(218,Buffer.from([1,1,0,0,63,0])),Buffer.from([18,52,255,217])]);
 const out=join(fixture,'frame.jpg');
 try{safeWrite(out,jpeg,{root:fixture,binary:'image'});}catch(e){if(/image refused|refusing to save/.test(e.message))return;throw e;}
 assert.equal(fs.readFileSync(out).includes(Buffer.from(secret)),false,'non-pixel SOF header extra bytes persisted');
});
test('ZIP entry names must not retain a recognized secret',()=>{
 const z=zipStore([{name:secret+'.txt',data:Buffer.from('ordinary text')}]);const out=join(fixture,'name.zip');
 try{safeWrite(out,z,{root:fixture,binary:'case-packet'});}catch(e){if(/refus|mask|secret/.test(e.message))return;throw e;}
 assert.equal(fs.readFileSync(out).includes(Buffer.from(secret)),false,'raw secret in entry name persisted');
});
test('sensitive JSON object fields must be redacted as a whole',()=>{
 const value='SYNTHETIC-CREDENTIAL-VALUE';const out=join(fixture,'credentials.json');
 safeWrite(out,JSON.stringify({credentials:{value}}),{root:fixture});
 assert.equal(fs.readFileSync(out,'utf8').includes(value),false,'nested sensitive object retained its value');
});
