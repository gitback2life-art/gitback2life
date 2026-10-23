# GitBack2Life — 13-tool interface

The Windows launcher now shows **exactly 13 numbered tools**. Pick a number 1–13, then pick an action within that tool. `0` returns from an action list to the main menu; `/back` cancels a prompt. **The historical letter labels below are internal action codes** and are no longer typed on the main menu. The original code modules and protections remain available, even where two modules share one tool.

1. Incident Management
2. Evidence Collection
3. Reports & Evidence Packages
4. Domain Health
5. Website Redirect & Authenticity
6. Email Security
7. Account Recovery & Access
8. Organization Registers
9. Directory Audit
10. Website Code Analysis
11. Dependency Analysis
12. File Protection
13. Computer Security Check

**Passive DNS/GitHub/domain checks are not offline.** They appear only as explicit actions and demand a typed `LOOKUP` confirmation and an existing incident scope permitting the exact target and outside service. The underlying specialist independently verifies scope, rate limits and network safeguards. A live redirect can run only within the existing verified inspect-mode sandbox with a fresh exact-URL attestation; ordinary Windows launchers cannot run it. No tool in this menu writes to an outside organization, contacts an account for recovery, applies a restore, signs an approval, or activates production authority.

Internal components such as the regression harness, Windows Sandbox support and protected authority are **not additional user-facing tools**. The extended direct CLI is preserved for compatibility and existing tests.

---

# One-click ordinary toolbox menu

Double-click `TOOLBOX.cmd` on Windows (Node.js 22+ required). It does not install, activate, elevate or start a service. All existing standalone utilities remain available. **At any input prompt, type `/back` to return to the main menu. Ctrl+C exits cleanly without registering a toolbox failure.**

The menu brings **incident drafts, sourced observations, evidence and decision reports, register health reports, role-offboarding checklists, incident timeline reports, backup previews, and review-request preparation** together in one place. Online public-record lookups require deliberate scope and confirmation; live redirects remain blocked outside their verified sandbox. It never updates protected registers, approves a change, signs anything, or contacts the protected pipe.

- `Cases/<case-id>/scope.json`: a local, offline-only scope; saves are explicitly allowed, all network/third-party actions default to forbidden. Cases are persistent project data, **not** disposable Temp files.
- `Cases/<case-id>/ledger_0000.json`, then `ledger_0001.json` etc.: append-only user-facing evidence revisions. Existing revision files are never overwritten.
- `Cases/<case-id>/reports/`: Markdown evidence and decision summaries, one set per revision.
- `Temp/Requests/<incident>_<operation>_<unique-id>/`: temporary review requests, using the prepared authority wire format. The authority remains inactive; a prepared request is *not* an approval. The incident must have a committed authority scope before the authority could later act on it.

Register create requests can start with an empty register without a JSON input (menu C). Otherwise, register requests require an existing JSON input. `create` takes a full empty-history register with the schema accepted by the authority. `replace` takes one complete proposed record. The menu checks the input and writes a new review request, not an updated register. The input must already contain safe metadata (not passwords, contact details or secret-bearing URLs). Existing read-only Python reports and other standalone tools continue to work independently.

Toolbox files and logs stay within the current staged copy. The one-click stager uses the already-existing Desktop `911_gitback2life\Temp` when available, otherwise the current user's `LocalApplicationData\GitBack2Life\Temp`; no Windows username or drive is hardcoded. This menu performs no installation.

For scripted use: `node toolbox/toolbox.mjs --help`.

Read-only Python reports are run through fixed bundled scripts with Python 3.10+; no shell commands are constructed from user input. Reports print to the console and do not save or modify the source registers.

When an owner-controlled console is actually running, menu D can transmit a prepared request through its one-time local pipe. This merely transmits bytes, it does not approve, sign, install or activate anything. The one-time code is prompted interactively rather than exposed in process arguments.

Menu E prepares a bounded text-only restore request from an existing folder inside the toolbox. It refuses links, binary files, inappropriate path names, and text requiring contact/secret masking. Files are staged for review only; no restore is applied.

Menu F explicitly stops a case scope (only after typing the case ID again). This prevents further saves under that scope; previous revisions stay intact.

## Automatic developer error logging

The one-click `TOOLBOX.cmd` launcher **always** records launch/preflight failures, menu selections and operation outcomes, Python tool exit codes, error stacks, and toolbox exit codes. Independent logs are written to `Temp/Logs/launcher_<run-id>.log`, `toolbox_<run-id>.log`, and `node_stderr_<run-id>.log` *within the extracted build*; separate files avoid Windows log-sharing conflicts. If the application log is unavailable, the toolbox continues and records a warning in its stderr log. On completion or error, the launcher uses built-in Windows PowerShell 5.1 to create `GB2L_TOOLBOX_SUPPORT_<run-id>.zip` in your Windows Downloads folder. The support ZIP contains the available per-run launch, application, stderr logs and an environment/exit summary. It never bundles incident data, case files, register contents, request folders, secrets, passphrases, one-time codes, or interactive input.

If packaging fails, the same run log remains available under `Temp/Logs`. Errors are displayed on screen and recorded, including errors before Node starts. Running `node toolbox/toolbox.mjs ...` directly still produces an application log but does not invoke the Windows support ZIP collector. No elevated privileges or authority activation are involved.

## Guided register records and recent requests

Menu **G** prepares a register with its first record (`create`), or a single metadata-record replacement (`replace`). For replacement, you can load an existing record from a local register JSON file; fields not edited keep their current values, and the existing record ID cannot be silently renamed. Blank answers keep the displayed value; `-` clears optional fields. Dates and typed values are validated against the protected register format before anything is saved. A final `PREPARE` confirmation writes a new request folder only—**it does not modify an existing register or perform an approval**. Menu **C** remains available for completely empty register requests.

Menu **H** lists prepared review requests. Menu **7** (inspect) and **D** (submit) can select a request by its displayed number instead of copying a long folder path. Invalid or incomplete request folders are displayed as unavailable, never submitted. `list-requests` is available from the direct Node CLI. Only a running, authorized owner console can receive a submitted request; submission never means approval.

## Additional local tools in the menu

- **I:** Discover candidate source files for a static code-flow scan (prints a config draft; read-only).
- **J:** Run the existing static source scanner using a previously reviewed configuration JSON (read-only report).
- **K:** Run the existing dependency inventory from a local configuration JSON (read-only report, no package installs).
- **L:** Make new cleaned JPEG/PNG copies using an existing incident scope. Originals are not overwritten, and the image-cleaning utility still applies its normal scope and metadata restrictions.

All paths supplied to these tools must remain inside the extracted toolbox. Other original standalone utilities and their more advanced options remain available independently. The authority is still inactive. Windows Temp remains the designated location for development/test installations, and no installation is performed by this menu.

## Drafts and reviewed case packets

Menu **M** creates a new, unsent notice draft from the current case ledger for one of the existing audience types. It refuses unsupported verdict language, never contacts anyone, and does not overwrite an earlier draft. The original notice drafting utility remains available separately.

Menu **N** builds a local case packet containing the evidence summary and ledger plus a SHA-256 manifest. A person must review the case for private details not detectable automatically, then type `REVIEWED`. It refuses to overwrite an existing packet for the same revision, never sends or uploads anything, and leaves the case ledger unchanged. Menu N can optionally include up to 30 explicitly selected, local evidence files (10 MB each). It displays each filename and size before the manual `REVIEWED` confirmation; filenames must be distinct and the existing case packet safety rules still apply. The standalone `case_packet` tool remains available for advanced options. Direct CLI case-packet creation is intentionally unavailable without the interactive confirmation.

## Integrated offline analysis (menus O–S)

These options reuse the project's **existing** read-only tools; they do not contact
sites or services, activate the authority, or write to an organization's files.

- **O — Email header triage.** Inspect a local `.eml` file (up to 10 MB), optionally
  comparing its apparent sender to an expected domain. Addresses are masked in
  displayed results and message bodies and attachments are not opened.
- **P — Directory record audit.** Review a selected local JSON export or folder of
  JSON records for missing, duplicate, implausible and stale metadata. No calls,
  emails or site visits occur.
- **Q — URL check.** Validate an HTTP(S) address for *eligibility to inspect*.
  This is only an offline preflight; it performs **no DNS or HTTP request** and
  says nothing about whether the destination is trustworthy.
- **R — Disclosure scan.** Run the existing static disclosure scanner against a
  reviewed `code_flow_scan` config. The report is heuristic and includes no code
  snippets.
- **S — Guided source review.** Discover candidate source files, show the list
  (up to 40 for interactive review), ask for a source version and `SCAN`
  confirmation, then save a config under `Temp/Scans` and run both the content-
  flow and disclosure static reports. For larger selections, menu I prints the
  full list for manual review; do not blindly scan an unreviewed source tree.
- **T — Case overview.** Display the current evidence-revision count, summaries,
  unsent notice drafts, case packets, stopped/expired status, and any obvious
  missing reports. The overview does not issue a verdict or grant approval.

Each operation is also accessible through direct Node commands (see `--help`).
Automatic launcher diagnostics remain enabled; no email body, JSON record,
source snippet or review content is deliberately written to a diagnostic log.

## Case timeline (menu U)

The guided timeline menu now wraps the original `incident_timeline.py` tool without
requiring hand-authored JSON. Start with a case already created under `Cases/`,
choose a scenario and `real` or `exercise`, then record evidence-referenced
stage events and decisions. The seven original stages are `recognize`,
`contain`, `preserve`, `scope`, `notify_assessment`, `recover`, and `follow_up`.

Every change creates a new `Cases/<case-id>/timeline_NNNN.json`; older versions
are never overwritten. Simulated events are accepted only in exercises.
A stage marked complete means that a named person **recorded** the decision,
not that the toolbox verified the outcome. The `View report` action invokes the
existing Python timeline reporter on the latest revision. A stopped or expired
case refuses new timeline changes, and the read-only case overview shows the
number of timeline revisions. This menu does not enact a decision or modify
any system outside the project.

## Offline guidance (menus V–W)

**V** displays the bundled provider account-recovery instructions (general guide,
list available providers or choose one). It makes no contact or changes. **W**
lists potential lookalike variants of a domain using the existing generator. It
does not look them up or contact DNS or RDAP. Both remain strictly advisory.

## Complete case review and reviewed backups (menus X–Y)

**X — Case evidence and assessment:** Choose an existing incident by its displayed
number or ID. Review evidence IDs and their source labels, then record the
items checked and not checked, a risk assessment, the proposed safe next step
and required permission, open hypotheses with optional supporting/opposing
**existing** evidence IDs, and clearly labeled inferences/recommendations/
decisions. You can export the six-part decision summary when ready.
Every saved change writes **one new `ledger_NNNN.json` revision**, never edits a
previous revision. The original evidence and timestamps remain intact. Blank
sections do not imply a clean verdict. The same functions are exposed through
the `review-*` commands shown by `node toolbox/toolbox.mjs --help`.

The main menu now allows selecting existing cases by number for common case
operations, eliminating repeated manual entry of IDs. Timeline entries that
cite an `E`-number evidence ID must reference an item recorded in that case;
external references are still accepted as short labels. Timeline edits remain
new `timeline_NNNN.json` revisions.

**Y — Reviewed local backup:** Choose a case and an existing explicit selection
JSON for `safe_backup`. The toolbox prints the **full preview of file names,
byte counts and hashes** before asking for `BACKUP`. Only after that confirmation
will it save the reviewed manifest and call the existing `safe_backup` tool to
make a **new copy under `Temp/Backups`**. The backup code verifies source hashes
again, and refuses files changed since the preview. No original is overwritten,
no restore occurs, and the case must have an open local-save scope. The backup
may refuse unsafe/binary/unmasked files; leave any partial result for review.

**S — Guided source scanning** now pages through *all* discovered files in
40-file groups instead of refusing every source tree larger than 40 files.
The operator must review each page (`NEXT`) and then explicitly type `SCAN`
before a scan selection is saved or any of the offline scans run.

## Current offline completion batch (2026-10-20)

- **DEVICE** in the main menu and direct `device-status` run the existing
  `device_check/check_device.ps1` on Windows, read-only. A *fail* or
  *unresolved* outcome is a completed report; no security setting is changed.
- **T** case overview now identifies missing checked/not-checked entries, risk,
  and safe-next-step/permission review without interpreting omissions as safety.
- Timeline stage decisions now reject explicit `E`-number references not
  recorded in the selected incident (matching stage-event validation).
- An unexpected menu/CLI failure attempts an early, privacy-masked diagnostic
  snapshot in Downloads; the existing launcher still makes its exit ZIP.
  Early Windows behavior requires owner-side verification.

This remains an offline development build. No production authority,
register, case revision, or previously staged build is modified by the staging
launcher. Only run the staging launcher after extracting the delivery ZIP.

## Integrated usability and accuracy improvements (consolidated batch)

- The underlying action codes are preserved within thirteen numbered tools, but the screen groups
  approved commands into incident work, organization records, local inspections,
  and unsent sharing drafts. Operators can still type `/back` to cancel.
- For a case named using only digits, entering the full ID works when the number
  is not a displayed list index. An index always takes priority when ambiguous.
- Windows Explorer's surrounding double quotes on file and folder paths are
  accepted. Paths are still restricted to the toolbox and checked for symlinks.
- Stage decision completion and register-loading confirmations require a real
  `yes` or `no`; malformed input cannot silently record the opposite answer.
- Invalid timeline menu actions stop before the operator is asked for an incident.
- Reviewed static source selections reject duplicate and unsafe relative paths.

These are corrections to existing approved tools, not new capabilities.

- New incident scopes and subsequent evidence revisions now validate that
  contact/secret masking would not silently change stored case references.
  Rejected entries leave previous revisions untouched and show an explanation.
- Nonexistent case IDs now produce a simple choice prompt rather than an OS
  file-not-found error.

## Integrated reviewed-backup and source-review reliability (batch 03)

- Menu **Y**, the existing approved reviewed-backup command, accepts a guided
  list of individually selected full source-file paths. It prepares the exact
  selection JSON required by `safe_backup.py`, prints that tool's SHA-256
  preview and still requires a deliberate `BACKUP` confirmation. Advanced
  users may supply their existing selection JSON without changing workflows.
- Menu **S** records SHA-256 fingerprints at discovery. If any reviewed source
  file changes before or during the two static scans, the combined result is
  refused and the operator is prompted to rediscover and re-review the files.
  The existing standalone I/J/R commands remain unchanged.
- Preparing an existing restore review request now enforces the authority's
  original file and total-size limits while traversing the selected tree,
  rather than loading an oversized tree into memory first. No restore, publish,
  approval or protected write was enabled.

These are corrections to approved workflows, not additions to the tool list.

## Easier existing guided choices

The ordinary review, timeline and guided register menus show numbered choices
for their existing categories and stages. Enter a displayed number or the exact
original label; saved schema values and direct CLI behavior do not change.

## Batch 04: guided dependency inventory and reviewed restore requests

**Menu K** now accepts a local npm source folder containing `package.json` and
`package-lock.json` (versions 2 or 3). It shows a concise offline package and
unknown-license count and saves a complete local report under `Temp/Dependencies`.
Source byte hashes are checked again after the report to avoid reporting changed
inputs as reviewed. No packages are installed and no advisories are fetched.
The existing advanced JSON configuration option remains available.

**Menu E** now previews the exact bounded restore selection (names, sizes and
SHA-256 hashes) before the operator types `PREPARE`. It rejects any change
between the preview and the final request preparation. No restore, direct
update, or approval is performed. Direct CLI preparation remains available.

**Incident selection** now refuses ambiguous numeric entries rather than
silently selecting the wrong case. For example `#1` is displayed row 1 and
`id:1` is incident ID `1`. Other existing input methods still work.

## Batch 06: guided checklists and multi-step incident review

- **9 — Departing staff access checklist:** Supply a validated access-register
  JSON file, then choose a numbered *current role*. The existing read-only
  checklist clearly warns when any affected system lacks an independent active
  owner/admin. It never removes account access, applies changes, or approves
  offboarding. Changed input must be reviewed again before generating a checklist.
- **P — Directory audit:** Supply a local directory JSON file/folder, optionally
  list required field names, choose how old a last-check date may be, and choose
  US or international phone rules. The existing auditor checks records offline
  and masks contact details. It does not visit websites or edit records.
- **X and U — Incident review and timeline:** After choosing a case, the menu
  stays within that case for several approved review/timeline steps. Type `0`
  for the main menu, or `/back` to cancel at any prompt. Every accepted change
  remains a separate append-only revision, and reports remain read-only views.

These are improvements to existing approved workflows, not new tools or authority.

## Consolidated approved-workflow refinement (Batch 07)

- **Y — Reviewed local backup:** New choice `3` lists ordinary candidate source
  files by number. An operator explicitly chooses individual numbers or ranges;
  no automatic all-files backup is offered. The exact original safe-backup
  preview (names, byte counts and SHA-256) and `BACKUP` confirmation remain
  required. Choices 1 (manual paths) and 2 (existing JSON) still work.
- **G — Register review:** Editing a record from an existing validated register
  now offers a numbered list, with `#N` for rows and `id:IDENTIFIER` for literal
  IDs when ambiguous. The source register is fingerprinted and a change during
  editing aborts the proposed request; no original register is changed.
- **N — Case packet:** The operator sees the current evidence and decision
  summary, plus exact SHA-256s of the optional supporting files, before typing
  `REVIEWED`. The final packet refuses changes to the case revision or selected
  file bytes after this preview. File-count, per-file and total packet-size
  limits are checked before accumulating file contents. Original packet privacy
  screening, no-overwrite, human review and no-transmission rules remain.
- **4 — Reports:** If an existing report for a numbered ledger revision differs
  from what that revision produces, the toolbox refuses to claim it is current.
  Neither changed report nor case evidence is overwritten; the mismatch is
  preserved for a human to review.

These are refinements of existing approved actions, not new toolbox commands.
They do not restore, approve, transmit, install or activate anything.
- **U — Guided incident timeline:** Entries and stage decisions now use the
  original timeline reporter's exact short metadata-label rules. Inputs that
  would make a timeline unreadable are rejected *before* an immutable revision
  is saved. Existing timeline files are checked for valid stage/event schema
  before being amended; the previous revision is always preserved.
- Menu **N** can also offer an operator a numbered list of supported evidence
  files from a chosen local folder. Files are never silently included: the
  original manual-path option remains, and an empty selection is supported.
  The same privacy inspection, review fingerprint and `REVIEWED` confirmation
  are required no matter how filenames were selected.

## Consolidated Batch 08 — integrity display and simpler correction of mistakes

- **T (case overview)** now separates filenames from verified current-revision exports. It reports changed, missing or unreadable reports, a current case packet whose internal manifest is invalid or does not match its case revision, and invalid/incomplete saved timelines without repairing evidence or issuing a verdict.
- **4 (export Markdown reports)** first checks *both* existing files for the selected revision, before creating any missing counterpart. Altered files are never replaced automatically.
- **Case revisions / U (timeline)** refuse to continue if their numbered revision history has a gap; saved timeline E-number references are cross-checked against current case evidence on read.
- **G (guided register editor)** asks only for the invalid field again (rather than starting over), flags impossible calendar dates and required blank values immediately. The protected schema is unchanged; review requests are still never applied or approved.

The original case files, evidence, registers and earlier revisions are preserved. No installation, transmission, authority activation or protected writes were enabled.

### Original menu paths made easier to use

Menu **V** now displays the existing offline account-recovery providers as numbered choices alongside the general guide (0). No account recovery, login or provider contact is performed. Menus **6, 8 and C** show numbered existing register types; menu **6** also shows review-request operations. Menu **M** shows numbered notice audiences. The original standalone CLI and stored schema names stay unchanged.
