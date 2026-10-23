# GitBack2Life Email Request Channel

This pull request is a dedicated **encrypted request channel** for the owner-controlled GitBack2Life email adapter. Keep this pull request open while the adapter uses its issue-comment transport.

## Rules for this channel
- Submit only a complete encrypted comment beginning with `GB2L_EMAIL_V1:` created by the approved sealer workflow/tool.
- Never post the plaintext recipient, subject, message body, private review nonce, OAuth credentials, tokens, private key, recovery codes, or sensitive case material here.
- Public comments are public. Ciphertext-only transport reduces exposure of message contents but does not make the pull request private.
- The owner reviews the full draft and private receipt outside this PR. In `approval_required` mode, each message also requires the protected `gb2l-email-send` GitHub Actions deployment approval.
- This pull request is a message-request channel, not an implementation PR. Do not merge it as part of sending a message.
- Sending stays disabled until the owner has completed and verified the no-send preflight and explicitly enabled `approval_required`.

No email request or personal data is included in this file.
