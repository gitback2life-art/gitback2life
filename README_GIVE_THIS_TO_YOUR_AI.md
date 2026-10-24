# To Baby Brother — integrate into existing GitBack2Life Email Communications

This is the **new inbox-only extension**, not a replacement of the existing working sender. Begin with the latest `main` of `gitback2life-art/gitback2life`. Review the new files under `REPOSITORY_FILES/` and add them at matching paths on a **new feature branch**. Do not overwrite unrelated files. `tools/gb2l-email/INBOX_SETUP.md` is the technical and owner setup guide.

**The other connected AI's GitHub account, not this chat, must perform repository writes.** The GitHub accounts available to the build conversation have `pull: true`, `push: false`; nothing was committed or activated here. Do not merge, run OAuth, alter sender secrets, enable inbox checks/autonomous sending, or read live Gmail until separately authorized.

### Exact contents

- `.github/workflows/gb2l-inbox-check.yml` — dedicated encrypted request-only GitHub Actions workflow, approval-protected
- `tools/gb2l-email/receive.mjs` and `receive.test.mjs` — reviewed baseline staged read-only Gmail retrieval
- `tools/gb2l-email/inbox-transport.mjs` — sealed search criteria, signed response, event/actor validation
- `tools/gb2l-email/inbox-run.mjs` and `inbox-inspect.mjs` — protected sender, replay guard, encrypted reply channel
- `tools/gb2l-email/inbox-flow.test.mjs` — integration/mocking and Python cross-language test
- `tools/gb2l-email/assistant_inbox_session.py` — ephemeral Python assistant-side transport and decryption, kept in active execution session
- `tools/gb2l-email/inbox-prepare-key.mjs`, `inbox-owner-setup.mjs`, `INBOX_SETUP.md` — separate owner-only future activation helpers and documentation

The existing `send.mjs`, `owner-setup.mjs`, `readiness.mjs`, `public-key.pem`, `GB2L_EMAIL_MODE`, and `.github/workflows/gb2l-approved-email.yml` **must remain untouched**. Do not commit the private inbox key or OAuth JSON. A new public inbox key has **not yet been created**: `inbox-public-key.pem` is intentionally absent until the owner creates it on their own trusted computer.

### Run tests on the feature branch

```sh
node --test tools/gb2l-email/receive.test.mjs tools/gb2l-email/inbox-flow.test.mjs
node --test tools/gb2l-email/*.test.mjs
```

The cross-language test requires `python3` and the Python `cryptography` package on the testing runner. For CI, use a pinned Python setup if existing GitHub Actions does not provide it. The standalone staged reader tests need only Node.js 22+.

No new workflow can be asserted operational until GitHub main accepts it, a protected `gb2l-inbox-read` environment is owner-approved, a separate scope-authorized Google credential is provisioned, and a safe synthetic test is decrypted **inside Baby Brother's actual active conversation**.

**Specific connector limitation to verify before enabling:** the connected GitHub app here exposes `add_comment_to_issue` for PR conversation comments (not arbitrary issue comments). This package therefore deliberately uses an **open dedicated PR channel**. Verify that Baby Brother's connected account can post as the trusted `gitback2life-art` actor. A `read`-only GitHub connection cannot create those comments.
