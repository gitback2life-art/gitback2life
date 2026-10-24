# GitBack2Life inbox — hosted encrypted reader

## How it works

1. In ChatGPT, ask to read your emails. The assistant posts a one-use `GB2L_INBOX_V2:` encrypted request as a comment on PR #41.
2. The `.github/workflows/gb2l-inbox-read.yml` workflow starts from the GitHub `issue_comment` event. It only accepts a new request comment authored by `gitback2life-art` on the open, dedicated PR #41, while running trusted code from `main`.
3. The job uses a dedicated Gmail refresh token authorized for `gmail.readonly` to read at most five newest messages from Inbox, all senders by default. It verifies the expected Google account and the read-only scope, reserves the request ID against replay, and never writes to or sends mail.
4. The reply is encrypted for the active ChatGPT session's temporary public key and signed. GitHub receives only the encrypted response comment; message text and headers are not printed to workflow logs.

The protected `gb2l-inbox-read` environment requires owner approval before each hosted job can access Gmail. This gives the request an automatic GitHub Actions trigger, with the environment approval remaining as a second safety gate before mailbox contents are read.

## One-time GitHub configuration

In **Settings → Environments**, create an environment named exactly `gb2l-inbox-read`:

- Add `gitback2life-art` as a required reviewer.
- Restrict deployments to `main` only.
- Add these as **environment secrets** (never commit them and never paste them into ChatGPT):

| Secret name | Value source |
|---|---|
| `GB2L_CONTROL_TOKEN` | The same existing control-token value used by the sender workflow. If it is currently only an environment secret under `gb2l-email-send`, copy its value into this environment too. |
| `GB2L_INBOX_REQUEST_PRIVATE_KEY` | Complete PEM contents of `%USERPROFILE%\\gb2l.inbox.private.pem` |
| `GMAIL_CLIENT_ID` | `client_id` from the same Google OAuth Desktop client JSON used by your Gmail sender, or the matching ID in `%LOCALAPPDATA%\\GitBack2Life\\inbox-oauth.json` |
| `GMAIL_CLIENT_SECRET` | `client_secret` from that same OAuth client JSON/local file |
| `GMAIL_INBOX_REFRESH_TOKEN` | `refresh_token` from `%LOCALAPPDATA%\\GitBack2Life\\inbox-oauth.json` |

The **client ID and client secret may be the same values already used by the sender**, so you do not need a second OAuth client just for reading. The Gmail refresh token must be the dedicated read-only inbox grant; do not reuse the sender's refresh token because it may have only `gmail.send` scope, and this reader intentionally rejects broader Gmail scopes. The inbox private key is separate from the sender's mail key because it protects a different encrypted request/return protocol.

The hosted reader is **paused pending Google data-policy compliance**. The workflow requires both repository Actions variables `GB2L_INBOX_ENABLED=true` and `GB2L_INBOX_GOOGLE_COMPLIANCE_READY=true`; the second gate must remain unset/false until the required security assessment is complete (or Google confirms an exemption in writing) and the privacy notice, OAuth privacy-policy URL, and in-context consent flow are in place. Do not set the compliance-ready variable merely to test the workflow. Keep the sender's `approval_required` mode, quota, keys, and secrets unchanged.

The workflow's short-lived `GITHUB_TOKEN` is used for the one-use reservation tag and encrypted response comment. The control token is used only to inspect the protected environment configuration. If the protected environment, control token, inbox key, or OAuth credentials are missing or misconfigured, the reader fails closed.

## Consent before every request

Before generating a request, the assistant must show the in-context disclosure immediately before asking for permission:

> This request will retrieve up to five matching Gmail Inbox messages, including message metadata and text. GitHub Actions will process the message text transiently before encrypting the result into a comment on this public repository. The encrypted result will be provided to ChatGPT for the email analysis you requested. The comment is public ciphertext and may persist; ChatGPT processes decrypted content under its own service terms and settings. Do you explicitly consent to this retrieval and sharing for this request?

Only after the user explicitly answers yes may the assistant call `InboxSession.prepare_request(..., consent_confirmed=True)`. A missing consent flag is rejected by the client and server. The request records the notice version and UTC time inside the encrypted payload. No request must be submitted on silence, ambiguity, or a negative answer.

## Privacy and Google scope note

The repository is private, but that does **not** mean the hosted runner never sees email text: Gmail plaintext is processed transiently in the GitHub-hosted runner's memory before the response is encrypted. The workflow is designed not to persist that text or place it in logs. Only the bounded, encrypted return is posted as a comment.

Google classifies `gmail.readonly` as a restricted Gmail scope. Google states that an app with restricted data accessible from or through a third-party server must undergo a security assessment by a Google-approved assessor, with reassessment at least every 12 months. Personal-use status is an OAuth verification exception; Google's published assessment rule does not extend that exception to hosted server processing. See [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), and the [Workspace User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

## Safety invariants

- Requester and dedicated PR are checked; only the repository owner's newly created encrypted request is accepted.
- The inbox key fingerprint, one-use request ID, temporary return key, response signature, per-request consent attestation and read-only Gmail scope are verified.
- The hosted reader remains disabled until the external Google compliance prerequisites are completed and the owner deliberately enables the compliance-ready gate.
- At most five Inbox messages are read; attachments are not fetched.
- The existing outgoing email sender remains separate and unchanged.
