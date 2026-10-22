#!/usr/bin/env node
// Requires local trusted code execution. Never uploads a plaintext draft.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {seal} from './crypto.mjs';
import {makeComment} from './request.mjs';
if(process.argv.length!==3)throw new Error('Usage: node tools/gb2l-email/prepare-comment.mjs /PRIVATE/PATH/OUTSIDE/REPO/draft.json');
const pub=readFileSync(new URL('./public-key.pem',import.meta.url),'utf8');
const draft=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
const envelope=seal(draft,pub);
console.log(makeComment(envelope));
console.error('PRIVATE OWNER RECEIPT — DO NOT POST THIS LINE TO GITHUB');
console.error('DRAFT ID: '+envelope.id+'  COMMITMENT: '+envelope.commitment+'  PRIVATE NONCE: '+envelope.private_receipt.commitment_nonce);
