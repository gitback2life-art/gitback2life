// Adapted copy of the v9 independent review's Node instrumentation (original: gitback2life_audit_v9\
// independent_v9_limits.test.mjs, preserved unchanged). Adaptation: the import points at the working toolbox.
// Assertions unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {syncBuiltinESMExports} from 'node:module';
import {sanitizePng} from '../_shared/image_policy.mjs';
const chunk=(type,data)=>{const t=Buffer.from(type),b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(zlib.crc32(Buffer.concat([t,data]))>>>0,8+data.length);return b;};
function png(w,h,raw) {
 const hdr=Buffer.alloc(13);hdr.writeUInt32BE(w);hdr.writeUInt32BE(h,4);hdr[8]=8;hdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
test('independent instrumentation: Node passes exact output limit and refuses overrun',()=>{
 const input=png(1,1,Buffer.alloc(64)),original=zlib.inflateSync,calls=[];
 zlib.inflateSync=function(data,options){calls.push({...options});return original(data,options);};syncBuiltinESMExports();
 try {assert.throws(()=>sanitizePng(input),/larger than the header says/);assert.deepEqual(calls,[{info:true,maxOutputLength:5}]);}
 finally{zlib.inflateSync=original;syncBuiltinESMExports();}
});
test('independent instrumentation: over-budget header never reaches Node decompressor',()=>{
 const input=png(4096,4096,Buffer.alloc(5)),original=zlib.inflateSync;let calls=0;
 zlib.inflateSync=function(){calls++;throw new Error('unexpected decompressor call');};syncBuiltinESMExports();
 try {assert.throws(()=>sanitizePng(input),/decoded image would exceed/);assert.equal(calls,0);}
 finally{zlib.inflateSync=original;syncBuiltinESMExports();}
});
