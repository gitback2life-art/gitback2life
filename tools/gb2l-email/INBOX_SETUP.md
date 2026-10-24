# GitBack2Life inbox — hosted encrypted reader

## How it works

1. In ChatGPT, ask to read your emails. The assistant posts a one-use `GB2L_INBOX_V1:` encrypted request as a comment on PR #41.
2. The `.github/workflows/gb2l-inbox-read.yml` workflow starts from the GitHub `issue_comment` event. It only accepts a new request comment authored by `gitback2life-art` on the open, dedicated PR #41, while running trusted code from `main`.
3. The job uses the dedicated Gmail OAuth grant to read at most five newest messages from Inbox, all senders by default. It verifies the expected Google account and the read-only scope, reserves the request ID against replay, and never writes to or sends mail.
4. The reply is encrypted for the active ChatGPT session's temporary public key and signed. GitHub receives only the encrypted response comment; message text and headers are not printed to workflow logs.

The protected `gb2l-inbox-read` environment is intentional: its required reviewer and `main`-only deployment branch policy must match the checks in `inbox-run.mjs`. A request triggers the workflow automatically, but the job waits for the configured GitHub environment approval before accessing Gmail.

## One-time GitHub configuration

In **Settings → Environments**, create an environment named exactly `gb2l-inbox-read`:

- Add `gitback2life-art` as a required reviewer.
- Restrict deployment branches to `main` only.
- Add these as **environment secrets** (never commit them and never paste them into ChatGPT):

| Secret name | Value source |
|---|---|
| `GB2L_INBOX_REQUEST_PRIVATE_KEY` | Complete PEM contents of `%USERPROFILE%\\gb2l.inbox.private.pem` |
| `GMAIL_INBOX_CLIENT_ID` | `client_id` in `%LOCALAPPDATA%\\GitBack2Life\\inbox-oauth.json` |
| `GMAIL_INBOX_CLIENT_SECRET` | `client_secret` in that same local OAuth JSON |
| `GMAIL_INBOX_REFRESH_TOKEN` | `refresh_token` in that same local OAuth JSON |

The existing repository Actions secret `GB2L_CONTROL_TOKEN` is used only to read the protected environment's configuration. The workflow's short-lived `GITHUB_TOKEN` is used for the one-use reservation tag and encrypted response comment. If the control token is absent or cannot read environment configuration, the hosted reader fails closed.

The OAuth JSON must be the dedicated read-only inbox authorization created by `inbox-local-setup.mjs`, not the outgoing sender's `gmail.send` credential. The hosted job's settings are intentionally scoped to this reader. Do not change the sender's `approval_required` mode, its daily quota of 30, its keys, or its secrets. Keep any repository-level `GB2L_INBOX_ENABLED` setting unchanged; the workflow only enables the reader within its guarded job.

## Privacy and Google scope note

The repository is private, but that does **not** mean the hosted runner never sees email text: Gmail plaintext is processed transiently in the GitHub-hosted runner's memory before the response is encrypted. The workflow is designed not to persist that text or place it in logs. Only the bounded, encrypted return is posted as a comment.

Google classifies `gmail.readonly` as a restricted Gmail scope and says that storing restricted-scope data on servers or transmitting it requires a security assessment. See [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes). A private repository and encrypted return do not waive that requirement. Use this hosted architecture only if you accept that processing boundary and have addressed the applicable Google requirements.

## Safety invariants

- Requester and dedicated PR are checked; only the repository owner's newly created encrypted request is accepted.
- The inbox key fingerprint, one-use request ID, temporary return key, response signature and read-only Gmail scope are verified.
- At most five Inbox messages are read; attachments are not fetched.
- The existing outgoing email sender remains separate and unchanged.
