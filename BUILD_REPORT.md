# GitBack2Life encrypted Inbox — engineering checkpoint

Date: 2026-10-23. Target: public `gitback2life-art/gitback2life` current `main`, new additive source/workflow only.

**Status: CODE PREPARED FOR REVIEW, NOT LIVE-READY.** Existing outgoing sender untouched. Gmail read scope not requested, owner environment not created, inbox mode not enabled, no actual Gmail message read.

## Evidence

- Live GitHub connector: current repo main contains existing sender, `owner-setup.mjs`, `readiness.mjs`, outbound workflow, and `public-key.pem`; original PR #16 is merged. Current connection reports `pull=true`, `push=false`.
- GitHub interface: the available connector supports fetching PR comments and an `add_comment_to_issue` action specifically for PR conversation comments. No write test was performed (connection reports read-only).
- Staged starting point: previously supplied `receive.mjs`/`receive.test.mjs` from `911_GitBack2Life_Inbox_Read_Staged_20261023.zip`.
- New receiver-side code adds encrypted search parameters, trusted owner PR actor/channel validation, separate GitHub Actions environment, signed encrypted replies, durable one-time request tags, key and OAuth owner helpers, and a persistent-session Python client.
- Simulated integration: 31 historical send-regression tests, 15 staged receiver tests, and 9 new inbox/protocol tests = **55 passed, 0 failed** in one Node.js 22.16.0 test run. Cross-language test used Python 3 with cryptography 46.0.4 in a persistent child process. Historical sender suite is not identical to current main. Test output in package root.
- Historical regression suite from October 22 ZIP was also exercised separately in the build sandbox, but this was NOT the live main-branch test suite; main's changed files were reviewed through the GitHub connector, not cloned locally.

## Remaining gates

- Genuine GitHub write/PR integration and environment review in owner's connected AI account
- Fresh inbox-only public key generated on the owner device and published, private key held locally/protected environment
- Dedicated PR channel, repo Actions variables and environment reviewer/branch-policy setup
- Google's restricted `gmail.readonly` scope authorization and applicability of verification/security assessment
- Live protected GitHub Actions execution, Gmail retrieval and return, and same-active-session decryption
- Canonical Toolbox adapter mirror and source-integrity manifest synchronization before distributing in the full Windows Toolbox

No merge, Gmail authorization, secret read/write, auto mode activation, or live mail operation occurred.
