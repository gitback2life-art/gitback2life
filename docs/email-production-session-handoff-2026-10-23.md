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


---

## Inbound Email / Baby Brother Session Handoff Addendum — 2026-10-23 (Evening)

**Purpose:** Continue the existing GitBack2Life Email Communications application from send-only toward owner-authorized, read-only incoming-mail retrieval with a verified encrypted return into Baby Brother's active conversation. This extends the repository application; it is not a request to build a separate ChatGPT email app or Dock.

### 1. Repository checkpoint and current code state

- Repository: `gitback2life-art/gitback2life`.
- Main HEAD verified immediately before this addendum: [`ef55c4dd0a17b02a2e2ae143cd9a5b1121bdec99`](https://github.com/gitback2life-art/gitback2life/commit/ef55c4dd0a17b02a2e2ae143cd9a5b1121bdec99).
- Existing app: [`tools/gb2l-email/`](https://github.com/gitback2life-art/gitback2life/tree/main/tools/gb2l-email).
- Existing outgoing workflow: [`.github/workflows/gb2l-approved-email.yml`](https://github.com/gitback2life-art/gitback2life/blob/main/.github/workflows/gb2l-approved-email.yml).
- The existing app sends outgoing Gmail through encrypted request envelopes, owner-controlled policy, protected `gb2l-email-send` environment, and per-message manual approval in `approval_required` mode. Do not replace this path or weaken its approval gate during inbox work.
- **Verified source absence:** fetching `tools/gb2l-email/receive.mjs` and `tools/gb2l-email/receive.test.mjs` from current main returned GitHub 404 / NOT_FOUND. No inbound Actions workflow was found in the tracked workflow set reviewed in this session. The receiver in the staged ZIP is not committed to main at the checkpoint above.

### 2. Latest outbound email result

On October 23, the owner asked Baby Brother to reply to Mom using the repository email app.

- The encrypted request was submitted via the existing request channel on [PR #18](https://github.com/gitback2life-art/gitback2life/pull/18).
- GitHub Actions run [#40021401914](https://github.com/gitback2life-art/gitback2life/actions/runs/40021401914) completed successfully.
- The `inspect` job succeeded; the `approval_required` job succeeded after owner approval; the `autonomous` job was skipped.
- The sender log recorded: `Result: provider_accepted - Gmail accepted email; recipient delivery/read status is not verified.`
- The owner confirmed success in the conversation.

This verifies Gmail provider acceptance, not independently confirmed Inbox placement or recipient reading. Do not include the private email body or recipient address in repository handoffs.

### 3. Staged inbox package examined in this session

User-provided file: `911_GitBack2Life_Inbox_Read_Staged_20261023.zip`.

- ZIP SHA-256: `e90660fd87601fb89e02da1fec0babbd7cba65724e885eb1284b5e1615d6579e`.
- ZIP CRC/integrity check passed.
- All four file hashes listed in `SHA256_MANIFEST.txt` matched.
- Included files: `BUILD_REPORT.md`, `README_GIVE_THIS_TO_YOUR_AI.md`, `REPOSITORY_FILES/tools/gb2l-email/receive.mjs`, `REPOSITORY_FILES/tools/gb2l-email/receive.test.mjs`, and `SHA256_MANIFEST.txt`.
- The staged build report states that 14/14 offline tests passed under Node v22.16.0. **This is package-reported test evidence; Baby Brother independently checked ZIP integrity and manifest hashes but did not rerun those Node tests.**
- The staged report states that no GitHub branch updates, OAuth changes, Actions deployment, Gmail read, or sending occurred.

Observed receiver behavior in the archive:
- Requires `gmail.readonly` and checks actual Google token-info audience and granted scope before read requests.
- Validates a required sender filter, optional date, and a maximum of five messages per request.
- Queries only `in:inbox` for the specified sender, deduplicates message IDs, and bounds processing.
- Extracts `text/plain` only; HTML-only messages do not fall back to HTML content.
- Marks output as `untrusted_email_content`.
- Provides `encryptInboxReturn()` / `decryptInboxReturn()` using a temporary RSA key, RSA-OAEP SHA-256, AES-256-GCM, and request ID as authenticated associated data.
- It is explicitly **not wired to GitHub Actions** and does not implement the authenticated request/response transport into this conversation.

### 4. Architectural direction — use the existing repository app and GitHub connection

The owner's requirement is explicit: use the existing GitBack2Life email app in the repository and the GitHub connection available in the active Baby Brother conversation. Do not ask the owner to locate or configure a separate ChatGPT Dock. Do not build another email app.

The GitHub connector can submit supported repository requests and retrieve supported repository responses, including comments and workflow status/results. It can be evaluated as the pull transport for an app-generated encrypted response during an active conversation. Connector availability alone does not prove that the end-to-end decryption-and-return path already works; that must be implemented and tested.

No live inbox permission should be added and no real inbox message should be read until the owner authorizes the scope expansion, Google's applicable requirements have been assessed, and the encrypted round trip has passed a controlled test.

### 5. Required implementation design

#### A. Integrate the staged receiver

Review the staged `receive.mjs` and test file against current main, then integrate compatible code under `tools/gb2l-email/`. Preserve outgoing sending behavior.

Inbox behavior stays bounded:
- explicit sender filter required;
- optional validated after-date;
- no more than five messages per request;
- no attachments;
- `text/plain` only;
- read-only Gmail API calls only;
- bounded body/response sizes and sanitized provider errors;
- no logs containing email content, credentials, OAuth tokens, or private headers.

#### B. Add an inbound-specific request protocol and workflow

Add a distinct inbound-only protocol (provisionally `GB2L_INBOX_V1:`) and a workflow (provisionally `.github/workflows/gb2l-inbox-check.yml`). Do not overload `GB2L_EMAIL_V1:`, which belongs to the existing send-request protocol.

The request must bind a unique 32-hex request ID, allowed sender/date/limit filters, the intended ephemeral return-key fingerprint, and expiry/anti-replay metadata. Search criteria and other potentially sensitive query metadata must be encrypted before submission because repository comments are public.

The workflow must:
- authenticate the requester and designated request channel;
- decrypt and validate request data with a repository-side key/secret without printing plaintext;
- validate the temporary recipient key and its fingerprint;
- enforce owner policy and a bounded read limit;
- reject malformed, stale, duplicate, unauthorized, or replayed requests;
- keep email bodies and decrypted headers out of public comments, logs, repository files, and plaintext artifacts.

Use a separate protected inbox-read environment or equivalently narrow owner-approval control. Keep outbound `approval_required` unchanged. Do not enable `auto_send`, bypass send approval, or treat sending authority as implicit permission to read the inbox.

**Request-channel mismatch to resolve deliberately:** PR #18 is recorded as closed/merged in the existing handoff, but comments there have continued to trigger the current outgoing workflow, including run #40021401914. Before enabling inbound requests, verify the configured channel and decide whether an explicitly designated inbound request channel is needed. Do not casually modify the currently working outbound channel as an incidental feature change.

#### C. Google authorization, least privilege, and consent

The current outbound setup requests `gmail.send`, `openid`, and `email`. The staged receiver requires `https://www.googleapis.com/auth/gmail.readonly`, a Google restricted scope.

Before new consent or live retrieval, confirm the actual Google verification and data-handling requirements for the intended architecture and owner use case. Do not assume a personal-use exception automatically applies.

Prefer an inbox-specific credential/secret boundary so the working sender grant and outbound secrets are not overwritten as a shortcut. If shared OAuth is proposed instead, document the scope change, least-privilege trade-off, refresh-token impact, and rollback plan before owner approval. Update readiness checks to validate actual token audience and actual granted read scope; a mock flag or repository setting is not proof.

Never paste or commit OAuth JSON, client secrets, refresh/access tokens, private keys, environment secrets, or private review receipts/nonces.

#### D. Use the existing GitHub connector for pull-based return

The intended first release is an on-demand, conversation-driven exchange:

1. While an authorized inbox request is being handled in an active conversation, generate a fresh temporary asymmetric key pair in the execution environment. Keep the private key outside GitHub and out of conversation transcripts.
2. Submit the request through the repository's designated inbound channel. The public return key may be shared; encrypt the sender/date filters and other query metadata to the repository's public key so search intent is not exposed in a public comment.
3. The inbound workflow authenticates the request and policy before contacting Gmail.
4. The receiver fetches only the permitted messages and encrypts the response to the temporary return public key. Bind the response to the request ID, recipient-key fingerprint, schema/version, and authenticated-encryption associated data.
5. Return/store ciphertext only through the designated GitHub response surface. Never write plaintext email content, decrypted headers, secrets, tokens, or attachments to public comments, Actions logs, repository files, or public artifacts.
6. Baby Brother retrieves the encrypted response through the existing GitHub connector during the active conversation; validates its schema, request ID, and key fingerprint; then decrypts it in the same still-active execution environment holding the matching private key.
7. Validate the decrypted result and size limits, show the requested email to the user, treat all email content as untrusted, and discard temporary key material after the exchange.
8. If the session/private key is lost, response is late, IDs do not match, authentication fails, or ciphertext is modified, fail closed. Check the prior request state before creating a new fresh request; never expose plaintext as a workaround.

The staged `encryptInboxReturn()` / `decryptInboxReturn()` functions may help after review. They do not themselves implement request transport, requester authorization, private-query encryption, replay defense, or delivery into the active conversation.

This is a **pull-based** first release. The GitHub connector does not independently push workflow results into ChatGPT in the background; Baby Brother must retrieve the response while the conversation is active. No background polling is requested for the first release.

### 6. Required test stages

**Stage 1 — Offline integration**
- Run current main's complete email regression suite plus the receiver tests.
- Verify byte-for-byte parity for any packaged Toolbox copies that mirror the email adapter.
- Cover actual-scope/audience failure, sender/date validation, empty inbox versus error, deduplication and limits, MIME/plain-text handling, HTML-only content, sanitized diagnostics, encryption/decryption, bad key, wrong request ID, tamper/tag failure, expiry/replay, untrusted email instructions, and ensuring received email cannot trigger sending.
- Confirm outbound code and required approvals remain unchanged.

**Stage 2 — No-read/no-send staging**
- Use synthetic inputs to test the request parser, authorization decisions, return envelope, and encryption.
- Confirm no Gmail read endpoint and no send endpoint are called.
- Inspect logs, comments, and artifacts to confirm no plaintext email or secret is exposed.

**Stage 3 — Synthetic encrypted round trip**
- Use a harmless synthetic email with a unique marker and fresh request ID/key.
- Run the workflow and obtain ciphertext from the designated GitHub response channel.
- Retrieve ciphertext via the existing GitHub connector and decrypt it with the matching active-session private key.
- Verify the unique marker is readable by Baby Brother in the intended conversation, with no plaintext leaked to GitHub.
- Test mismatched key/request ID, modified ciphertext, unauthorized requester, expired/replayed request, and missing read scope.

**Stage 4 — Owner-authorized live test**
Only after Stages 1–3 pass, applicable Google requirements are resolved, and the owner explicitly authorizes it, perform one bounded read of a harmless test email. Confirm the message is securely readable in the active session and Gmail was not modified. Do not label inbox receiving operational until this is demonstrated.

### 7. Acceptance criteria

Complete only when:
- existing outbound email still works and every send retains owner approval;
- the real granted read scope is verified before Gmail is called;
- only authorized, bounded messages can be retrieved;
- plaintext email content never appears in public GitHub comments, logs, artifacts, or tracked files;
- the existing GitHub connector retrieves ciphertext and the active execution environment successfully decrypts it;
- Baby Brother actually reads the intended email in this conversation—not merely a green workflow result;
- request binding, tamper detection, anti-replay, and failure behavior are tested;
- Google requirements, credential separation, and rollback are documented;
- request status distinguishes queued, awaiting approval, no matches, read failure, encrypted response ready, decryption success, and return failure.

### 8. Remaining unknowns and non-goals

- The staged receiver/test files are not committed to current main at the recorded checkpoint.
- No inbound Actions workflow is present on main at the recorded checkpoint.
- No live `gmail.readonly` authorization or inbox read has occurred.
- An end-to-end encrypted return that Baby Brother can decrypt via the existing GitHub connector has not yet been demonstrated.
- Google restricted-scope requirements need assessment before new consent.
- PR #18's merged/closed state conflicts with older instructions to keep the request channel open; resolve deliberately before using it for new inbound requests.
- Do not introduce a standalone ChatGPT Dock, separate email application, public plaintext response, attachments, mailbox modifications, automatic sending, or background polling in this initial release.
- Do not claim Baby Brother independently reran the staged 14 tests; only the ZIP CRC and four manifest hashes were independently verified here.

### 9. Immediate next actions for Big Brother

1. Review staged ZIP `911_GitBack2Life_Inbox_Read_Staged_20261023.zip` against current main and preserve its recorded SHA-256.
2. Inspect the current request-channel state and workflow permissions; define the minimum safe inbound protocol and approval gate.
3. Assess applicable Google requirements and document the least-privilege read credential boundary before requesting new consent.
4. Integrate the receiver and add encrypted request/response handling within the existing `tools/gb2l-email/` app, using the existing GitHub connection as the active conversation's pull transport.
5. Run Stages 1 and 2; record actual test outputs.
6. Demonstrate Stage 3 end-to-end before asking for explicit permission for Stage 4.
7. Update guide/setup documentation, tests, and exact packaged copies while preserving the existing sender.
8. Record commit IDs, test runs, and remaining limitations in the next handoff. Do not claim success until Baby Brother can actually read the returned synthetic email in the active conversation.

**Owner's intended outcome:** “Baby Brother, check my email and read Mom's reply” should use the existing GitBack2Life email app and existing GitHub connection to deliver the selected message privately into this conversation, without exposing inbox data on public GitHub or weakening outbound approval safeguards.
---

## Session addendum — inbound inbox review and Google restricted-scope decision (2026-10-23)

### Scope clarification

This work concerns the **GitBack2Life email application inside this repository** (tools/gb2l-email/) and its GitHub Actions transport. It is not a request to connect ChatGPT's separate Gmail connector or use a ChatGPT inbox feature. The goal is for the existing GitBack2Life app to retrieve a small, explicitly requested set of incoming email and return it encrypted to the active assistant session through the connected GitHub repository. The existing outgoing email sender must remain separate and unchanged.

### What was added for review

- Review branch: [review/encrypted-inbox-roundtrip](https://github.com/gitback2life-art/gitback2life/tree/review/encrypted-inbox-roundtrip)
- Draft pull request: [PR #35](https://github.com/gitback2life-art/gitback2life/pull/35)
- Original reviewed commit: [cd720ac0680dc1b041dc42d21e6e803de80a8520](https://github.com/gitback2life-art/gitback2life/commit/cd720ac0680dc1b041dc42d21e6e803de80a8520)
- Manifest-path correction: [1987cd1b2a59ff8f2d827ed126d6489d3d61b006](https://github.com/gitback2life-art/gitback2life/commit/1987cd1b2a59ff8f2d827ed126d6489d3d61b006)

The inbox implementation is additive under tools/gb2l-email/, with two workflow files under .github/workflows/. It uses a bounded inbox-only query (maximum five messages), encrypted query criteria, an ephemeral return key, a signed/encrypted response, trusted-actor and designated-PR checks, a protected owner-review environment, and one-time request markers. It does not download attachments or interpret email HTML as executable content. The sender implementation and sender workflow were checked against main and have identical file hashes on the review branch: tools/gb2l-email/send.mjs SHA-256 288cbe04ba59830f608ac935c2b17336c1ba5078; .github/workflows/gb2l-approved-email.yml SHA-256 fe484e4982d4820cbd572f74f8a873943a75f1ac.

### Test evidence and limits

GitHub Actions run [#40044869240](https://github.com/gitback2life-art/gitback2life/actions/runs/40044869240) completed successfully on the earlier reviewed code commit. After the manifest-path correction at commit [1987cd1b2a59ff8f2d827ed126d6489d3d61b006](https://github.com/gitback2life-art/gitback2life/commit/1987cd1b2a59ff8f2d827ed126d6489d3d61b006), CI ran again on that corrected commit: encrypted inbox tests [#40046460375](https://github.com/gitback2life-art/gitback2life/actions/runs/40046460375) and existing email regression/source-integrity tests [#40046460378](https://github.com/gitback2life-art/gitback2life/actions/runs/40046460378) both succeeded. The inbox job completed its synthetic Python/Node crypto tests and JavaScript syntax checks; the existing email job completed its full Node test suite, Toolbox adapter integrity verification, and JavaScript syntax checks. The earlier inbox job reported **24 tests: 24 passed, 0 failed, 0 skipped**. These are synthetic/offline tests, not a live Gmail integration test.

The manifest-path correction therefore **did receive successful CI afterward**. This confirms the tested workflows and source-integrity check passed on the corrected commit; it does not independently prove every SHA-256/byte-count entry in the standalone SHA256_MANIFEST.txt matches the final package.

### Google authorization blocker — do not assume an exemption

Google classifies https://www.googleapis.com/auth/gmail.readonly as a **restricted Gmail scope**, unlike the existing gmail.send scope. Whether a personal-use or testing exception applies must be determined for this exact OAuth app, its users, and the proposed processing architecture. Moving message content through GitHub-hosted Actions and storing credentials in GitHub environment secrets may introduce additional verification, security-assessment, data-handling, and disclosure obligations. A possible exception is not proof that this deployment is exempt.

Before requesting consent for the read scope, determine and document the applicable Google verification/security-assessment requirements for this use. Do not weaken the requested scope, misrepresent the use, or assume that the existing send authorization covers reading mail. The inbound setup requests a **separate** read-only OAuth grant and uses separate inbox-specific secrets; never replace or reuse the outgoing sender's credentials for inbox access.

### What remains blocked

1. **No live Gmail read has occurred.** Current test evidence is mocked/synthetic.
2. **No end-to-end GitHub write/read path has been proven** with the actual connected account posting as gitback2life-art, the protected gb2l-inbox-read environment pausing for owner review, and the encrypted reply being fetched and decrypted in the same active assistant session.
3. The owner-only inbox public/private key pair has not been established as a production-ready secret arrangement. The private key must remain off-repository and the public key must match it.
4. The repository connection previously reported read-only (pull=true, push=false). Do not assume it can create the required PR comment or approve a workflow; verify actual permissions rather than trying to work around them.
5. The package's canonical Toolbox adapter mirror and source-integrity manifest synchronization must be checked before distributing the feature in the full Windows Toolbox.
6. PR #35 remains **draft and unmerged**. The inbox workflow is not authorized for live activation.

### Exact next actions

- Resolve Google's restricted-scope requirements for this use before obtaining new Gmail read consent.
- Verify actual GitHub write capability and the designated request-PR / protected-environment settings without exposing secrets.
- Recheck manifest hashes against the files at their final repository paths and rerun CI after any source or workflow changes.
- Complete offline and no-read/no-send checks, then demonstrate a harmless synthetic encrypted round-trip through the real GitHub transport and decrypt it in the same active session.
- Only after those gates pass, request separate explicit owner authorization for one bounded live test against a harmless test email.
- Keep PR #35 unmerged, inbox disabled, and the existing outgoing approval_required mode intact until the owner authorizes the relevant next step.

### Handoff discipline

A green mocked test run is not proof of live Gmail access. A GitHub file commit is not proof that the intended live configuration changed. Do not tell the owner to do setup steps that the assistant can complete safely through its connected repository tools; do not claim to have performed actions that require unavailable GitHub write permissions, local owner credentials, Google's consent screen, or the owner's private key. Ask the owner for an action only when it is genuinely owner-only, and state the single specific action needed.

