# GitBack2Life inbox — local read path

## Why Gmail reading is local

The existing sender is already working and remains unchanged: owner-setup.mjs requests gmail.send, stores the outgoing refresh token as a protected GitHub Actions secret, and the approval-gated workflow sends the approved encrypted request. gmail.send is a sensitive scope.

gmail.readonly is a restricted scope. Google lists personal use as an exception to submitting an app for OAuth verification, but its docs separately discuss security assessment when restricted Gmail data can be accessed from or through a third-party server. The previous inbox workflow would have read plaintext messages inside GitHub Actions. That server-side reader has been disabled; use the local reader instead. Sources:
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/workspace/gmail/api/auth/scopes

## First-time setup

1. The public inbox key is already merged on main. The matching private key is expected at %USERPROFILE%\gb2l.inbox.private.pem, outside the repository.
2. Keep the existing Cloud Console scope declaration, including gmail.readonly. Do not submit the app for public verification merely to use this as a personal app. Google's personal-use exception can allow the app to proceed with an unverified-app warning; only continue for your own account if the account shown is gitback2life.ai@gmail.com.
3. From the local repo root, double-click Read-GB2L-Inbox.ps1. On first run, choose the Google Desktop OAuth client JSON when the file picker opens. The local setup requests only gmail.readonly plus openid/email identity, checks the actual grant and exact account, and stores the refresh token outside GitHub and outside the repo in %LOCALAPPDATA%\GitBack2Life\inbox-oauth.json with a Windows owner-only ACL. It does not read any email during setup.
4. If Google does not issue a refresh token or the actual grant includes another Gmail scope, the setup refuses and writes no credentials. Do not broaden the scope or replace the existing sender grant.

## One-time local watcher

After OAuth setup is complete, start the local watcher once and leave its PowerShell window open:

```powershell
$repo = Join-Path $env:USERPROFILE 'GitBack2Life-InboxSetup'
& (Join-Path $repo 'Read-GB2L-Inbox.ps1') -Watch
```

The watcher checks PR #41 every 10 seconds. Closing the window or pressing Ctrl+C stops it; after Windows restarts, start it again.

## Reading email from ChatGPT

1. In the active assistant conversation, simply ask to read your emails. The assistant prepares a one-use encrypted GB2L_INBOX_V1 request for the newest five messages in Inbox from any sender. A sender, date, or smaller limit can be specified, but is not required.
2. The assistant posts only that encrypted request to PR #41. The already-running local watcher accepts only a valid encrypted request comment authored by `gitback2life-art`, created after the watcher started, then reads only the requested bounded messages locally without asking you to type YES again.
3. The local reader reserves the request ID once, signs and encrypts the bounded result to the active assistant session's temporary return key, and posts only ciphertext to PR #41. The assistant retrieves and decrypts that response in the same active session. If the assistant session has reset, ask for a fresh request.
4. GitHub Actions must never read Gmail. Keep GB2L_INBOX_ENABLED=false and do not add the Gmail read refresh token to GitHub secrets.

## Data handling

Gmail API access and raw message results remain on the owner's computer. GitHub receives only the bounded signed ciphertext. Email text is untrusted user content and must be used only to answer the owner's explicit request. Because the user chooses to send selected contents into the assistant session, the product should clearly disclose AI processing. The personal-use OAuth-verification exception and the separate server security-assessment language are distinct; this design avoids GitHub Actions having access to the restricted Gmail data, but does not promise a blanket exemption for unrelated server-side handling.

## Sender protection

No modifications to the existing outgoing sender or its workflow are intended. Keep approval_required mode, environment review, quota, keys and sender secrets unchanged.
