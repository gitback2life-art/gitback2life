# Email Communications — owner-authorized development patch

**Status: development implementation, not deployed, not connected, not approved for real sending.**

The project owner specifically requested an additional dedicated **Email Communications** tool following the earlier 13-tool consolidation. Original tools remain available; there are now 14 top-level choices by explicit later direction. This is not a new remote-access capability: it offers HTTPS **email-only** operations and cannot control a client's computer.

## Workflow

1. An operator opens **Email Communications** in the existing mouse/numeric-key Toolbox (tool 14, keyboard `0` then `5`).
2. The Toolbox requests the protected HTTPS backend URL and operator access configuration from its environment. Without these, the tool states **not configured**. It never silently uses personal Gmail accounts.
3. The operator chooses an existing incident, one recipient, plain-text subject/message, and optionally an evidence-based suggestion from the existing Notice Drafter. Direct observations, reports, hypotheses, unknowns and requested action must remain distinguishable. The operator reviews or edits every line.
4. The encrypted backend saves the draft and returns an opaque ID. The operator fetches the complete draft to review *From, To, Cc, Bcc, subject, full text and attachments* (the latter three are disabled/empty in the first release).
5. A role-authorized person **explicitly approves the SHA-256 of that exact draft**. Any edit invalidates approval. A separate send action requires another explicit confirmation and an independent protected role check. No AI or UI text can bypass the backend checks.
6. When activated, Gmail returns a message ID for an accepted send. Failed or ambiguous outcomes are recorded separately. An attempted message cannot be automatically retried, even after a timeout, service restart or double click. The protected audit record retains the result. The case timeline records only a nonprivate email ID and outcome.
7. The owner can connect and disconnect the approved Gmail account. The service never reads inboxes or creates bulk jobs or attachments.

## Configuring a protected backend (owner/admin task, *not* done by this development package)

Requires Node.js 22+, an existing protected server with HTTPS certificate and key, a protected administrative operator credential file, and Google Cloud **Web application** OAuth credentials with an exact HTTPS redirect URI. Do **not** run the protected backend from a volunteer-accessible filesystem or expose its environment to the Toolbox UI. No local HTTP fallback for deployed Gmail OAuth.

Required backend environment-variable **names** (never commit values):

| Name | Purpose |
|---|---|
| `GB2L_EMAIL_BACKEND_MODE` | Must be `protected` to start the server |
| `GB2L_EMAIL_STATE_DIR` | Dedicated access-controlled backend data directory, not in the repository/ZIP or volunteer PC |
| `GB2L_EMAIL_KEY_B64` | Independent 32-byte random AES-GCM secret encoded with base64, stored in server secrets manager |
| `GB2L_EMAIL_TLS_CERT` | Existing TLS public certificate file path |
| `GB2L_EMAIL_TLS_KEY` | Existing private TLS key file path (restricted permissions) |
| `GB2L_EMAIL_OPERATORS_FILE` | Private JSON operator config with `operators` array of `{actor,tokenSha256,roles,incidents}`; distinct random bearer token per operator; never store plaintext tokens here |
| `GB2L_GMAIL_CLIENT_ID` | Google OAuth web client ID |
| `GB2L_GMAIL_CLIENT_SECRET` | Google OAuth web client secret, backend only |
| `GB2L_GMAIL_REDIRECT_URI` | Exact registered `https://.../oauth/callback` URI routed to this protected backend |
| `GB2L_EMAIL_PORT` | Optional HTTPS service port (default 8443) |
| `GB2L_EMAIL_BIND_HOST` | Optional listener address; default `127.0.0.1`, do not publicly expose without network controls |
| `GB2L_EMAIL_LIVE_SEND_ENABLED` | Must be the literal `1` **and** protected authorizations must all succeed for sending; default is off |
| `GB2L_EMAIL_VERIFIED_SENDER` | Must match `gitback2life.ai@gmail.com` after an owner-controlled account-identity confirmation; otherwise live sending remains off. This is an owner's attestation, not cryptographic proof |

Required **Toolbox operator** settings:

| Name | Purpose |
|---|---|
| `GB2L_EMAIL_API_URL` | Exact protected HTTPS backend origin (for example `https://email.internal.example:8443/`) |
| `GB2L_EMAIL_OPERATOR_TOKEN_FILE` | Restrictive-permissions file containing only this operator's random bearer token (outside the Toolbox and repository) |

Operator config roles: `draft`, `review`, `approve`, `send`, `connect`. `incidents` may be an approved list of case IDs or `*`; avoid broad access in production. The protected server matches hashes with constant-time comparison and never logs bearer tokens. The backend directory must have OS ACLs restricting files, keys and secrets to the dedicated service identity. File permissions alone should **not** be assumed to enforce Windows ACLs. Certificate trust and permitted ports must be configured by the server administrator.

**Owner provisioning:** Enable Gmail API in Google Cloud, set the consent screen, configure Web application OAuth, register the exact HTTPS redirect URI, and request **only** `https://www.googleapis.com/auth/gmail.send`. Use the Toolbox connection workflow to open Google's consent page. The owner must verify on Google's screen that the signed-in Google account is `gitback2life.ai@gmail.com` before consenting. `gmail.send` does **not** permit the API to independently read account/profile identity; therefore the connected identity must also be checked by an owner in a controlled live test. This patch does not claim that check has occurred. Google testing-mode, test-user and app-verification requirements may apply before wider use.

## Scope and authorization for live email

The operator must have verified backend role permissions, and an existing active incident. Before each send, the backend demands:
- Existing incident scope with `save_local` permission.
- `contact_third_party` permission for the recipient **domain** (listed among scope targets), a current exact-target attestation, and `gmail` listed in scope disclosures.
- The **installed, valid protected signed owner authority** (`checkAuthority().required && .valid`). Without this, send is refused even when someone typed an attestation into a JSON scope file.
- The current encrypted draft's unmodified approved hash, a configured Gmail OAuth token and the explicit send action. An attempt record is committed *before* the first provider call.

These are new, deliberately stringent constraints. **This developer package does not activate the protected authority or owner Gmail service**. There is no equivalent of `--unsafe` or a local admin bypass.

Only the sender's authorized email service communicates with Google. The client does not read donor lists, Gmail inboxes, client-machine files, or remote desktops. The original incident data and protected approval records are not modified by this patch. Only the live-protected backend, when separately deployed, may create encrypted mail records and append metadata-only case timeline revisions.

## Testing / release status

Run `node --test email_communications/email_service.test.mjs` for synthetic offline unit tests. Integration with the existing Toolbox menu is checked by `toolbox/gui_ui.test.mjs` and `toolbox/13_tool_interface.test.mjs` (the latter retains its historical filename). The complete offline suite and manifest verification are also included in the delivery package.

**Still required**: provision an actual protected backend and verified operator identities; independent security review (including OAuth handling, ACL enforcement, exact-case scope, recipient authorization and privacy); controlled end-to-end testing of HTTPS callback and Gmail token refresh; owner-designated test-recipient send and message-ID verification; native Windows GUI and staging testing; owner's review/approval of deployment and publication. No test should contact an actual animal rescue.

The current GitHub connectors did not expose the authoritative Toolbox source repository or its working branch. This patch is therefore based on the owner's most recent supplied source ZIP, packaged for review. **No GitHub branch, PR, merge or deployment was performed.** Do not put private incident material, tokens, operator configs or test messages into any public repository.
