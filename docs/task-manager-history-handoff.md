# Task Manager History — Evidence Review Handoff

## Purpose

This document preserves the current evidence-based understanding of the historical task-management application so a future session can continue the investigation without rebuilding the history from memory.

The application was originally developed on the author's main/personal ChatGPT account. The surviving materials are being reviewed for possible use as a public case study in the pseudonymous `gitback2life` project.

**Primary rule:** recover what the evidence supports. Do not invent missing history, convert plans into implementation facts, or expose private account identity.

## Current Investigation Status

**Status:** Evidence recovery substantially complete for the currently supplied V2–V8 source/history package. The investigation has moved from primary evidence collection into chronology/reconstruction.

The October 8, 2026 recovery now provides actual HTA source through V8, plus the referenced spreadsheet files, handoff packages, build notes, and timestamp evidence. Screenshots and real-runtime evidence remain incomplete. Therefore this document is now a source-informed historical audit through V8, but not a definitive real-Windows runtime audit.

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

- Exact final JavaScript architecture beyond the recovered V2–V7 source
- Exact final UI rendering in the target Windows/MSHTML runtime
- Exact final runtime JSON/state schema
- Referenced screenshots
- Any versions or source artifacts outside the recovered V2–V8 sequence
- Exact dates for every development stage before the currently recovered timestamp evidence
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

1. Build the Master Historical Evidence Chronology from the recovered artifacts and timestamps.
2. Search surviving chat archives only where they can answer a specific unresolved historical question or explain a documented development decision.
3. Compare V8 source behavior against the documented requirements and identify remaining discrepancies.
4. Upgrade individual claims from “Supported by surviving historical evidence” to “Verified” only when direct evidence warrants it.
5. Record contradictions rather than silently resolving them.
6. Maintain a separate list of missing/deleted historical evidence.
7. Identify AI-assisted incidents that can be supported by surviving evidence and document them as attempt → problem → investigation → correction → verification → lesson.
8. Perform a privacy review before any historical artifact is published.
9. Update this handoff as the evidence base improves.

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

## Continuation Handoff — October 8, 2026

A new continuation handoff supplied by the user confirms that the evidence-collection work should now be treated as substantially complete for the material already recovered. The next phase is historical reconstruction, not another broad inventory.

The supplied continuation instructions explicitly establish:

- Do not ask the user to re-provide the same files.
- Do not restart the inventory unless a specific unresolved question requires an artifact that has not been examined.
- Build a **Master Historical Evidence Chronology**.
- Preserve the evidence labels **VERIFIED**, **SUPPORTED**, **RECONSTRUCTED / LIKELY**, **UNKNOWN**, and **MISSING**.
- Do not silently turn historical statements, plans, or AI suggestions into implementation facts.
- Keep the eventual public story focused on **ATTEMPT → PROBLEM → INVESTIGATION → CORRECTION → RESULT → LESSON**.
- Include AI's contribution to problems where the individual incident is actually supported by surviving evidence, rather than reducing the story to “AI broke the app.”
- Preserve the lesson that AI-generated code still requires inspection, testing, and verification in the actual environment.
- Do not make major public case-study changes until the historical evidence review is complete and the user has reviewed the findings.

The continuation handoff also confirms that the current authoritative checkpoint remains:

docs/task-manager-history-session-checkpoint.md

and that the recovered source history currently runs:

**V2 → V3 → V4 → V5 → V6 → V7 → V8**

with **V8 as the latest directly recovered application source baseline**.

### Timestamp evidence now established

The user supplied a Windows Explorer screenshot showing the **Date created** values for the final group of historical files. This is currently the strongest evidence for the creation timeline of that group.

Observed Windows creation times:

| Date/time | Artifact |
|---|---|
| **2026-10-06 10:45 AM** | `sole_proprietor_business_tracker.xlsx` |
| **2026-10-06 11:24 AM** | `sole_proprietor_business_tracker_hybrid.xlsx` |
| **2026-10-06 1:42 PM** | `Solo_Business_Command_Center_Handoff_Package_UPDATED.zip` |
| **2026-10-06 1:59 PM** | `Solo_Business_Command_Center_Handoff_Package_UPDATED_V3.zip` |
| **2026-10-06 2:51 PM** | `Solo_Business_Command_Center_Handoff_Package_UPDATED_V4.zip` |
| **2026-10-06 3:01 PM** | `Solo_Business_Command_Center_Handoff_Package_UPDATED_V5.zip` |
| **2026-10-06 3:07 PM** | `Solo_Business_Command_Center_SESSION_HANDOFF.md` |

Evidence status: **Verified from the user-provided Windows Explorer screenshot** for the displayed creation times.

The earliest currently observed creation timestamp is therefore:

**October 6, 2026 at 10:45 AM — `sole_proprietor_business_tracker.xlsx`.**

This is **not** established as the beginning of the entire project. It is the earliest currently observed Windows creation timestamp in the recovered evidence group.

The previously observed ZIP-internal timestamp of **October 6, 2026 at 5:24:16 PM** is therefore no longer the earliest known timestamp for the recovered materials; it is a later archive-entry timestamp. ZIP timestamps, Windows creation timestamps, document metadata, source evidence, handoff claims, and runtime verification must remain separate evidence categories.

The anomalous DOCX internal metadata showing **2013-12-23 23:15:00Z** remains observed metadata but should not be treated as the project-development date absent corroboration.

### Current evidence boundary

The recovered source establishes implementation details through V8. It does not automatically establish successful target-environment behavior.

Still unresolved at the runtime level include, unless separately demonstrated:

- native Windows Explorer drag/drop success
- actual right-click context-menu behavior
- visual rendering
- Windows FileSystemObject/WScript.Shell behavior
- dark-mode appearance
- multi-monitor/window restoration behavior

The V8 source change itself is stronger than before: V7→V8 directly shows the addition of `dragenter` and `dataTransfer.dropEffect = 'copy'`, matching the historical Windows 11 “not allowed” cursor report. Evidence status remains **Verified from source + supported by historical development notes**, while final real-Windows success remains **Unknown**.

### AI-related historical investigation

The next chronology should explicitly look for incidents where AI-assisted development contributed to a problem, but only where the surviving evidence supports the chain:

**request → AI-produced/suggested change → failure or defect → discovery → correction → verification → lesson**

The public narrative should acknowledge AI as both an accelerator and a source of mistakes where warranted. It should not assign blame beyond what the evidence supports.

### Immediate next deliverable

The next substantive artifact should be a **Master Historical Evidence Chronology** built from the evidence already recovered.

It should use:

| Date/time | Artifact | What happened | Evidence | Confidence | Consequence |
|---|---|---|---|---|---|

The chronology should begin with the earliest currently observed artifact timestamp (**2026-10-06 10:45 AM**) while explicitly labeling that timestamp as an artifact-creation observation, not a proven project start.

No further broad file-collection request should be made unless the chronology exposes a specific unresolved question for which a missing artifact would materially change the conclusion.

## Fresh Session Handoff — October 8, 2026 — Historical Reconstruction Phase

The timestamp investigation is now considered **closed for the currently recovered evidence**. Do not restart timestamp archaeology unless genuinely new evidence appears.

The investigation has moved to the substantive historical reconstruction of the task-manager development story.

### Current authoritative state

- Recovered source sequence: **V2 → V3 → V4 → V5 → V6 → V7 → V8**
- **V8 is the latest directly recovered application source baseline.**
- Evidence collection for the currently supplied materials is substantially complete.
- The next task is **chronology/reconstruction**, not another broad inventory.
- Do not ask the user to re-upload or re-provide files already supplied to another session.
- Use the existing evidence and this handoff/checkpoint as the starting point.

### Timestamp conclusion

The strongest currently established creation-time evidence is the user-provided Windows Explorer screenshot showing:

- `sole_proprietor_business_tracker.xlsx` — **2026-10-06 10:45 AM**
- `sole_proprietor_business_tracker_hybrid.xlsx` — **2026-10-06 11:24 AM**
- subsequent handoff-package creation times through 3:07 PM

Therefore **2026-10-06 10:45 AM is the earliest currently observed Windows creation timestamp**, but it is **not** established as the project's start date.

A later user-provided Explorer screenshot also showed **Date modified** values. Those are separate evidence and should not be substituted for creation times. They show later editing/activity, including:

- V6 created 3:17 PM; modified later at about 7:16 PM
- V7 created 3:30 PM; modified later at about 7:16 PM
- V8 created 3:50 PM; modified later at about 7:47 PM
- V8 build notes created 3:50 PM; modified later at about 7:47 PM

These modification timestamps are useful as evidence of later activity, but they do not establish project start or exact development events by themselves.

Keep the five evidence categories separate:

1. Windows Explorer creation timestamps
2. Windows Explorer modification timestamps
3. ZIP internal timestamps
4. Document metadata
5. Source/runtime evidence

The anomalous 2013 DOCX metadata remains unreliable for dating the project.

### Development reconstruction already established

The working chronology currently supports this implementation progression:

**V2**
- task/category state handling
- local state persistence
- category management
- task rows/status controls
- dashboard/task views
- window geometry persistence
- no dedicated Task Detail workspace

**V3**
- dedicated Task Detail
- task notes
- links
- attachments
- Windows path handling
- drag/drop handling
- manual path fallback
- theme state
- task-detail navigation

**V4**
- clearer task/category interaction separation
- context menus
- task-row navigation
- task/category edit/delete/add/remove behavior

**V5**
- Task Detail resource-bar refinement
- links before attachments
- link/attachment menus
- native drop plus manual path fallback

**V6**
- safer persistence using temporary and backup state files
- corrupt/empty-state recovery
- notes autosave/flush
- multi-file dropped-path parsing
- window restore bounds
- stronger attachment-opening checks
- mailto/tel corrections
- UI/context-menu corrections

**V7**
- centralized applyView() navigation
- task/category navigation corrections
- safe fallback for missing task-detail pages
- due-date normalization/validation
- expanded Task Edit fields
- notes scheduling/flush
- scoped context-menu detection
- 29 new automated checks plus the prior 36 checks

**V8**
- direct source comparison with V7 confirms the drag/drop correction:
  - V7 had dragover, dragleave, drop
  - V8 adds dragenter
  - V8 sets dataTransfer.dropEffect = copy in dragenter and dragover
- this directly matches the surviving historical note about a Windows 11 “not allowed” drag cursor

### Runtime boundary

Do not claim that source implementation equals successful Windows/MSHTML behavior.

Still-unproven runtime areas include, unless separate evidence demonstrates them:

- native Explorer drag/drop success
- actual right-click menu behavior
- actual visual rendering
- real Windows FileSystemObject/WScript.Shell behavior
- dark-mode appearance
- multi-monitor/window restoration

For V8 specifically:

**Verified:** the corrective source change exists.

**Supported:** it corresponds to the documented Windows 11 drag/drop problem.

**Unknown:** whether the final V8 change actually solved native Explorer drag/drop in the target runtime.

### AI/problem-solving investigation — next major task

The user's goal is to include the real AI-related problems in the story, but accurately.

Do **not** write a generic claim such as “AI broke the app.”

For each incident that can be supported by surviving evidence, reconstruct:

**What was requested → what AI produced/suggested → what went wrong → how it was discovered → what changed → what was actually verified → lesson learned**

The intended lesson is:

> **AI can accelerate building, but it cannot replace verification.**

AI should be treated as both an accelerator and, where the evidence supports it, a contributor to mistakes or misleading confidence. Do not assign blame beyond the evidence.

### Master Historical Evidence Chronology

The next substantive deliverable is the **Master Historical Evidence Chronology**, using:

| Date/time | Artifact | What happened | Evidence | Confidence | Consequence |
|---|---|---|---|---|---|

Use these confidence labels consistently:

- **VERIFIED**
- **SUPPORTED**
- **RECONSTRUCTED / LIKELY**
- **UNKNOWN**
- **MISSING**

Do not silently resolve contradictions. Record them.

The chronology should begin with the earliest currently observed artifact timestamp (10:45 AM) while explicitly stating that this is an artifact-creation observation, not a proven project start.

### Public story comes later

Do not immediately turn the chronology into polished public documentation.

First establish the internal historical record. Then derive:

1. technical development history
2. AI/problem-solving history
3. lessons learned
4. public gitback2life case study

The eventual public narrative should follow:

**ATTEMPT → PROBLEM → INVESTIGATION → CORRECTION → RESULT → LESSON**

Before publication, perform a privacy review and ensure no private identity, account data, credentials, personal paths, unrelated conversations, or other sensitive material is exposed.

### Fresh-session instruction

A fresh session should begin from this document and:

1. read docs/task-manager-history-session-checkpoint.md
2. treat V8 as the latest recovered source baseline
3. treat timestamp investigation as complete
4. continue building the Master Historical Evidence Chronology
5. focus next on evidence-supported AI/problem incidents
6. do not request the already-recovered file set again
7. do not publish or substantially rewrite the public case study until the historical findings are reviewed by the user

 
## Current Authoritative Status — October 8, 2026
 
This section supersedes earlier provisional statements in this document where they conflict with later recovery.
 
- Historical source sequence recovered: **V2 → V3 → V4 → V5 → V6 → V7 → V8**.
- **V8 is the latest directly recovered application source baseline.**
- The master chronology in `docs/task-manager-historical-chronology.md` has been reviewed and approved for continued use.
- A targeted repository search found no additional evidence-backed AI/problem incidents beyond the documented V7 navigation and V8 drag/drop incidents.
- V8 incident status: **SUPPORTED** from historical notes; V8 corrective source change: **VERIFIED**; final native Explorer drag/drop success: **UNKNOWN**.
- The public technical history and case study have now been drafted under `projects/task-manager/`.
- No further broad historical inventory is warranted unless new evidence appears.
- Future work should focus on substantive case-study refinement, real-runtime verification if the application can be run, or genuinely new historical evidence.
