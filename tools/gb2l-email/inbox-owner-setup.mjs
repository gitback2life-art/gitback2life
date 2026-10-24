#!/usr/bin/env node
// Deprecated intentionally: this older setup placed restricted Gmail read credentials
// in GitHub Actions. Use inbox-local-setup.mjs so Gmail authorization stays on the owner computer.
console.error('This server-side inbox setup is retired. Do not provision gmail.readonly into GitHub Actions. Run Read-GB2L-Inbox.ps1 or tools/gb2l-email/inbox-local-setup.mjs instead.');
process.exitCode = 1;
