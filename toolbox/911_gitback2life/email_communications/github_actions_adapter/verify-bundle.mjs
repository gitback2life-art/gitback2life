#!/usr/bin/env node
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const scripts = [".gitignore","ASSISTANT_GUIDE.md","OWNER_SETUP.md","crypto.mjs","email.test.mjs","identity.mjs","inspect.mjs","owner-mode.mjs","owner-setup.mjs","policy.mjs","preflight.mjs","prepare-comment.mjs","prepare-key.mjs","public-key.pem","readiness.mjs","readiness.test.mjs","request.mjs","review-local.html","seal.mjs","send.mjs","setup-checks.mjs","setup.test.mjs"];
const workflows = ["gb2l-approved-email.yml","gb2l-email-preflight.yml","gb2l-email-readiness.yml","gb2l-email-tests.yml"];
const mappings = [
  ...scripts.filter(name=>name!=='ASSISTANT_GUIDE.md').map(name => [
    resolve('tools/gb2l-email',name),
    resolve('toolbox/911_gitback2life/email_communications/github_actions_adapter',name),
    'script: '+name
  ]),
  ['tools/gb2l-email/ASSISTANT_GUIDE.md',
   'toolbox/911_gitback2life/email_communications/github_actions_adapter/ASSISTANT_GUIDE.md',
   'assistant guide'],
  ...workflows.map(name => [
    resolve('.github/workflows',name),
    resolve('toolbox/911_gitback2life/email_communications/github_actions_adapter/workflow-templates',name),
    'workflow: '+name
  ])
];
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const errors=[];
for(const [canonical,bundled,label] of mappings){
  if(!existsSync(canonical)){errors.push('canonical file missing: '+canonical);continue;}
  if(!existsSync(bundled)){errors.push('bundled file missing: '+bundled);continue;}
  if(sha(canonical)!==sha(bundled))errors.push('bundle differs from canonical source: '+label);
}
const root=resolve('toolbox/911_gitback2life/email_communications/github_actions_adapter');
for(const denied of ['gb2l.private.pem','client_secret.json','.env','credentials.json','refresh_token.txt']){
  if(existsSync(resolve(root,denied)))errors.push('forbidden credential-like file exists: '+denied);
}
if(errors.length){
  console.error('Toolbox email adapter bundle verification FAILED.');
  for(const e of errors)console.error('- '+e);
  process.exitCode=1;
}else{
  console.log('Toolbox email adapter bundle verified: '+scripts.length+' script files and '+workflows.length+' workflow templates match canonical sources.');
  console.log('No forbidden credential-like files found at the bundle root.');
}
