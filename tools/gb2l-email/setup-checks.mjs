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
export const GMAIL_SEND_SCOPE='https://www.googleapis.com/auth/gmail.send';
// Google's consent screen lets the account holder untick individual permissions, so a successful
// token exchange does not prove gmail.send was granted. Fail closed before any secret is written.
export function assertGmailSendGranted(token) {
  const scopes=typeof token?.scope==='string'?token.scope.split(/\s+/):[];
  if(!scopes.includes(GMAIL_SEND_SCOPE))
    throw Error('Google did not grant gmail.send (the send-email permission was unticked or not offered). No GitHub secrets were changed. Restart setup and keep the Gmail send permission ticked on the consent screen.');
}
export function assertKeyPair(publicPem, privatePem) {
  const priv=createPrivateKey(privatePem),pub=createPublicKey(publicPem);
  if(priv.asymmetricKeyType!=='rsa'||priv.asymmetricKeyDetails?.modulusLength<3072 ||
     !createPublicKey(priv).export({type:'spki',format:'der'}).equals(pub.export({type:'spki',format:'der'})))
    throw Error('Private key does not match the published RSA public key');
}

export function assertSoloMainRuleset(rulesets) {
  if (!Array.isArray(rulesets)) throw Error('Cannot verify GitHub main branch ruleset; expected a ruleset list.');
  const matching = rulesets.filter(r =>
    r?.target === 'branch' &&
    r?.conditions?.ref_name?.include?.length === 1 &&
    r.conditions.ref_name.include[0] === 'refs/heads/main' &&
    Array.isArray(r.conditions.ref_name.exclude) &&
    r.conditions.ref_name.exclude.length === 0
  );
  const valid = matching.filter(r => {
    const rules = r.rules || [];
    const types = new Set(rules.map(x => x.type));
    const pr = rules.find(x => x.type === 'pull_request')?.parameters;
    const status = rules.find(x => x.type === 'required_status_checks')?.parameters;
    return r.enforcement === 'active' &&
      Array.isArray(r.bypass_actors) && r.bypass_actors.length === 0 &&
      types.has('deletion') && types.has('non_fast_forward') &&
      pr?.required_approving_review_count === 0 &&
      pr?.require_code_owner_review === false &&
      Array.isArray(pr?.required_reviewers) && pr.required_reviewers.length === 0 &&
      status?.strict_required_status_checks_policy === true &&
      status?.do_not_enforce_on_create === false &&
      Array.isArray(status?.required_status_checks) &&
      status.required_status_checks.some(x => x?.context === 'email-tests');
  });
  if (valid.length === 0) {
    throw Error('Solo-owner main ruleset missing or unsafe. Require an active exact-main rule, no bypass actors, PRs with zero required approvals, strict email-tests, no deletions and no force pushes.');
  }
  return true;
}
