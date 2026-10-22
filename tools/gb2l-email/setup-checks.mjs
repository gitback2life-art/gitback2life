import {createPublicKey,createPrivateKey} from 'node:crypto';
import {OWNER} from './policy.mjs';

export function assertOwner(account, repository) {
  if(account?.login!==OWNER || repository?.permissions?.admin!==true)
    throw Error('Sign in to GitHub CLI as gitback2life-art with repository ADMIN access. Maintainer access cannot configure environments/secrets.');
}
export function assertSoloProtection(branch) {
  if(branch?.enforce_admins?.enabled!==true || branch.allow_force_pushes?.enabled!==false || branch.allow_deletions?.enabled!==false ||
     !branch.required_pull_request_reviews || branch.required_pull_request_reviews.required_approving_review_count!==0 ||
     branch.required_pull_request_reviews.require_code_owner_reviews!==false ||
     branch.required_status_checks?.strict!==true || !branch.required_status_checks.contexts?.includes('email-tests'))
    throw Error('Solo main protection requires PRs, zero required approvals, email-tests (strict), enforced admins, no force pushes/deletions.');
  const bypass=branch.required_pull_request_reviews.bypass_pull_request_allowances;
  if(bypass && ['users','teams','apps'].some(k=>bypass[k]?.length))throw Error('PR bypass allowances are not permitted');
}
export function assertManualEnvironment(data) {
  const reviews=data?.protection_rules?.filter(x=>x.type==='required_reviewers');
  const rule=reviews?.[0];
  if(data?.can_admins_bypass!==false || reviews?.length!==1 || rule.prevent_self_review!==false ||
     rule.reviewers?.length!==1 || rule.reviewers[0].type!=='User' || rule.reviewers[0].reviewer?.login!==OWNER)
    throw Error('Owner approval gate must allow self-review, disable admin bypass and require only gitback2life-art');
}
export function assertKeyPair(publicPem, privatePem) {
  const priv=createPrivateKey(privatePem),pub=createPublicKey(publicPem);
  if(priv.asymmetricKeyType!=='rsa'||priv.asymmetricKeyDetails?.modulusLength<3072 ||
     !createPublicKey(priv).export({type:'spki',format:'der'}).equals(pub.export({type:'spki',format:'der'})))
    throw Error('Private key does not match the published RSA public key');
}
