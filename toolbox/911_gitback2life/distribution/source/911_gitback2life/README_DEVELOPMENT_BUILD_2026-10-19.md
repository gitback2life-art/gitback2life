# 911_gitback2life — integrated Windows toolbox development build

This source tree is a **development toolbox**, not an installer or production authority.
Double-click `TOOLBOX.cmd` from the extracted folder to use its local Windows menu.
It has automatic diagnostic logging and creates a support ZIP in Downloads after
exit. No installation, elevation, activation, or protected register write occurs.

## What is new compared with the owner-verified R3 Windows menu

The original offline tools are still present. Additional integrated toolbox work
includes local email-header/directory/URL reviews, source discovery and guided
static scans, unsent notice drafts, selected supporting evidence in manually
reviewed packets, case/timeline progress review and revisions, and local account
recovery guides. The latest connected batch adds:

- Menu **X**: full case evidence inspection and six-part case review. Record
  checked and unchecked work, evidence-referenced hypotheses, inferences,
  recommendations, decisions, risk, and a safe next step. Each change produces
  a new evidence ledger revision; old revisions are never overwritten.
- Menu **Y**: explicitly reviewed offline backup to a NEW `Temp/Backups` folder.
  Review exact filenames, sizes and hashes before typing `BACKUP`. Original
  files are not changed. The original backup engine rechecks hashes and scope.
  This is **not** a restore or a protected operation.
- Menu **S**: paginated review of all discovered source files, not an arbitrary
  40-file cap. No scan runs until the operator finishes review and types `SCAN`.
- Menu **N**: add zero or more explicitly selected local evidence files to a
  human-reviewed local case packet. Previously it silently included no files.
- Existing incidents can be selected by number in commonly used menu paths;
  timeline references beginning with `E` and a number must cite an existing
  evidence item.

Node.js 22+ and Python 3.10+ are needed for the relevant integrated tools.
The external network remains off in the ordinary menu. Owner-only authority
operations remain disabled and unchanged.

## Project paths and diagnostics

No old project path is overwritten. Keep the extracted build under the user's
approved development `C:\Users\BlueFrost\Desktop\911_gitback2life\Temp`.
Case records under the extracted `Cases` folder are persistent, whereas
`Temp` contains requests, scans, backups and logs. The tool must never be
extracted over an active project or existing case directory.

`TOOLBOX.cmd` writes separate logs to `Temp\Logs` and automatically creates
`GB2L_TOOLBOX_SUPPORT_<run-id>.zip` in Downloads, with **logs only** (no cases,
request payloads, register contents, images or credentials). If a problem
occurs, submit that small support ZIP for diagnosis instead of copying raw
incident data into chat.

## Verification scope

One focused offline end-to-end workflow completed with synthetic project-local
files: case, evidence, checks, hypothesis, risk, next step, analysis, timeline,
reports and exact-copy backup. A focused manually reviewed packet check also
completed. Node.js syntax passed. The new Windows menu choices have not yet
been operated on the owner's Windows machine; the earlier R3 launcher and
cancellation paths were successfully Windows-verified separately.

No protected installer, migration, production activation or owner security
gate is claimed to be complete by this build.
