// Configuration is an owner-managed GitHub environment secret, NOT a tracked file or issue.
export const OWNER='gitback2life-art';
export const REPO='gitback2life-art/gitback2life';
export const SENDER='gitback2life.ai@gmail.com';
export function requestedMode(raw){
  if(raw===undefined||raw===null||raw==='')return 'approval_required';
  if(!['approval_required','auto_send','disabled'].includes(raw))throw new Error('Unknown sending mode; refusing all sends');
  return raw;
}
const keys=(x)=>Object.keys(x).sort().join(',');
export function parsePolicy(raw, mode, actor){
  if(typeof raw!=='string'||raw.length>4096)throw new Error('Owner-controlled policy secret unavailable');
  let p;try{p=JSON.parse(raw)}catch{throw new Error('Owner-controlled policy is malformed')}
  if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Invalid owner policy');
  const permitted=['version','mode','owner','requester','sender','daily_limit','recipients','domains'];
  if(Object.keys(p).some(k=>!permitted.includes(k)))throw new Error('Unknown owner policy setting');
  if(p.version!==1||p.mode!==mode||p.owner!==OWNER||p.sender!==SENDER||typeof p.requester!=='string'||!p.requester||p.requester!==actor)throw new Error('Owner authorization/policy mismatch');
  if(!Number.isSafeInteger(p.daily_limit)||p.daily_limit<1||p.daily_limit>30)throw new Error('Invalid daily send quota');
  for(const k of ['recipients','domains']){
    if(p[k]!==undefined&&(!Array.isArray(p[k])||p[k].length>50||p[k].some(v=>typeof v!=='string'||!v||v!==v.toLowerCase()||/[\r\n\s]/.test(v))))throw new Error('Invalid '+k+' restrictions');
  }
  return p;
}
export function permitRecipient(policy,to){
  const rec=to.toLowerCase();
  if(policy.recipients&&policy.recipients.length&&!policy.recipients.includes(rec))throw new Error('Recipient not allowed by owner policy');
  const domain=rec.split('@')[1];
  if(policy.domains&&policy.domains.length&&!policy.domains.includes(domain))throw new Error('Recipient domain not allowed by owner policy');
}
export function assertSendContext({mode,actor,policy,recipient}){
  const effective=requestedMode(mode);
  if(effective==='disabled')throw new Error('Emergency stop active: email disabled');
  const p=parsePolicy(policy,effective,actor);
  permitRecipient(p,recipient);
  return p;
}

// GitHub environment custom deployment policy must allow exactly the main branch.
// Do not accept protected_branches=true alone: it can cover additional branches.
export function assertMainOnlyDeployment(environment, listing){
  const cfg=environment?.deployment_branch_policy;
  if(!cfg||cfg.protected_branches!==false||cfg.custom_branch_policies!==true)
    throw new Error('Autonomous environment must use custom main-only deployment branch policy');
  if(!listing||listing.total_count!==1||!Array.isArray(listing.branch_policies)||listing.branch_policies.length!==1)
    throw new Error('Autonomous environment must have exactly one deployment branch policy');
  const one=listing.branch_policies[0];
  if(one?.name!=='main'||one.type!=='branch')
    throw new Error('Autonomous deployment branch policy must match main only');
  return true;
}
