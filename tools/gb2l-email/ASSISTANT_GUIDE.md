# GitBack2Life Email Communications — AI Assistant Guide

Last checked: 2026-10-22. Read this file and `OWNER_SETUP.md` before taking any email action.

## What this adapter does

This GitHub Actions adapter can send one explicitly authorized outgoing Gmail message through the configured sender `gitback2life.ai@gmail.com`. Requests travel as encrypted ciphertext in a comment on the designated request pull request. In `approval_required` mode, the owner must inspect the exact message privately and approve the protected `gb2l-email-send` GitHub environment before Gmail's send endpoint is used.

It does **not** read Gmail inboxes or retrieve incoming messages/replies. The GitHub comment channel receives send requests; it is not email inbox access.

## Current live setup — verified facts, not assumptions

- Repository: `gitback2life-art/gitback2life`.
- Dedicated request channel: [PR #18](https://github.com/gitback2life-art/gitback2life/pull/18). Keep it open and unmerged.
- Repository mode: `GB2L_EMAIL_MODE=approval_required`. Never switch to `auto_send` as a workaround.
- The protected `gb2l-email-send` environment and its six required secrets have been provisioned. Never request or print their values in chat/logs.
- The sender-readiness workflow successfully refreshes an access token, but the latest no-send diagnosis failed because that token's actual Google OAuth grant **does not contain** `https://www.googleapis.com/auth/gmail.send`: [readiness run 39813519317](https://github.com/gitback2life-art/gitback2life/actions/runs/39813519317). That diagnostic did not contact Gmail's send endpoint.
- The initial test request reached Gmail's send endpoint and returned HTTP 403 after its attempt had been reserved; status was `uncertain_delivery`: [run 39798700833](https://github.com/gitback2life-art/gitback2life/actions/runs/39798700833). The old diagnostic version did not record Google's response reason.
- The old request/draft ID `dbd4da02a28c5f2acd9e991b26005f0c` is permanently reserved. **Never retry, rerun, or reuse it.** No fresh test email is authorized by this guide.
- Safe error-detail logging and the no-send scope/audience diagnostic are included and their CI tests passed on main at commit `b8148c7be873fa455008813eee95a86b52d96f0c`.

## Next recovery step (currently paused)

The diagnosis points to a missing Gmail permission, not a need for a new Google Cloud project or OAuth client. When the owner resumes setup:

1. Restore local GitHub CLI sign-in to `gitback2life-art` before running owner-only setup; the local account switch is currently on hold.
2. Keep use of the existing Desktop OAuth client. Reauthorize `gitback2life.ai@gmail.com` with `gmail.send` and `openid email`; do not request inbox access.
3. The existing `owner-setup.mjs` requires sending mode to be disabled during credential provisioning. The owner must explicitly run its setup procedure, which securely replaces the refresh-token secret and leaves mode disabled, then explicitly restore `approval_required`.
4. Run [sender readiness (no-send)](https://github.com/gitback2life-art/gitback2life/actions/workflows/gb2l-email-readiness.yml). Proceed only if actual token audience/client, `gmail.send` scope, identity, key pair, secret presence, and policy checks pass.
5. A live test email needs a **new draft ID and fresh explicit owner authorization**. Only then post a new encrypted request to PR #18 and approve the protected environment. Do not send anything on the basis of this guide alone.

## Required files

- `crypto.mjs`: draft sealing/encryption/validation.
- `prepare-comment.mjs` and `seal.mjs`: ciphertext request preparation.
- `request.mjs`, `inspect.mjs`: request transport and trust validation.
- `send.mjs`: protected runtime policy, durable attempt reservation, Google token refresh and Gmail send; uncertain outcomes fail closed.
- `readiness.mjs`: no-send checks of actual OAuth client audience and scope.
- `owner-setup.mjs`, `owner-mode.mjs`, `setup-checks.mjs`, `preflight.mjs`: owner-only setup, mode control and safeguards.
- `identity.mjs`, `policy.mjs`: sender identity and policy validation.
- `public-key.pem`: public encryption key only.
- `*.test.mjs`: offline regression tests.
- `workflow-templates/`: required GitHub Actions workflow files for an installation.

## Secret handling and approval boundary

Never commit or paste private keys, OAuth JSON, refresh/access tokens, control tokens, environment secret values, plaintext incident emails, or private review nonces/receipts. The public RSA key is safe to distribute. The owner must inspect the full recipient, subject, and body through the trusted private review process; a public encrypted comment is not proof that the owner has read or approved the plaintext.

A send attempt is irreversible from the workflow's perspective. Do not automatically retry after an attempt marker, HTTP failure, timeout, or ambiguous result. Reconcile the existing attempt before any separate, newly authorized message.

## Bundle distinction

The current repository's canonical runnable files remain `tools/gb2l-email/` and `.github/workflows/gb2l-*.yml`. This folder mirrors them into the Toolbox distribution. CI checks the copy byte-for-byte. The full 14-tool local Toolbox source itself still needs to be imported into the repository as individual files; see `../TOOLBOX_SOURCE_IMPORT_STATUS.md`.
