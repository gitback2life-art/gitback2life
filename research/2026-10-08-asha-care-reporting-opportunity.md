# ASHA Care reporting candidate — inactive after status correction

**Status: INACTIVE — do not submit.** A small practice patch was prepared and tested locally, but it has not been submitted upstream and should not be offered as a current contribution. No real database or patient record was accessed.

## The request

The discussion is internally inconsistent about whether help is still needed. The original author posted on September 29: “My work is done now—someone helped me with it.” The discussion also contains later October 7 replies where the author appears to describe remaining work. The operator linked the September 29 completion reply and corrected us that this should be treated as an inactive request that was not properly closed. For opportunity selection, the explicit status correction takes precedence: do not approach the author or submit work unless they clearly renew the request.

- Discussion: https://github.com/orgs/community/discussions/208007
- App repository: https://github.com/parth270520/My-Mom-Project-
- Current contribution guide/readme status: the repository root README was nearly empty on the current `main` branch; it is a Django app backed by SQLite.
- Repository models inspected: `Village`, `Family`, and `Member` store village, household, and member records. The member schema includes sensitive identifiers and health-related fields, so any report needs a clear privacy boundary.

## Current project activity and overlap check

A separate open PR (#1, “Feat/new look and features”) from another contributor adds attendance/duty tracking and a monthly print-ready attendance register. To avoid duplicating that scope, this proposal focuses on a separate **aggregate household and coverage snapshot by village**, not attendance reporting.

PR: https://github.com/parth270520/My-Mom-Project-/pull/1

## Prepared contribution

The patch adds:
- `scripts/generate_coverage_report.py` — dependency-free Python CLI to read the Django SQLite database **read-only** and emit CSV or JSON.
- `tests/test_generate_coverage_report.py` — tests using a synthetic in-memory SQLite schema.
- `docs/coverage-report-script.md` — scope and usage notes.

The report contains one aggregate row per village plus an all-villages total: households, members, female-member count, pregnancy flags recorded, BPL-member count, ABHA/Ayushman number presence, mobile-number presence, and expected-delivery-date completeness for entries currently marked pregnant. It does not output individual records.

### Guardrails and limits

- No names, addresses, phone numbers, Aadhaar/ABHA/beneficiary numbers, disease notes, caste, religion, or person-level pregnancy entries are exported.
- The report describes the **current database snapshot**, not a dated visit history or proof that a service was delivered.
- A populated card-number field is counted as “present”; it is not independently verified enrollment.
- It is not an official government form and must not be used for clinical decisions.
- Only synthetic data was used in tests. No test was run against the owner's actual database.
- This is a CLI/export starter, not a finished in-app reporting UI. It needs review by the intended user before operational use.

## Verification

Five standard-library unit tests passed: village and all-village totals, villages with no members, CSV/JSON privacy boundary, schema-error messaging, command-line output using a synthetic file-backed database, and no accidental creation of a missing database file. Patch application was also checked against a sample repository root with an existing README.

## Delivery state

No comment, branch, or pull request has been created in the target repository. The connected GitHub integration has previously denied writes to another repository, so the prepared patch still needs to be applied and submitted by the operator through their public GitHub account (preferably from a fork), or reviewed before deciding whether it matches the author's intended report.

Next step: share the patch and ask the author whether this aggregate village-level report is useful as a first reporting feature, then adapt only after they confirm it matches their workflow.
