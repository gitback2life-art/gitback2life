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

## Retroactive entries reconstructed from the project history — 2026-10-08

Some earlier moments were important enough to preserve even though the story log did not exist yet. These are reconstructed from the surviving conversation/project context, not presented as a verbatim transcript.

### “We thought the feature was finished. It wasn't.”

The handoff said the Opportunity Tracker's import and save checkpoints were complete. A direct inspection of the actual source showed the page's JavaScript was not executing because of a malformed esc() function.

The deployment validator had its own broken regular expression, so the safety check could fail for the wrong reason too.

This became a very real example of the project's recurring pattern:

**claim → inspect the actual thing → find the mismatch → fix it → verify again**

### The wrong app got our attention first

During the debugging process, an older standalone HTA Task Manager file was initially examined before the Opportunity Tracker was confirmed as the actual target for the import/save work.

Useful lesson:

> Before fixing the problem, make sure you're fixing the right thing.

### “Why do the Import/Export buttons look like that?”

After the functional fixes, the Import JSON and Export JSON controls were visually stranded in the upper-right corner.

They were moved into the **Imported files** section so the controls sit next to the thing they actually manage.

This was another reminder that a feature can be technically correct and still feel wrong when the interface does not communicate its purpose.

### Story-log limitation

Retroactive reconstruction can recover notable project moments, but it cannot guarantee that every earlier goofy question, joke, or small interaction is available. From this point forward, meaningful story moments should be captured as the work happens.

## 2026-10-08 — Test complete; legality comes before chasing paid work

The basic Opportunity Tracker import/save test is complete. The next step is not to invent a test job; it is to establish a legitimate opportunity pipeline.

A practical constraint was identified: before pursuing paid work, the project's state business-registration/licensing requirements need to be checked for the specific type of work.

This matters because an opportunity is only useful if it is actually legal and feasible to pursue.

## 2026-10-08 — The tax part of paid work

Another practical constraint was identified: earning self-employment/independent-contractor income can create both ordinary income-tax obligations and self-employment tax obligations. The IRS generally requires Schedule C reporting for sole-proprietor business income and Schedule SE when net self-employment earnings reach $400 or more. Independent contractors generally do not have taxes withheld like employees and may need estimated tax payments.

This reinforces the rule that the opportunity pipeline must consider **legal setup and taxes before pursuing paid work**, not just whether a listing looks attractive.

### Story principle

Keep the mistakes.

The value of this story is not that everything worked the first time. It is the sequence:

**attempt → confusion → question → investigation → correction → clearer understanding**

That process is part of gitback2life.

## 2026-10-08 — “cry cry cry”

After realizing the Opportunity Tracker had briefly pulled attention away from the larger purpose of gitback2life, the response was simply:

> **cry cry cry**

A useful reminder that keeping the project pointed at its real purpose sometimes matters more than adding another feature.

## 2026-10-08 — 700+ miles away, still following along

The first public story is already being read by Mom, more than 700 miles away. She is also enjoying the project conversations and watching the work take shape.

That is a reminder that “public” does not have to mean anonymous strangers only. A public project can also let the people who care about you follow the journey from far away.

## 2026-10-08 — First external publication

The first gitback2life story was published on Hashnode, extending the story beyond the project's own website.

Article: https://gitback2life.hashnode.dev/i-started-building-again-here-s-what-actually-happened

The milestone is simple: the real story now has an external publishing home as well as the GitHub Pages home base.

## 2026-10-08 — Second external publication: the feature wasn't finished until we tried it

The second gitback2life article was published on Hashnode. It documents how attempting to use the full Opportunity Tracker exposed JavaScript and validation issues that had been missed when the work was treated as complete.

Article: https://gitback2life.hashnode.dev/we-thought-the-feature-was-finished-then-we-tried-using-the-full-app

The core lesson is practical: **don't assume a feature works because the work looks finished. Try using it, investigate mismatches, fix them, and verify again.** A syntax check is useful, but it does not prove the full application works correctly.

This is the second published Hashnode article. No external promotion or outreach is implied by this entry.

## 2026-10-08 — “I better not look away”

After the researched JSON sample was imported into the deployed Opportunity Tracker, the operator confirmed: **“it works.”**

This is a small but real verification milestone: a researched record passed through the import flow and appeared to work in the actual tool. It is not proof that every part of the application is finished or fully tested.

The running joke was that the operator had better not look away, or the project might accidentally grow another department—or a comedy club—before anyone notices.

