#!/usr/bin/env node
// Offline owner-only setup. Never reads Gmail, touches credentials, or changes GitHub.
import {existsSync,readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPublicKey,generateKeyPairSync} from 'node:crypto';
import {assertOutsideRepository,securePrivateKeyFile} from './prepare-key.mjs';
export function main(args=process.argv.slice(2)){
  const [target]=args;
  if(!target)throw Error('Usage: node tools/gb2l-email/inbox-prepare-key.mjs /PRIVATE/OUTSIDE-REPO/inbox.private.pem');
  const root=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
  const output=resolve(realpathSync(dirname(resolve(target))),basename(resolve(target)));
  assertOutsideRepository(root,output);
  const pubPath=new URL('./inbox-public-key.pem',import.meta.url);
  if(existsSync(pubPath)&&!existsSync(output))throw Error('Existing inbox public key needs its original private key; no key rotation performed');
  if(!existsSync(output))writeFileSync(output,'',{flag:'wx',mode:0o600});
  securePrivateKeyFile(output);
  if(lstatSync(output).size===0){
    if(existsSync(pubPath))throw Error('Empty private key with published inbox public key; recover original key');
    const pair=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    writeFileSync(output,pair.privateKey,{flag:'w',mode:0o600});
  }
  const pub=createPublicKey(readFileSync(output,'utf8')).export({format:'pem',type:'spki'}).toString();
  if(existsSync(pubPath)){
    if(readFileSync(pubPath,'utf8')!==pub)throw Error('Existing inbox public key does not match private key');
    console.log('Inbox key pair matched; no rotation or Gmail access');
  }else{
    writeFileSync(pubPath,pub,{flag:'wx'});
    console.log('Inbox public key prepared. Commit ONLY inbox-public-key.pem, never your private key');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{main()}catch(e){console.error('Inbox key preparation refused: '+e.message);process.exitCode=1;}
}
