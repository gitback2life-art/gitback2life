# GitBack2Life Production Email + 911 Toolbox Session Handoff

**Prepared:** 2026-10-23  
**Repository:** [gitback2life-art/gitback2life](https://github.com/gitback2life-art/gitback2life)  
**Default branch at preparation:** `main` at `67675c76f688937348476e0c9b1f8e71b0003fe6`  
**Purpose:** Give the next session a complete factual checkpoint for the recent Toolbox import and production email repair. Preserve distinctions between verified repository evidence, owner-reported results, live configuration that still needs updating, and uncompleted work.

## Executive status

- The reviewed 14-tool 911 GetBack2Life Toolbox archive is imported as individual files under `toolbox/911_gitback2life/distribution/`. Both source manifests were checked; Windows installation/acceptance remains unverified.
- The Gmail `gmail.send` guard is merged. The owner confirmed the Google OAuth app is verified and in Production. On the owner's computer, `owner-setup.mjs` completed and reported: **“Manual environment credentials provisioned. Mode remains disabled; no email was sent.”**
- The owner then ran sender readiness (no-send), which succeeded, and restored `approval_required`. Per-message owner approval must remain enabled; do not bypass the protected GitHub environment approval gate or enable autonomous sending.
- A message sent to the owner's own inbox was accepted by Gmail; the owner reported it landed in Spam. Terri Boo's family-introduction email was accepted by Gmail; the owner said she loved it.
- Momma's request (#5 on the encrypted request channel) was **not sent**. Run [#40003116089](https://github.com/gitback2life-art/gitback2life/actions/runs/40003116089) failed with `Mail sender refused: Owner daily sending quota exhausted` before the request reached Gmail.
- The owner said the old three-per-UTC-day quota had not been selected by them. The current source now specifies **10 per UTC day** for approval-required mode. Latest email tests and Toolbox source integrity checks pass. However, source-code changes do not update the protected live `GB2L_EMAIL_POLICY` secret; that must be synchronized locally before a fresh Momma request is submitted.

## 1. 911 GetBack2Life Toolbox import

The uploaded source ZIP was committed at:

`toolbox/911_gitback2life/911_GitBack2Life_Email_Communications_Review_Build_20261020 (2).zip`

Imported distribution:

`toolbox/911_gitback2life/distribution/`

Evidence:
- Import commit: [`3b80cd4`](https://github.com/gitback2life-art/gitback2life/commit/3b80cd4b350da21bb06b1b548dc85f631452b533)
- Import PR: [#29](https://github.com/gitback2life-art/gitback2life/pull/29)
- Manifest verification recorded 206 outer-manifest files and 205 embedded source-manifest files; the 14 user-facing tool groups were checked.
- Latest integrity run after the quota source updates: [#40007245930](https://github.com/gitback2life-art/gitback2life/actions/runs/40007245930) — success.

**Not verified:** native Windows installation/acceptance. Source import integrity does not prove Windows install behavior or production readiness.

## 2. Gmail OAuth scope failure and repair

The earlier production send failed with `HTTP 403`, `insufficientPermissions`, and Google's message `Request had insufficient authentication scopes.`. The issue was the existing grant's missing `https://www.googleapis.com/auth/gmail.send` scope, not the app's Testing/Production status.

The correction is merged in [commit `0926a6b`](https://github.com/gitback2life-art/gitback2life/commit/0926a6bb4858fa02c88f695822402c913adc7e59):
- `owner-setup.mjs` checks the granted `gmail.send` scope immediately after the token exchange.
- It fails before sender-identity verification and before any GitHub secret is written.
- Regression tests were added and the canonical files were synchronized with the packaged adapter copies.
- Email tests [#39877770012](https://github.com/gitback2life-art/gitback2life/actions/runs/39877770012) and Toolbox integrity [#39877770037](https://github.com/gitback2life-art/gitback2life/actions/runs/39877770037) passed.

Owner-reported local sequence:
1. GitHub CLI was signed in as `gitback2life-art`.
2. The local private key was checked against the repository's public key without exposing key contents.
3. The browser OAuth callback returned to local setup, and owner setup provisioned credentials while leaving mode disabled.
4. Email no-send preflight [#39886680805](https://github.com/gitback2life-art/gitback2life/actions/runs/39886680805) succeeded.
5. Sender Readiness (no-send) [#39887443804](https://github.com/gitback2life-art/gitback2life/actions/runs/39887443804) succeeded.
6. The owner restored `approval_required`.

The old request with draft ID `e0262567c9c3a184025e1118304deb5d` is an earlier reserved Gmail-403 attempt and must never be rerun or reused.

Never put the Google client JSON, client secret, refresh token, access token, private key, or private review nonce in chat, logs, or the public repository.

## 3. Actual email outcomes

Treat Gmail provider acceptance, inbox placement, and recipient reading as separate outcomes.

| Event | Evidence | Result |
|---|---|---|
| Earlier message to the owner's own inbox | [Run #39878940029](https://github.com/gitback2life-art/gitback2life/actions/runs/39878940029) | Gmail 403 for missing authentication scope after the attempt had been reserved. Do not retry that draft ID. |
| Later message to the owner's own inbox | [Run #39887797236](https://github.com/gitback2life-art/gitback2life/actions/runs/39887797236) | `provider_accepted`; the owner reported it went to Spam. The workflow does not verify inbox placement or reading. |
| Family-introduction email to Terri Boo | [Run #39889341623](https://github.com/gitback2life-art/gitback2life/actions/runs/39889341623) | `provider_accepted`; owner reported that Terri loved the message. |
| Email request for Momma (channel request #5) | [Run #40003116089](https://github.com/gitback2life-art/gitback2life/actions/runs/40003116089) | **Not sent.** The quota check refused the request before Gmail was called; log: `Owner daily sending quota exhausted`. |

This public handoff omits recipients' personal addresses and plaintext message bodies. Keep requests as encrypted `GB2L_EMAIL_V1:` comments. Private review receipts/nonces stay local and must never be committed or pasted into chat.

## 4. Quota source correction versus live configuration

The three-per-UTC-day cap was a built-in default, not an owner-selected policy. Main history had an interim 30/day change, then corrected the approval-required quota to **10/day**:

- Current quota commit: [`67675c7`](https://github.com/gitback2life-art/gitback2life/commit/67675c76f688937348476e0c9b1f8e71b0003fe6)
- Latest email test workflow: [#40007245990](https://github.com/gitback2life-art/gitback2life/actions/runs/40007245990) — success.
- Latest Toolbox source integrity: [#40007245930](https://github.com/gitback2life-art/gitback2life/actions/runs/40007245930) — success.

The live `GB2L_EMAIL_POLICY` is a protected environment secret and cannot be confirmed by reading tracked files. The source fix does not update that secret. Treat its quota as **unverified / potentially still old** until the owner updates it successfully.

### Required owner action

From a local checkout updated to the latest `main` (at or after commit `67675c76f688937348476e0c9b1f8e71b0003fe6`), run:

```powershell
gh api user --jq .login
node .\tools\gb2l-email\owner-mode.mjs approval_required --daily=10 --actor=gitback2life-art
```

The account check must print `gitback2life-art`. If the checkout is stale, update it first using `git fetch origin`, `git switch main`, and `git pull --ff-only origin main`. The mode command should finish successfully and explicitly report daily quota **10**. It also reasserts repository and environment protections and retains owner review for every message. If the command fails, stop and inspect the non-secret error; do not weaken a ruleset or skip approval.

## 5. Momma request — next steps

1. Synchronize the live protected policy as described above and confirm the command reports quota 10 with `approval_required` mode.
2. Submit a **fresh encrypted request with a new draft ID** for Momma. The old request did not reach Gmail, but do not rely on retrying the old issue-comment event.
3. Review the exact message locally against its commitment. Never paste the private review nonce or the receipt contents into ChatGPT.
4. Approve the usual `gb2l-email-send` deployment only if the recipient and content match what the owner intends. Do not bypass standard owner approval or switch to `auto_send`.
5. After approval, verify the send-job log. `provider_accepted` means Gmail accepted the message; it does not prove Inbox placement or reading.

## 6. Spam-folder follow-up

The owner reported the first accepted message to their own inbox landed in Spam. No message-header authentication results have been recorded yet.

- Open the message in Spam and select **Show original**.
- Record the PASS/FAIL/none results for SPF, DKIM, and DMARC plus the concise Gmail warning. Do not share full headers or private content.
- Use **Report not spam** and add the sender to Contacts for the owner's mailbox; this can help that mailbox but is not a global deliverability fix.
- Avoid speculative DNS or code changes until header evidence identifies the problem.
- For all send reports, distinguish provider acceptance from actual Inbox placement and whether the recipient read the message.

## 7. Request channel and safety boundaries

The encrypted request channel is [PR #18](https://github.com/gitback2life-art/gitback2life/pull/18), titled “Dedicated GitBack2Life email request channel.” It is **closed/merged**, though comments on it have continued triggering the configured issue-comment workflow. Its original instructions said to keep it open, so document this as a workflow/channel-state mismatch for later cleanup; do not redesign it during the immediate quota repair without specific authorization.

Preserve these controls:
- `GB2L_EMAIL_MODE=approval_required`.
- Owner review in the protected `gb2l-email-send` environment for every message.
- Main-only deployment protections and required email tests.
- No retry of a reserved/uncertain send attempt.
- No plaintext email contents, private addresses, keys, tokens, or review nonces in public comments.
- No auto-send/autonomous path or approval bypass.
- Do not claim Momma's message was sent; run #40003116089 failed before Gmail contact.

## 8. Role and remaining work

Baby Brother's role here is continuity, documentation, and precise use of the existing workflow—not redesigning the email system. The owner explicitly objected to over-testing and over-engineering; stay focused.

**Immediate priority:** update the protected live policy to 10/day, send a fresh encrypted Momma request through owner review, then diagnose the Spam placement from the original headers. **Separate remaining gap:** Windows installation acceptance of the imported 14-tool Toolbox is still unverified.
