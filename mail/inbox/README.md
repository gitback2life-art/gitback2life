# GitBack2Life encrypted inbox request channel

This pull request is the designated comment channel for the existing GitBack2Life email app's inbound request/response workflow.

- Request comments may contain only `GB2L_INBOX_V1:` encrypted request envelopes.
- Return comments may contain only `GB2L_INBOX_RESULT_V1:` signed ciphertext envelopes.
- Never post plaintext email content, sender filters, credentials, access tokens, or private keys here.
- The receiving workflow must remain disabled unless the owner deliberately enables it for an approved request and the owner-review environment is configured.

This file is a channel marker only. It contains no email, credentials, keys, or active request.