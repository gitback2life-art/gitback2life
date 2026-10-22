#!/usr/bin/env node
// No Gmail endpoint, OAuth credentials, decryption key, or email request is used.
import {verifyEnvironment,verifyCurrentOwnerMode} from './send.mjs';
import {REPO} from './policy.mjs';
const e=process.env;
if(e.GITHUB_REPOSITORY!==REPO||e.GITHUB_REF!=='refs/heads/main'||!e.GB2L_CONTROL_TOKEN||!/^[a-f0-9]{40}$/.test(e.GITHUB_SHA||''))throw Error('Preflight requires main and settings-read token');
const github={repo:REPO,githubToken:e.GITHUB_TOKEN,controlToken:e.GB2L_CONTROL_TOKEN};
await verifyEnvironment(github,'approval_required');
await verifyCurrentOwnerMode(github,'disabled');
const headers={Authorization:`Bearer ${e.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
const base=`https://api.github.com/repos/${REPO}`;
const ledger=await fetch(`${base}/git/matching-refs/tags/gb2l-email-attempt-`,{headers,signal:AbortSignal.timeout(20000)});
if(!ledger.ok||!Array.isArray(await ledger.json()))throw Error('Attempt ledger not readable');
// A separate permanent probe tag establishes Contents write, without reserving email.
if(!/^\d+$/.test(e.GITHUB_RUN_ID||'')||!/^\d+$/.test(e.GITHUB_RUN_ATTEMPT||''))throw Error('Missing run identity');
const r=await fetch(`${base}/git/refs`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({ref:`refs/tags/gb2l-email-preflight-${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}`,sha:e.GITHUB_SHA}),signal:AbortSignal.timeout(20000)});
if(r.status!==201)throw Error('Contents write probe failed; no email attempted');
console.log('No-send preflight passed: manual gate, main-only policy, disabled mode, settings read and ledger write. No Gmail contact.');
