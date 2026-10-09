# Volunteer opportunities for gitback2life — 2026-10-08

**Status:** Research and recommendations only. No comments, applications, pull requests, or other contact have been made.

## Research question

Find legitimate, no-cost volunteer work where the current gitback2life skill level can help a worthy cause, preferably through remote, clearly scoped work without joining another platform or exposing private identity.

## Best fit: Code Your Future — free coding education

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

## Evaluation

**Recommended first choice:** Code Your Future issue #1902, if the maintainers confirm it is still needed. It matches the existing work and learning story, serves people gaining access to coding education, and offers a scoped way to practice clear technical writing and collaborative GitHub workflow.

**Alternative:** Cboard issue #2250 if the operator prefers to try a code-focused contribution for assistive technology and is comfortable with additional JavaScript/React learning and tests.

## Decision and next action

Research only. No organization has been contacted, no issue comment or pull request has been posted, and no obligation has been accepted.

The first action, if approved, should be to review the Code Your Future materials and prepare a short message asking whether issue #1902 is still needed. Only after confirmation should we draft the contribution. Work at a sustainable pace; there is no response-time or deadline promise.
