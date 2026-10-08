# Security

The public gitback2life project should never contain private credentials or personally identifying information.

## Do not report secrets publicly

If you discover an accidentally exposed API key, password, access token, private document, or identifying information, do not reproduce it in a public issue. Contact the project owner privately through the dedicated project contact method.

## Personal privacy

The project is intentionally pseudonymous. Public materials should not disclose the operator's legal identity, address, personal phone, private email, medical records, government identification, financial information, passwords, recovery codes, or other sensitive information.

## Public-repository rule

Assume anything committed to this repository can be seen by anyone and retained in Git history.

Do not submit private research, private correspondence, account credentials, sensitive financial or medical information, or identifying material that is not deliberately part of the public project.

## Before every public release

Check for:
- credentials, API keys, tokens, and private keys
- private URLs or tokens
- local filesystem paths that reveal personal information
- personal email addresses or other contact details
- screenshots containing notifications, account names, email addresses, addresses, or billing information
- document metadata or other content that could reveal private information
- research or planning material that was not intentionally selected for public release

## If a secret was committed

Deleting it from the current files is not enough. Treat the secret as exposed, revoke or rotate it as appropriate, and assess whether the public Git history requires remediation.

