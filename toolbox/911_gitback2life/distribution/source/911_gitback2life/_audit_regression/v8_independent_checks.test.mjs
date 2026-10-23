// Adapted copy of the v8 independent review's Node checks (original: audit_2026-10-11_current\snapshot\
// independent_v8.test.mjs, preserved unchanged). Adaptations: imports point at the working toolbox; `root` (where the
// test saves its outputs) is a fresh folder under .test_tmp, removed afterwards, instead of the test's own folder.
// Assertions unchanged, including the control that the only pixel still uses index 255.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {safeWrite,TOOLBOX_ROOT} from '../_shared/common.mjs';
import {parsePng,sanitizePng} from '../_shared/image_policy.mjs';
const parent=join(TOOLBOX_ROOT,'.test_tmp');fs.mkdirSync(parent,{recursive:true});
const root=fs.mkdtempSync(join(parent,'independent-v8-'));
after(()=>{fs.rmSync(root,{recursive:true,force:true});try{if(!fs.readdirSync(parent).length)fs.rmSync(parent,{recursive:true});}catch{}});
const chunk=(t,d)=>{const b=Buffer.from(t),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(d.length);c.writeUInt32BE(crc32(Buffer.concat([b,d]))>>>0);return Buffer.concat([n,b,d,c]);};
const secret=Buffer.from('ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01');
const png=(palette,alpha)=>{const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=3;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('PLTE',palette),...(alpha?[chunk('tRNS',alpha)]:[]),chunk('IDAT',deflateSync(Buffer.from([0,255]))),chunk('IEND',Buffer.alloc(0))]);};
for(const location of ['palette','transparency']) test(`unused ${location} entries below used index must not persist secrets`,()=>{
 const palette=Buffer.alloc(768,120),alpha=Buffer.alloc(256,255);
 secret.copy(location==='palette'?palette:alpha,0);
 const input=png(palette,location==='transparency'?alpha:null);
 const output=sanitizePng(input);
 assert.equal(parsePng(output).rows[1],255,'control: only pixel still uses index 255');
 const target=join(root, `unused-${location}.png`);
 safeWrite(target,input,{root,binary:'image'});
 assert.equal(fs.readFileSync(target).includes(secret),false,'synthetic secret survived in unused non-pixel entries');
});
