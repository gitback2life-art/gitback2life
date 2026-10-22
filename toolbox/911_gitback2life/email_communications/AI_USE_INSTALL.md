# 911 GitBack2Life Toolbox — AI Use and Installation Guide

## First: inspect the actual tool sources

- `source/911_gitback2life/MASTER_TOOL_LIST.md` is the specialist module inventory.
- `source/911_gitback2life/README_13_TOOLS.md` describes the original 13-menu-tool base.
- `source/911_gitback2life/TOOLKIT_RULES.md` and `source/911_gitback2life/CLAUDE.md` define operating and safety constraints.
- `source/911_gitback2life/EMAIL_COMMUNICATIONS_REVIEW.md` and `source/911_gitback2life/email_communications/README.md` describe the 14th Email Communications menu action and its protected-backend requirements.
- `github_actions_adapter/ASSISTANT_GUIDE.md` and `github_actions_adapter/OWNER_SETUP.md` describe the separate AI/GitHub email sender adapter.
- `github_actions_adapter/workflow-templates/` contains all four GitHub Actions workflows required by that adapter.

Use the included staging script to verify and stage the local Toolbox package on Windows. Do not bypass its manifest, authorization, or isolation checks to make a failed install appear successful.

## The two Email paths are distinct

**Toolbox menu Email Communications** uses `email_client.mjs` to talk over HTTPS to a dedicated owner-protected backend implemented by `email_service.mjs` and `protected_backend.mjs`. The reviewed source package contains code/tests but does not deploy that backend or provision its OAuth credentials. It must stay unconfigured and unable to send until the owner completes protected deployment and verifies the controls.

**AI/GitHub Actions email adapter** uses the bundled `github_actions_adapter/` source and GitHub workflows. It accepts encrypted send requests via PR #18, uses the protected GitHub deployment approval gate, and calls Gmail's send API only after authorization. It is configured for `gitback2life-art/gitback2life`, but sending readiness is currently blocked because the actual OAuth grant lacks `gmail.send`.

Neither path reads incoming Gmail messages or replies. GitHub comments and workflow status are not Gmail inbox access.

## Safe install rules

- Keep local incident records and real email contents out of the public repository and source archive.
- Never package OAuth client JSON, private keys, refresh/access tokens, GitHub control tokens, secret values, plaintext drafts, or private review nonces. The published public key may be included.
- For the current repository, use the canonical implementation at `tools/gb2l-email/` and `.github/workflows/`; the packaged copy is checked byte-for-byte by `verify-bundle.mjs`.
- For a different repository, the GitHub adapter is **not plug-and-play**: it pins repository and owner identities. Review and update all repository-specific constants, workflows, permissions, environments, variables and secrets through a reviewed change before installation.
- Never enable `auto_send` or bypass owner approval to overcome a failing diagnostic.
- Do not retry a previously reserved or uncertain send. A new email needs a new ID and explicit authorization.

## Current email blocker

The latest no-send workflow reports that the actual Google OAuth access token grant lacks `https://www.googleapis.com/auth/gmail.send`. See [readiness run 39813519317](https://github.com/gitback2life-art/gitback2life/actions/runs/39813519317). The next authorized recovery is to reauthorize the existing Desktop OAuth client as `gitback2life.ai@gmail.com` with `gmail.send` and `openid email`, then rerun the readiness check. No new email test is authorized by this guide.

## Verification

From the repository root:

```powershell
node toolbox/911_gitback2life/email_communications/github_actions_adapter/verify-bundle.mjs
node --test tools/gb2l-email/*.test.mjs
```

## Current source-control gap

The full 14-tool Toolbox source is not yet committed as individual files in this GitHub repository. This email adapter bundle makes the separate email sender files discoverable within the repository's Toolbox path; it does not claim the other local-tool source files have been imported. See `../TOOLBOX_SOURCE_IMPORT_STATUS.md`.
