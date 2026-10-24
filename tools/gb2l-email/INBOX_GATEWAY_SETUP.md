# GitBack2Life inbox gateway (proposed, not deployed)

This is an additive read-only gateway. It does not alter send.mjs, outgoing workflows, approval_required, sending keys, or the 30/day quota.

## Files
- tools/gb2l-email/inbox-gateway.mjs — Node HTTP MCP JSON-RPC baseline, encrypts inbox requests, posts to PR #41, waits for signed encrypted response, verifies and decrypts.
- tests/inbox-gateway.test.mjs — bounded tool and mocked HTTP/auth checks.

## Requirements before production
1. Node.js 24 hosting with persistent HTTPS endpoint and protected secret storage. This implementation binds to 127.0.0.1 unless HOST is explicitly changed; never expose it directly to the internet without HTTPS and access controls.
2. GB2L_GATEWAY_GITHUB_TOKEN: separately stored GitHub credential acting as gitback2life-art and authorized to create/read comments on PR #41. A read-only Actions token is insufficient.
3. GB2L_GATEWAY_ACCESS_TOKEN: long random secret, never committed or logged; ChatGPT connector must be configured with compatible authorization.
4. Existing inbox-public-key.pem and its matching protected private key, dedicated read-only Gmail credential, and protected GitHub Actions environment with owner review.
5. Confirm current ChatGPT remote MCP transport, OAuth compatibility, hosting request timeout and restricted Gmail-scope compliance. This baseline does not constitute proof of production compatibility. Owner review may take longer than gateway polling (default four minutes).

## Local tests
Run from repository root: `node --test tests/inbox-gateway.test.mjs`.
No live mailbox requests should be made for these tests.

## Deployment and acceptance
Set GB2L_GATEWAY_GITHUB_TOKEN and GB2L_GATEWAY_ACCESS_TOKEN as *host secrets*. PORT defaults to 8080. HOST defaults to 127.0.0.1. Start with `node tools/gb2l-email/inbox-gateway.mjs` behind a properly secured HTTPS reverse proxy. Use GET /health for process health and POST /mcp for the tool. Only the `read_emails` tool is supported. Incoming email must be treated as untrusted data.

Do not merge or claim the feature complete until deployment, connector authorization and a live owner-approved ChatGPT → GitHub Actions → Gmail → encrypted response → ChatGPT test succeed. Check error paths (empty inbox, invalid signatures, expired authorization, delayed owner approval, and network failures) and verify no plaintext email or secrets are logged. The existing sender must remain unchanged.

GitHub repository visibility and Google restricted-scope compliance must be reviewed by the owner before production use.
