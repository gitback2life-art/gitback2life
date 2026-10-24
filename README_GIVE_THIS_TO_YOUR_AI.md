# GitBack2Life email — current inbox handoff

**Status:** The read-only receiving extension is merged into `main` (PR #35, merge commit `68216d32282f559c0e7c59f695f69adbd9fce473`). It is integrated into the existing GitBack2Life Email Communications app; it is not a second email app and it does not replace the sender.

## What is already in the repository

- `.github/workflows/gb2l-inbox-check.yml`: inbox-only GitHub Actions workflow, disabled unless `GB2L_INBOX_ENABLED=true`, owner-review-gated, and restricted to `main`.
- `tools/gb2l-email/receive.mjs`: bounded Gmail read of at most five matching inbox messages, text/plain content only, with no attachment retrieval or mail modification.
- `tools/gb2l-email/inbox-transport.mjs`, `inbox-inspect.mjs`, and `inbox-run.mjs`: encrypted request/response protocol, owner/channel checks, one-time request reservation, and ciphertext-only return.
- `tools/gb2l-email/assistant_inbox_session.py`: temporary recipient key and same-session response decryption through the existing GitHub connector.
- `tools/gb2l-email/inbox-owner-setup.mjs` and `inbox-prepare-key.mjs`: local owner setup. The read credential must be limited to `gmail.readonly`; the reader rejects any broader Gmail grant.

## Existing sender protection

The existing `send.mjs`, `owner-setup.mjs`, `readiness.mjs`, `public-key.pem`, and `.github/workflows/gb2l-approved-email.yml` remain unchanged. Preserve `approval_required`. The inbox has a separate environment, private key, and read-only OAuth grant so receiving cannot inherit sending permission.

## What's still needed for first use

The implementation and synthetic CI tests pass, including the inbox SHA-256 manifest check. It is **not live-connected yet**: `tools/gb2l-email/inbox-public-key.pem` has intentionally not been created, the protected `gb2l-inbox-read` environment is not yet configured, the dedicated channel [PR #41](https://github.com/gitback2life-art/gitback2life/pull/41) is open but `GB2L_INBOX_REQUEST_PR=41` has not been configured, and no inbox OAuth grant/secrets have been provisioned.

On the owner's trusted Windows computer, from the local repository root in PowerShell, the next local-only step is:

```powershell
node tools/gb2l-email/inbox-prepare-key.mjs "$env:USERPROFILE\gb2l.inbox.private.pem"
```

That creates the **private** key under the local user profile and writes only the matching public key into `tools/gb2l-email/inbox-public-key.pem`. Never share, upload, or commit `gb2l.inbox.private.pem`; only the public PEM belongs in GitHub. After the public key is published, the remaining steps are: configure `GB2L_INBOX_REQUEST_PR=41` and the owner-reviewed `gb2l-inbox-read` environment; obtain a separate read-only OAuth grant using `inbox-owner-setup.mjs`; then run one owner-approved synthetic message round-trip and verify decryption in the same live assistant session. Keep the inbox disabled except for an explicitly approved test.

## Verified checks

- Inbox crypto/protocol, bounded reader, mocked GitHub/Gmail and cross-language tests passed.
- Existing email regression tests and Toolbox source-integrity check passed.
- SHA-256/byte-count manifest validation passed on the merged inbox branch.

Synthetic tests are not evidence of live Gmail access. The existing sender must remain unchanged while the receiving path is being configured.
