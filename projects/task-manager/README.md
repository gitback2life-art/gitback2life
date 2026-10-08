# Task Management System

This is the first existing software project documented publicly under gitback2life.

## What it is

A standalone Windows HTA task/business command center developed iteratively with AI assistance.

The recovered history runs through **V2 → V3 → V4 → V5 → V6 → V7 → V8**.

## What the recovered source shows

The application evolved from a locally persisted task/category system into a richer task workspace with:

- task and category management
- task lists and status controls
- dedicated Task Detail pages
- notes
- task-specific links
- file/folder attachments
- context-menu task/category actions
- due dates and validation
- local persistence and recovery safeguards
- Windows-specific path and file handling
- theme state
- window geometry persistence
- automated checks
- Windows/MSHTML-specific drag/drop handling

## How the project evolved

**V2** established the application and local persistence.

**V3** introduced Task Detail pages and task-specific resources.

**V4** separated task/category interactions and expanded context-menu behavior.

**V5** refined the resource workflow.

**V6** hardened persistence, recovery, notes saving, path parsing, window restoration, and Windows-specific behaviors.

**V7** corrected navigation/view application, strengthened due-date handling and editing, and expanded automated verification.

**V8** added a targeted drag/drop correction for a documented Windows 11 “not allowed” cursor problem by adding `dragenter` handling and explicitly setting the drag effect.

## How AI assisted

AI accelerated implementation and iteration: building features, revising code, and helping reason through problems.

The project also demonstrates the limits of AI-generated code. The recovered history includes a navigation defect and a Windows 11 drag/drop problem that required investigation and correction.

The central lesson is:

> **AI can accelerate building, but it cannot replace verification.**

## Verification boundary

The recovered source proves that the documented implementation changes exist.

It does **not** prove that every feature ultimately worked correctly in the real Windows/MSHTML runtime.

In particular, final native Explorer drag/drop success remains unknown, along with some real-runtime details such as complete visual rendering, context-menu behavior, dark-mode appearance, and certain window-restoration behavior.

## Documentation

[Technical development history](technical-history.md)

[Public case study](case-study.md)

[Master historical evidence chronology](../../docs/task-manager-historical-chronology.md)

## Current limitations

- No complete preserved runtime test record for every feature
- Some original historical material was deleted or is unavailable
- Planned architecture cannot be assumed to equal final implementation
- Runtime success must be distinguished from source presence and automated test results

## Source code

The recovered historical source is retained as evidence in the project materials associated with the task-manager reconstruction.

