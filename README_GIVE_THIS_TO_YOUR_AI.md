# GitBack2Life email — current send and inbox handoff

The existing outgoing sender is unchanged. Sending continues through owner-local setup, the GitHub encrypted request channel, and the protected GitHub Actions approval gate. Keep GB2L_EMAIL_MODE at approval_required.

## Inbox receiving

Inbox requests travel through PR #41 using the GB2L_INBOX_V1 encrypted request and GB2L_INBOX_RESULT_V1 signed encrypted response formats. The public key is `tools/gb2l-email/inbox-public-key.pem`; the private key and Gmail read-only OAuth token stay on the owner's Windows computer.

After one-time OAuth setup, start `Read-GB2L-Inbox.ps1 -Watch` and leave it open. When the owner tells the active assistant session to read email, the assistant should create a fresh in-memory `InboxSession`, prepare an encrypted request, and post that request as a comment on PR #41 with the connected GitHub account. Default request: newest five Inbox messages from any sender; optional sender/date/limit come from the user's instruction. The local watcher processes only a valid request authored by `gitback2life-art` and posted after the watcher started, then returns signed ciphertext. The assistant must fetch the matching response and decrypt it using the same still-live `InboxSession`. Do not ask the user to rerun the reader for every request or require a sender address by default.

The Gmail API read runs locally. GitHub receives only request/response ciphertext; GitHub Actions must never read Gmail or receive its refresh token. Keep `GB2L_INBOX_ENABLED=false`. See `tools/gb2l-email/INBOX_SETUP.md` for the one-time watcher command and behavior.

## Local setup

From the repository root, double-click Read-GB2L-Inbox.ps1. On first run it opens a file picker for the Google Desktop OAuth client JSON, starts the local Google consent flow for only gmail.readonly plus identity, and stores the refresh token outside the repository with owner-only file permissions. Do not submit OAuth verification materials solely to use this as a personal app; Google lists personal use as a verification exception. Google may still display an unverified-app warning.

To process a pending request later, double-click the same script. It finds your private key and local OAuth file automatically, previews the requested sender/date/message limit, and waits for you to type YES. No message text is posted to GitHub; only a signed ciphertext reply is posted to the dedicated PR #41.

## Important boundary

This path keeps the Gmail API token and raw Gmail API response off GitHub-hosted Actions. Only a bounded, user-requested result is encrypted for the active assistant session; GitHub stores ciphertext. Google distinguishes the personal-use exception for app verification from its separate security-assessment language concerning restricted data accessed through third-party servers. This local path avoids giving GitHub Actions the ability to read Gmail; do not claim it grants a blanket exemption for every possible data-transfer arrangement. Disclose the AI processing clearly and only retrieve email when the owner asks.

## Existing sender

Do not change send.mjs, owner-setup.mjs, public-key.pem, or .github/workflows/gb2l-approved-email.yml as part of inbox work. The outgoing sender keeps gmail.send only, owner review, per-message approval, quota enforcement, and the existing encrypted request protocol. The local reader uses a separate read-only token, never writes it to GitHub, and never invokes the sender.
