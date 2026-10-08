# Task Manager — Technical Development History

> Public-facing technical history derived from the recovered V2→V8 source sequence, surviving handoffs/build notes, and the reviewed historical chronology.
>
> Evidence rule: source code establishes implementation; build notes establish documented development/testing activity; neither automatically establishes successful real Windows/MSHTML runtime behavior.

## Overview

The task-management application was developed as a standalone Windows HTA (HTML Application) for a solo-business workflow. The recovered source shows an iterative progression rather than a single finished build.

The directly recovered sequence is:

**V2 → V3 → V4 → V5 → V6 → V7 → V8**

The strongest current chronology evidence places the recovered artifact group on **October 6, 2026**, with the earliest currently observed Windows Explorer creation timestamp being **10:45 AM** for the original business-tracker spreadsheet. That timestamp establishes an observed artifact-creation time, not the proven beginning of the project.

## V2 — Foundation

V2 establishes the core application model.

The recovered source implements:

- task and category state handling
- local persistence using a `state.json` file
- category rendering and management
- task rows and status controls
- dashboard/task views
- window geometry persistence

At this stage, the source does **not** contain the later dedicated Task Detail workspace.

### What changed conceptually

The application had moved beyond a static task list into a locally persisted Windows desktop-style workflow, but the task itself was still primarily represented through list/navigation views.

## V3 — Task Detail workspace

V3 is a substantial functional expansion.

The recovered source introduces:

- a dedicated Task Detail workspace
- task-specific notes
- task-specific links
- task-specific attachments
- Windows path normalization
- drag/drop handling
- manual full-path fallback
- theme state/toggling
- Task Detail back navigation

The source stores task resources with the task model and normalizes missing resource arrays during state loading.

### Why this mattered

The task changed from being only a row in a list into a workspace that could contain the information and files needed to act on that task.

## V4 — Interaction model

V4 improves how users interact with the task and category structure.

The source explicitly handles:

- category-sidebar right-click context menus
- task-row right-click context menus
- empty-list right-click behavior for adding a task
- task-row left-click navigation to Task Detail
- task edit/delete
- category add/edit/remove
- document-level context-menu fallback

### Why this mattered

Task and category actions became more deliberately scoped. This reduced ambiguity about which object an interaction was supposed to affect.

## V5 — Resource workflow refinement

V5 refines the Task Detail resource area.

The source shows:

- Links rendered before attachments
- attachment controls following Links
- link add/edit/remove menus
- attachment context handling
- explicit task-row navigation
- native drop handling
- manual path-paste fallback

The surviving V5 build notes also record a Node syntax check for the embedded JavaScript.

### Why this mattered

The Task Detail workspace became more practical as a place to collect external references and Windows files associated with a task.

## V6 — Reliability and persistence hardening

V6 contains a concentrated reliability pass.

The recovered source/build notes show:

- temporary state writes through `state.tmp.json`
- preservation of a prior good state in `state.bak.json`
- recovery for corrupt or empty state
- notes autosave/flush handling
- multi-file dropped-path parsing
- window restore bounds
- stronger attachment-opening checks
- corrected `mailto:` / `tel:` handling
- improved Back-button labeling
- a dark-mode context-menu hover correction

### Why this mattered

The project was no longer just adding features. It was responding to failure modes that appear when local persistence and Windows-specific behavior have to survive imperfect conditions.

The evidence supports the fixes themselves. It does **not** establish that AI caused each underlying reliability problem.

## V7 — Navigation and validation correction

V7 addresses a concrete navigation problem.

The documented defect was that internal active-page state could change without reliably making the corresponding page visible. The recovered source responds with a centralized `applyView()` mechanism and related navigation corrections.

V7 also adds or strengthens:

- explicit category navigation through `openCategoryPage()`
- safer Task Detail fallback when a task-detail page is missing
- explicit task-row `openTaskDetail()` behavior
- `normalizeDate()`
- due-date validation and normalization
- Edit Task fields for name, area, status, priority, and due date
- notes scheduling/flush behavior
- scoped context-menu detection using `nearestAttr()` and `isDescendantOf()`

The V7 build notes record **29 new automated checks plus 36 prior checks**.

### Verification boundary

Those checks are useful evidence of regression/testing activity, but the surviving notes explicitly distinguish them from real Windows/MSHTML verification. They do not prove actual rendering, right-click behavior, real row clicks, Explorer drag/drop, or dark-mode appearance.

## V8 — Windows 11 drag/drop correction

V8 is the latest directly recovered source baseline.

The surviving development notes describe a Windows 11 observation: dragging a file onto the task page produced a **“not allowed”** cursor.

The direct V7→V8 source comparison identifies the corresponding implementation change:

- V7 handled `dragover`, `dragleave`, and `drop`.
- V8 adds `dragenter`.
- V8 explicitly sets `dataTransfer.dropEffect = 'copy'` during `dragenter` and `dragover`.

This is a strong example of environment-specific debugging: code that looked structurally correct still needed to account for the behavior of the target HTML/MSHTML event model on Windows.

### What is verified

**Verified:** the corrective source change exists in V8.

**Supported:** the change corresponds to the documented Windows 11 drag/drop incident.

**Unknown:** whether native Explorer drag/drop actually worked after the correction in the target Windows/MSHTML runtime.

## What the progression shows

The version history is not simply a list of added features.

It shows a change in the kind of engineering work being done:

**V2:** establish the application model

**V3:** turn a task into a real working context

**V4:** make interactions explicit

**V5:** refine the resource workflow

**V6:** harden persistence and reliability

**V7:** correct state/navigation behavior and increase automated verification

**V8:** diagnose a target-environment-specific Windows/MSHTML problem

That progression is the clearest technical story supported by the surviving evidence.

## Planned architecture vs. recovered implementation

Earlier handoff material describes an intended architecture with managers such as:

- NavigationManager
- TaskManager
- CategoryManager
- LinkManager
- AttachmentManager
- PersistenceManager
- WindowManager
- ContextMenuManager

Those descriptions are design/requirements evidence.

They should **not** be treated as proof that the final implementation used those exact modules or boundaries.

The source recovered through V8 is the stronger evidence for what was actually implemented.

## Known limitations of the historical record

The recovered record still does not establish:

- complete real-Windows runtime success for every feature
- successful final native Explorer drag/drop
- exact final visual appearance
- complete right-click/context-menu behavior in the target runtime
- exact final multi-monitor/window-restoration behavior
- every final runtime state-file detail
- the existence or behavior of versions outside the recovered V2→V8 sequence

The historical record is therefore strongest when it says **what the source implemented and what the surviving notes document**, and cautious when it says **what a real user ultimately experienced**.

## Engineering lessons

### 1. State changes are not the same as visible behavior

V7 demonstrates that changing an internal view variable is not enough. The application also has to apply that state to the actual UI.

### 2. Automated checks have a boundary

The V7 checks strengthened confidence in logic-level behavior, but they could not reproduce every Windows/MSHTML interaction.

### 3. Target-environment behavior matters

The V8 drag/drop incident shows why a browser-like event model can behave differently in an older Windows host such as MSHTML.

### 4. Reliability work is part of product development

Persistence, recovery, path handling, and window restoration are not secondary polish. They determine whether a local tool remains usable.

### 5. AI accelerates implementation; verification still belongs to the builder

The recovered history supports a more precise lesson than “AI broke the app”:

> AI can accelerate building, but the person using it still has to inspect the result, test it, diagnose the environment, and decide whether it actually works.

## Evidence status

The chronology supporting this document is maintained in:

`docs/task-manager-historical-chronology.md`

The historical reconstruction remains separate from any claim that the final application was completely verified in a real Windows runtime.
