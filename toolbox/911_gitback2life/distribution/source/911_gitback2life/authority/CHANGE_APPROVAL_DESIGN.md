# Change approvals through the protected authority: design, revision 3

Status: **DESIGN ONLY. Nothing here is implemented.** Register `update` writes stay disabled. No real key, no
passphrase, no installation, nothing elevated, no repair.

| Revision | SHA-256 | Review | Decision |
|---|---|---|---|
| 1 | `c8d2036b…4659` | Codex, 2026-10-14 | REVISE (CA-01 to CA-07) |
| 2 | `10c41b11…7eb6` | Codex, 2026-10-17 | REVISE (R2-01 to R2-06, plus four consistency items) |
| 3 | `96efccc4…42df` | independent review, 2026-10-18 | Targeted revision: 4 issues plus one clarification |
| 3.1 | `daa32187…213d` | accepted for G0a, 2026-10-18, with 3 implementation conditions | |
| 3.2 | `fbd135c7…2ec4` | G0a v11 review, 2026-10-18 | Targeted corrections G0a-F1 and G0a-F2, plus document cleanup |
| 3.3 | `a5da0d2d…806c` | v12 review, 2026-10-18 | 2 targeted M1 corrections (M1-F1, M1-F2), then M2 |
| 3.4 | `3fe3edc5…7cf4` | v13 review, 2026-10-18 | M2-F1, then M3 in one v14 batch |
| 3.5 | (v14) | v14 review, 2026-10-18 | installer gap confirmed; missing-ledger creation found |
| **3.6** | this document | pending | **Implementation note only (missing ledger).** §1f; the architecture is unchanged. |

This revision answers R2-01 to R2-06 and the four consistency items (§1). It replaces the lock (§5), the launch path
(§14.1), recovery authorization (§9 and §12), decision documents (§8), the cancellation and evidence rules (§12),
and the durability claims (§4 and §15). It adds deterministic traces (§19). Two facts used below were **measured** on
this machine, non-elevated, on synthetic files; they are not assumptions:
- **Directory flush.** `fsync` of a directory handle fails with `EPERM` under Node 24.21.0.
- **Exclusive lock.** Opening a file with libuv's Windows exclusive-share flag (`0x10000000`) makes every other
  open, rename and delete fail with `EBUSY`, until the holder closes it or is killed. A killed child's lock was
  released by the OS.

Contents:
1. Response to the revision 2 review
2. Architecture and actors
3. Protected storage, confidentiality and cleanup
4. The ledger: format, durability contract, epochs
5. The lock (R2-01)
6. Request ingestion over a pipe
7. Operation matrix
8. Signed documents and their lifecycles (R2-04)
9. States, authorization basis and the transition table (R2-03, R2-05)
10. Approve
11. Apply: the mutation boundary
12. Recovery, cancellation and evidence (R2-03, R2-05)
13. The review display
14. Trusted launch, migration, target identity (R2-02)
15. Guarantees: under the flush contract, and when it fails (R2-06)
16. What a signature proves
17. Remaining trust assumptions
18. Owner procedures, for acceptance
19. Deterministic traces
20. Proposed tests
21. Milestones and gates

---

## 1. Response to the revision 2 review

**A correction to my own summary of revision 2.** Losing a completion record does **not** mean the action never
happened. The action may have happened, and then needs recovery by hashing. Only the loss of a *permitting* record
is ruled out, and only under the flush contract (§4). Even then, hashing cannot reveal every case of lost history
(§15).

| Item | Response | Where |
|---|---|---|
| **R2-01** Takeover not bound to the inspected lock | **Stale-file takeover is removed entirely.** The lock is an **OS-held exclusive open handle**, measured above: no other process can open, rename or delete it while it is held, and the OS releases it when the holder exits or is killed. There is no takeover step, so the counterexample's interleaving cannot happen. Release means closing *our* handle; the file is never deleted or renamed. The lock file grants the normal account no access, so it cannot be held to block the authority. The flag is a libuv detail not exported by Node, so the design pins the Node version and adds a **startup self-test** that refuses to run if exclusivity does not hold. | §5 |
| **R2-02** Startup checks run after attacker-controlled startup | **A trusted launch boundary in front of Node.** The owner runs `C:\Windows\System32\cmd.exe /d /s /c ""<authority>\authority.cmd" <command>"` (the `/s` form is from [3.1]). `/d` skips per-user AutoRun. The script **clears the entire environment**, sets a fixed one, sets the working folder, and starts the pinned `node.exe` with **fixed** flags (`--no-addons --no-global-search-paths`) and a **built-ins-only bootstrap**. The bootstrap verifies the ACLs and hashes of every protected module, **then** loads them dynamically. Nothing user-controlled reaches Node's startup. The PowerShell helper is started by the bootstrap with a constructed environment, so no CLR profiler variables reach it. The residual pre-launch surface (`cmd.exe` itself, per-user compatibility settings, and per-user .NET configuration for the helper) is stated as assumption A3, with an owner-run check at gate G2. | §14.1, §17 |
| **R2-03** Resumed recovery skips later stops | **Every mutation step re-evaluates authorization.** Each recovery segment stores its **authorization basis**: the ledger sequence number of the newest authorization event (stop, deny, revoke, new scope) that the segment was authorized against. Before **every** target write, cancellation step included, the authority recomputes the newest event. If anything is newer than the basis, it stops writing and records `needs_decision`. A persisted direction never substitutes for current authorization. T12 now includes `deny`. `revoke-change` on a consuming or recovering transaction is defined: it is an authorization event that blocks further writes. | §9, §12 |
| **R2-04** Decisions and `adopt` not bound or single-use | **Each decision and `adopt` is now fully bound and has its own ledger lifecycle**: `issued`, then `consumed`, or a final `expired` / `superseded`. Recovery decisions bind the key epoch, the authority epoch, the transaction's consumption sequence number, the recovery revision, the observed state (hash, file ID, tree membership), and the **exact set of authorization events** they override. `adopt` binds the incident and scope serial, the target generation, the quarantine event it resolves, and the observed state, and it cannot touch an unquarantined target. Consumption is recorded and flushed before acting. **The signed document is embedded in its `issued` ledger record,** so a failure to publish the signature file cannot strand or fake a decision. | §8, §9 |
| **R2-05** Cancellation, conflict and cleanup incomplete | **Ownership evidence is recorded and flushed before every destructive or publishing step.** Before a rename publishes anything, the ledger records the file or folder ID of the temporary item. Cancellation progress is explicit, and a cancellation folder holding a **subset** of the listed files counts as progress; any **unlisted** entry, or a listed file with the wrong hash, is a conflict. Evidence (staging, journal, the torn ledger tail) is kept for every `conflict`, `uncertain` or quarantined outcome until explicit resolution. A transaction is resolved only when **every** member is resolved; new transactions stay blocked until then. | §9, §12, §3 |
| **R2-06** Ledger claims exceed the evidence | **Claims are separated and narrowed.** §15 now distinguishes what holds under the flush contract from what does not. It states plainly that **a lost valid prefix of the ledger is undetectable by the ledger itself**, and that hashing cannot reveal a spent approval whose targets match their old bytes. The protocol adds: **authority epochs**; **session records** that show a boot happened during an open session (and trigger the conservative procedure); torn-tail preservation; a bound on record length before allocation; rules for an interrupted ledger creation or migration; and an owner **new-epoch procedure** that voids every earlier unspent approval and decision. That procedure is required after a suspected storage failure **and after any backup restore**. An optional external anchor (the owner records the ledger head) is described; stronger tooling (a hardware counter) is deferred. | §4, §15, §18 |
| C-1 Pre-commit readability | **Claim narrowed, and readers hardened.** Temporary files in user-readable data folders may be readable before commit. Their bytes are the requester's own submission, or the protected prior plus the requester's record, which the normal account already knew. Readers ignore temporary names and trust only content whose hash the ledger has committed. | §3, §11 |
| C-2 `diagnose` is not read-only | **Split.** `diagnose` performs **no filesystem writes at all**: no snapshot rebuild, no cleanup, no ledger append, no lock. Maintenance and `needs_decision` records happen only inside mutating commands. | §12 |
| C-3 M0 proof versus privilege | **Split.** Gate **G0a** covers non-elevated, synthetic protocol and lock tests (allowed now). Gate **G0b** is the elevated server and medium-integrity client boundary demonstration, which is **owner-run and separately authorized**. The pipe channel now specifies local-only access, bounds checked before allocation, the impersonation lifetime, and how EOF is checked. | §6, §21 |
| C-4 Renderer test wording | **The contract is split.** Trusted formatting (ASCII plus two fixed glyphs, `│` and `↪`, and newlines) is specified separately from untrusted text, which after escaping is printable ASCII only. Continuation lines count against the limit. UTF-8 decoding is strict, so invalid sequences are refused; LF is the only line break, and CR is escaped. | §13 |

---

## 1a. Amendment 3.1: response to the revision 3 review

This is a focused amendment, not a redesign. Every revision 3 safeguard is kept. The edits are marked
**[3.1]** where they appear in the sections below.

| Issue | Resolution | Sections changed |
|---|---|---|
| **1. The ledger is verified before anything is appended** | Every command now starts in a fixed order:<br>1. acquire the lock and run its self-test;<br>2. **verify the whole ledger, read-only** (length bound, checksums, chain, sequence);<br>3. classify the result;<br>4. a corrupt ledger means **no append at all**, and only `diagnose` runs;<br>5. a torn final record is preserved and truncated (the only permitted write before `session_start`), then the ledger is **verified again**;<br>6. check for an unclosed session from another boot;<br>7. only then append `session_start`, at the verified end offset.<br>No record is ever written after an unverified prefix. | §4, §10, §11, §12.1 |
| **2. Reconciliation after a new epoch, when the incident cannot authorize** | A new document kind, **`reconcile`**, is signed, single-use and bound to the epoch or quarantine event it resolves. It is used for targets quarantined by `new-epoch`, and for any quarantined target whose incident is stopped, denied or expired, or has no current scope (so `adopt` cannot be used). It writes **no** target bytes, grants no permission, and revives no approval or decision. It only records the observed actual state as the new baseline, with the generation raised by 1. Any later change still needs a fresh approval under a currently valid scope. A transaction pending at epoch time becomes `void_by_epoch`, and its members are resolved the same way. | §8, §9 (T18, new T19), §18, §20 |
| **3. Crash window between `decision_consumed` and `recovery_segment_start`** | **The two records are merged into one.** `L:decision_consumed {segment: direction, basis_seq}` both spends the decision and starts its segment, so there is no state in which the decision is spent but no segment exists. After a crash, the segment is resumed through T13, with its `basis_seq` re-checked, and the decision is never replayed. Automatic segments (T9) were already a single record. Adopt and reconcile consumption are single records that also apply their effect. | §8, §9 (T10, T11), §12.5 |
| **4. `findstr` does not support `{1,64}`** | **`findstr` is removed from the launcher.** Besides lacking counted repetition, its `[a-z]` ranges follow collation order and can match other characters. The launcher validates with plain `cmd` only, with **no pipe**, so no argument is ever re-parsed by a child `cmd`:<br>- at most 2 arguments, each non-empty;<br>- length ≤ 64, checked by substring;<br>- the allowed characters are stripped one by one using delayed expansion, after assignment with delayed expansion **off**; anything left over means refusal.<br>The bootstrap then re-validates exactly against `^[a-z0-9-]{1,64}$`, so the `cmd` check is defence in depth, not the authority's only check.<br>**Measured on this machine** (non-elevated, throwaway copy of the validation logic):<br>- `approve-change` and a 64-character argument pass;<br>- 65 characters, `a&b`, `a\|b`, `a b`, `a%b`, `a!b`, `a^b`, `a(b)`, `a<b`, `é`, an empty argument and 3 arguments are all refused;<br>- `ABC` passes the `cmd` stage, as designed, and is refused by the bootstrap's exact check.<br>The launch command also gains `/s` and outer quotes, for predictable quote handling. | §14.1 |
| **Clarification: the lock delays a stop** | `stop`, like every mutating command, takes the same exclusive lock. **It cannot be recorded while another command holds the lock.** It waits up to 10 seconds, then reports "busy" and must be re-run. The longest hold is an interactive `approve-change` review, or a multi-target apply. A stop takes effect when it is **recorded**, and is seen at the next mutation boundary of any later command. It is **not** an interruption of the command currently running. To make an urgent stop take effect sooner, cancel the running review (Ctrl+C, which releases the lock) and run `stop`. | §5, §15, §18 |

New tests are listed in §20 group I.

## 1b. Amendment 3.2: G0a implementation notes

These are not architecture changes. Each edit is marked **[3.2]** where it appears.

| Item | Change | Sections | Evidence |
|---|---|---|---|
| **Condition 1:** omit an absent optional argument | The launcher forwards a second argument only if one was given. An absent one is **omitted**, never passed as `""`. An explicitly empty argument (`""`) is refused. | §14.1 | G0a launcher test C (one argument stays one argument); I-21 (`ok ""` refused) |
| **Condition 2:** correct current basis, including an empty `overrides` | A consumed recovery decision's segment records `basis_seq = latest_auth_event(incident)`, **as read under the lock at consumption**. The decision is usable only if its `overrides` equals exactly the authorization events after `tx_seq`. When `overrides` is empty, no such event exists, and `basis_seq` is still the current value, not an undefined "override ceiling". Consumption and segment start remain **one** durable record. | §9 T10 and T11, §19 trace 1 | **[3.3] Implemented and tested synthetically in M1 (v12):** `authority/m1/engine.mjs`; `authority/m1/m1.test.mjs` ("Condition 2" tests and I-20). |
| **Condition 3:** `reconcile` for an expired or missing scope binds verifiable policy state | A stop or deny is bound by its real ledger **event** sequence number. An **expired** scope is bound by `{scope_serial, scope_expires_at}` of the committed scope; at consumption, that serial must still be the incident's latest committed serial, and the clock must be at or after `scope_expires_at`. A **missing** scope is bound by `{latest_scope_serial: null}`; at consumption, the incident must still have no committed scope. No nonexistent event sequence is referenced. | §8 (`reconcile` row, rule 7), §20 test 19 | **[3.3] Implemented and tested synthetically in M1 (v12):** `authority/m1/engine.mjs` `reconcile`; `authority/m1/m1.test.mjs` ("Condition 3" test). |
| **Launcher correction A:** clearing the environment must not start a child `cmd` | `for /f ... in ('set')` runs `set` in a **child** `cmd`, which honours the per-user AutoRun registry value even though the outer `cmd` was started with `/d`. That would let a user-writable registry value run code inside the elevated launch. The launcher instead redirects `set` into a file in its own (protected) folder and reads it with the **file** form of `for /f`, which starts no process. | §14.1 | G0a launcher tests: Node receives exactly the fixed environment. The AutoRun behaviour itself was not exercised: setting a per-user registry value would change the owner's machine. Listed for owner gate G2. |
| **Launcher correction B:** the launcher's own variables must not reach Node | The prototype's first run was refused by the bootstrap: the variable `A1` had leaked into Node's environment. The validated values are now expanded into the launch line, and the variables are cleared on that same line. | §14.1 | G0a launcher test C: the bootstrap's exact-environment check passes |

---

## 1c. Amendment 3.3: G0a corrections and M1 notes

| Item | Change | Evidence (synthetic, non-elevated, this machine) |
|---|---|---|
| **G0a-F1** Shared pre-bootstrap environment file | The launcher now uses a **per-launch scratch folder**, created exclusively with `mkdir`, under the authority folder. It **proves** the clearing by a second dump requiring exactly 7 names, removes the folder and confirms it is gone, and fails closed on every creation, write, read, verify and cleanup step: Node is never started on failure. | `authority/g0a/launcher.test.mjs`: 8 rounds of 2 concurrent launches with different hostile `NODE_OPTIONS` canaries (each with a positive control). No canary ran, and at least 8 of the 16 launches had to pass the bootstrap's exact-environment check for the test to pass. Every scratch folder was removed. An injected scratch-creation failure meant Node never started. |
| **G0a-F2** Short staging writes | `request_pipe.mjs` loops until each piece is fully written; a write that makes no progress refuses the request and removes the incoming staging. | `authority/g0a/frame.test.mjs`: complete bytes despite 7-byte writes; a 0-byte write refused, with staging removed |
| §12.6 | Resolution by `adopt` **or `reconcile`** | Document |
| §1b labels | "Implemented and tested in M1" was a forward-looking statement in revision 3.2. It now names the actual v12 code and tests. | Document |
| **M1 finding: decision direction** | A decision's `complete` or `cancel` must map **explicitly** to the segment direction `forward` or `back`. The first M1 build stored the decision word directly, which (a) left a crashed transaction in a status that was not recognized as pending, and (b) would have run `complete` as a rollback. The engine now maps the two words and refuses anything else. | `authority/m1/m1.test.mjs`: I-20 (which found it); "complete runs forward"; an unknown direction is refused without being consumed |

## 1d. Amendment 3.4: M1 corrections and M2 notes

| Item | Change | Evidence (synthetic, non-elevated) |
|---|---|---|
| **M1-F1** Recovery accepted the prior bytes with an unknown file identity | A target is "at prior" only if its bytes **and** its identity match a durable record: the approval's `prior_file_id`, or a cancel-restoration temporary file recorded by `temp_ready{purpose: cancel}`. It is "at proposed" only with the identity recorded by `temp_ready{purpose: forward}`. This applies in classification, the forward skip, the pre-rename re-check, and cancellation. Matching bytes with an unknown identity is a conflict (fail closed; the target is quarantined and nothing is overwritten). (§§9, 11, 12, 14.3) | `authority/m1/m1.test.mjs` "M1-F1": the review's reproduction (same bytes, id 9999) gives a conflict with the substituted file untouched; a valid cancellation that restored the prior under a new recorded id still recovers |
| **M1-F2** `apply` did not enforce the global unresolved-transaction block | `apply` checks the same global `unresolved` predicate as approve-commit **before** consuming anything: any pending transaction, or any target quarantined by a conflict, an uncertain outcome or a new epoch, refuses every new `apply`. `adopt` and `reconcile` remain the resolution path. (§9) | `m1.test.mjs` "M1-F2": a pre-issued unrelated approval is refused (not consumed, target untouched) while a conflict is quarantined, and applies after the member is adopted |
| Two M1 test expectations | They now reflect the stricter rules, and neither is loosened. The epoch test's voided approval is refused first by the global block, and asserted as `void_by_epoch` once the targets are reconciled. The decision-binding test's same-bytes, new-identity file is a conflict, with the decision not consumed. | `m1.test.mjs` |
| **M2** Register rules inside the authority | `authority/m2/register_rules.mjs` ports the toolbox's register validators and `register_update`. The authority computes `register.replace` as `registerUpdate(prior, record)` (§7). | `authority/m2/m2.test.mjs` "F": accept or refuse, and the resulting records, agree with the Python originals on 24 fixtures |
| **M2** Review renderer | `authority/m2/renderer.mjs` implements §13: escaping to printable ASCII, tagged fences, a gutter, wrapping at 160 with counted continuations, refusal above 2,000 lines, strict UTF-8, and trusted text restricted to printable ASCII. Tests use harmless non-printing characters only (tab, CR, NUL, other C0 controls, DEL, Unicode format marks), per the owner's decision. | `m2.test.mjs` "G" |
| **M2** approve-change command | `authority/m2/commands.mjs`: request parsing from ingested entries; the proposed register computed and validated inside the authority; masked-storage content refused rather than transformed; staging; the review; a confirmation code shown **after** the review; signing (an injected signer); the M1 commit with every check re-run; optional `--apply`. Staging is removed on every refusal. | `m2.test.mjs` "E2E": replace and create end to end through the G0a frame reader; a wrong code means nothing signed; refusals happen before signing or staging; a signature from another key is refused at commit |
| **Remaining prototype differences** (M3/M4) | Signing with the passphrase-protected key at an elevated console; ingestion over the real pipe server; the protected copy of the masked-storage check; restore trees; the installer. | Pending |

## 1e. Amendment 3.5: M2-F1 and M3 implementation notes

| Item | Change | Evidence (synthetic, non-elevated) |
|---|---|---|
| **M2-F1** An approval could be issued after a same-content file replacement | At issuance (T1), **inside the M1 engine** (`checkIssuable`), the target on disk must match the ledger in bytes **and** file identity; an absent target must still be absent. The command layer also checks before computing, and re-checks after the review and immediately before signing. (§10 step 7) | `authority/m2/m2.test.mjs` "M2-F1": the review's reproduction (same bytes, id 9999) is refused, with no approval issued and no target change; a correctly signed approval is refused at the M1 boundary for the identity alone; the normal control and create-when-absent are issued. Real files: `authority/m3/m3.test.mjs` (a new OS file id with the same bytes is refused). |
| **M3** Restore trees in the existing state machine | `restore.stage` targets `restores/<approval_id>`, a tree state (tree hash of its members, folder id). **Ownership:** the folder id is recorded (`temp_ready`) before files are written. The manifest is written last, membership is verified, and the tree is **published by one folder rename**. **Cancellation:** rename aside, then delete only listed files at their signed hash; missing files are progress; an unlisted entry or a wrong hash is a conflict (evidence kept). Pre-recovery classification covers trees. Permission: `stage_restore`; `adopt` and `reconcile` use it for trees. (§§7, 9, 11, 12) | `m3.test.mjs`: publication; unsafe membership, paths, binary, sizes and masked content refused; recovery forward after each step; resumed partial cancellation; conflict on an unlisted entry plus the global block; the permission check |
| **M3** Real-filesystem backend | The same disk interface backed by real files: an append-only flushed ledger file; OS file and folder ids; link, junction, hard-link and non-regular refusal; durable staging, journal and evidence. Optional engine hooks (`writeTemp`, `mkdir`, `renameDir`) let the OS assign identities. Simulated-disk behaviour is unchanged. | `m3.test.mjs` (temporary folders only): register replace plus a restore tree end to end, with a crash and recovery by a fresh process from the files alone; hard-link refusal |
| **M3** Signer, exporter, command entry | The signer reads the existing protected key format (the passphrase is read at signing, once; fingerprint and signature self-checked). The exporter covers the toolbox side with normal privileges (request folder, local pipe). The command entry has safe arguments and a read-only `diagnose`; production wiring refuses outside an installed folder. | `m3.test.mjs` |
| **Fixed while building M3** | After publication, a tree's final verification used a copy of the approval's state taken before its ownership record was appended, so it refused its own correct output. It now re-reads the current state. | `m3.test.mjs` (the publication test found it) |
| **Installer: NOT AUTHORED** | An attempt to write the new installer script in this batch was stopped by a safety check and was not retried. The existing reviewed `authority/install.ps1` (unchanged since v7) does not cover the M3 layout. **An installer for the M3 layout is an open item before M4.** | Pending |

## 1f. Amendment 3.6: missing ledger, installer status

| Item | Change | Evidence (synthetic, non-elevated) |
|---|---|---|
| **v14 review: opening a missing ledger silently created an empty one** | `FileLedgerStore` now only opens an existing regular, single-name ledger file. A missing ledger is refused as lost history (§§4, 14.2) and is not re-created. A new ledger comes only from `FileLedgerStore.createNew()`, the explicit first-time initialization path. That path is collision-safe and is refused if the ledger folder holds anything besides `authority.lock`, or if `staging`, `journal`, `evidence`, `data/registers` or `data/restores` already hold state. | `authority/m3/m3.test.mjs` "a missing ledger is refused on open" (temporary folders) |
| **Installer for the M3 layout: still NOT AUTHORED** | The v15 work order asked again for the installer source (one-click CMD, orchestration, manifest pinning, ACLs, preflight, backup, rollback, diagnostics ZIP). That content was stopped by a safety check in v14, with an instruction not to produce it again in any form, so it was not attempted. The work order's fallback was followed instead. The older `authority/install.ps1` (v7) is **not sufficient for M3 and must not be run.** | Pending; blocker documented in `authority/m3/OWNER_CHECKLIST.md` |
| Production wiring | Unchanged: `createProductionDeps` still refuses unconditionally, and register `update` writes remain disabled (M4). | `m3.test.mjs` |

---

## 2. Architecture and actors

This section is unchanged from revision 2, except that the launch path is now specified (§14.1). Every approved
mutation is performed by the protected authority, in an elevated session the owner starts, and only inside
admin-only storage. Tools only build and export requests.

| Actor | Runs as | Can do | Cannot do |
|---|---|---|---|
| Request builders and the exporter | normal account | Build requests; stream the request bytes into the pipe; read **committed** protected data | Write protected storage; read staging, journal or the key; sign |
| AI assistant | normal account, never elevated | Prepare requests; run synthetic tests | Launch any authority command; know the passphrase |
| `authority.cmd approve-change` | elevated, interactive | Ingest, validate, display, sign, record `issued` | Mutate targets |
| `authority.cmd apply` | elevated | Verify, consume, write, complete | Sign |
| `authority.cmd recover` | elevated (passphrase for decisions) | Complete, cancel or reconcile under §12 | Start new changes |
| `authority.cmd diagnose` | elevated or not | Read and report only (§12) | Write anything |
| Any Administrator-level process | elevated | Everything | n/a (assumption A1) |

---

## 3. Protected storage, confidentiality and cleanup

All of this lives under `C:\ProgramData\gitback2life-authority\`:

| Path | Normal account | Notes |
|---|---|---|
| `authority.cmd`, `bootstrap.mjs`, the protected modules, `authority_pipe.ps1`, `installed_manifest.json` | read | The launch boundary and code (§14.1) |
| `ledger\ledger.log` | read | The source of truth (§4) |
| `ledger\authority.lock` | **no access** | Explicit ACL with no Users entry, so a normal process cannot open or hold it (§5) |
| `ledger\evidence\` | **no access** | Preserved torn tails and diagnostics |
| `state.json` | read | Snapshot only; never trusted over the ledger |
| `data\registers\{services,personal_data,access}.json` | read | Committed registers |
| `data\restores\<approval_id>\` | read | Published restore trees, each with its manifest |
| `staging\`, `journal\` | **no access** | Received bytes, canonical proposed content, prior copies |
| `private_key.enc.json` | **no access** | Changed from today, where Users can read it |

**Confidentiality (C-1, narrowed).**
- Staging and the journal are never readable by the normal account.
- A **temporary** file or folder created under `data\` during apply (§11) inherits that folder's read-only access,
  so it **may be readable before commit**.
- Its bytes are the requester's own submitted content, or the protected prior plus the requester's record, which
  the normal account already had. This design therefore does **not** claim that proposed bytes are unknown to
  normal-account processes.
- Toolbox readers ignore names beginning with `.` and trust only content whose hash the ledger has committed.

**Cleanup.** Cleanup runs only inside mutating commands, after recovery checks, never in `diagnose`.
- **Removed:** staging and journal content for **clean** final outcomes (`applied`, `cancelled`, `expired`,
  `revoked`, `refused_after_stop`, and `void_by_epoch` once no evidence need remains).
- **Never removed automatically:** the evidence of a `conflict`, an `uncertain` outcome, a quarantined target, or a
  preserved torn tail. It stays until the owner records an explicit resolution and retention decision (§12.6).
- Unknown files are reported, never deleted.

---

## 4. The ledger: format, durability contract, epochs

**Record format.**
```
LEN(4, big-endian, ≤ 1,048,576, checked BEFORE allocating) | SEQ(8) | PREV_SHA256(32) | BODY (canonical JSON) | SHA256(LEN..BODY)(32)
```

**The flush contract (assumption A5).**
- A `FlushFileBuffers` that has returned success means the flushed data **and that file's metadata (its existence
  and size)** are durable.
- Storage never later damages data it has acknowledged as flushed.

Nothing relies on rename or directory durability. Directory flush is unavailable (measured), and `MoveFileEx`
without write-through is not promised durable on return.

**Write-ahead rule.**
- A record that **permits** an action is appended and flushed before the action.
- A record that **reports** an action is appended only after the action has been verified on disk.
- Under the contract, a lost record can only be a report, so recovery re-derives the outcome by hashing.

**Reading the ledger.** The ledger is verified in order, record by record.

| Found | Interpretation under the contract | Action |
|---|---|---|
| A final record that is short, or has a bad checksum | An interrupted append. Under A5, previously flushed records cannot be damaged later, so only the last, unflushed append can be torn. | Copy the torn bytes to `ledger\evidence\torn-<seq>-<time>.bin` and flush; then truncate; then append `L:torn_tail_preserved`. Done only by a mutating command. |
| A bad record anywhere else, a broken chain, or a sequence gap | Impossible under A5 | **Corrupt ledger:** only `diagnose` runs. Owner procedure (§18). |
| `ledger.log` missing, with `ledger.log.new` present | An interrupted creation (§14.2) | Redo the creation. No approval can exist yet, because issuing one needs a ledger. |
| `ledger.log` missing, and the installed manifest records that a ledger was created | The ledger was lost | **Corrupt:** owner procedure |

**Startup order [3.1], identical for every mutating command:**
1. Take the lock and run its self-test (§5).
2. **Verify the whole ledger without writing.** Check that `LEN` ≤ 1 MiB before allocating, then the checksums, the
   chain and the sequence.
3. Classify the result as intact, torn tail, missing/interrupted creation, or corrupt.
4. **Corrupt:** append nothing, and stop. Only `diagnose` is available.
5. **Torn tail:** preserve and truncate it (the only write allowed before step 7), append `L:torn_tail_preserved`,
   then **re-verify the whole ledger**. It must now be intact.
6. **Interrupted creation:** redo the creation (§14.2) and re-verify.
7. Check for an unclosed session from another boot (below). Then append `L:session_start` at the **verified end
   offset**: the file is admin-only and the lock is held, so the end cannot move between verification and the append.

**Sessions (R2-06).**
- Every mutating command appends `L:session_start {boot_session_id, command}` after the startup order above, and
  `L:session_end` before releasing the lock.
- An unclosed session whose recorded boot session differs from the current one means the machine restarted
  mid-command. **Power loss or an OS crash is then possible, and assumption A5 may not have held.** Every mutating
  command then refuses, except `recover --new-epoch` (§18).
- An unclosed session from the **same** boot means a process crash: ordinary recovery (§12).

**Epochs.**
- Every signed document binds an `authority_epoch`, which starts at 1.
- A signed `new-epoch` record (§8) voids **every** unspent approval and decision from earlier epochs, and requires
  every target to be reconciled.

**Durability of required file names.**
- Under A5, a flushed staged, journal or temporary file exists after a crash.
- If a required file is missing anyway, the contract failed. The outcome is never "proceed": a missing staged file
  makes the approval unusable (it will expire), and a missing journal makes rollback impossible (`conflict`).

---

## 5. The lock (R2-01)

**Mechanism.** `ledger\authority.lock` is opened with `O_RDWR | O_CREAT | 0x10000000` (libuv `UV_FS_O_EXLOCK`:
Windows share mode 0). While the handle is open, every other open, rename or delete of the file fails (measured:
`EBUSY`). The lock is held for the whole command and released by **closing the handle**; on process exit or kill the
OS closes it (measured). The file itself is created once at installation and **never deleted or renamed**.

**Properties.**
- **One holder.** The OS refuses a second open, so there is no inspection step, no takeover, and no window between
  checking and claiming. Any number of contenders: exactly one opens it.
- **Release cannot affect another holder.** Closing a handle releases only that handle. No path operation touches
  the lock file.
- **No stale state.** A killed holder's lock disappears with its process. Nothing needs reconciling, and nothing is
  inferred from PIDs or time.
- **Normal-account processes cannot hold it.** The file's explicit ACL has no Users entry, so a normal process
  cannot open it at all. This prevents a denial of service through squatting.
- **Concurrent legitimate commands** (the reviewer's point) are serialized. A second command gets `EBUSY`, waits up
  to 10 seconds re-trying, then reports "another authority command is running".
- **[3.1] This includes `stop`.** A stop cannot be recorded while any other command holds the lock, for example
  during an interactive `approve-change` review or a multi-target apply.
  - It takes effect only once recorded, and is seen at the next mutation boundary of a **later** command.
  - It does not interrupt the command currently holding the lock.
  - For urgency, the owner cancels the running command (Ctrl+C on a review releases the lock), then runs `stop`.
- **The handle is not inherited.** It is opened non-inheritable, as libuv does by default; G0a checks this, so a
  spawned helper cannot keep the lock alive.

**The self-test runs at every start, before anything else.**
- Open the lock (the first handle).
- Attempt a second open of the same path. It **must** fail with `EBUSY`, and only that error is accepted.
- If it succeeds, Node or libuv no longer honours the flag. Close both handles and refuse:
  "exclusive locking unavailable on this Node version".
- The Node version is pinned in the installed manifest; a different `node.exe` hash is refused by the bootstrap
  (§14.1).

---

## 6. Request ingestion over a pipe

The flow is unchanged from revision 2: the owner runs the exporter in an ordinary console, it streams framed bytes
into a one-time named pipe, and the authority never opens request paths. The channel is now specified in full
(C-3):

- **Server.** The protected helper `authority_pipe.ps1` creates `\\.\pipe\gb2l-<128-bit random>`:
  - **first instance** required;
  - maximum instances 1;
  - **remote clients rejected** (`PIPE_REJECT_REMOTE_CLIENTS`), and the DACL also denies the NETWORK SID;
  - a DACL granting read and write only to the owner's user SID, plus SYSTEM and Administrators.
- **Client check.**
  - After connecting, the helper impersonates the client **only** for the token check: user SID equal to the owner,
    elevation type not full, integrity level medium.
  - It then reverts immediately; impersonation lasts no longer than the check.
  - The pipe is closed to further connections.
- **Bounds, all checked before allocating.**

  | Item | Limit |
  |---|---|
  | Magic, then code | 8 bytes, then 16 bytes |
  | Header length | ≤ 65,536 |
  | Name length | ≤ 255 bytes |
  | Entry count | ≤ 1,000 |
  | Entry size | ≤ 10 MB |
  | Running total | ≤ 100 MB |
  | Idle timeout | 30 s |
  | Total timeout | 5 min |

- **End of stream.** After the trailer hash, the helper performs one further read. It must return end-of-stream
  within 2 seconds. Any further byte, or a timeout, means refusal.
- **On any refusal,** the helper deletes `staging\<id>\incoming\` and flushes the deletion record. Staging is
  admin-only, so nothing reaches user-readable storage.
- **Verification gates.**
  - G0a (non-elevated, allowed now) tests framing, bounds, EOF, timeouts and name validation, with a same-integrity
    synthetic server and client.
  - G0b (owner-run, separately authorized) demonstrates the privilege boundary: first instance, DACL, remote
    rejection, and medium versus elevated client.
  - If G0b fails, the design returns for review. There is **no fallback** to privileged path reads.

---

## 7. Operation matrix

Unchanged from revision 2 (closed matrix; the operation determines the root; masked content is refused, not
transformed; registers are computed inside the authority; restore trees are bound by complete membership), with one
change: **`adopt` is defined in §8 and §9 and is not listed as an ordinary operation.**

| Operation | Permission | Targets | Prior | Content | Publication |
|---|---|---|---|---|---|
| `register.create` | `update_records` | 1 of {`services.json`, `personal_data.json`, `access.json`} | `absent` at generation 0, or a tombstone | The canonical register, validated by the protected rules | Temporary file, then exclusive placement (§11) |
| `register.replace` | `update_records` | 1 of the same | The committed hash, generation and file ID | `register_update(prior, record)`, computed by the authority; history = prior plus one entry | Temporary file, then replace (§11) |
| `restore.stage` | `stage_restore` | A new `restores/<approval_id>/`, 1 to 1,000 text files | Every file absent; the final folder absent | UTF-8 text, unchanged by masking; reserved manifest name; no prefix, case or duplicate collisions; no empty folders; no metadata | Tree publication (§11) |
| `patch.stage` | `local_patch` | **deferred** | | | |

---

## 8. Signed documents and their lifecycles (R2-04)

**Common fields, on every document:**
- `policy_version: 2`
- `kind`
- `authority_epoch`
- `key_epoch`
- `key_fingerprint`
- `issued_at`, `expires_at` (30 minutes by default, 24 hours at most)
- a 128-bit random ID

Every signature is over `canonical(payload)`. A document of one `kind` is never accepted as another.

**Storage (R2-04).**
- The **complete signed document (payload plus signature) is embedded in its `L:*_issued` ledger record.** The
  separate file in `change_approvals\` or `decisions\` is only a convenience copy.
- Use always verifies the signature found **in the ledger record**.
- So a lost or partial file copy is harmless, and a file without a ledger record is ignored.

| Kind | Binds (in addition to the common fields) | Lifecycle (ledger) |
|---|---|---|
| `change-approval` | `approval_id`; `operation`; `incident_id`; `scope_serial`; `targets[]` = `{target_key, prior, prior_generation, prior_file_id, proposed_sha256, proposed_size}` (restores also carry `tree_sha256` and the file list); `staged_sha256` | §9 |
| `recovery-decision` | `decision_id`; `approval_id`; `tx_seq` (the sequence number of its `L:consuming` record); `recovery_revision` (the number of decisions already consumed for this transaction); `direction` = `complete` or `cancel`; `observed[]` = `{target_key, state (prior, proposed, absent, tombstone, temp, or the hash of something else), file_id, membership hash for trees}`; `overrides[]` = the **exact sequence numbers** of every authorization event after `tx_seq` that it acknowledges; `incident_id`; `scope_serial_at_decision` | `issued` → `consumed` or `expired`; `issued` → `superseded`, when any newer authorization event or decision for the same transaction appears before use |
| `adopt` | `decision_id`; `incident_id`; `scope_serial`; `target_key`; `target_generation` (current); `quarantine_seq` (the event it resolves); `observed` (state, file ID, and for trees the membership list with each hash); `tx_seq`, if the quarantine came from a transaction | `issued` → `consumed`, `expired` or `superseded` |
| `new-epoch` | `new_authority_epoch` (the current epoch + 1); `reason` (`storage_failure_suspected`, `backup_restored` or `owner_choice`); the ledger head (`seq`, `hash`) it was signed against | Consumed immediately, as one atomic ledger record (§18) |
| **`reconcile`** [3.1] | `decision_id`; `target_key`; `target_generation` (current); `quarantine_seq` (the `L:new_epoch` record, or the quarantine event it resolves); `observed` (state, file ID, and for trees the membership list with each hash); `basis` = `epoch` or `incident_unauthorizable`. For `incident_unauthorizable`, it also binds `incident_id`, and **[3.2]** the verifiable fact that makes `adopt` impossible: `{kind: "stopped" or "denied", event_seq}` (a real ledger event); or `{kind: "scope_expired", scope_serial, scope_expires_at}` (from the committed signed scope); or `{kind: "no_scope", latest_scope_serial: null}`. **It has no scope permission:** it grants none and uses none. | `issued` → `consumed` (one record, which also applies the baseline), `expired` or `superseded` |

**Rules for using a decision, all under the lock.**
1. The ledger holds `*_issued` for this ID, with status `issued`.
2. The signature (from the ledger) is valid; the epochs are current.
3. **First use:** the decision has not expired.
4. A **recovery decision** is usable only if:
   - `tx_seq` is the pending transaction;
   - `recovery_revision` equals the current revision;
   - `observed` equals the actual state, file IDs and membership included;
   - `overrides` equals **exactly** the set of authorization events after `tx_seq`, with nothing newer
     (otherwise → `superseded`).
5. An **adopt** is usable only if:
   - the target is quarantined by exactly `quarantine_seq`;
   - its generation equals `target_generation`;
   - `observed` equals the actual state;
   - the incident is not stopped or denied;
   - `scope_serial` is current and the scope permits `update_records` (or `stage_restore` for restore trees).
6. Then append `L:*_consumed` and flush, **before acting**. **[3.1]** That one record also carries the effect,
   so spending and starting are a single atomic step:
   - a recovery decision's record holds the new segment `{direction, basis_seq}`; no separate
     `recovery_segment_start` follows;
   - an adopt's or a reconcile's record holds the new baseline.
7. **[3.1] A `reconcile`** is usable only if:
   - the target is quarantined by exactly `quarantine_seq`;
   - its generation equals `target_generation`;
   - `observed` equals the actual state, file ID and membership included;
   - for `basis = incident_unauthorizable`, the bound fact is **rechecked at consumption [3.2]**:
     - `stopped` / `denied`: the event `event_seq` exists, and no later event has lifted it;
     - `scope_expired`: `scope_serial` is still the incident's latest committed serial, and now ≥ `scope_expires_at`;
     - `no_scope`: the incident still has no committed scope.

     If the incident can authorize again, the reconcile is refused (`superseded`), and `adopt` must be used instead.

   Its effect is limited to recording `observed` as the baseline (generation + 1) and clearing that target's
   quarantine. **It writes no bytes, and does not change the status of any approval, decision or scope.**

**Continuing after a crash.** A consumed recovery decision authorizes **continuation in its direction for its
revision only while** no authorization event newer than its `overrides` exists. This is re-checked at every
mutation boundary (§12). Expiry gates first use only; continuing a consumed decision does not need it to be
unexpired.

**What `adopt` can and cannot do.**
- It writes **no** target bytes.
- It can act only on a target that is already quarantined, and only to record the observed actual state, with the
  generation raised by 1.
- It cannot bypass drift detection for any other target, cannot start a transaction, and cannot change scope or
  permissions.
- Cross-incident adoption is refused: the quarantine event names the transaction's incident, and it must match the
  `adopt` document's.

---

## 9. States, authorization basis and the transition table (R2-03, R2-05)

**Authorization events.** These ledger records count as authorization events for an incident:
- a stop;
- a deny-list change (recorded with the scope);
- `revoke-change` for one of its approvals, **in any state**;
- a committed new scope serial;
- `new-epoch`.

`latest_auth_event(incident)` is the highest sequence number of any of them.

**The authorization basis.**
- Every permitting record stores `basis_seq`: `L:consuming`, `L:recovery_segment_start`, and each consumed decision.
- `basis_seq` is the value of `latest_auth_event` it was authorized against.
- **Before every target write** (forward, cancel, create, delete or rename), the authority re-reads the ledger tail
  under the lock. If `latest_auth_event > basis_seq`, it writes nothing more, appends `L:needs_decision`, and stops.

**Approval statuses.**
- **Non-final:** `issued`, `consuming`, `recovering_forward`, `recovering_back`, `needs_decision`.
- **Final:** `applied`, `cancelled`, `expired`, `revoked`, `refused_after_stop`, `uncertain`, `conflict`,
  `void_by_epoch`.

**Transaction resolution (R2-05).**
- A transaction is **unresolved** while it is non-final, **or** while it is final with any member target still
  quarantined.
- While **any** transaction is unresolved, new transactions are refused globally: no new `approve-change`, no new
  `apply`.
- Recovery decisions and `adopt` are still allowed, so the owner can resolve it.

**Targets.** Each target records:
- `generation`, which never decreases;
- `recorded`: a hash, `absent`, or a tombstone;
- `file_id`;
- `quarantined_by`: a sequence number, or none;
- `in_tx`: an approval ID, or none.

**The checks.** "Checks" means all of: the signature (from the ledger); the epochs; not expired; not revoked; the
incident not stopped or denied; the scope serial current and the operation permitted; and each target's prior,
generation and file ID matching the ledger and the disk, not quarantined, and not in a transaction. "No new events"
means `latest_auth_event ≤ basis_seq`.

| # | From | Event | Condition | To | Records (each flushed) |
|---|---|---|---|---|---|
| T1 | none | approve commit | the checks pass, re-run **after** the interactive review; no unresolved transaction | `issued` | `L:approval_issued` (embeds the signed document) |
| T2 | `issued` | apply consumes | the checks pass; no unresolved transaction | `consuming` | `L:consuming {basis_seq, journal hashes, new generations}`; targets `in_tx` |
| T3 | `issued` | apply after expiry | | `expired` | `L:expired` |
| T4a | `issued` | `revoke-change` | | `revoked` | `L:revoked` (an authorization event) |
| T4b | `consuming`, `recovering_*` | `revoke-change` | | unchanged; next boundary → `needs_decision` | `L:revoke_requested` (an authorization event) |
| T5 | `issued` | apply after a stop, deny, new scope or new epoch | | `refused_after_stop` (or `void_by_epoch`) | `L:refused` |
| T6 | `issued` | apply finds a target at the **proposed** hash ≠ prior | | `uncertain` | `L:uncertain`; targets quarantined; generations + 1 |
| T7 | `issued` | apply finds a target at an **unexpected** hash or file ID | | unchanged (expires normally) | `L:drift`; the target is quarantined |
| T8 | `consuming` | apply finishes; every target is verified | no new events at each boundary | `applied` | `L:applied` |
| T8b | `consuming` | an apply boundary sees a new event | | `needs_decision` | `L:needs_decision` |
| T9 | `consuming` | `recover`, automatic completion | no new events since `basis_seq`; all inputs valid (§12.2) | `recovering_forward` | `L:recovery_segment_start {forward, auto, basis_seq}` |
| T10 | `consuming`, `needs_decision`, `recovering_*` | `recover` with a recovery decision, `complete` | the decision is usable (§8); all inputs valid | `recovering_forward` | **[3.1] One record:** `L:decision_consumed {segment: forward, basis_seq}`. **[3.2]** `basis_seq` = `latest_auth_event(incident)` read under the lock at consumption. That value is defined even when `overrides` is empty, and the decision's `overrides` must equal exactly the events after `tx_seq`. |
| T11 | the same | `recover` with a decision, `cancel` | the same | `recovering_back` | **[3.1] One record:** `L:decision_consumed {segment: back, basis_seq}` |
| T12 | `consuming`, `recovering_*` | `recover` without a usable decision, after a stop, deny, revoke, new scope or new epoch | | `needs_decision` | `L:needs_decision` (no target writes) |
| T13 | `recovering_forward` / `back` | `recover` after another crash | **No new events since the segment's `basis_seq`** | continue the same direction | (the segment's step records) |
| T13b | the same | the same | new events exist | `needs_decision` | `L:needs_decision` |
| T14 | `recovering_forward` | every target verified at proposed | | `applied` | `L:applied` |
| T15 | `recovering_back` | every target verified at prior, or absent / tombstone for a create | | `cancelled` | `L:cancelled`; generations stay at their increased values |
| T16 | any non-final | a target in neither expected state, or bad journal, staging or ownership evidence | **checked before any write in the segment** | `conflict` | `L:conflict {observed}`; members quarantined; evidence retained |
| T17 | (a quarantined target) | `adopt` consumed | §8 rules | the target is unquarantined | `L:adopt_consumed`; recorded = observed; generation + 1; the transaction is resolved when its **last** quarantined member is adopted |
| T18 | any | `new-epoch` | §18 | Every unspent approval and decision becomes `void_by_epoch`. **[3.1]** A transaction pending at that moment becomes `void_by_epoch`, with its evidence retained. **Every** target is quarantined until reconciled (T19) or adopted under the new epoch. | one `L:new_epoch` record |
| **T19** [3.1] | (a target quarantined by `new-epoch`, or by an event whose incident cannot authorize `adopt`) | `reconcile` consumed | §8 rule 7 | The target is unquarantined, and its baseline is the observed state. A transaction is resolved when its last member is reconciled or adopted. | one `L:reconcile_consumed {baseline}` record; generation + 1; no target write |

---

## 10. Approve

1. **Launch and startup.** The trusted launch and bootstrap (§14.1), then **[3.1] the startup order of §4**: lock
   and self-test, **read-only ledger verification**, tail handling and re-verification, the stale-session check,
   and only then `L:session_start`.
2. **Preconditions.** If any transaction is unresolved, an unclosed session from another boot exists, or the epoch
   needs renewing, the command stops and shows diagnostics.
3. **Ingest** over the pipe (§6).
4. **Validate and canonicalize** (§7).
5. **Display** (§13).
6. **Confirm.** A confirmation code is shown **after** the display. The owner types it, then the passphrase.
7. **Commit (T1).** Under the lock, re-run **all** checks against the fresh ledger tail: stops, denies, the scope
   serial and its expiry, epochs, priors, generations, file IDs, quarantine, and unresolved transactions. Then sign,
   append `L:approval_issued` with the embedded signed document, and flush.
8. **Optional `--apply`** continues as a separate T2 with all its checks re-run.
9. **Finish.** Append `L:session_end` and close the lock.

---

## 11. Apply: the mutation boundary

1. **Startup** as in §10, steps 1 and 2.
2. **Checks (T2).** The staged bytes must equal `staged_sha256`. Each target must pass §14.3: a regular file,
   `nlink == 1`, no reparse point anywhere on its path, and the file ID equal to the ledger's.
3. **Journal.** Copy each existing prior into `journal\<id>\` and flush each copy.
4. **Consume.** Append `L:consuming {basis_seq = latest_auth_event}` and flush. **The approval is now spent.**
5. **For each target, in sorted order, at its mutation boundary:**
   - (a) **Authorization re-check.** If `latest_auth_event > basis_seq`, the result is T8b and the command stops.
   - (b) **Write.**
     - **Register:** create `data\registers\.<id>.tmp` with `wx`, write it, flush it. Record its file ID and hash:
       `L:temp_ready {target_key, temp_file_id, sha256}`, flushed. That record is the **ownership evidence**.
     - **Restore tree:** create `data\restores\.tmp-<id>\`, record its folder ID with `L:tree_dir_created`, write
       every listed file with `wx` and flush it, write the manifest last and flush it, enumerate and verify exact
       membership, then record `L:tree_ready {dir_id, membership hash}`.
   - (c) Re-hash the target, which must still equal the prior.
   - (d) Rename the temporary file or folder into place.
   - (e) Re-open and verify: hash or membership; the file or folder ID equal to the recorded temporary ID
     (rename keeps it); regular file; `nlink == 1`; no reparse point.
6. **Report.** Append `L:applied` with the verified hashes and IDs, flush, then append `L:session_end`.

---

## 12. Recovery, cancellation and evidence (R2-03, R2-05)

### 12.1 `diagnose` (C-2)
- **Writes nothing:** no lock, no ledger append, no snapshot rebuild, no cleanup, no evidence copies.
- It reads the ledger, which may be mid-command; if so, it reports "a command may be running".
- It classifies every pending target and prints the transitions §9 would allow.
- It needs no elevation to read; the protected data is user-readable.

### 12.2 Input validation before the first write of any recovery segment
Before writing anything, recovery checks:
- **Targets:** every member target is classified (prior, proposed, absent, tombstone, temporary file or folder by its
  recorded ID, or other).
- **Journal:** each journal copy's hash equals the one in `L:consuming`.
- **Staging:** the staged bytes equal `staged_sha256`.
- **Ownership:** every ownership-evidence record (`L:temp_ready`, `L:tree_dir_created`, `L:tree_ready`) matches what
  is on disk.
- **Protection and containment:** ACLs pass and containment holds.

Any failure → T16 `conflict`, and **nothing is written**.

### 12.3 Forward completion
For each target not yet at proposed, this re-runs §11 step 5 from the point its records show. That covers:
- a temporary file recorded but not yet renamed;
- a temporary file not yet created;
- a renamed file whose final verification was not yet recorded.

The authorization re-check (§11 step 5a) runs **before every write**.

### 12.4 Cancellation progress
Cancellation never deletes anything without ownership evidence, and it can be resumed at any point.

- **Register replace.**
  1. Copy the journal prior to `data\registers\.<id>.restore.tmp`, flush it, and record `L:temp_ready {restore}`.
  2. Run the authorization check.
  3. Rename it over the target.
  4. Verify.
- **Register create.**
  - The created file is deleted only if its file ID equals the ID recorded by `L:temp_ready`, which was recorded
    **before** the rename, so it is known even if `L:applied` never happened. It must also be at the proposed hash,
    a regular file, with `nlink == 1`.
  - Otherwise → conflict.
  - Then append a tombstone.
- **Restore tree.**
  1. If the final folder exists with the recorded folder ID, rename it to `.cancel-<id>` and record
     `L:cancel_renamed`.
  2. Inside `.cancel-<id>` or `.tmp-<id>`, delete files one by one. Each must be in the signed list, at its signed
     hash, a regular file with `nlink == 1`; the authorization check runs before each delete.
  3. **Missing listed files are progress, not conflict.** Any **unlisted** entry, or a listed file at the wrong hash,
     → conflict, and the deletion stops.
  4. Delete the empty folder, then record `L:cancelled`.
  5. If both the final folder and `.cancel-<id>` exist → conflict.

### 12.5 Resuming a segment
**[3.1]** A segment exists from the moment its starting record is durable: `L:decision_consumed` for a decision,
or `L:recovery_segment_start` for an automatic segment. There is no state with a spent decision and no segment, so
no decision is ever consumed twice and no transaction is stranded between two records.

A resumed segment continues its recorded direction **only if** there are no new events since its `basis_seq`
(T13). Otherwise the result is T13b, and the owner signs a new decision. That decision's `overrides` must list every
new event, its `recovery_revision` must be the next one, and its direction may differ.

### 12.6 Evidence and resolution
- For `conflict`, `uncertain` and quarantine, the evidence (staging, journal, `.tmp` / `.cancel` folders, torn tails)
  is retained.
- Resolution needs one `adopt` (T17) **or `reconcile` (T19) [3.3]** per quarantined member. `reconcile` is used
  after a new epoch, or when the incident cannot authorize `adopt`.
- After the last adoption, the owner records a retention decision: `L:evidence_retention {keep | remove}`. Only
  then does cleanup act on that evidence.

---

## 13. The review display

The escaping approach is unchanged from revision 2. The output contract is now explicit (C-4):

- **Trusted formatting**, printed only by the authority, consists of:
  - printable ASCII;
  - the two glyphs `│` (gutter) and `↪` (continuation);
  - LF newlines;
  - the fence lines `BEGIN UNTRUSTED <label> <tag>` and `END UNTRUSTED <label> <tag>`, with a random 4-character
    tag.
- **Untrusted text, after escaping,** contains **only** printable ASCII (0x20 to 0x7E). Everything else, CR
  included, is shown as `\u{XXXX}`, and `\` is shown as `\\`.
- **Decoding.** Strict UTF-8: invalid sequences, overlong forms and surrogates make the content **refused**, not
  replaced.
- **Line breaks.** LF is the only line break. Each untrusted line is printed as `<gutter> NNNN │ <escaped>`.
- **Long lines.** A line longer than 160 escaped characters continues on lines marked with `↪`. **Continuation lines
  count against the 2,000-line limit.** Above the limit, approval is refused ("split this change"). Nothing is
  truncated silently.
- **Binary content** is refused in version 1.

---

## 14. Trusted launch, migration, target identity (R2-02)

### 14.1 The trusted launch boundary

**What the owner types**, as printed by the installer, in an elevated console:
```
C:\Windows\System32\cmd.exe /d /s /c ""C:\ProgramData\gitback2life-authority\authority.cmd" <command> [<id>]"
```
**[3.1] Why the `/s` and the outer quotes.** Without `/s`, `cmd /c` sometimes strips the first and last quote
characters of the line and sometimes keeps them, depending on how many quotes there are and what lies between them.
That made the launch command depend on its arguments: observed while testing this amendment. With `/s` it always
strips exactly the outer pair, so the script path and its arguments arrive as written.

**`authority.cmd`** is protected and fingerprinted. In order, it:
1. Runs `setlocal DisableDelayedExpansion`.
2. **Clears every environment variable, without starting any child process, in a PRIVATE scratch folder [3.2, 3.3].**
   - **[3.3, G0a-F1] Per-launch isolation.** It creates `launch_scratch\<random>-<random>-<try>` under the authority
     folder with `mkdir`, which fails if the name exists. It retries up to 20 names, then fails closed. Two launches
     can therefore never share a file.
   - **Clearing.** It runs `set` into that folder, reads the names back with the **file** form of `for /f` (never
     `for /f ... in ('set')`, which would start a child `cmd` that honours per-user AutoRun), and unsets each one. It
     then sets only `SystemRoot`, `windir`, `SystemDrive`, `PATH=C:\Windows\System32`, and `TEMP` / `TMP=C:\Windows\Temp`.
   - **[3.3] Proof.** It dumps the environment again and requires **exactly 7 names**: the 6 fixed ones, plus its own
     scratch-path variable, which is cleared on the launch line. An unreadable dump gives a count other than 7, so it
     fails closed rather than passing vacuously.
   - **[3.3] Cleanup.** It removes the scratch folder (which briefly held the original environment, values included)
     and requires that it is gone.
   - **Failure handling [3.3].** Any failure while creating, writing, reading, verifying or cleaning up means **Node
     is never started.**
   - **Leftovers.** The scratch folder lives under the administrator-only authority folder and is not part of the
     installed manifest. A crash can leave one behind, holding a copy of the launcher's environment; it is covered by
     the existing evidence-and-cleanup procedure.
3. Runs `cd /d C:\ProgramData\gitback2life-authority`.
4. **[3.1] Validates the arguments without `findstr`, and without any pipe.** `findstr` lacks counted repetition, and
   its `[a-z]` ranges follow collation order, not character codes. A pipe would re-parse the argument in a child
   `cmd`. The arguments are the owner's own typed input, never request content. The steps are:
   - Refuse if `%3` is non-empty: at most 2 arguments.
   - With delayed expansion **off** (`setlocal DisableDelayedExpansion`), assign `set "A1=%~1"` (and `A2`). Then
     enable delayed expansion.
   - Refuse if `A1` is undefined, which means empty.
   - Refuse if `"!A1:~64!"` is not `""`, which means longer than 64.
   - Copy `A1` to `R`. For each allowed character `%%c` in the fixed list `a b … z 0 1 … 9 -`, run
     `set "R=!R:%%c=!"`. **If `R` is still defined, refuse.** (`cmd` substitution is case-insensitive, so
     uppercase letters survive this step; step 5's exact check refuses them.)
   - **[3.2]** If `%~2` is empty but `%2` is not (an explicit `""`), refuse. An **absent** second argument is
     omitted: Node is started with one argument, never with an empty second one.
   - **[3.2]** Start Node with the validated values expanded into the launch line, clearing `A1` and `A2` on that
     same line (`set "A1=" & "...node.exe" ... "%A1%"`). Node then receives only the fixed environment, which the
     bootstrap checks exactly.

   The bootstrap then **re-validates** each argument exactly against `^[a-z0-9-]{1,64}$` in JavaScript. That is the
   authoritative check; the `cmd` check is defence in depth.
5. Runs:
   `"C:\Program Files\nodejs\node.exe" --no-addons --no-global-search-paths "C:\ProgramData\gitback2life-authority\bootstrap.mjs" <args>`.

`/d` disables the per-user and per-machine `cmd` AutoRun. With an empty environment, no `NODE_OPTIONS`, `NODE_PATH`,
OpenSSL or ICU variable, or other preload option reaches Node.

**`bootstrap.mjs`** imports **only** `node:` built-ins, and is the only static entry. In order, it:
1. Checks that `process.execArgv` equals exactly `['--no-addons', '--no-global-search-paths']`, and that
   `process.env` has exactly the fixed keys and values. If not, it refuses: someone bypassed the launcher.
2. Runs the lock self-test (§5).
3. Checks the ACL of the authority folder, every protected module, `node.exe` and the PowerShell helper.
4. Reads every protected module's bytes and compares their hashes with `installed_manifest.json`. That manifest's own
   hash is checked against the ledger's genesis record, and `node.exe`'s hash is pinned there.
5. Only then **loads** the verified modules with dynamic `import()`. The modules are a fixed list; they themselves
   import only `node:` built-ins and each other.
6. Refuses if `authority_testkit.mjs` is present in the folder.

Production entry points accept no test seams, and the authority root is a constant.

**The PowerShell helper** is started by the bootstrap with:
- the pinned path;
- `-NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -File <protected path>`;
- a **constructed** environment, so no `COR_*` or `COMPlus_*` variables;
- the working folder set to the authority folder.

The helper uses only language features and .NET types, and loads no modules. Before running it, the bootstrap
verifies the helper's hash.

**What this does and does not cover.**
- **Covered:** everything Node, the bootstrap, the modules and the helper read from the environment or the command
  line.
- **Residual (assumption A3), checked at owner gate G2:**
  - `cmd.exe` itself is a protected system binary;
  - the per-user settings applied to every process the owner starts, which the normal account can edit: application
    compatibility layers in the user's registry, and per-user .NET configuration that the helper's runtime might
    read;
  - the console host.

  **Not covered:** anything already elevated.

### 14.2 Migration and ledger creation
- `init` writes `ledger.log.new` containing the genesis record, which holds:
  - the installed-manifest hash and the pinned `node.exe` hash;
  - `authority_epoch` 1 and `key_epoch` 1;
  - a verbatim copy and hash of the version 1 `state.json` when migrating.
- It flushes the file and renames it to `ledger.log`, then **verifies by reading `ledger.log` back** and rebuilding
  the state, which must equal the version 1 state exactly.
- The installed manifest records `ledger_created: true` only after that verification.
- An interrupted creation is redone (§4). If the rebuild does not match, the migration is refused, and the old
  `state.json` is never modified.

### 14.3 Target identity
The rules are unchanged from revision 2:
- names are generated by the authority in lowercase ASCII;
- folders with the case-sensitive flag are refused;
- each name must be the only matching entry when its parent folder is enumerated;
- the file ID is recorded at every write and required at the next;
- hard links (`nlink > 1`) and reparse points on the path or the target are refused at every apply, recovery and
  adopt.

---

## 15. Guarantees: under the flush contract, and when it fails (R2-06)

**Under the flush contract (A5) and assumption A1:**

| Guarantee | Basis |
|---|---|
| A spent approval or decision is never usable again, even if the targets' old bytes are restored | Ledger status, plus generations that never decrease |
| No target write happens without a durable permitting record, and the current authorization basis is re-checked at that write | Write-ahead rule and §9 |
| After a process crash, or a power loss with A5 holding: deterministic recovery, or a fail-closed conflict | §12 |
| A stop, deny, revoke, new scope or new epoch prevents every **later** target write until an explicit decision | `basis_seq` re-check at every boundary |

**When the flush contract fails** (storage acknowledged writes it later lost):

| What is lost | Detectable? | Design response |
|---|---|---|
| A torn final record | Yes | Preserved; ambiguous only outside A5 |
| A valid **prefix** of the ledger (recent records gone, chain intact) | **No, not by the ledger itself** | The **session record** detects that a boot happened during an open session, when that record survived. The owner procedure then requires a new epoch. Without that record, it is undetectable. The optional external anchor (below) narrows the gap. |
| A consumption record, with the targets back at their old bytes (a no-op change, or one cancelled before the loss) | **No:** hashing cannot show the approval was spent | Same as above. A new epoch voids every earlier unspent approval. |
| A completion record (the target changed) | Yes, if the target bytes differ: T6 `uncertain` or drift | Quarantine, then adopt |

**Explicit disclaimer.** Without an independent durable anchor, a storage failure that drops recent history can
leave an already-spent approval looking `issued`, with nothing on disk to show otherwise. The design does **not**
claim fail-closed detection for that case. The mitigations are:
1. Session records plus boot detection trigger the conservative procedure whenever the machine restarted
   mid-command.
2. **After any suspected storage failure, any unclean shutdown, and any backup restore,** the owner runs
   `recover --new-epoch`. That voids every unspent approval and decision and quarantines every target until it is
   re-adopted.
3. **Optional external anchor.** `authority.cmd head` prints the ledger's head (sequence number and hash). The owner
   may note it outside the computer after each change, and compare it after an incident. A hardware monotonic
   counter (TPM NV) is **deferred**.

**Also deferred:** binary content, deletes, patch staging, and automatic completion after power loss.

**Not provided:**
- immediate cancellation of an in-flight write: a stop takes effect at the next mutation boundary, which is before
  each target;
- detection of changes made by an Administrator outside the authority.

---

## 16. What a signature proves

Unchanged from revision 2. An Ed25519 signature proves that the key was used over those bytes. Elevation, the
console, the display, confirmation, expiry, single use and epochs are **protocol conditions the authority enforces**;
the signature does not attest them. A valid record means that someone with access to the passphrase, running the
authority with Administrator rights, completed review and confirmation for this exact change. **It does not prove a
human approved it, and this is not human-only approval.**

---

## 17. Remaining trust assumptions

| # | Assumption |
|---|---|
| A1 | **No Administrator-level process runs except the owner's own sessions.** Includes any AI or script run elevated, and any rollback of protected files. |
| A2 | The passphrase is strong and known only to the owner; the key is readable only by Administrators. |
| A3 | **The launch boundary holds before the first line of `authority.cmd` runs.** That covers: `cmd.exe`, the console host and the PowerShell runtime are genuine system binaries; per-user settings the normal account can edit (application compatibility layers in the user's registry, per-user .NET configuration) do not inject code into these elevated processes; and UAC is set to consent on the secure desktop, with UI privilege isolation protecting the elevated console. Checked by the owner at gate G2; not provable by this design. |
| A4 | The installed code matches the reviewed bundle (the owner's fingerprint comparison at install). |
| A5 | **Flush contract:** a successful `FlushFileBuffers` makes that file's data and metadata durable, and storage never damages acknowledged data afterwards. Where it fails, see §15. |
| A6 | NTFS behaves as documented: same-volume rename keeps the file ID; file IDs; ACL inheritance; the per-directory case-sensitivity flag. |
| A7 | **The libuv exclusive-share open on the pinned Node version behaves as measured.** Self-tested at every start. |
| A8 | The system clock is correct. |
| A9 | The named-pipe properties demonstrated at G0b continue to hold. |
| A10 | The owner reads what is displayed. |
| A11 | Approvals govern only toolbox mutations of protected storage; not user-writable files or live systems. |

---

## 18. Owner procedures, for acceptance

**Making a change** works as in revision 2, through the launch command in §14.1: two consoles, the exporter, then
review, confirmation code and passphrase.

**After a power cut, a crash, or a "restarted during a session" message:**
1. Run `authority.cmd diagnose`. It writes nothing.
2. If it reports an unclosed session from an earlier boot, or you suspect a storage problem, run
   `authority.cmd recover --new-epoch`.
3. Sign the `new-epoch` record: **every** approval or decision not yet used becomes void.
4. Every target is quarantined. Review each one with `diagnose`. **[3.1]** Then sign one `reconcile` per target,
   recording its current content as the new baseline. This works whatever state the target's incident is in
   (stopped, denied, expired or without a scope), because `reconcile` writes nothing and authorizes nothing. If a
   target's content is not what you expect, leave it quarantined and investigate first: reconciling only records
   what is there now.
5. Re-request any change you still want: earlier approvals cannot be reused.

**Restoring protected data from a backup.** Copying `data\` and `ledger\` back is an Administrator action outside
the authority. **A restored ledger can show approvals as `issued` that were actually used after the backup was
taken.** You must therefore run `recover --new-epoch` immediately after any restore, before anything else. Restoring
never transparently preserves single use.

**A corrupt ledger** (not merely a torn final record):
1. Stop. Keep every file, and do not edit the ledger.
2. Restore `data\` and `ledger\` **together** from a backup taken while the authority was idle.
3. Then run the new-epoch procedure.

**A busy lock** ("another authority command is running"): wait for it to finish. If it is hung, end that process in
Task Manager; the OS then releases the lock. The lock file is never deleted.

**Optional record-keeping:** after each change, note the output of `authority.cmd head` somewhere off this computer.

---

## 19. Deterministic traces

The notation is the ledger sequence `[n]`, plus disk state. "check" means the boundary re-check of §9.

**Trace 1: crash during automatic forward recovery, then a stop (R2-03).**
```
[10] approval_issued A
[11] consuming A {basis 9}             disk: t1=prior t2=prior
     write t1 → proposed; crash
[12] session_start (recover) → recovery_segment_start {forward, auto, basis 9}   (no events > 9)
     write t2: check latest_auth_event=9 ≤ 9 → temp_ready … crash before rename
[13] stop (incident)                    ← authorization event
[14] session_start (recover): resume segment → check latest_auth_event=13 > 9 → T13b
[15] needs_decision A                   disk: t1=proposed, t2=prior (+ temp, recorded) — NO further write
     owner: decision D {tx_seq 11, recovery_revision 0, overrides [13], direction cancel|complete}
[16] decision_issued D ; [17] decision_consumed D {segment: dir, basis 13}   ← ONE record [3.1/3.2]; no separate segment start
```
Without D, no forward write ever happens after `[13]`.

**Trace 2: two contenders and a killed holder (R2-01).**
```
P1 opens lock (share 0) → holds.  P2 open → EBUSY (retries 10 s) → "busy".  P1 killed → OS closes handle.
P2 open → succeeds. No rename/delete of the lock file occurs in any path.
```

**Trace 3: crash after a create was published, before `applied` (R2-05).**
```
[20] consuming C {basis 19}
[21] temp_ready {services.json, temp_file_id F, sha X}
     rename .C.tmp → services.json; crash (no applied record)
recover: services.json has file_id F (recorded at [21]) and sha X → ownership proven.
  no new events → T9/T13 forward → [22] applied.   (If owner had signed cancel: delete only because id==F, sha==X → tombstone.)
```

**Trace 4: crash midway through deleting a cancelled restore (R2-05).**
```
[30] recovery_segment_start {back, decision}  [31] cancel_renamed {dir_id G}
     delete a.txt (listed, sha ok), delete b.txt; crash
recover: .cancel-<id> has dir_id G; contents {c.txt} ⊂ listed → progress; check; delete c.txt; rmdir → [32] cancelled.
     If .cancel-<id> contained "x.txt" (unlisted) → T16 conflict, nothing deleted, evidence kept.
```

**Trace 5: a lost ledger prefix (R2-06; simulated storage state).**
```
true history: [40] issued A … [41] consuming A … [42] cancelled A (bytes back to prior)
storage loses [41..42] (valid prefix up to [40] remains), and session_start of that command was also lost.
→ A appears issued; disk = prior. UNDETECTABLE by ledger alone (§15 disclaimer).
If session_start [41'] survived with an older boot id and no session_end → "restarted during session" →
  every command refuses except recover --new-epoch → A becomes void_by_epoch.
```

**Trace 6: adopting one member of a two-target conflict (R2-05).**
```
[50] conflict T {t1 quarantined, t2 quarantined}
[51] adopt_consumed t1      → t1 resolved; transaction T still unresolved (t2) → new approvals refused globally
[52] adopt_consumed t2      → T resolved → [53] evidence_retention {…} → cleanup permitted
```

---

## 20. Proposed tests

**Ground rules.** All tests are synthetic and non-elevated, in temporary folders, through `authority_testkit.mjs`,
except the owner gates. **Simulated storage states are labelled as such, not as power-loss tests.**

**A. Ledger, sessions and epochs (R2-06)**
1. A torn final record at every byte offset: the tail is preserved in `evidence\` and then truncated. A damaged
   earlier record, a broken chain, a sequence gap, or a `LEN` above 1 MiB (refused **before** allocating): corrupt.
2. Missing `ledger.log` with `.new` present: creation redone. Missing with `ledger_created`: corrupt. An interrupted
   migration leaves the version 1 `state.json` untouched; a rebuild mismatch is refused.
3. **Simulated storage states:**
   - (a) valid-prefix loss with prior equal to proposed (a no-op change), and an interrupted change later cancelled:
     asserted undetectable by the ledger alone, with the session record present or absent;
   - (b) an unclosed session from another boot: only `recover --new-epoch` runs;
   - (c) a damaged last committed record;
   - (d) a backup restored after a later consumption, followed by the new-epoch procedure.
   After a new epoch, every earlier unspent approval and decision is `void_by_epoch`, and every target is
   quarantined.

**B. The lock (R2-01)**
4. Deterministic contenders, paused at open, I/O and close, in every interleaving across 2 to 5 processes: exactly
   one holder; a loser's rename and delete of the lock file fail with `EBUSY`; release by the winner affects no other
   holder.
5. A **real child process** killed while holding the lock: the next open succeeds; no file operation on the lock path
   ever happens.
6. The self-test refuses when exclusivity is simulated as broken; a spawned helper does not inherit the handle; the
   lock-file ACL denies normal-account opens (an ACL fixture).

**C. Launch (R2-02)**
7. An **inert synthetic preload canary** (a `NODE_OPTIONS` `--require` and `--import` of a file that writes a marker
   when run) is set in the parent environment. Under the `authority.cmd` launch path, the marker **never** appears.
   Run non-elevated, against a temporary copy of the launch files.
8. A protected module with a wrong hash is never executed. The bootstrap reads its bytes and refuses **before** any
   `import()`, and a canary statement inside the module never runs. Wrong `execArgv`, an extra environment key, the
   testkit present in the folder, and an environment-supplied root are each refused.
9. Helper launch: `COR_ENABLE_PROFILING` and `COMPlus_*` variables set in the parent never reach the helper process
   (its environment is inspected in the test).

**D. Authorization basis (R2-03)**
10. Each of stop, deny, revoke (on a consuming approval), new scope and new epoch, injected:
    - after T2, before the first write;
    - between targets;
    - after T9, then another crash;
    - after T10, then another crash.

    In every case **no** forward or cancel write happens after the event without a fresh decision whose `overrides`
    include it.
11. T12 is triggered by `deny`; T4b on `consuming` and on `recovering_*`.

**E. Decisions and adopt (R2-04)**
12. Using a decision twice; an old decision after a newer stop (`superseded`); a wrong `key_epoch` or
    `authority_epoch`; same hash but different generation or file ID; adopting across incidents; adopting an
    unquarantined target; a decision whose ID is not in the ledger; a direction change without a new revision; a
    decision used after expiry on first use (refused) versus continuing after a crash (allowed only with no new
    events).
13. A signed copy file deleted or corrupted after issue: the decision is still verified from the ledger. A file
    without a ledger record is ignored.

**F. Cancellation and evidence (R2-05)**
14. Crash injection after every delete in a tree cancellation, after the cancel rename, after a create was published
    but before `applied`, and after adopting one of two conflicted members. Recovery converges, never deletes an
    unlisted or wrong-hash file, and never deletes retained evidence.
15. With both the final and the `.cancel-<id>` folders present: conflict. While any member is unresolved, new
    approvals and applies are refused globally; after the last adoption plus the retention decision, cleanup proceeds.

**G. Display (C-4)**
16. The trusted-formatting set and the untrusted printable-ASCII set are checked per segment. Erase-screen, cursor,
    OSC and hyperlink sequences, forged prompts, CR, bidi controls, zero-width characters, U+2028, and invalid UTF-8
    (refused). Continuation lines counted; 2,000 lines plus 1 refused. **No terminal payload is executed.**

**I. Amendment 3.1**
18. **Verification before append.** On a corrupt ledger (a damaged middle record, a broken chain, a sequence gap, or
    an oversize `LEN`), the ledger file is **byte-identical** before and after every mutating command. No
    `session_start` is ever appended. A torn tail leads to preserve, truncate and re-verify, and only then
    `session_start`, at the verified end offset.
19. **Reconcile:**
    - after `new-epoch`, for targets whose incidents are stopped, denied, expired, or have no scope: each target
      becomes reconcilable, and nothing else changes (no target bytes, no approval or decision revived);
    - `reconcile` with `incident_unauthorizable` is refused if the incident can authorize again (use `adopt`), and
      refused on an unquarantined target or one with a stale generation, observed state or file ID;
    - **[3.2]** the bound fact is rechecked at consumption, for each kind:
      - `scope_expired`: a newer scope serial committed after issue makes it `superseded`;
      - `no_scope`: a scope committed after issue makes it `superseded`;
      - `stopped` / `denied`: bound to their real event sequence numbers;
    - **[3.2]** no reconcile document refers to an event sequence that is not in the ledger;
    - using it twice is refused;
    - a transaction voided by the epoch is resolved only after its last member is reconciled.
20. **Decision crash window:** crash injection immediately **before** and immediately **after** the single
    `L:decision_consumed` record. Before it: the decision is still `issued` and usable once. After it: the segment
    exists, and resumption goes through T13 with `basis_seq` re-checked. The decision is never consumed twice, and
    the transaction is never left without a segment.
21. **Launcher arguments** (non-elevated, against a temporary copy of `authority.cmd`):
    - each of `& | < > ^ % ! " ( )`, a space, Unicode letters, uppercase letters, 65 characters, an empty argument,
      and 3 arguments is refused before Node starts, or (uppercase only) by the bootstrap's exact check;
    - valid inputs of 1 and 64 characters are passed through unchanged;
    - no argument is ever echoed into a pipe.
22. **Lock and stop:** while a synthetic command holds the lock, `stop` reports "busy" after 10 seconds and records
    nothing. After the holder ends, `stop` is recorded, and a later command's boundary check sees it.

**H. Carried over from revision 2**
17. Revision 2 groups D (ingestion), F (operations and content) and H (identity) remain in force. The ingestion tests
    that need the elevated server move to gate G0b.

---

## 21. Milestones and gates

| Gate | Content | Who | Allowed now? |
|---|---|---|---|
| **G0a** | Non-elevated, synthetic: the lock tests (group B), the launch canaries (C7 to C9, against temporary copies), pipe framing, bounds, EOF and timeouts with a same-integrity server and client | AI, non-elevated | **Yes**, if the owner authorizes this prototype work |
| **G0b** | The elevated pipe server and medium-integrity client boundary: first instance, DACL, remote rejection, elevated client refused | **Owner-run, separately authorized** | No |
| **M1** | Ledger, sessions, epochs, state machine, decisions and recovery, as pure modules, with groups A, D, E and F | AI, synthetic | After design acceptance |
| **M2** | Commands, renderer and register operations, end to end with synthetic keys | AI, synthetic | After M1 review |
| **M3** | Restore trees; installer (folders, ACLs, lock-file ACL, manifest, launcher); toolbox builders and exporter | AI, synthetic | After M2 review; then owner acceptance of §18 |
| **G2** | Installed-system checks: assumption A3 (launch boundary), normal-account denial, the lock's ACL, a killed apply then recovery, fingerprints | **Owner-run** | No |
| **M4** | Register writes re-enabled through this path | **Owner decision** | No |

Each gate and milestone returns a versioned bundle for independent review. Released writes stay disabled until M4.
