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

During this session, the local toolbox's `suggestVerdict` logic and tests were iteratively refined to distinguish primary-site evidence from third-party page evidence. A second-round independent audit of the updated toolbox then reproduced additional authorization, containment, privacy, attribution, and availability failures. The toolbox is **not ready for operational incident use**. The test status and highest-priority blockers are summarized in the audit checkpoint below; no fixes were applied as part of that audit.

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


## Second-round toolbox safety-audit checkpoint — 2026-10-09

**Release decision: FAIL — operational trust has not yet been earned.** The audit tested the updated local 911 GetBack2Life toolbox from a review bundle. Existing tests passed, but new adversarial tests reproduced important weaknesses. Keep live inspection and untrusted project execution unavailable until the relevant fixes are tested and the real operating-system isolation boundary is demonstrated.

### Recorded test results

These are the actual results recorded in the audit report, not tests rerun by this story-reference update:

| Test group | Recorded result |
|---|---|
| Existing Node suite | 214 passed, 1 skipped (215 total) |
| Existing Python suite | 33 passed |
| Adversarial Node suite | 20 passed, 17 failed |
| Adversarial Python suite | 3 passed, 3 failed |
| Mocked transport suite | 5 passed |

The adversarial failures represent regression assertions grouped into 12 findings, not 20 separate vulnerabilities. Mocked tests do not demonstrate real DNS/TLS behavior, host firewall enforcement, or sandbox containment. The supplied Windows Sandbox was unavailable in the audit environment; the operational sandbox and child-process/package-lifecycle containment remain **not tested**. A historical source diff against the first audit could not be verified because the prior source snapshot was unavailable.

### Priority findings

**Priority 1 — must resolve before any operational authorization**

- **F11 — Python metadata scrubber output-junction escape.** An executed test created a Windows junction from a toolbox path to a synthetic outside directory. The actual CLI returned success and wrote the test image outside the toolbox. Fix output containment and reject reparse-point paths before writes; preserve ordinary image-cleaning behavior.
- **F02 — redirect authorization/disclosure gaps.** Mocked reproductions showed requests to unapproved public URLs through GitHub/API or robots redirects, and through a redirect chain after only the initial URL was approved. Validate authorization, scope, and disclosure for every hop and auxiliary request; do not weaken robots handling.
- **F03 — isolation checker inspects insufficient firewall detail.** A simulated rule set with acceptable counts but unsafe/unrelated rule semantics was accepted as isolated. Validate actual effective filters and expected profiles; then test in a genuinely disposable OS sandbox. Do not treat an environment variable or mocked result as isolation proof.
- **F07 — privacy/output and secret-persistence gaps.** Synthetic secrets survived representative cache keys, JSON/report paths, email subject output, Python output, and URL path/fragment handling. Centralize structured output protection, avoid storing raw sensitive URLs in cooldown state, and test every export boundary. Pattern matching cannot replace human privacy review.
- **F01 — approvals can be forged by the constrained actor.** An unkeyed checksum can be generated by a process able to construct the approval record. Either describe this honestly as an operator attestation, or put approval issuance and policy storage behind a trust boundary the worker cannot write.

**Priority 2 — fix before relying on the corresponding capabilities**

- **F05 — hardlink overwrite escape.** Overwriting an internal hardlink changed a synthetic external file. Safely replace destinations without truncating an existing linked inode; retain junction/symlink checks.
- **F12 — scope schema and revocation gaps.** Python accepts incomplete incident scopes, and an operation that is already running can continue requests after its scope is stopped. Align scope schemas and bind artifacts to incidents/targets; define and test the stopping/revocation contract at each relevant boundary.
- **F10 — unrelated asset corroboration.** A reputation flag for an unrelated third-party domain upgraded a primary-site redirect to “suspicious indicators.” Corroboration must be linked to the affected domain/asset or redirect destination, not merely the organization label.
- **F06 — request budgets and reuse guarantees.** Concurrent reservations can exceed the configured cap, while transient repeated lookups bypass reuse controls. Fix reservation concurrency and reconcile privacy-preserving transient mode with any repeat-limit requirement.
- **F09 — case packets preserve active Markdown/HTML.** A synthetic Markdown file with a remote image and JavaScript link passed the packet classifier unchanged. Keep raw evidence inert and generate sanitized views without destroying evidence integrity.
- **F08 — malformed URL crashes the sanitizer.** A malformed URL caused recursive sanitization until a stack overflow. Make invalid-URL handling nonrecursive and safe.
- **F04 — generated sandbox cache junction conflicts with write containment.** The generated inspect layout maps state through a junction that the general write guard correctly refuses. Redesign the mapped state boundary; do not solve this by weakening general containment.

### Safeguards that passed, with limits

The audit recorded passing tests for CLI scope-refusal cases, private-address and ordinary redirect safeguards, core junction refusal/new-file protection, cross-organization compromise restrictions, common ledger Markdown escaping, and refusal to treat the current host as isolated. These passes apply only to the tested paths. They do not cancel the failures above or establish that every tool entry point is protected.

### Fix-validation sequence

1. Fix F11, F02, F03 and F07; decide whether F01 requires a real separate approval authority or an explicitly non-security-boundary attestation.
2. Fix F05, F12, F10, F06, F09, F08 and F04 without weakening existing containment.
3. Keep every reproduced adversarial case as a regression test. Rerun the existing Node/Python suites and the adversarial suites; inspect exact outputs and diffs.
4. In a disposable Windows sandbox, verify the actual firewall/effective filter contents, IPv4/IPv6 egress denial, non-Node child processes, package lifecycle behavior, mapped host read/write access, teardown, and persistence behavior. These were not tested in the recorded audit.
5. Revisit historical comparison when the prior source snapshot is available. Do not claim a finding is fixed until the corresponding test passes against the changed code.

### Story and privacy boundaries

The audit was confined to the local toolbox and synthetic fixtures. It did not access or modify the NYC Animal Rescue repository or actual rescue websites; no suspicious destination or private network was probed, no downloaded code was executed, and nothing was published by the audit. No production fix was applied. Keep findings in this focused reference only unless the operator explicitly chooses to document them elsewhere.

**What the story should say:** the toolbox's safety principles are valuable, and the second-round audit found real gaps before operational use. The lesson is that documenting good rules is not enough—enforcement needs adversarial tests, and mock tests cannot substitute for verifying the actual sandbox. This is progress, not a finished or certified security tool.

---
