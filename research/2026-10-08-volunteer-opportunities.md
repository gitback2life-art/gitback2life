# Volunteer opportunities for gitback2life — 2026-10-08

**Status:** Research and recommendations only. No comments, applications, pull requests, or other contact have been made.

## Research question

Find legitimate, no-cost volunteer work where the current gitback2life skill level can help a worthy cause, preferably through remote, clearly scoped work without joining another platform or exposing private identity.

## Previous candidate (deprioritized): Code Your Future — free coding education

### Cause and project
Code Your Future describes itself as a volunteer-led community that teaches people to code for free. Its public contribution guide explicitly says people can contribute in multiple ways and volunteer remotely. The curriculum emphasizes practical content written in simple English.

Sources:
- Project: https://github.com/CodeYourFuture/curriculum
- Contribution guide: https://github.com/CodeYourFuture/curriculum/blob/main/CONTRIBUTING.md
- AI usage guidance: https://curriculum.codeyourfuture.io/guides/ai-usage/
- Specific issue: https://github.com/CodeYourFuture/curriculum/issues/1902

### Open task found
**Issue #1902 — “Add AI guidelines to Launch”**

At the time of research, GitHub showed the issue as **Open**, with labels for AI and prep work, a size estimate of **1–4 hours**, no assignee, and no linked branch or pull request. The issue requests Launch-specific AI-use guidance in course preparation material, using the project's existing course guidance as a reference.

The issue is several months old. Before doing substantial work, ask publicly on the issue whether this task is still wanted and whether the maintainers have a preferred scope. Do not assume that an old open issue is still a priority.

### Why it fits
- It supports free technical education.
- It is mainly a learning-material/documentation task rather than a large code feature.
- gitback2life has first-hand experience with AI-assisted learning, generated code that needed correction, and the importance of checking the actual result. That experience may help us explain the learning/verification trade-off honestly, without claiming to be expert educators.
- It can be approached through the existing pseudonymous GitHub account; no new platform account is needed.

### Contribution guardrails
- Read the existing AI guidance and contribution guide first.
- If the issue is still wanted, prepare a small draft for review before opening a pull request.
- Keep factual claims sourced; follow their current AI-course guidance rather than inventing policy.
- Test/preview the rendered content and follow their style rules.
- Public comments, commits, and pull requests can be associated with the GitHub account. Keep private identity information out.
- This would be unpaid volunteer work; no income or acceptance is implied.

## Alternative: Cboard — assistive communication technology

Cboard describes itself as a browser-based Augmentative and Alternative Communication (AAC) system with text-to-speech, serving people who need communication support.

Sources:
- Project: https://github.com/cboard-org/cboard
- Specific issue: https://github.com/cboard-org/cboard/issues/2250
- Project directory: https://forgoodfirstissue.github.com/

At the time of research, issue #2250 was open and labeled **good first issue**. It requests using the correct file extension for recorded audio based on its MIME type rather than hardcoding `.mp3`, and adding a unit test. This is a more code-heavy JavaScript/React contribution than the Code Your Future documentation task. It may be an impactful future challenge, but it should only be attempted after reading the code, confirming maintainers still want it, and ensuring the change is thoroughly tested. Because the software supports communication, do not make changes to user-facing behavior based only on assumptions.

## Current front-runner: Open Food Facts — ingredient parser regression

### Cause and project
Open Food Facts maintains an open database of food-product information, including ingredients and nutritional information. Improving how ingredient text is structured is a concrete data-quality contribution.

Sources:
- Project: https://github.com/openfoodfacts/openfoodfacts-server
- Contribution guide: https://github.com/openfoodfacts/openfoodfacts-server/blob/main/CONTRIBUTING.md
- Issue: https://github.com/openfoodfacts/openfoodfacts-server/issues/14853
- Parser implementation: https://github.com/openfoodfacts/openfoodfacts-server/blob/main/lib/ProductOpener/Ingredients.pm
- Existing parser tests: https://github.com/openfoodfacts/openfoodfacts-server/blob/main/tests/unit/ingredients.t

### Current issue status
**Issue #14853 — “Parser: split sheep's and goat's milk”** was opened on October 7, 2026 and updated on October 8, 2026. It remained **Open** when checked. No assignee was shown. One public comment traces the issue to the parser's rule that both sides of an “and” expression must be recognized independently. In “Pasteurised sheep's and goat's milk,” the first part becomes “sheep's,” which is not independently recognized, even though “milk” is shared by both parts.

A scan of the first page of recently updated open pull requests did not show a matching PR title. Re-check linked work and current PRs before implementation; this is not a guarantee that no related work exists.

### Proposed safe first steps
- Read the nearby “and”-splitting logic in `lib/ProductOpener/Ingredients.pm` and the fixture-driven cases in `tests/unit/ingredients.t`.
- Add a regression case for the reported text and understand the expected ingredient output before changing parser behavior.
- If a code fix is warranted, keep it narrow to shared-head coordination and preserve existing safeguards against incorrectly splitting legitimate ingredient descriptions containing “and.”
- Run the relevant tests or be explicit about what could not be run. Do not claim the fix works until the test result supports that.

This is a more technical first contribution than the previous documentation task, but it is current, concrete, and benefits an open food-data project. No outreach, contribution branch, PR, or commitment has been made. The connected GitHub integration previously returned 403 when attempting to comment on an external project's issue, so a public “I’ll take this” comment may need to be posted manually once we are ready to commit to it.

## Evaluation and decision

The original Code Your Future issue #1902 is still open, but it was created and last updated in June 2026. It is now **deprioritized as our primary pick** because the task looked stale and lacked recent activity; no comment was posted.

**Recommendation at the time of this research:** Open Food Facts issue #14853 was the most recent concrete code-and-test alternative found in that search. After the operator asked specifically for a community request where we can make and test a small deliverable, the later-selected current candidate is the ASHA Care reporting request documented in [the dedicated evaluation](2026-10-08-asha-care-reporting-opportunity.md). Open Food Facts remains an alternative, not the current top choice.

Work at a sustainable pace. Re-check that an issue remains open and that no PR has appeared before preparing a contribution. No income, acceptance, or deadline is implied.
