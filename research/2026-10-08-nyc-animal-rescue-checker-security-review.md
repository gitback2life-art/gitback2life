# NYC Animal Rescue weekly-checker security review

**Research date:** 2026-10-08  
**Status:** Preliminary; no compromise confirmed  
**Target:** https://github.com/btaylor62000-spec/nyc-animal-rescue  
**Open report:** https://github.com/btaylor62000-spec/nyc-animal-rescue/issues/1

## Research question

Could the unusually high number of items flagged by the weekly checker indicate an infected/compromised website, or is there a demonstrable checker defect?

## Why it matters

The directory includes time-sensitive animal-help resources and emergency contacts. False positives can bury important findings; a wrong contact is potentially harmful. The investigation must not edit live data merely because a scanner reported a difference.

## Sources reviewed

- Weekly-check issue, last report dated 2026-10-05: https://github.com/btaylor62000-spec/nyc-animal-rescue/issues/1
- 2026-09-28 run: https://github.com/btaylor62000-spec/nyc-animal-rescue/actions/runs/36438667140
- 2026-10-05 run: https://github.com/btaylor62000-spec/nyc-animal-rescue/actions/runs/37332890503
- `scripts/agent/weekly.ts`
- `scripts/agent/rules.ts`
- `scripts/agent/fetch.ts`
- `tests/agent.test.ts`

## Findings

### Confirmed: the checker has a third-party redirect false-positive path

The weekly check gathers pages from multiple categories: the organization's primary website, intake URLs, suggested contact paths on the website, and source URLs. In the rules engine, the redirect check currently selects the first page whose `offDomain` flag is true, without requiring that the originally requested URL was the organization's primary website.

This means an intake link that normally redirects from a URL shortener to a hosted form can be reported as if the organization's own website moved. That is a code-level logic defect, independent of whether any target website is compromised.

### Confirmed: both unusually high runs were stopped by the safety valve

The 2026-09-28 run flagged 65 of 311 records; the 2026-10-05 run flagged 58 of 311. Both crossed the configured 15% safety threshold. The workflow logs show the rules-engine test step succeeded, the scanner completed the 311-record pass, and the safety valve caused the job to fail. Rebuild and commit steps were skipped. The anomaly report itself says to treat its list as a bug report, not verified findings.

### Separate hardening question: redirect targets

The fetcher allows automatic redirect following and computes whether the final URL is on a different site. The code reviewed does not contain an application-level validation of every redirect hop against private/local IP addresses before the redirect is followed. The actual exposure depends on runtime/network protections and the trustworthiness of the input URLs; this is a security-review item, **not evidence of exploitation**.

## Infection/compromise assessment

**Not established.** Unexpected redirects can have benign causes (expired or repurposed domains, configuration changes, hosted forms) as well as malicious causes (hijacking or compromise). The issue and code evidence support a confirmed scanner false-positive path, but do not prove that the target sites are infected or that the directory repository has been compromised.

No threat-intelligence lookup, safe redirect-chain investigation, response-body comparison, or malware/payload analysis was performed as part of this preliminary review.

## Confidence / uncertainty

- **High confidence:** the general false-positive logic exists in the checked source code.
- **High confidence:** the two cited runs were stopped by the safety valve rather than accepted as routine updates.
- **Unknown:** whether the particular unexpected-domain redirect cited in the report is malicious.
- **Unknown:** whether identical/shared responses or other checker/network failure modes explain the remaining flags.
- **Not assessed:** whether the workflow's runtime blocks every unsafe redirect destination at the network layer.

## Recommendation

1. Preserve the fail-closed safety valve and do not act on the flagged contact list as verified evidence.
2. Add an offline regression test: a healthy primary site confirms its stored contact while a third-party intake URL redirects off-domain; this should not create a primary-site-moved finding. Preserve the existing test that a primary-site off-domain redirect is flagged.
3. Review redirect handling separately and validate destination safety without visiting suspicious destinations in a normal browser or executing returned content.
4. Use reputable passive threat-intelligence checks for specific domains/URLs before asserting compromise. Distinguish a reputation hit or a redirect anomaly from confirmed infection.
5. Ask the maintainer or offer a small patch only after tests and scope are clear; no target-repository changes or outreach have been made.

## Decision

No conclusion about infection yet. Continue with controlled, read-only verification.
