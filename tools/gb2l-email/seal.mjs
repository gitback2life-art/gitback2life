#!/usr/bin/env node
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { seal } from './crypto.mjs';
const args=process.argv.slice(2);
if(args.length!==1)throw new Error('Usage: node tools/gb2l-email/seal.mjs /private/path/to/draft.json');
const pub=readFileSync(new URL('./public-key.pem',import.meta.url),'utf8');
const draft=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
const e=seal(draft,pub);
const out=join('mail','outbox',e.id+'.sealed.json');
mkdirSync(join('mail','outbox'),{recursive:true});
writeFileSync(out,JSON.stringify(e,null,2)+'\n',{flag:'wx',mode:0o600});
console.log('SEALED FILE: '+out);
console.log('DRAFT ID: '+e.id);
console.log('APPROVAL COMMITMENT: '+e.commitment);
console.log('Only commit the SEALED FILE. Never commit the original draft.');
