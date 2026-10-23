# 911 GitBack2Life Toolbox — source import and readiness status

Updated: 2026-10-22.

## Repository source status
The complete source tree from the supplied 14-tool Email Communications review build is now tracked as individual files under toolbox/911_gitback2life/distribution/, including all shared modules, all specialist tools, all menu/UI code, tests, fixtures, launchers, both integrity manifests, the Windows staging files, and the consolidated acceptance script. The importer requires the source archive SHA-256 to match the reviewed ZIP and verifies every manifest entry before importing. CI rechecks the imported source manifests and runs the package's Node test suite.

The imported snapshot is exactly build: 2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT. It is a development/review build, not a statement of production readiness.

## Email status
1. Local Toolbox Email Communications is present at distribution/source/911_gitback2life/email_communications/. Its protected HTTPS backend and credentials were not deployed by this package. Live local-tool sending must remain disabled/unconfigured.
2. The separate repository-backed AI email adapter is present at email_communications/github_actions_adapter/ and canonical source remains at tools/gb2l-email/. It is a guarded outgoing-send path via encrypted request comments and GitHub environment approval; it does not read Gmail inboxes/replies.
3. The current GitHub Actions sender readiness check is blocked because the actual Google OAuth access token grant lacks https://www.googleapis.com/auth/gmail.send. See https://github.com/gitback2life-art/gitback2life/actions/runs/39813519317. Mode must remain approval_required.
4. The prior reserved email draft ID dbd4da02a28c5f2acd9e991b26005f0c had an uncertain HTTP 403 outcome and must never be retried or reused. A fresh email test requires a new ID and separate explicit owner authorization.

## Verification limits
- The source archive's embedded and outer SHA-256 manifests were verified before import.
- The Node offline test suite runs in CI under the package's network-denial harness.
- Native Windows staging and menu acceptance were not run on the owner's computer as part of this import.
- The legacy full Python test suite was not treated as passing; the build notes identify a Windows-only _winapi import and two existing deployment payload count expectations that fail in the Linux review environment.
- Importing source files does not deploy services, provision credentials, activate protected authority operations, or authorize live email.
