# 911 GitBack2Life Toolbox — exactly 13 user-facing tools

Start by double-clicking `TOOLBOX.cmd` in the independently staged project on Windows. It opens a simple **mouse-and-number-key interface** showing exactly 13 numbered tool tiles, then the original actions. Press 1-9 for the first nine tools, or 0 then 1-4 for tools 10-13. Inside a tool select the action by mouse or number key; its existing guided operation opens in a separate window. No new tools were added. Node.js 22+ and Python 3.10+ are required for the existing operations; Windows PowerShell 5.1 provides the desktop interface. The first-time source staging launcher is `STAGE_TO_APPROVED_TEMP.cmd` in the delivery ZIP; it stages a separate verified copy in the existing Desktop `911_gitback2life\Temp` folder when present, or otherwise in the current user's `LocalApplicationData\GitBack2Life\Temp`. It does not assume any username or drive letter and never overwrites an existing build.

| No. | Tool | Original approved components retained |
|---|---|---|
| 1 | Incident Management | incident_intake, incident_timeline |
| 2 | Evidence Collection | github_evidence, evidence_ledger |
| 3 | Reports & Evidence Packages | decision_summary, notice_drafter, case_packet |
| 4 | Domain Health | domain_research, domain_watch |
| 5 | Website Redirect & Authenticity | redirect_inspector, lookalike_domain_check |
| 6 | Email Security | email_spoof_check, email_header_triage |
| 7 | Account Recovery & Access | account_recovery_guide, access_offboarding |
| 8 | Organization Registers | org_registers |
| 9 | Directory Audit | directory_record_audit |
| 10 | Website Code Analysis | fetcher_review, code_flow_scan |
| 11 | Dependency Analysis | dependency_inventory |
| 12 | File Protection | safe_backup, metadata_scrub |
| 13 | Computer Security Check | device_check |

**Three internal components**, not separate tools: `sandbox_setup` (required sandbox plumbing); `regression_harness` (offline regression tests); `authority` (owner-managed protected authorization). These modules remain intact. The original 26-entry `MASTER_TOOL_LIST.md` is preserved because it is the authoritative scope and source-module inventory, not the size of the operator menu.

## Safe operating defaults

- Start with Incident Management to create a case before collecting evidence. It initializes an offline local scope; it **does not** authorize outside lookup automatically.
- Public GitHub evidence, domain registration/DNS, lookalike checks, and email DNS checks require a case scope permitting that specific service and target, **plus a typed `LOOKUP` confirmation**. Existing network guards, robots checks and request limits remain enforced. No automatic online searches are performed.
- Live redirect inspection is disabled outside an independently verified inspect-mode Windows Sandbox and an exact-URL operator attestation. A check-url preflight is offline and is not proof a URL is safe.
- Backup copies and cleaned images are new local copies only; restoration and register updates are review requests, **not executed repairs**. No protected authority installation or activation is part of this release.
- Original incident revisions and files are never overwritten by a menu restructure. Do not delete any earlier project folders.
- Each Windows launcher session automatically creates one support ZIP in Downloads containing diagnostic logs but not case records, credentials or evidence content.

## Verification and release limits

The new 13-tool menu and its underlying source can be tested offline without an owner account. Source-code integrity and scripted workflows are verified in this delivery. Native Windows staging/launcher checks cannot be claimed to pass until the included one-click Windows acceptance runs on the owner's computer. The status of the **protected production authority remains inactive**; activating it would require explicit owner authorization, not a toolbox-menu action.

For advanced use, the original specialist modules and CLI subcommands remain available as implementation details for compatibility. They are **not extra menu tools**.


## Helping other organizations — client report workflow

Tool 13 is **client-first**. The operator can share the standalone
`device_check/CLIENT_DEVICE_COLLECTOR.zip` with a consenting Windows user.
After extracting it, they double-click `CLIENT_DEVICE_CHECK.cmd`, review its consent notice, and
receive one privacy-minimal security status ZIP in **their** Downloads folder.
The operator reviews that provided ZIP with **13 > 1 — Review a client security
report ZIP**, or runs a self-check with **13 > 2 — Check this computer**.
No remote control, device logins or unattended connections were introduced.
Client-provided findings are not independently authenticated. Network-based
website/domain/email tools use their existing external-target scope checks;
local file-analysis tools require an organization-provided copy/export.

### Tool 4 reliability note

A failed remote RDAP/CT/archive robots.txt fetch is **unverified**, not an explicit provider opt-out. A DNS `ECONNREFUSED`, `ETIMEOUT` or `EAI_AGAIN` is a resolver/connectivity failure, not proof of an absent DNS record. Tool 4 preserves verified findings, labels incomplete checks, and makes nonzero incomplete status visible through the Toolbox (including its original error text). When selecting DNS or all public records, the operator can explicitly choose the existing system resolver or one of the existing DoH methods; DoH requires scope disclosure for the `doh` service and is never a silent fallback. Do not infer that a remote site's domain is compromised based on a blocked execution environment.

### Reliability policy across all 13 tools

This is a shared behavior rule, not a new tool, menu or permission. For **every** existing workflow, failed execution, missing client-provided evidence or an unavailable data source is **not a finding** about the person being helped. The Toolbox retains completed results in its action output, distinguishes an incomplete check from a verified negative result, and records actionable errors in its existing local support logs. A live scope refusal or request-limit stop stays enforced.

The tools that actually use external lookups apply this rule to DNS/email protection, registration monitoring, typo-domain checks, GitHub log retrieval and redirect inspection, alongside Domain Research. Local-only tools (incident/evidence/report management, imported email headers, account recovery guides, registers, directories, code, dependencies, backups, metadata and client ZIP analysis) keep their offline behavior: they **never** invent external verification or silently fetch a client's data. They report errors or unknowns when supplied evidence is absent/incomplete. No automatic resolver fallback, broader target permissions, extra remote-control capability or production writes were added.

## Owner-approved addition: Email Communications

The owner separately authorized a dedicated Email Communications tool after the thirteen-tool consolidation. It is an additional top-level capability. Gmail sending is disabled until a protected backend is configured and the owner explicitly authorizes a controlled test. See `email_communications/README.md`.
