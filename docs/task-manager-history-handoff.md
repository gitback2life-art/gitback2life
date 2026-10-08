# Task Manager History — Evidence Review Handoff

## Purpose

This document preserves the current evidence-based understanding of the historical task-management application so a future session can continue the investigation without rebuilding the history from memory.

The application was originally developed on the author's main/personal ChatGPT account. The surviving materials are being reviewed for possible use as a public case study in the pseudonymous `gitback2life` project.

**Primary rule:** recover what the evidence supports. Do not invent missing history, convert plans into implementation facts, or expose private account identity.

## Current Investigation Status

**Status:** Evidence recovery in progress.

Earlier evidence packets lacked the actual standalone HTA source, but the October 8, 2026 package recovery now provides actual HTA source through V7. The referenced spreadsheet is also present in the uploaded packages. Screenshots and later source/runtime evidence remain incomplete. Therefore this document is now a source-informed historical audit through V7, but not a definitive real-Windows runtime audit.

## Evidence Hierarchy

1. **Raw application/source files — primary evidence**
   - Use source to establish what was actually implemented.
2. **Surviving project handoffs/build notes — secondary evidence**
   - Use for goals, decisions, problems, changes, and historical context.
   - Distinguish intended behavior from demonstrated implementation.
3. **Chat archives — additional historical evidence**
   - Use to explain why decisions were made, what was attempted, and what changed.
   - A conversation describing a feature does not by itself prove successful implementation.

## Evidence Status Labels

- **Verified** — directly demonstrated by source/code or documented real-world testing.
- **Supported by surviving historical evidence** — repeatedly documented, but the underlying source is not currently available.
- **Reconstructed / likely** — reasonable interpretation from multiple surviving sources; not directly established.
- **Unknown** — cannot currently determine.
- **Missing historical evidence** — evidence is referenced or known to have existed but is not currently available.

## Current Application Understanding

The surviving materials describe a standalone Windows HTML Application (HTA) functioning as a task/business command center for a solo-business workflow.

Documented areas include:

- Overview/dashboard
- All Tasks
- User-managed categories
- This Week
- Task lists
- Individual Task Detail pages
- Task creation/editing/deletion
- Status, priority, and due-date fields
- Search/filter behavior
- Notes
- Task-specific links
- File/folder attachments
- Context-menu task/category management
- Local persistence
- Dark/light mode
- Window size/position persistence
- Windows-specific file/folder interaction

These are currently **supported by surviving historical evidence**, unless later source inspection upgrades them to Verified.

## Persistence

Surviving V2 documentation identifies local state persistence at:

`%APPDATA%\\SoloBusinessCommandCenter\\state.json`

The documented persisted state includes task/category/filter/view-related state and window size/position behavior. Ctrl+S/manual Save was also documented.

The exact final persisted state schema is now partially recoverable from the V2–V7 source, but the final runtime state file/schema remains **Unknown**.

## Development History Recovered So Far

### Earlier / standalone transition

The application evolved toward a standalone Windows HTA so it could operate as its own application rather than requiring a browser tab or web server.

**Evidence status:** Supported by surviving historical evidence.

### V2

V2 documentation describes:

- Local persistence
- User-managed categories
- Category ordering
- General as a protected base category
- Moving tasks to General when a category is removed
- Categories appearing in the Add Task selector
- Window state persistence

**Evidence status:** Supported by surviving historical evidence.

### V5

V5 handoff material describes the navigation model:

`category -> task list -> individual Task Detail`

It also describes:

- Task Detail pages
- Notes
- Task-specific links
- File/folder attachments
- Attachment opening behavior
- Context menus
- Back navigation

**Evidence status:** Supported by surviving historical evidence.

### V7 — Navigation and validation fixes

V7 build notes document concrete failures found during development/testing.

A navigation bug caused task/category clicks to update internal active-page state without reliably making the corresponding page visible. Related paths included:

- task navigation
- category navigation
- deleting an open task
- removing a category
- creating a new task

The notes document a centralized `applyView()` fix and regression testing.

V7 also documents due-date validation and normalization, including acceptance of `YYYY-MM-DD` and `MM/DD/YYYY`, conversion to `YYYY-MM-DD`, and rejection of invalid calendar dates.

**Evidence status:** Verified historical development event.

### V7 — Automated verification limits

V7 records 29 new automated checks while retaining 36 previous checks. The checks included navigation, deletion/removal paths, date parsing, and Edit Task behavior.

However, the notes explicitly state that automated checks did not fully establish real Windows/MSHTML behavior such as:

- actual rendering
- right-click menus
- real row clicks
- Explorer drag/drop
- dark-mode appearance

**Important:** Do not describe automated tests as equivalent to complete Windows UI verification.

### V8 — Windows/MSHTML drag-and-drop fix

V8 documents a Windows 11 observation in which dragging a file onto the task page produced a “not allowed” cursor.

The notes identify a likely MSHTML event-handling issue and add `dragenter` handling alongside `dragover`.

Automated tests passed, but the notes explicitly left real Windows drag/drop verification outstanding.

**Evidence status:** Verified historical development event; final real-world behavior remains Unknown.

## Planned vs. Implemented

Future documentation must maintain a separate distinction between:

### Planned / specified

The surviving handoff outline describes an intended architecture including managers such as:

- NavigationManager
- TaskManager
- CategoryManager
- LinkManager
- AttachmentManager
- PersistenceManager
- WindowManager
- ContextMenuManager

It also specifies a data model involving categories, tasks, links, and attachments.

These descriptions are **requirements/design evidence**, not proof that the final source used those exact modules or structures.

### Implemented / supported

Features repeatedly described in the later surviving materials should be treated as supported historical evidence unless direct source inspection establishes them more strongly.

## Known Missing Evidence

The following are currently unavailable or not established:

- V8/final-version HTA source
- Exact final JavaScript architecture beyond the recovered V2–V7 source
- Exact final UI rendering in the target Windows/MSHTML runtime
- Exact final runtime JSON/state schema
- Referenced spreadsheet contents in the historical narrative
- Referenced screenshots
- Complete V2–V8 source/version sequence
- Exact dates for every development stage
- Whether every documented context-menu behavior worked correctly in real Windows
- Whether the final drag/drop fix worked in the target Windows environment
- Which handoff requirements were abandoned or changed before the final build
- Original chat archives, unless separately supplied/recovered

**Do not fill these gaps with assumptions.**

## Privacy Rules

The historical application was created in a personal/main-account context.

Before anything is copied into the public `gitback2life` repository:

- Remove personal/legal identity information.
- Remove personal email addresses.
- Remove home/location information.
- Remove account identifiers.
- Remove API keys, secrets, tokens, credentials, and other authentication material.
- Exclude unrelated private conversations.
- Do not expose private file paths if they reveal unnecessary personal information.
- Preserve the pseudonymous `gitback2life` framing.

The public case study should describe the work accurately without exposing the original account identity.

## Public Case-Study Direction

The eventual story should favor the real development process:

> attempt -> problem -> investigation -> correction -> result -> lesson

The project should not be presented as cleaner, more sophisticated, or more completely verified than the surviving evidence supports.

Useful future case-study themes include:

- Building a standalone Windows HTA
- Persistence and local state
- Navigation bugs discovered during testing
- Automated tests versus real Windows behavior
- MSHTML-specific drag/drop behavior
- Iterative debugging with AI
- The difference between planned architecture and actual implementation
- Evidence-based reconstruction of an older project

## Next Investigation Steps

1. Recover the actual HTA/source file if available.
2. Recover the referenced spreadsheet if available.
3. Recover screenshots if available.
4. Search surviving chat archives for development decisions and version transitions.
5. Compare source behavior against this document.
6. Upgrade individual claims from “Supported by surviving historical evidence” to “Verified” only when direct evidence warrants it.
7. Record contradictions rather than silently resolving them.
8. Maintain a separate list of missing/deleted historical evidence.
9. Perform a privacy review before any historical artifact is published.
10. Update this handoff as the evidence base improves.

## Current Bottom Line

The recovered evidence now supports a source-level historical picture of a standalone Windows task/business command center through V7, including local persistence, task/category navigation, Task Detail workspaces, notes, links, attachments, context-menu management, and Windows-specific behavior.

It still does **not** support a definitive real-Windows runtime audit, and V8/final-version source remains unrecovered in the current package set.

This handoff remains a **continuation document for evidence recovery**, with explicit separation between source-verified implementation and runtime behavior that still requires Windows verification.


## New Source-Recovery Checkpoint — October 8, 2026

The evidence base has materially improved.

Newly supplied packages contain actual HTA source through **V7**:

- V2: `sole_proprietor_command_center_standalone_v2.hta`
- V3: `sole_proprietor_command_center_standalone_v3.hta`
- V4: `sole_proprietor_command_center_standalone_v4.hta`
- V5: `sole_proprietor_command_center_standalone_v5.hta`
- V6: `sole_proprietor_command_center_standalone_v6.hta`
- V7: `sole_proprietor_command_center_standalone_v7.hta`

This means the earlier statement that the current evidence packet lacked the actual HTA source is now superseded.

### Source-supported progression

- **V2:** direct source confirms local `state.json` persistence, category/task state handling, category management, task rows/status controls, and window geometry persistence.
- **V3:** direct source confirms dedicated Task Detail, task-specific notes, links, attachments, path handling, drag/drop handler, manual path fallback, theme state, and task-detail navigation.
- **V4:** direct source confirms distinct category/task context-menu handling, empty-list Add Task behavior, task-row left-click to Task Detail, and task edit/delete behavior.
- **V5:** direct source confirms the Task Detail resource bar with Links first and attachments following it, plus link/attachment menu behavior.
- **V6:** direct source/build notes confirm safer state-file writes, backup/corruption recovery, notes autosave, multi-file path parsing, window restore bounds, attachment safety checks, link-scheme handling, and other reliability fixes.
- **V7:** direct source/build notes confirm centralized `applyView()`, explicit task/category navigation corrections, due-date normalization/validation, expanded Edit Task fields, and notes scheduling/flush behavior.

### Runtime-verification boundary

Source presence is not equivalent to successful real Windows/MSHTML execution.

The V6/V7 evidence explicitly leaves real Windows verification outstanding for areas including:

- actual rendering
- right-click menus
- real row clicks
- Explorer drag/drop
- dark-mode appearance
- real FileSystemObject/WScript.Shell behavior
- some window/multi-monitor behavior

### V8 boundary

Earlier surviving notes describe a V8 Windows/MSHTML drag/drop fix involving `dragenter` handling after a Windows 11 “not allowed” cursor observation.

The V8 source/package was **not** included in the newly supplied package set for this checkpoint. Therefore V8 remains secondary historical evidence until its source is recovered.

### Current baseline for future investigation

For historical source analysis, **V7 is now the latest directly recovered source baseline**.

The investigation should next compare V7 source against the documented requirements, recover V8 if available, and recover original chat/build history where possible.

A detailed checkpoint was recorded separately at:

`docs/task-manager-history-session-checkpoint.md`

This checkpoint should be read before continuing the historical investigation.


## V8 Source Recovery — October 8, 2026

The V8 HTA source has now been recovered and directly compared with V7.

`sole_proprietor_command_center_standalone_v8.hta` is present. The V7→V8 source diff identifies the documented drag/drop correction:

- V7 task drop-zone setup used `dragover`, `dragleave`, and `drop`.
- V8 adds `dragenter`.
- V8 explicitly sets `dataTransfer.dropEffect = 'copy'` during `dragenter` and `dragover`.

This directly corroborates the surviving V8 development note about the Windows 11 “not allowed” drag cursor and the attempted MSHTML event-handling correction.

**Evidence status:** The V8 correction is now **Verified from source + supported by historical development notes**.

The remaining boundary is runtime verification: source presence proves the change was implemented, but does not prove native Explorer drag/drop worked successfully on the target Windows/MSHTML environment.

V8 retains the major V7 mechanisms examined so far, including `applyView()`, `openTaskDetail()`, `normalizeDate()`, safer state persistence, task-detail resources, and manual attachment-path fallback.

**Updated baseline:** V8 is now the latest directly recovered source baseline.
