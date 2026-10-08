# Task Manager History — Evidence Review Handoff

## Purpose

This document preserves the current evidence-based understanding of the historical task-management application so a future session can continue the investigation without rebuilding the history from memory.

The application was originally developed on the author's main/personal ChatGPT account. The surviving materials are being reviewed for possible use as a public case study in the pseudonymous `gitback2life` project.

**Primary rule:** recover what the evidence supports. Do not invent missing history, convert plans into implementation facts, or expose private account identity.

## Current Investigation Status

**Status:** Evidence recovery in progress.

The current evidence packet contains historical documentation and build notes, but does **not** contain the actual standalone HTA source file or the referenced spreadsheet/screenshots. Therefore this document is a historical baseline, not a source-level implementation audit.

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

The exact final state schema remains **Unknown** until the actual application/source or state file is recovered.

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

- Final/final-version HTA source
- Exact JavaScript architecture
- Exact final UI rendering
- Exact final JSON/state schema
- Referenced spreadsheet
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

The surviving evidence supports a fairly strong historical picture of a standalone Windows task/business command center with local persistence, task/category navigation, Task Detail workspaces, notes, links, attachments, context-menu management, and Windows-specific behavior.

It does **not** currently support a definitive source-level audit because the actual application source is missing from the current evidence packet.

This handoff is therefore a **continuation document for evidence recovery**, not a claim that every documented feature has been independently verified.
