# Offline regression plan: secondary-URL redirect wrongly treated as "primary domain moved"

Status: **plan only**. The fix below has not been written or tested. Write it only after the source has
been re-read at a pinned commit (`github_evidence snapshot`) and local patch work is approved in the scope file.

## Suspected defect (re-verify before relying on it)
- `scripts/agent/weekly.ts` checks several page roles per organization: primary website, intake URLs,
  same-origin contact paths and source URLs (subject to a page cap).
- `scripts/agent/fetch.ts` follows redirects (`redirect: 'follow'`) and records `offDomain` when the final
  URL is not the same site as the requested one.
- `scripts/agent/rules.ts` reportedly does the equivalent of `evidence.pages.find((p) => p.offDomain)`.
  So an intake or source page redirecting to a third-party form would raise the same warning as the
  primary website moving.

## Minimal fix shape
Restrict the domain-moved rule to evidence whose page role is the recorded primary website. Do not
change thresholds, data, workflows or generated output (`diff_scope_check.mjs` flags these).

## Required offline tests (mocked fetch, network blocked by `network_guard.mjs`)
1. Healthy primary site + off-domain third-party **intake** redirect → **no** primary-domain-moved warning
   from that redirect alone.
2. Off-domain redirect from the **primary** site itself → still flagged for human review.
   (The existing test, named similarly to "a redirect off the domain is flagged rather than followed",
   must stay unchanged and passing.)
3. Healthy primary site → contact/phone verification behavior unchanged.
4. Absent or malformed primary URL → handled exactly as the current rule contract says (read it first).

## Steps
1. (Changed 2026-10-09: `github_evidence archive` is disabled, because zips cannot be masked and only masked copies are kept. Getting a runnable copy of the project needs a separate, explicit decision by the owner.)
2. Extract into a new folder under `regression_harness/workspace/` (PowerShell `Expand-Archive`).
3. Read `package.json` scripts and the test files. Dependencies need a one-time install, which uses the
   network and needs its own approval. Always install without running packages' install scripts:
   `npm ci --ignore-scripts` (on this computer: it only downloads, no package code runs). Never install without that flag:
   plain installs run code from every package. The tests sandbox has no network, so install before copying in.
4. Baseline, **inside the tests-mode Windows Sandbox only** (`sandbox_setup create --mode tests`; networking off):
   `node regression_harness/run_offline.mjs --cwd <folder> --reviewed --scope <scope.json> -- <test command>`
   and record the counts. The runner refuses to run anywhere else.
5. Add the tests, then the fix. Re-run the full suite with `run_offline`.
6. `git diff`-style patch → `node regression_harness/diff_scope_check.mjs <patch>`.
7. Report exact command, exit code, counts and environment. Never cite the historical CI result (144 tests) as a local run.
