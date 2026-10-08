# What Building a Windows Task Manager Taught Me About AI-Assisted Development

I wanted to see what I could actually build with AI—not a tutorial project, not a toy prompt, but a tool with enough moving parts to expose real problems.

The result was a standalone Windows task-management application built as an HTA, or HTML Application.

It started small.

The early version handled tasks, categories, local persistence, task lists, and window state. Then the project kept growing: individual Task Detail pages, notes, links, attachments, Windows path handling, context menus, due dates, recovery logic, and automated checks.

That is where the interesting part began.

## When the code was right but the screen was wrong

One of the clearest problems appeared during navigation.

The application could change its internal active-page state without reliably making the corresponding page visible. In other words, the program could think it had navigated while the user was still looking at the old screen.

The correction was to centralize view application through an "applyView()" mechanism and repair the related navigation paths.

The lesson was simple:

**A state change in code is not the same thing as a correct user-visible state.**

That is exactly the kind of problem that can survive when you focus too heavily on whether the code looks reasonable.

## Then Windows had its own opinion

Later, the task page supported file drag-and-drop.

On Windows 11, dragging a file produced a "not allowed" cursor.

The source already had drag-and-drop handling, so this was not a simple case of "the feature is missing." The surviving development notes point toward the behavior of the older MSHTML event model.

The next source revision added "dragenter" handling and explicitly set the drag operation to "copy" during "dragenter" and "dragover".

That correction is present in the recovered V8 source.

What I cannot honestly say is that the final change has been proven to work in every real Windows runtime. The historical record proves the implementation change; it does not give me a complete runtime test record.

And that distinction matters.

## AI helped—but it did not finish the job

AI was extremely useful for building and iterating.

It helped accelerate the cycle of:

**build → change → check → investigate → revise**

But the difficult part still required human judgment.

Someone had to notice that the screen did not match the program state.

Someone had to recognize that automated checks could not reproduce every Windows/MSHTML behavior.

Someone had to investigate the "not allowed" cursor.

And someone still has to decide whether the evidence is strong enough to call a fix successful.

That is the bigger lesson I took from the project:

> **AI can accelerate building, but it cannot replace verification.**

## Why I am documenting the failures

The temptation with AI-assisted development is to present the finished code as the story.

I think that misses the most useful part.

The failures show where assumptions broke.

The fixes show how the reasoning improved.

The uncertainty shows where verification still matters.

This project is part of a larger rebuilding effort called **gitback2life**. The goal is not to pretend everything is easy or polished. It is to rebuild skills by doing real work, learn from what goes wrong, and keep moving toward greater independence.

The task manager is one piece of that process.

**Build something real. Find the problem. Understand it. Fix it. Learn from it. Then build again.**

## Source and history

The full evidence-based case study and technical development history are maintained in the gitback2life repository:

- Task-manager case study: https://github.com/gitback2life-art/gitback2life/blob/main/projects/task-manager/case-study.md
- Technical history: https://github.com/gitback2life-art/gitback2life/blob/main/projects/task-manager/technical-history.md
