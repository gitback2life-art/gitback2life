# 911 GetBack2Life Toolbox — Temporary Story Reference

> **Purpose:** A compact, public-safe story reference for the main gitback2life project.
> It captures the real problem, what has been learned, and the responsible direction of the work.
> It is not a replacement for `docs/session-handoff.md`, a finished article, or a definitive security report.
>
> **Status:** Working reference · 2026-10-09

## The story in one paragraph

gitback2life is about rebuilding, learning, and building useful things with AI without pretending the hard parts disappear. A concrete opportunity came from a public directory of New York City animal-rescue resources: its weekly checker began flagging far more entries than expected. Instead of treating every alert as truth—or assuming a website had been hacked—we examined the safety controls, checked the workflow evidence, and read the code. That revealed a credible checker bug: redirects from secondary links could be interpreted as evidence that an organization's main website had moved. A separate, reported redirect from one rescue's primary domain remains unresolved. The response is to build a small, careful “911 GetBack2Life” toolbox that organizes evidence, preserves uncertainty, and supports safer decisions before anyone changes live data.

## Why this belongs in the gitback2life story

The project’s recurring pattern is:

**question → inspect the actual evidence → identify what is known → test the explanation → correct carefully → verify**

This work applies that pattern to a real-world problem where careless changes could confuse people trying to find animal-rescue help. The useful story is not “AI detected a hack” or “AI fixed everything.” It is that AI-assisted problem-solving can help a person investigate a serious-looking alert while maintaining skepticism, clear boundaries, and human control.

The motivation is to help animals by improving the reliability of information and the tools used to assess it—not to defend an institution or accuse one without evidence.

## What is established

- The target is the public directory repository [`btaylor62000-spec/nyc-animal-rescue`](https://github.com/btaylor62000-spec/nyc-animal-rescue), which lists animal rescues, shelters, veterinary resources, and related services. It is a directory project, not a single shelter.
- The weekly workflow on **September 28, 2026** flagged **65 of 311** records and stopped before rebuilding/committing suspected directory changes. [Workflow run](https://github.com/btaylor62000-spec/nyc-animal-rescue/actions/runs/36438667140)
- The weekly workflow on **October 5, 2026** flagged **58 of 311** records and likewise stopped before rebuilding/committing suspected directory changes. The issue report says only check-date bookkeeping was written. [Workflow run](https://github.com/btaylor62000-spec/nyc-animal-rescue/actions/runs/37332890503) · [Weekly-check issue #1](https://github.com/btaylor62000-spec/nyc-animal-rescue/issues/1)
- The safety valve behaved as designed for these runs: tests and scans completed, the threshold triggered, and rebuild/commit steps were skipped. The high flag counts were an anomaly to investigate, not proof that dozens of organizations had bad websites.
- Current code review identifies a credible false-positive path. The checker visits an organization's primary website plus intake, contact, and source URLs. The fetcher follows redirects and records whether the final URL is off-domain; the rules engine can select any off-domain page as a primary-site warning. That means an ordinary redirect from a third-party form or another secondary URL can be misleadingly attributed to the organization's main website.
- This explains a class of checker errors. It does **not** prove that every flagged record was a false positive.

## The unresolved example: Kittens and Barbells

The October 5 report records the requested primary URL `https://www.kittensandbarbells.org` as redirecting to `https://www.talesofhazaribagh.com/`.

That report is a lead to investigate, not a compromise verdict. Public searches also surfaced a Squarespace-hosted site containing Kittens and Barbells rescue information, but official control of that alternative site has not been independently established. An older third-party WHOIS snapshot has an August 2024 expiration date but was last updated in 2023, so it cannot prove that the domain actually expired. A current authoritative registration history and a reliable timeline for nameserver/DNS changes have not yet been obtained.

Plausible explanations include legitimate migration, DNS/hosting misconfiguration, a lapse or change in domain control, or unauthorized control. **No independent evidence currently establishes that the rescue's website, hosting account, or DNS was compromised.** A redirect and an unrelated destination alone cannot distinguish these causes.

Primary reference: [weekly-check issue #1](https://github.com/btaylor62000-spec/nyc-animal-rescue/issues/1).

## Why the 911 toolbox is being built

The proposed local toolbox is intended to help with urgent, messy investigations by making it easier to:

- collect evidence and preserve source links and timestamps;
- distinguish direct observations from reports, inferences, and hypotheses;
- keep page roles clear (primary website versus intake, contact, or source page);
- assess a warning without automatically treating it as proof of compromise;
- review code and design offline, deterministic regression tests;
- identify permission, privacy, and safety boundaries before an action is taken.

An evidence-ledger verdict is decision support, not an automated accusation. Page-specific evidence must not be attributed to a primary website when the page belongs to a third-party service. Unknown page roles should lead to review rather than being silently dismissed. A report or reputation flag alone must not be presented as proof of compromise.

During this session, the local toolbox's `suggestVerdict` logic and tests have been iteratively discussed and refined to reflect these distinctions. The exact final diff and successful test output have **not** been independently verified in this reference; do not describe the toolbox as fully tested or finished until actual results are checked.

## Safety boundaries and current status

- Keep the investigation read-only unless a specific action is expressly authorized.
- Do not edit live resource records, emergency phone numbers, clinic details, or intake contacts as part of this investigation.
- Do not disable or bypass the directory's safety valve.
- Do not run intrusive scans, download or execute suspected payloads, or probe private/internal networks.
- Prefer passive registration, DNS, certificate, archive, and reputable reputation sources before considering controlled live inspection.
- If live HTTP inspection becomes necessary, explain the exact method and risks and obtain authorization first.
- Do not claim a website is infected, compromised, or clean without evidence supporting that exact conclusion.
- Do not publish a contribution, contact maintainers, or modify the target animal-rescue repository without specific authorization.

This story reference intentionally avoids private identity details and private tool/account information. Although it is a temporary draft, it lives in the public gitback2life repository; treat its contents as public. It is not a private incident log and should not be expanded with sensitive raw research.

## Story beats for a later short article

1. **The human question:** Can we use the tools we are learning to build to help the wonderful animals?
2. **The alarming signal:** Two weekly runs flag an unusually large share of a public directory.
3. **The safety mechanism works:** The checker refuses to apply broad changes when its results look abnormal.
4. **The investigation finds a real software flaw:** A redirect from a secondary page can be mistaken for a change to the primary website.
5. **The honest complication:** One reported primary-domain redirect still needs careful investigation; the available facts do not establish compromise.
6. **The build response:** Create a small emergency-investigation toolbox that makes evidence provenance, page role, uncertainty, and human approval explicit.
7. **The lesson:** Responsible AI-assisted work is not about producing the most dramatic verdict. It is about helping someone make a better-informed decision without causing avoidable harm.

## Editorial guardrails

- Keep confirmed facts, reports, hypotheses, recommendations, and decisions clearly separated.
- Link to primary evidence for important factual claims.
- Do not publish allegations as established findings.
- Do not imply that the directory's maintainer or any rescue endorsed this work.
- Do not imply a contribution was submitted, accepted, merged, or deployed; none has been made to the target repository as part of this reference.
- Keep this as a story seed until the operator explicitly chooses to turn it into a public article.

## Relationship to canonical project documents

- Canonical long-term project context remains in [`docs/session-handoff.md`](session-handoff.md).
- The wider narrative and voice remain in [`docs/story.md`](story.md) and [`docs/story-log.md`](story-log.md).
- This file is a **temporary, focused reference** for the 911 GetBack2Life toolbox and the animal-rescue investigation. It does not change the canonical handoff, project policy, or public website.

---
