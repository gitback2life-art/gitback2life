# 911 GitBack2Life Toolbox — repository source

This directory is the repository-tracked source distribution for the 14-tool 911 GitBack2Life Toolbox review build. The original build files are kept under distribution/ with their source-relative folder layout and both SHA-256 manifests.

## Start here
1. Read distribution/README_START_HERE.md and distribution/BUILD_NOTES.md.
2. Review distribution/source/911_gitback2life/MASTER_TOOL_LIST.md, TOOLKIT_RULES.md, and CLAUDE.md before an AI runs or changes anything.
3. On Windows, use distribution/STAGE_TO_APPROVED_TEMP.cmd only from an extracted distribution folder. It verifies the package manifests and stages a separate copy; native Windows staging and full menu acceptance still need to be verified on the target computer.
4. A GitHub-connected AI can read the source files directly in this directory. It must preserve the manifest integrity and request explicit authorization before any live or privileged operation.

## Email Communications has two distinct paths
- Local Toolbox menu tool: distribution/source/911_gitback2life/email_communications/. This is a development implementation that expects an owner-protected HTTPS backend. The backend is not deployed or configured by the source package and must remain unavailable for real sending until the owner separately provisions and verifies it.
- Repository-backed AI/GitHub email adapter: email_communications/github_actions_adapter/ and canonical source at tools/gb2l-email/, with workflow templates under its subdirectory. It sends outgoing messages only using protected GitHub Actions approval. It does not read a Gmail inbox or incoming replies. Its current no-send readiness blocker is the actual Google OAuth grant missing gmail.send; see the bundled AI guide and workflow run link there.

Never put Google client JSON, OAuth tokens, refresh tokens, private keys, GitHub control tokens, real drafts, incident-private data, or private approval receipts in this public repository. The public encryption key is distributable; its private counterpart is not.

The archive's hashes prove byte integrity of this source snapshot, not operational readiness. The review build reports 437 passing and 12 skipped Node tests at the supplied snapshot; native Windows GUI/staging acceptance and live Gmail/OAuth deployment were not verified. See BUILD_NOTES.md.
