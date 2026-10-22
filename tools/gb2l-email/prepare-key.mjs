#!/usr/bin/env node
// Offline only. Never authorizes Google or changes GitHub settings.
import {existsSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createPublicKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertKeyPair} from './setup-checks.mjs';
const [file]=process.argv.slice(2);
if(!file)throw Error('Usage: node tools/gb2l-email/prepare-key.mjs /PRIVATE/OUTSIDE-REPO/gb2l.private.pem');
const root=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
const dest=resolve(realpathSync(dirname(resolve(file))),resolve(file).split(/[\\/]/).pop());
const rel=relative(root,dest);
if(!rel.startsWith('..')&&!isAbsolute(rel))throw Error('Private key must be outside the repository');
const pubPath=new URL('./public-key.pem',import.meta.url);
if(existsSync(pubPath)){
  if(!existsSync(dest))throw Error('Public key already exists. Refusing rotation; recover its matching private key.');
  assertKeyPair(readFileSync(pubPath,'utf8'),readFileSync(dest,'utf8'));
  console.log('Existing key pair matches; nothing changed.');
}else{
  if(!existsSync(dest)){
    // Create an empty file first and restrict Windows ACL before writing secret bytes.
    writeFileSync(dest,'',{flag:'wx',mode:0o600});
    if(process.platform==='win32'){
      const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-[0-9-]+/)?.[0];
      if(!sid)throw Error('Cannot determine owner SID; empty key file created, no key generated');
      execFileSync('icacls',[dest,'/inheritance:r','/grant:r',`*${sid}:F`],{stdio:'ignore'});
    }
    const pair=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    writeFileSync(dest,pair.privateKey,{mode:0o600});
  }
  const privateKey=readFileSync(dest,'utf8');
  const publicKey=createPublicKey(privateKey).export({type:'spki',format:'pem'});
  assertKeyPair(publicKey,privateKey);
  writeFileSync(pubPath,publicKey,{flag:'wx'});
  console.log('Public key prepared. Commit only tools/gb2l-email/public-key.pem. Keep the private file outside GitHub and chat.');
}
