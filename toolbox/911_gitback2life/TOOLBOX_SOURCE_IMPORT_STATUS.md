# 911 GitBack2Life Toolbox — source-control gap

Updated: 2026-10-22.

This repository's main branch contains the configured GitHub Actions email adapter at `tools/gb2l-email/` and the active workflows at `.github/workflows/gb2l-*.yml`. This branch adds a verified mirror of those files inside `toolbox/911_gitback2life/email_communications/github_actions_adapter/`, plus installation guidance and workflow templates.

**Remaining gap:** the full 14-tool Toolbox source package is not yet tracked in this repository as individual files. The available later review build, `911_GitBack2Life_Email_Communications_Review_Build_20261020.zip`, existed as a working-session artifact; the entire source tree was not present in GitHub main. The earlier copy labelled `911_GitBack2Life_Toolbox_FULL_COPY_20261022.zip` was instead built from the 13-tool reliability ZIP and omitted the 14th Email Communications tool and the newly configured GitHub email adapter.

The 14-tool review ZIP marks the local Email Communications feature as development/review-only: its offline mocked tests passed, but native Windows staging/GUI and live Gmail HTTPS/OAuth/backend deployment were not verified. Presence of source code does not mean the protected backend has been deployed or enabled.

Before claiming a GitHub-connected AI can install **all** Toolbox tools from this repository alone, the entire verified 14-tool package (all source modules, helpers, tests, launchers, and integrity manifests) must be imported as individual repository files and tested. This document deliberately keeps separate:
- source that exists in a generated ZIP;
- source committed in GitHub;
- an adapter configured in GitHub Actions; and
- a live service that is actually operational.
