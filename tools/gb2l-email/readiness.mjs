#!/usr/bin/env node
// Safe, owner-approved readiness check. It never calls Gmail's send endpoint and never prints secret values.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {assertKeyPair} from './setup-checks.mjs';
import {parsePolicy,OWNER,REPO,SENDER} from './policy.mjs';
import {refreshAccessToken} from './send.mjs';
import {verifySenderIdentity} from './identity.mjs';

const REQUIRED_SECRETS = [
  'GB2L_CONTROL_TOKEN',
  'GB2L_EMAIL_POLICY',
  'GB2L_MAIL_PRIVATE_KEY',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
];

export async function checkSenderReadiness({env=process.env,publicKeyPem,http=fetch}={}) {
  if(env.GITHUB_REPOSITORY!==REPO || env.GITHUB_REF!=='refs/heads/main' || env.GITHUB_ACTOR!==OWNER) {
    throw new Error('Readiness check is allowed only for the repository owner on protected main.');
  }
  if(env.GB2L_EMAIL_MODE!=='disabled') {
    throw new Error('Sending mode must remain disabled for readiness verification.');
  }
  if(env.GB2L_REQUEST_ACTOR!==OWNER || !/^\d+$/.test(env.GB2L_REQUEST_PR||'')) {
    throw new Error('Owner request-channel variables are not configured as expected.');
  }
  const missing=REQUIRED_SECRETS.filter(name=>typeof env[name]!=='string'||env[name].trim()==='');
  if(missing.length) {
    throw new Error('Missing required environment secrets: '+missing.join(', ')+'. Secret values were not displayed; no Google request made.');
  }

  parsePolicy(env.GB2L_EMAIL_POLICY,'approval_required',env.GB2L_REQUEST_ACTOR);
  const privatePem=env.GB2L_MAIL_PRIVATE_KEY.replace(/\\n/g,'\n');
  const publicPem=publicKeyPem ?? readFileSync(new URL('./public-key.pem',import.meta.url),'utf8');
  try {
    assertKeyPair(publicPem,privatePem);
  } catch {
    throw new Error('Private key does not match the published public key or is not a supported RSA private key. Key material was not displayed; no Google request made.');
  }

  // Refreshes a short-lived OAuth access token and checks only the OpenID userinfo
  // endpoint. It never calls Gmail message APIs and does not send email.
  const accessToken=await refreshAccessToken({
    clientId:env.GMAIL_CLIENT_ID,
    clientSecret:env.GMAIL_CLIENT_SECRET,
    refreshToken:env.GMAIL_REFRESH_TOKEN
  },http);
  await verifySenderIdentity(accessToken,http);
  return {
    secretNamesPresent: REQUIRED_SECRETS,
    policyValid: true,
    publicPrivateKeyMatch: true,
    oauthRefreshSucceeded: true,
    senderIdentityVerified: SENDER,
    modeRemainsDisabled: true,
    gmailSendAttempted: false
  };
}

async function main() {
  try {
    const result=await checkSenderReadiness();
    console.log('Sender readiness checks passed.');
    console.log('Secrets present (names only): '+result.secretNamesPresent.join(', '));
    console.log('Owner policy: valid approval_required policy.');
    console.log('Encryption: private key matches the published public key.');
    console.log('Google OAuth: refresh succeeded; verified sender identity is '+result.senderIdentityVerified+'.');
    console.log('Sending mode remains disabled. Gmail send endpoint was not contacted. No email was sent.');
  } catch(error) {
    // Deliberately log only authored validation errors; never log env, request bodies, tokens or response bodies.
    console.error('Sender readiness check failed: '+error.message);
    process.exitCode=1;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
