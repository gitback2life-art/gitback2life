# gitback2life — Story Log

> A running record of the real questions, mistakes, surprises, goofy tests, breakthroughs, and corrections that show the human side of rebuilding. This is not a transcript and should not capture every mundane interaction. It should capture moments that are useful, funny, revealing, or meaningful to the project's story.

## 2026-10-08 — “What is this page even for?”

The Opportunity Tracker had been built as a working prototype before its purpose had been clearly explained.

The important realization was that the tracker is **not an opportunity generator**. It is a personal tool for saving and managing real jobs/opportunities discovered elsewhere.

The intended flow became:

**Find → investigate → decide → save → work → update → follow up**

The missing piece was the opportunity-finding/research process. The tracker can hold the data, but the data has to come from actual listings, grants, contracts, freelance work, training, or other legitimate opportunities that are researched and evaluated.

### 2026-10-08 — The random JSON experiment

A test file containing random characters was created:

`adfhapdfhu`

The tracker correctly rejected it because a `.json` filename does not make the file valid JSON.

A proper minimal test record is:

```json
[
  {
    "title": "Test opportunity"
  }
]
```

This led to a useful UX correction: the importer now distinguishes between invalid JSON and valid JSON that contains no recognizable opportunity record.

### 2026-10-08 — “I had to hunt for the saved message”

The save action was technically working, but the confirmation:

**✓ Opportunity saved successfully.**

was too visually quiet. It took deliberate searching to notice it.

That became another concrete product lesson:

> A successful action should look successful immediately, not merely be technically successful.

The tracker was updated to give successful saves a stronger visual confirmation.

### Story principle

Keep the mistakes.

The value of this story is not that everything worked the first time. It is the sequence:

**attempt → confusion → question → investigation → correction → clearer understanding**

That process is part of gitback2life.

