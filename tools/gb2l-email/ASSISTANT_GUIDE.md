# GitBack2Life AI Email Communications — instructions for GitHub-connected assistants

## Prerequisites

- The owner has completed `OWNER_SETUP_READ_FIRST.md` and added `tools/gb2l-email/public-key.pem` to the repository.
- Repository owner-required review is enabled for `gb2l-email-send` GitHub Actions environment.
- `main` is protected and code-owner review applies to privileged email sender code.
- This is a public repository: do not put any plaintext recipient, subject, message, private client data, token, key, or credential into issues, PR descriptions, comments, tracked files, logs, or history.

## Preparing one email

1. Work with the owner **privately** to establish a legitimate incident scope and compose the email. Clearly distinguish verified facts, third-party reports, and uncertainties. Never imply a suspicious domain or person is confirmed guilty without evidence.
2. Obtain the owner's permission to create a draft, not to send.
3. In a private temp folder OUTSIDE the cloned GitHub repository, create a UTF-8 JSON with fields `to`, `subject`, `body`, optionally `incident_id` (single recipient, no attachments). Example:
   ```json
   {"to":"OWNER-DESIGNATED-TEST@EXAMPLE.ORG","subject":"Test only","body":"This is an explicitly requested harmless test.","incident_id":"SYNTHETIC"}
   ```
4. Run from repository root: `node tools/gb2l-email/seal.mjs /path/outside/repo/to/draft.json`. Requires Node.js 22+ and the owner's public key in the repo.
5. Give the owner the exact entire draft privately including the sealed draft's `id` (same as filename), and show the full sender/recipient/subject/body. The owner can paste `{"id":"...", ... original draft ...}` into the included `review-local.html` to calculate the content commitment independently.
6. Commit **only** the encrypted `mail/outbox/<id>.sealed.json` file to a new branch and open a PR. Do not change workflow or sending code in the same PR.
7. The owner reviews and merges the PR. `inspect.mjs` enforces one encrypted draft per commit, and the GitHub Actions summary displays only the ID and commitment.
8. The owner compares that commitment with the independent local review and clicks **Approve and deploy** for the **gb2l-email-send** environment if and only if the exact message is acceptable.
9. Report the GitHub Actions outcome. `provider_accepted` means Gmail accepted the request, not proof of recipient delivery. If `uncertain_delivery`, **do not rerun or reissue the same message automatically**.

## Do not

- Do not put Google Desktop OAuth `.json` or Gmail refresh tokens, a private key, private messages or identity data in the public repository.
- Do not use `pull_request_target` or PR workflows with Gmail secrets.
- Do not disable GitHub environment owner approval or widen Google scopes beyond `gmail.send`.
- Do not run autonomous mailing, batch sends, attachments, inbox reads or remote computer control.
- Do not claim a GitHub connector by itself can execute node scripts; the connected assistant needs a code execution environment and appropriate GitHub write / PR privileges.

## Testing

`node --test tools/gb2l-email/email.test.mjs`

Current tests mock the Gmail/GitHub APIs; they cannot validate OAuth, Windows, GitHub environments, or live sending until the owner completes setup and a harmless test send.
