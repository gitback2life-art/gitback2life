# GitBack2Life inbox — hosted encrypted reader

## How it works

1. In ChatGPT, ask to read your emails. The assistant posts a one-use `GB2L_INBOX_V1:` encrypted request as a comment on PR #41.
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

Set the repository Actions variable **`GB2L_INBOX_ENABLED`** to the string `true` only after the environment and its secrets are configured. The hosted workflow checks this flag before it starts; if the variable is unset or false, a request comment will not start Gmail reading. This is the kill switch. Keep the sender's `approval_required` mode, daily quota of 30, keys, and secrets unchanged.

The workflow's short-lived `GITHUB_TOKEN` is used for the one-use reservation tag and encrypted response comment. The control token is used only to inspect the protected environment configuration. If the protected environment, control token, inbox key, or OAuth credentials are missing or misconfigured, the reader fails closed.

## Privacy and Google scope note

The repository is private, but that does **not** mean the hosted runner never sees email text: Gmail plaintext is processed transiently in the GitHub-hosted runner's memory before the response is encrypted. The workflow is designed not to persist that text or place it in logs. Only the bounded, encrypted return is posted as a comment.

Google classifies `gmail.readonly` as a restricted Gmail scope and says that storing restricted-scope data on servers or transmitting it requires a security assessment. See [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). A private repository and encrypted return do not waive those requirements. Use this hosted architecture only if you accept the server-side processing boundary and have addressed the applicable Google requirements.

## Safety invariants

- Requester and dedicated PR are checked; only the repository owner's newly created encrypted request is accepted.
- The inbox key fingerprint, one-use request ID, temporary return key, response signature and read-only Gmail scope are verified.
- At most five Inbox messages are read; attachments are not fetched.
- The existing outgoing email sender remains separate and unchanged.
