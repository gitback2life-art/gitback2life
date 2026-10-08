# Case Study — Building a Standalone Windows Task Manager with AI

## From a task list to a real Windows application

One of the first substantial software projects in the gitback2life rebuilding process was a standalone Windows task-management application: a small business command center designed to keep tasks, notes, links, files, and categories together in one place.

What makes the project worth documenting is not a perfect final product.

It is the engineering process.

The surviving project record shows a progression from a basic persisted task system through task-specific workspaces, Windows file interaction, reliability hardening, automated checks, and finally a Windows 11 drag-and-drop problem that required environment-specific debugging.

It is a useful example of what building with AI actually looks like when the generated code has to meet the behavior of a real machine.

## The starting point

The recovered history begins with a simple question:

**Can a useful business task manager be built as a standalone Windows application without turning the project into a large software stack?**

The answer became a Windows HTA — an HTML Application that could run as a desktop-style Windows program while using HTML, CSS, and JavaScript for its interface and logic.

The recovered V2 source established the foundation:

- tasks and categories
- local state persistence
- task lists and status controls
- dashboard/task views
- window geometry persistence

At that point, there was a functioning application model, but a task was still mostly a list item.

## Step 1 — Give each task a workspace

V3 changed the shape of the application.

A dedicated Task Detail workspace was introduced, along with task-specific notes, links, attachments, Windows path handling, drag/drop behavior, and a manual path fallback.

This was an important shift.

A task was no longer just something to mark complete. It could become a small working context containing the information and resources needed to complete it.

## Step 2 — Make interactions explicit

V4 focused on interaction.

Task and category context menus were separated. Task rows could open Task Detail. Categories could be added, edited, or removed. Empty task lists could still expose an Add Task action.

These changes sound small individually, but they matter because software becomes confusing when the same action can mean several different things depending on where the pointer happens to be.

The application needed clearer object-level behavior.

## Step 3 — Refine the resource workflow

V5 refined the Task Detail resource area.

Links appeared before attachments, and resource-specific menus were added or improved. Native file dropping remained available, but the application also kept a manual full-path fallback.

That fallback turned out to be valuable because Windows file interaction was becoming one of the harder parts of the project.

## Step 4 — The project stopped being just feature development

V6 is where the work became much more about reliability.

The application introduced safer state-file writes, backup state, recovery from corrupt or empty state, notes autosave/flush behavior, multi-file dropped-path parsing, window restore bounds, stronger attachment checks, and link-scheme corrections.

This is an important part of the story because software projects are often described as a sequence of features.

Real software is also a sequence of failure modes.

The source proves that this reliability work was implemented. The surviving evidence does not justify blaming AI for each individual persistence problem, so the honest description is that the project encountered reliability problems and hardened the implementation.

## The navigation bug

V7 contains one of the clearest examples of why generated code still needs testing.

### Attempt

The application needed to navigate among categories, task lists, and Task Detail pages.

### Problem

The documented defect was that internal navigation state could change without reliably causing the correct page to appear.

In other words, the code could believe it had switched views while the user was still looking at the old one.

### Investigation

The problem was isolated to the way navigation state was being applied.

### Correction

V7 centralized the view application through `applyView()` and corrected related task/category paths.

### Verification

The build notes record 29 new automated checks in addition to 36 prior checks, including navigation and related deletion/removal paths.

### Boundary

Those checks were not a full Windows UI test.

The surviving record explicitly says that real rendering, right-click menus, real row clicks, Explorer drag/drop, and dark-mode appearance still required Windows verification.

### Lesson

A state change in code is not the same thing as a correct user-visible state.

## The Windows 11 drag-and-drop problem

The V8 incident is the most concrete example of environment-specific debugging in the surviving history.

### Attempt

The task page already supported dragging files into the application.

### Problem

On Windows 11, dragging a file produced a **“not allowed”** cursor.

The feature existed in the source, but the environment was telling the user that the operation was not accepted.

### Investigation

The surviving development notes identified the problem as likely related to MSHTML event handling.

### Correction

The V8 source adds a `dragenter` handler and explicitly sets the drag operation to copy during `dragenter` and `dragover`.

### What the evidence proves

The corrective source change is real and directly recoverable.

The historical note and source change line up.

What the evidence does **not** prove is that the final V8 change successfully made native Explorer drag-and-drop work in the real target runtime.

That distinction matters.

## What AI actually contributed

The useful story is not “AI wrote the application.”

It is closer to this:

AI accelerated the cycle of building, changing, checking, and revising the application.

But the hardest problems still required human judgment:

- noticing that a state transition did not match the visible page
- recognizing that automated checks did not equal Windows verification
- diagnosing a Windows 11 drag/drop behavior
- deciding what evidence was strong enough to call a fix successful
- preserving uncertainty instead of declaring victory too early

The surviving history supports this lesson:

> **AI can accelerate building, but it cannot replace verification.**

That is a more useful description of AI-assisted development than either “AI did everything” or “AI broke everything.”

## What I learned

### Code that looks right can still behave wrong

The navigation bug is a reminder that logic has to be connected to visible behavior.

### Tests are evidence, not magic

Automated checks can catch regressions and validate logic. They cannot automatically reproduce every desktop host behavior.

### Old environments have their own rules

A standalone HTA runs inside a very different environment from a modern web browser. Windows/MSHTML behavior can create problems that are invisible when thinking only in abstract web-development terms.

### Reliability is part of the feature

A task manager that loses its state, mishandles paths, or restores itself incorrectly is not reliable enough just because the main task list works.

### Reconstructing old work is its own engineering task

Some of the original handoff material and historical artifacts were lost. That means the history has to be reconstructed from surviving source, notes, timestamps, and other evidence.

That creates another important discipline:

**Do not turn a reasonable guess into a fact.**

## What is verified

The recovered source directly establishes an iterative V2→V8 implementation history including task/category state, local persistence, Task Detail resources, context-menu behavior, reliability work, navigation correction, validation, automated checks, and the V8 drag/drop source correction.

## What is still unknown

The surviving record does not prove that every feature worked correctly in the final Windows/MSHTML runtime.

In particular, final native Explorer drag/drop success is still unknown, as are some aspects of real rendering, context-menu behavior, dark mode, and window restoration.

## Why this project matters to gitback2life

The task manager is more than a software artifact.

It is evidence of a process:

**build → fail → investigate → correct → learn → build again**

That process fits the larger gitback2life goal.

The point is not to pretend the work was flawless.

The point is to become more capable by doing real work, keeping the mistakes, and learning how to solve the next problem.

---

## Technical record

The detailed source-oriented history is maintained in:

- `projects/task-manager/technical-history.md`
- `docs/task-manager-historical-chronology.md`

The public case study intentionally avoids treating planned architecture, historical claims, or automated tests as proof of successful real-world runtime behavior.
