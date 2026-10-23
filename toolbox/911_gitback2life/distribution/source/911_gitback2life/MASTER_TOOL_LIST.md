# gitback2life: master tool list

A local-first toolkit for helping animal rescues, shelters and other public-interest groups with urgent
technical problems: a website that suddenly redirects somewhere else, a domain about to lapse, a
suspected account takeover, or an automated check that starts flagging everything.

Everything here runs on this computer. Default behavior is **read-only, passive and offline**. Nothing
posts to GitHub, contacts an organization, submits URLs to scanners, or saves files outside this folder.
This is not a replacement for calling emergency services when a person or animal is in physical danger.

**Scope:** tools that go online or save incident data require `--scope <file>` and refuse anything the scope does not allow (see TOOLKIT_RULES.md section 1c).

**Repairs and updates:** every repair or update requires explicit approval from an authorized human, tied to the exact target and the exact proposed changes, enforced by each tool. **This is not yet enforced everywhere:** `safe_backup restore` and patch work have no such check, and no approval binds the exact proposed changes yet. `org_registers update` and `access_offboarding update` therefore **do not write at all** for now: they validate the change, show its hash and refuse, and a person applies it by hand. See the status table in TOOLKIT_RULES.md section 1e.

**Rules:** everything here follows [TOOLKIT_RULES.md](TOOLKIT_RULES.md): test, help and report only; never
harm or flood the people we help. Tools that use the network go through **polite limits** (1 request/second
per service, at most 60 per command and 300 per service per day, answers reused for 12 hours, live checks at
most once a day per URL) and end every command with a count of exactly what was sent. Every request, to any
site or service, first reads and obeys that site's **robots.txt** (including Crawl-delay), on every redirect
hop. A rule test enforces all of this for every tool.

**One-click toolbox:** On Windows, double-click `TOOLBOX.cmd` in this project folder. It provides an ordinary, non-elevated local menu for incident drafts, evidence revisions, decision summaries, register reports, access-offboarding checklists, incident timeline reports, backup previews, offline email/directory/URL reviews, guided static source/disclosure checks, case progress overviews, complete six-part evidence review (checked/unchecked, hypotheses, risk and next steps), editable revision-preserving incident timelines, explicit reviewed local backups, and preparation/inspection of protected review requests. It does **not** install, approve, activate or modify protected registers. See [`toolbox/README.md`](toolbox/README.md).

**Requirements:** Node.js 22+ and Python 3.10+. No packages to install.

**Run all tests (offline):**
```
npm test
python -I _shared/test_python_tools.py -v
```

---

## Workflow tools (Node.js)

Use roughly in this order: **intake → evidence → research → ledger → summary**.

| Tool | Folder / entry point | Purpose | Network |
|---|---|---|---|
| **incident_intake** | `incident_intake/incident_intake.mjs` | Creates and manages the incident **scope** that the tools enforce: question, targets, permitted actions, which outside services may see the targets, persistence, expiry (7 days by default) and status. `authorize` answers "would this be allowed?"; `approve` records a 24-hour **operator attestation** for one always-ask action on one exact target (interactive terminal and retyped target as an accident guard; an attestation is the operator's statement, not proof that a person approved); `stop` ends the incident so every tool refuses it. `state` shows what the toolkit has stored and `--clear-results` removes cached lookup results now (safety limits expire, and are removed at the next clean-up). Scopes are validated against the shared contract `_shared/scope_schema.json`; `deny_actions` is the executable form of "prohibited"; `allow_derived_lookalikes` opts in to lookalike lookups. | None |
| **github_evidence** | `github_evidence/github_evidence.mjs` | Read-only collector for public GitHub issues, comments, Actions runs/steps (and log excerpts with a token), files pinned to a commit SHA, **masked** snapshots (labelled MODIFIED EVIDENCE; originals identified by blob SHA), and change checks (only for the snapshot's own incident). Zip downloads are disabled: zips cannot be masked. Only fine-grained tokens are accepted. GET only. | api.github.com |
| **domain_research** | `domain_research/domain_research.mjs` | Passive look-ups of existing public records: registration/expiry (RDAP), DNS records with TTLs, certificate history (crt.sh), and Wayback archive captures, including historical redirects. Never visits the site itself; never submits to scanners. | rdap.org, DNS resolver, crt.sh, web.archive.org |
| **evidence_ledger** | `evidence_ledger/ledger.mjs` | Keeps every observation labeled (confirmed / source report / inference / hypothesis / recommendation / decision), sourced, timed, and tied to its page role (primary, intake, source, contact). Restricts verdicts to four calibrated options. `suggestVerdict` proposes a verdict per organization: reports alone never go above "needs review"; redirects and harmful content only count against an organization when confirmed on its primary site; "compromise" requires a confirmed compromise observation of an asset the organization itself controls. Items with a warning signal must name their organization, and asset signals (compromise, harmful content, DNS change, reputation flag) must name the asset and who controls it (organization / third party / unknown); verdicts can only rest on evidence about that same organization, including in hand-edited ledgers. Source links must be real web addresses (non-web sources go in `source_ref`, reports only) and times must be UTC timestamps, not in the future. | None |
| **decision_summary** | `decision_summary/decision_summary.mjs` | Turns a ledger into a six-part summary: checked/not checked, observations, confirmed vs inferred, explanations still in play, risk, and the safe next step with the permission it needs. Shows each organization's suggested verdict (with the evidence IDs behind it) next to any verdict a person has set. Flags verdict-sounding words. | None |

## Specialist tools (Node.js)

| Tool | Folder / entry point | Purpose | Network |
|---|---|---|---|
| **redirect_inspector** | `redirect_inspector/redirect_inspector.mjs` | Hop-by-hop redirect chain check: one HEAD per hop (plus a GET of each site's robots.txt) through the shared guarded transport, every hop validated (private addresses, https→http downgrades, loops), robots.txt and Crawl-delay obeyed per site, hops outside the scope recorded but not contacted. **Live mode only runs inside the verified inspect-mode Windows Sandbox** (real system state checked), with `--scope` holding an exact-URL operator attestation for every hop contacted, `--live` and `--approve`. `check-url` works offline. | Off unless all checks pass |
| **fetcher_review** | `fetcher_review/fetcher_review.mjs` + `CHECKLIST.md` | Static map of where a project fetches URLs and follows redirects, plus a security review checklist. For code review, not testing against live systems. | None |
| **regression_harness** | `regression_harness/` | `network_guard.mjs` blocks outbound network for Node.js processes; `run_offline.mjs` runs a reviewed project's Node tests **only inside the verified tests-mode Windows Sandbox** (networking off), without a shell, with npx unable to download packages, and reports exact command, exit code and counts; `diff_scope_check.mjs` flags patches touching data, contacts, thresholds or workflows; `PATCH_PLAN.md` holds the plan for the current rescue-directory fix. | Blocked |

## Organization support tools (Python, adapted from the gitback2life security suite)

| Tool | Folder / entry point | Purpose | Network |
|---|---|---|---|
| **org_registers** | `org_registers/org_registers.py` | Register of the organization's services (domain registrar, DNS, host, email, donation/forms platforms, social) with renewal dates, auto-renew, two-step login and recovery-contact review. The report flags lapsed or soon-to-lapse domains and missing two-step login. A second register tracks what personal data is held, where and for how long. `update` validates a change but **does not write** until approval enforcement exists (TOOLKIT_RULES 1e). | None |
| **incident_timeline** | `incident_timeline/incident_timeline.py` + `PLAYBOOK.md` | UTC timeline and decision record across seven response stages, for real incidents or practice exercises (website redirect, domain expiry, account takeover, data exposure, and others). | None |
| **safe_backup** | `safe_backup/safe_backup.py` | Hash-verified backup of an explicit file list before anyone changes anything; refuses if files changed since the preview; restores only into a new folder after checking every hash. Backups are exact, so a file is kept only if masking would not change it (no secret- or contact-shaped content); images only with nothing beyond their core parts; other binary refused. `restore` is not tied to an approval of the exact target and changes (TOOLKIT_RULES 1e: unimplemented). | None |
| **code_flow_scan** | `code_flow_scan/code_flow_scan.py` | Finds where website code stores, logs or sends data (including third-party scripts and off-site form posts), and flags absolute privacy/security claims ("100% secure"). Reports never include code snippets. | None |
| **dependency_inventory** | `dependency_inventory/dependency_inventory.py` | Lists npm packages, versions and licenses from a lockfile, and matches advisories you supply by exact version. | None |
| **metadata_scrub** | `metadata_scrub/metadata_scrub.py` | Strips GPS/EXIF, XMP, comments and text chunks from JPEG/PNG screenshots before sharing them as evidence. Writes cleaned copies to a new folder; originals untouched; no Pillow needed. | None |
| **device_check** | `device_check/check_device.ps1` | Read-only security status of the Windows PC doing the work: Defender, signature age, BitLocker, firewall, screen-lock policy. Changes nothing. Split into a *read* step and a *decide* step; `-InputJson` judges sample settings instead of the real PC (results marked `test_fixture`), which is how its tests run. | None |

## Shelter emergency tools (added 2026-10-09)

| Tool | Folder / entry point | Purpose | Network |
|---|---|---|---|
| **domain_watch** | `domain_watch/domain_watch.mjs` | Spots domain trouble early: compares a domain's public registration (expiry, registrar, status, nameservers) and DNS records with a saved baseline. Flags lapsed or soon-to-lapse registrations and risky registry status as urgent, registrar/nameserver changes for review, and DNS changes as info. Reads domains from an `org_registers` service register. Baselines are saved only when a person asks: `--save-baseline` keeps a first baseline, `--accept` replaces it; with a scope allowing local persistence, lookup results are also cached for 12 h in `_shared/.polite_cache`. At most 5 domains per run; manual runs only. | Passive via `domain_research` (polite limits, robots.txt) |
| **email_spoof_check** | `email_spoof_check/email_spoof_check.mjs` | Checks whether a domain publishes protection against people sending fake email in its name: SPF (who may send), DMARC (what receivers should do with fake mail, and whether reports are sent), MX, and up to 5 DKIM selectors you name. Plain-language findings with suggested fixes and an overall rating. Report addresses are never printed. Never sends email or contacts a mail server. | Passive DNS only (spaced, capped, 12 h reuse) |
| **account_recovery_guide** | `account_recovery_guide/account_recovery_guide.mjs` + `guides.json` | Printable recovery checklists for the organization's **own authorized people**: who should do it, proof to gather, what to do when a domain has expired, and what to lock down afterwards. Covers GoDaddy, Namecheap, Squarespace, Wix, WordPress.com, Google Workspace, Microsoft 365, Facebook Pages, Instagram and other registrars, linking only to official help sites. Helpers never file requests or log in for anyone. | None (offline) |
| **lookalike_domain_check** | `lookalike_domain_check/lookalike_domain_check.mjs` | Lists typo and lookalike versions of a domain (different ending, look-alike characters, missing/swapped/doubled letters, missing dot after www) and checks which are registered with one DNS question each. Optional registration dates for up to 5, marking any registered in the last 90 days. 25 per run (`--offset` for more), most commonly abused kinds first. Never visits them; says "registered", never "scam". The lookalike names are not scope targets, so `check` needs the scope's explicit `"allow_derived_lookalikes": true` (`list` works offline without it). | Passive DNS (+ optional RDAP), polite limits |
| **email_header_triage** | `email_header_triage/email_header_triage.mjs` | Offline look at a saved suspicious email (.eml): reply-to and display-name mismatches, failed sender checks (SPF/DKIM/DMARC), links whose text shows one site but go to another, encoded lookalike domains, lookalikes of the expected domain, and risky attachment types. Masks email addresses; never prints or saves the body; never opens links or attachments. | None (offline) |
| **sandbox_setup** | `sandbox_setup/sandbox_setup.mjs` | Writes Windows Sandbox configs in two modes. **inspect** (for `redirect_inspector`): networking on, firewall blocks all outbound except DNS to the sandbox resolver and web ports, every private/reserved address blocked. **tests** (for `run_offline`): networking off, no outbound allow rules, no writable folder shared with this computer. The toolbox is mapped read-only; the inside script verifies the lock before setting `GITBACK2LIFE_ISOLATED=<mode>`, and the tools re-check the real state. Never enables Windows features or starts anything. **Not yet exercised in a real sandbox.** | None (writes files only) |
| **notice_drafter** | `notice_drafter/notice_drafter.mjs` | Drafts one calm message from an evidence ledger for the organization, a directory maintainer, a registrar or a host. Confirmed facts with source and time; reports worded as reports; unknowns and possible explanations listed honestly; states what was not done; low-pressure ask. Removes contact details and secrets; refuses drafts with verdict words. Marked "DRAFT: not sent". **Never sends.** | None (offline) |
| **authority** | `authority/authority_cli.mjs`, `authority_core.mjs`, `install.ps1` | Protected approval authority (F01). The owner installs it once into an admin-only folder, then signs each incident's COMPLETE authorization with a passphrase-protected key (at an elevated console) and records protected stops. Once installed, every scoped command needs a valid signature, the latest serial (no rollback or replay) and no protected stop. Signed authorizations are stored only inside the protected folder (`authorizations\<incident>.json`); `init` is exclusive and all-or-nothing; PowerShell is pinned by absolute path with a constructed environment; anything other than a genuinely absent folder at the authority path is refused. Includes a tamper-detection baseline for the toolbox code. Not `human-only approval`: see TOOLKIT_RULES 1c-1 for what remains vulnerable under the same Windows account. **Not yet installed.** | None (offline) |
| **case_packet** | `case_packet/case_packet.mjs` | Bundles the decision summary, the evidence ledger and chosen evidence files into one zip (`case_packet/packets/`) with a README and a SHA-256 manifest, so the organization can check nothing changed. Text files are stored as masked copies and labelled MODIFIED EVIDENCE (the manifest lists each original_sha256). Refuses images that still carry hidden metadata (run `metadata_scrub` first) and stores the others strictly rebuilt (hidden chunks, segments and trailers cannot survive); the zip itself is re-parsed strictly and rebuilt when saved and any file containing secrets, email addresses or phone numbers. Also refuses links with credentials or secret-looking parameters, Markdown with HTML/images/non-web links and CSV with formula cells (rename such evidence to `.txt` to include it as inert text, same SHA-256), and will not build until a person confirms they checked for names, addresses and identifying images (`--reviewed-for-personal-info`). Never uploads or sends. | None (offline) |
| **directory_record_audit** | `directory_record_audit/directory_record_audit.mjs` | Offline data-quality check of a downloaded copy of a resource directory (a folder of JSON records or one JSON array): malformed phone numbers, broken or non-https web addresses, malformed emails, stale or unreadable "last checked" dates, missing required fields, and duplicate names/phones/websites. Masks phone numbers and emails by default. **Never calls, emails or visits anything** to verify a record. | None (offline) |
| **access_offboarding** | `access_offboarding/access_offboarding.py` | Register of which roles can get into which systems (owner, admin, editor, viewer, billing). The report flags owners/admins without two-step login, access nobody needs any more, overdue reviews, and the lockout risk of a system with only one admin (or none). `offboard --role` prints an ordered checklist for a departing role: hand over control first, then remove access, then update recovery details. Roles only; never names, passwords or contact details; history kept. `update` validates a change but **does not write** until approval enforcement exists (TOOLKIT_RULES 1e). | None (offline) |

## Shared support (not tools)

| Folder | Purpose |
|---|---|
| `_shared/common.mjs` | Labels, verdicts, page roles, secret redaction, write-only-inside-this-folder helper (Node tools; refuses writes through symlinks/junctions and checks the real folder). |
| `_shared/polite.mjs` | Polite limits for every network request: spacing, per-command caps, 12 h answer reuse (`_shared/.polite_cache/`; lookup results only when the scope allows saving), 24 h live-check cool-down, automatic removal of expired state, run report. `politeFetch` follows redirects by hand and checks every hop (address, no https→http downgrade, loops, robots.txt, budget); robots.txt is read the same way and fails closed. |
| `_shared/safe_http.mjs` | The toolkit's **only** HTTP transport: GET/HEAD only, URL checked before connecting, DNS answer pinned and checked for private addresses, connected address re-checked, no automatic redirects, size and time limits. |
| `_shared/output.mjs` | Output guard used by reports, summaries, drafts and packet summaries (stored files are masked separately and always, by `safeWrite`; code excerpts and opt-in `--show-*` flags are screen-only exceptions, TOOLKIT_RULES 6): masks secrets, emails and phone numbers, removes credentials and secret-looking URL parameters, escapes Markdown/HTML so evidence text cannot become links or HTML, and provides the human "before sharing" checklist. |
| `_shared/image_policy.mjs` | Strict PNG/JPEG parser that rebuilds images from their core parts only (V6-02): canonical pixel rows, unused palette and transparency entries cleared (V8-01), bounded decompression (V8-02); used by every image save. Python twin in `gb2l_core.py`. |
| `_shared/system_exec.mjs` / `_shared/acl_check.mjs` | The pinned system PowerShell with a constructed environment (V6-03), and the protected-authority permission rules (closed read-only rights list plus mask bits, V6-05). |
| `_shared/isolation.mjs` | Read-only check of the real system state (sandbox account, firewall profiles and rules, connected adapters) used before live inspection and project test runs; a typed setting alone never passes. |
| `_shared/scope.mjs` | Incident scope enforcement used by every online or saving tool: valid/open/unexpired scope, permitted action, listed target, allowed disclosures, persistence, and exact-target operator attestations (statements, not proof of a person). Python tools use the same rules via `gb2l_core.require_scope`. |
| `_shared/guards.mjs` | Shared URL/IP guards (private IPv4/IPv6 ranges, internal hostnames, schemes, credentials, ports), the per-hop redirect check, and the pinned DNS lookup. |
| `_shared/robots.mjs` | robots.txt reader and matcher (RFC 9309): which pages a site allows, Crawl-delay, missing vs unreachable rules, and the honest `gitback2life/1.0` user agent. |
| `_shared/toolkit_rules.test.mjs` | Fails if any tool reaches the network outside polite limits, requests web pages without checking robots.txt, has network code in Python/PowerShell, or installs a schedule. |
| `_shared/gb2l_core.py` | Safe path selection, size budgets, atomic writes inside this folder, shared report format (Python tools). |
| `_shared/*test*` | Offline tests for the shared helpers and all Python tools. |
| `TOOLKIT_RULES.md` / `CLAUDE.md` | The toolkit's rules, and the same rules for AI assistants working in this folder. |

## Examples included

- `incident_intake/examples/nyc-animal-rescue.scope.json`: scope for the NYC Animal Rescue directory weekly-check incident.
- `evidence_ledger/examples/nyc-animal-rescue.ledger.json`: starting ledger; everything still marked as reported or inferred.
- `incident_timeline/examples/website_redirect.json`: timeline for the same incident.

## Known limits

- **Live redirect inspection stays off.** This PC has no Docker/WSL sandbox, so there is no isolated, egress-limited place to run it yet.
- **GitHub Actions logs** need a read-only token, even for public repositories. Run/job/step summaries work without one.
- **Project tests** in `regression_harness` need the project's dependencies installed first, which uses the network and needs its own approval.
- Static scanners find leads, not proof. A missing result from any look-up is not evidence either way.
