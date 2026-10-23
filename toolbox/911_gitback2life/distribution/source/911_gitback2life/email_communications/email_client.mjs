// User-facing Email Communications client. HTTPS to the dedicated protected
// email-only backend; it never stores drafts or Gmail tokens on volunteer PCs.
import {readFileSync,lstatSync} from 'node:fs';

function settings() {
  const root=process.env.GB2L_EMAIL_API_URL;
  const tokenPath=process.env.GB2L_EMAIL_OPERATOR_TOKEN_FILE;
  if(!root||!tokenPath||!/^https:\/\//.test(root)||/[@?#]/.test(new URL(root).origin))
    throw new Error('Email Communications backend not configured: see email_communications/README.md');
  if(new URL(root).username||new URL(root).password||new URL(root).pathname!=='/' ||new URL(root).search)
    throw new Error('Email backend URL must be an HTTPS origin only');
  if(!lstatSync(tokenPath).isFile()||lstatSync(tokenPath).isSymbolicLink())throw new Error('operator token must be a protected ordinary file');
  const token=readFileSync(tokenPath,'utf8').trim();
  if(!/^[\w.-]{32,256}$/.test(token))throw new Error('protected operator token not configured');
  return {root:new URL(root).origin,token};
}
export async function emailRequest(path,method='GET',body) {
  const {root,token}=settings();
  if(!/^\/v1\/email\/[a-z0-9\/-]+$/.test(path))throw new Error('unapproved email endpoint');
  const res=await fetch(root+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!res.ok)throw new Error(`Protected email backend declined the request (${res.status}). No email is assumed sent.`);
  return res.json();
}
export function configured(){try{settings();return true;}catch{return false;}}
// The caller supplies the existing Toolbox's guided ask/chooseCase functions;
// nothing here elevates permissions or silently calls Send.
export async function emailMenu({ask,chooseCase,suggest}) {
  if(!configured()){
    console.log('Email Communications is not yet connected to an owner-protected backend. Sending remains disabled.');
    console.log('See email_communications/README.md for owner setup. No credentials are requested in this Toolbox window.');
    return;
  }
  console.log('Email Communications — personal Gmail accounts, inbox reading, bulk email and attachments are NOT supported.');
  const menu= ['Compose email for an incident','Review exact draft','Edit draft','Approve exact reviewed draft','Send approved message',
    'Connection status','Begin owner Google connection','Disconnect owner Google account'];
  while(true){
    menu.forEach((v,i)=>console.log(`  ${i+1}  ${v}`));console.log('  0  Back');
    const command=await ask('Email action: ');
    if(command==='0'||!command)return;
    if(!/^[1-8]$/.test(command)){console.log('Choose an action 1-8, or 0 to return.');continue;}
    try{
      if(command==='1'){
        const incidentId=await chooseCase();
        const to=await ask('Exact To address (one recipient only): ');
        let suggestion=null;
        if(suggest && (await ask('Use evidence-based notice text from this case? (yes/no): ')).toLowerCase()==='yes') {
          const audience=await ask('Audience organization/maintainer/registrar/host: ');
          suggestion=suggest(incidentId,audience);
          console.log('Suggested draft (review every line, no automatic sending):',suggestion.subject,'\n',suggestion.body);
        }
        const subject=(await ask('Subject (blank uses suggested subject): '))||suggestion?.subject||'';
        console.log('Paste the plain-text message. End on a line containing only .END');
        const lines=[];
        while(lines.join('\n').length<15000){const line=await ask('> ');if(line==='.END')break;lines.push(line);}
        const refs=(await ask('Evidence reference IDs, comma separated (optional): ')).split(',').map(x=>x.trim()).filter(Boolean);
        const created=await emailRequest('/v1/email/drafts','POST',{incidentId,to,subject,body:lines.length?lines.join('\n'):suggestion?.body||'',evidenceRefs:refs});
        console.log(`Draft created: ${created.id}. Status: ${created.status}. Not sent.`);
      } else if(['2','3','4','5'].includes(command)) {
        const id=await ask('Draft ID (UUID shown when composed): ');
        if(!/^[a-f0-9-]{36}$/.test(id)){console.log('Invalid draft ID.');continue;}
        const path=`/v1/email/drafts/${id}`;
        const r=await emailRequest(path);
        console.log('\nREVIEW — unsent unless status explicitly says sent');
        console.log(`Incident: ${r.draft.incidentId}\nFrom: ${r.draft.from}\nTo: ${r.draft.to}\nCc: (disabled)\nBcc: (disabled)`);
        console.log(`Subject: ${r.draft.subject}\nAttachments: (disabled)\nMessage:\n${r.draft.body}`);
        console.log(`Status: ${r.status}\nExact draft SHA-256: ${r.digest}`);
        if(command==='3'){
          console.log('Editing invalidates any prior approval.');
          const subject=await ask('New subject (leave blank to retain): ');
          const to=await ask('New recipient (leave blank to retain): ');
          const msg=await ask('New complete plain-text message (leave blank to retain): ');
          if(await ask('Type EDIT to save your changes: ')==='EDIT')console.log(await emailRequest(path,'PUT',
            {...(subject?{subject}:{}),...(to?{to}:{}),...(msg?{body:msg}:{})}));
        }
        if(command==='4'){
          console.log('Approval binds to the exact displayed contents.');
          if(await ask('Type APPROVE followed by the first 12 SHA-256 characters: ')===`APPROVE ${r.digest.slice(0,12)}`)
            console.log(await emailRequest(path+'/approve','POST',{digest:r.digest}));
          else console.log('Not approved.');
        }
        if(command==='5'){
          if(r.status!=='awaiting_send'){console.log('Not approved or previously attempted. Cannot send.');continue;}
          if(await ask('Type SEND followed by the first 12 SHA-256 characters: ')===`SEND ${r.digest.slice(0,12)}`)
            console.log('Provider result:',await emailRequest(path+'/send','POST',{}));
          else console.log('Not sent.');
        }
      } else if(command==='6')console.log(await emailRequest('/v1/email/connection'));
      else if(command==='7'){
        const r=await emailRequest('/v1/email/connect','POST',{});
        console.log('Open this Google authorization link in your browser to connect only the approved sender account:');
        console.log(r.url);console.log('Google will redirect back to the protected backend after consent.');
      } else if(command==='8'){
        if(await ask('Type DISCONNECT to remove the protected Gmail connection: ')==='DISCONNECT')
          console.log(await emailRequest('/v1/email/disconnect','POST',{}));
        else console.log('Connection unchanged.');
      }
    } catch(e) {console.log('Email action refused:',e.message);}
  }
}
