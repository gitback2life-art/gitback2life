#!/usr/bin/env node
// Offline only. Never authorizes Google or changes GitHub settings.
import {existsSync,lstatSync,readFileSync,writeFileSync,realpathSync,chmodSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,basename,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {generateKeyPairSync,createPublicKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertKeyPair} from './setup-checks.mjs';

export function assertOutsideRepository(root,destination) {
  const rel=relative(resolve(root),resolve(destination));
  const inside=rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));
  if(inside)throw Error('Private key must be outside the repository');
  return true;
}

export function securePrivateKeyFile(destination,{platform=process.platform,run=execFileSync}={}) {
  const st=lstatSync(destination);
  if(!st.isFile()||st.isSymbolicLink())throw Error('Private key path must be a regular, non-symlink file');
  if(platform==='win32'){
    const who=run('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8'});
    const sid=who.match(/S-1-[0-9-]+/)?.[0];
    if(!sid)throw Error('Cannot determine owner SID; refusing to read private key');
    // Reset stale explicit ACLs, remove inherited ACEs, then grant only the signed-in owner.
    run('icacls',[destination,'/reset'],{stdio:'ignore'});
    run('icacls',[destination,'/inheritance:r','/grant:r',`*${sid}:F`],{stdio:'ignore'});
  }else{
    chmodSync(destination,0o600);
    const checked=lstatSync(destination);
    if((checked.mode&0o077)!==0)throw Error('Private key file permissions remain accessible to group/other users');
  }
  return true;
}

export function main(args=process.argv.slice(2)) {
  const [file]=args;
  if(!file)throw Error('Usage: node tools/gb2l-email/prepare-key.mjs /PRIVATE/OUTSIDE-REPO/gb2l.private.pem');
  const root=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
  const resolved=resolve(file);
  const dest=resolve(realpathSync(dirname(resolved)),basename(resolved));
  assertOutsideRepository(root,dest);
  const pubPath=new URL('./public-key.pem',import.meta.url);

  if(existsSync(pubPath)){
    if(!existsSync(dest))throw Error('Public key already exists. Refusing rotation; recover its matching private key.');
    securePrivateKeyFile(dest);
    assertKeyPair(readFileSync(pubPath,'utf8'),readFileSync(dest,'utf8'));
    console.log('Existing key pair matches; permissions were secured and nothing was rotated.');
  }else{
    if(!existsSync(dest))writeFileSync(dest,'',{flag:'wx',mode:0o600});
    securePrivateKeyFile(dest);
    // An empty file left by an interrupted first run is safe to initialize after locking it.
    if(lstatSync(dest).size===0){
      const pair=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
      writeFileSync(dest,pair.privateKey,{flag:'w',mode:0o600});
    }
    const privateKey=readFileSync(dest,'utf8');
    const publicKey=createPublicKey(privateKey).export({type:'spki',format:'pem'});
    assertKeyPair(publicKey,privateKey);
    writeFileSync(pubPath,publicKey,{flag:'wx'});
    console.log('Public key prepared. Commit only tools/gb2l-email/public-key.pem. Keep the private file outside GitHub and chat.');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{main()}catch(error){console.error('Key preparation refused: '+error.message);process.exitCode=1;}
}
