# GitBack2Life encrypted Inbox — engineering checkpoint

Date: 2026-10-23. Target: public `gitback2life-art/gitback2life` current `main`, new additive source/workflow only.

**Status: INBOX IMPLEMENTATION MERGED to `main` via PR #35 (merge commit `68216d32282f559c0e7c59f695f69adbd9fce473`), but still disabled and not live-ready.** Existing outgoing sender untouched. No inbox public key, read-only OAuth grant, or inbox secrets have been provisioned; no actual Gmail message has been read.

## Evidence

- Current `main` contains the existing sender and the merged inbox extension. GitHub Actions inbox workflow is inactive by default. Repository commits/PRs were made through the available GitHub tools; a live encrypted inbox request/response has not been attempted.
- GitHub interface: the available connector supports fetching PR comments and an `add_comment_to_issue` action specifically for PR conversation comments. No write test was performed (connection reports read-only).
- Staged starting point: previously supplied `receive.mjs`/`receive.test.mjs` from `911_GitBack2Life_Inbox_Read_Staged_20261023.zip`.
- New receiver-side code adds encrypted search parameters, trusted owner PR actor/channel validation, separate GitHub Actions environment, signed encrypted replies, durable one-time request tags, key and OAuth owner helpers, and a persistent-session Python client. The inbox reader now rejects OAuth grants containing any Gmail permission beyond `gmail.readonly`, both during owner setup and again before each Gmail API read.
- Simulated integration: 31 historical send-regression tests, 15 staged receiver tests, and 9 new inbox/protocol tests = **55 passed, 0 failed** in one Node.js 22.16.0 test run. Cross-language test used Python 3 with cryptography 46.0.4 in a persistent child process. Historical sender suite is not identical to current main. Test output in package root.
- Historical regression suite from October 22 ZIP was also exercised separately in the build sandbox, but this was NOT the live main-branch test suite; main's changed files were reviewed through the GitHub connector, not cloned locally.

## Remaining gates

- Live owner-comment posting/retrieval and protected `gb2l-inbox-read` environment approval still need an end-to-end synthetic test
- Fresh inbox-only public key generated on the owner device and published, private key held locally/protected environment
- Dedicated request channel [PR #41](https://github.com/gitback2life-art/gitback2life/pull/41) is now open; set `GB2L_INBOX_REQUEST_PR=41` and configure the owner-reviewed environment/branch policy
- Google's restricted `gmail.readonly` scope authorization and applicability of verification/security assessment
- Privacy/consent disclosure that selected email is transferred only to answer the user's explicit request in a user-facing productivity feature; no email data may be used for model training. Google lists generative-AI email summaries as an approved Gmail use case, while disclosure and any applicable restricted-scope verification/security assessment remain required
- Google's data-use rules for transferring decrypted Gmail content into a separate AI conversation, explicit consent/disclosure, human viewing, and prohibition on using Google user data to train/improve foundation models
- Live protected GitHub Actions execution, Gmail retrieval and return, and same-active-session decryption
- Canonical Toolbox adapter mirror and source-integrity manifest synchronization before distributing in the full Windows Toolbox

The code merge occurred; no Gmail authorization, inbox secret provisioning, inbox-mode activation, or live mail operation occurred.
