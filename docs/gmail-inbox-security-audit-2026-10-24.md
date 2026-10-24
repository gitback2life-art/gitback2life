# Gmail inbox security and privacy audit — 2026-10-24

## Scope and limitations

Read-only review of the current .github/workflows/gb2l-inbox-read.yml, tools/gb2l-email/inbox-run.mjs, tools/gb2l-email/inbox-transport.mjs, tools/gb2l-email/receive.mjs, tools/gb2l-email/INBOX_SETUP.md, tools/gb2l-email/inbox-flow.test.mjs, tools/gb2l-email/receive.test.mjs, and privacy.html. This is a source/configuration review, not a formal penetration test, CASA assessment, or verification of owner-only GitHub/Google Cloud settings. CI results are recorded separately and are not evidence of Google's approval.

## Summary

**Keep hosted inbox access paused.** The separate GB2L_INBOX_GOOGLE_COMPLIANCE_READY gate, V2 request protocol, explicit per-request consent attestation, dedicated GitHub environment approval, narrow Gmail scope check, bounded message count/size, encrypted signed response, and replay reservation are useful safeguards. They do not remove the fact that a GitHub-hosted runner processes plaintext Gmail content before encryption, or establish that the transfer to ChatGPT is policy-approved.

## Findings

### F1 — External compliance blocker: restricted-scope server-side assessment and approved use case
**Severity: Release blocker.** The gmail.readonly scope is restricted. The runner processes message plaintext as a third-party server. Google's published guidance says this class of app must undergo an assessment; personal-use OAuth verification exception is described separately and does not expressly waive the assessment. Google lists generative-AI summaries as an approved productivity example but prohibits one-time/manual email export. Google has not confirmed this exact request-and-return architecture. Obtain written clarification and any required assessment before reactivation.

### F2 — Over-broad workflow token permission
**Severity: Medium, remediated in this branch.** The hosted reader uses the GitHub token to create a tag for replay prevention and post an issue comment; the workflow's pull-requests: write permission is not used by the reviewed reader code. Remove that permission. contents: write remains necessary for the current replay-reservation tag mechanism, issues: write for the ciphertext reply comment, and deployments: write is retained for the protected GitHub Environment deployment flow. Revisit the tag mechanism if a narrower permission design is introduced.

### F3 — Public ciphertext is durable public-repository data
**Severity: Medium, accepted with controls but residual risk remains.** The response comment is encrypted, not plaintext, but is posted to a public PR and may persist in GitHub history/notifications/cache. A compromised or exposed temporary private key could make it readable. Keep private keys and plaintext out of comments/logs; continue using one-use temporary response keys and delete comments when no longer needed. Deletion does not guarantee removal from provider backups or copies.

### F4 — Third-party plaintext processing precedes encryption
**Severity: High, inherent to current architecture.** Gmail message text is decrypted/processed in runner memory before the response is encrypted. Encryption protects transport/storage of the returned result but does not protect plaintext from the runner process or its hosting boundary. The workflow's short duration, environment approval, trusted-main checkout, pinned actions, bounded query, and no-body logging reduce risk but do not eliminate this trust boundary.

### F5 — Data transfer to ChatGPT needs provider-specific confirmation
**Severity: Release blocker.** The flow transfers selected Google user data to an external AI service. Consent and a published privacy notice are necessary but, by themselves, not sufficient. Confirm that the specific ChatGPT product, account settings, retention terms, and data-use controls satisfy Google's Limited Use restrictions. Do not infer this from a disabled model-training setting alone.

### F6 — OAuth privacy-policy URL and external account state unverified
**Severity: Release blocker until verified.** The privacy page exists and the Pages deployment was reported successful, but this repository session cannot inspect the Google Cloud OAuth consent-screen URL, Verification Center, developer email, current consent grant, or environment/repository variable values. Owner-side verification is required.

### F7 — Defense-in-depth checks observed in code
**Status: Present in reviewed source; tests are not a formal security proof.**
- Workflow accepts only a newly created V2 request by the owner on the dedicated open PR and checks the main ref/run attempt.
- The job checks out trusted main, not PR-head code, and uses pinned checkout/setup-node action SHAs.
- GitHub Environment requires owner approval and a main-only deployment branch policy, checked again by the reader before Gmail access.
- Gmail token audience and scopes are checked; broader Gmail scopes are rejected.
- Query is Inbox-only and bounded to at most five messages; attachments are not fetched; response/body sizes are capped.
- Requests include explicit consent attestation and a versioned notice; missing consent is rejected.
- Request IDs are reserved to prevent replay; responses are encrypted and signed; private data is excluded from intended logs.
- The workflow and transport fail closed when the separate compliance-ready variable is not true.

## Immediate recommendations

1. Keep GB2L_INBOX_GOOGLE_COMPLIANCE_READY unset/false and keep request PR #41 closed.
2. Send the inquiry in docs/google-gmail-compliance-inquiry-2026-10-24.md through the official Google Cloud OAuth Verification Center/support route; do not purchase a self-initiated assessment before Google confirms the appropriate route.
3. Set and verify the OAuth consent-screen privacy-policy URL in Google Cloud Console.
4. Confirm in writing the approved use case, security assessment requirement/tier, and transfer-to-OpenAI conditions.
5. Before any controlled reactivation, verify actual GitHub environment reviewers/branch restrictions and that both variables remain disabled until the owner explicitly approves reactivation.
6. Re-run CI and review results for this branch. No live Gmail read is part of the audit.

## Sources

- Google restricted-scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Google Workspace User Data and Developer Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Personal-use OAuth verification exception: https://support.google.com/cloud/answer/13464323?hl=en
- App Defense Alliance CASA Tier 2 process: https://appdefensealliance.dev/casa/tier-2/tier2-overview
