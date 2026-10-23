# M3: restore trees, real-filesystem backend, signer, exporter, command entry (design revision 3.5 notes)

**Prototype only.**
- Nothing here is installed or used by any toolbox tool.
- Tests use synthetic keys and passphrases, the simulated disk, and TEMPORARY folders for the real-filesystem backend.
- The protected authority folder is never referenced.
- Register `update` writes stay disabled.

| File | What it implements | Design |
|---|---|---|
| `tree.mjs` | Restore trees: validation (text only, §14.3 path rules, duplicate, case and prefix collisions, reserved manifest name, limits), the canonical listing and tree hash, the manifest, membership comparison, the atomic folder rename | §§7, 11, 12 |
| (in `../m1/engine.mjs`) | Trees inside the EXISTING state machine. Ownership (the folder id) is recorded before any file is written; the manifest is written last; publication is one rename. Cancellation renames aside, then deletes only listed files at their signed hash (missing files are progress; an unlisted entry or a wrong hash is a conflict). A tree is classified before any recovery write. The `stage_restore` permission applies. | §§9, 11, 12 |
| (in `../m2/commands.mjs`) | `approveRestore`. The shared review → confirm → re-check → sign → commit tail is now used by registers and restores alike. | §10 |
| `fs_backend.mjs` | The real-filesystem backend behind the same disk interface. The ledger file is append-only, with flushed writes and torn-tail truncation only. A missing ledger is refused on open (lost history). A new ledger is made only by `FileLedgerStore.createNew()` (first-time initialization, refused if any earlier state exists; amendment 3.6). Identities come from the OS file id. Links, junctions, non-regular files and hard links are refused. Staging, journal and evidence are durable. | §§3, 4, 14.3 |
| `signer.mjs` | Signing with the EXISTING protected key format (scrypt + AES-256-GCM, Ed25519). The passphrase is read at signing time, once. The fingerprint and signature are self-checked. | §§10, 16 |
| `exporter.mjs` | The toolbox side, with normal privileges: the canonical request builder, request folders (regular files only, bounded, no links), and export over the G0a local pipe | §§2, 6 |
| `cli.mjs` | The command entry point (safe arguments, as the launcher enforces) dispatching to M1, M2 and M3. Production wiring refuses outside an installed folder and stays gated (M4). | §§2, 10-12 |
| `m3.test.mjs` | Focused tests | §20 |

**Run** (from the toolbox folder):
```
node --import ./regression_harness/network_guard.mjs --test --test-reporter=spec authority/m3/m3.test.mjs
```

**Installer: NOT AUTHORED (v14 and v15).** In v14, an attempt to write the new installer script was stopped by a
safety check. Its instruction was not to produce that content again in any form, so v15 did not attempt it either. The
older `authority/install.ps1` (unchanged since v7) does not know the M3 layout and **must not be run for M3**. The M3
layout needs these folders:
- `data/`
- `staging/`
- `journal/`
- `evidence/`
- `ledger/`, including the exclusive-lock file

It also needs the launcher, bootstrap and manifest. An installer covering that layout is required before M4, and remains
open.

## Read-only filesystem view (session handoff change, 2026-10-18)

`new RealDisk(root, { readOnly: true })` is for diagnostic reads. It does not create `.work`, staging, journal or evidence folders; its mutators refuse. A regular `new RealDisk(root)` remains the existing synthetic/temporary-file writer for the M3 tests. `createProductionDeps()` remains **disabled**. In any future M4 production dispatch, `diagnose` must use the read-only view and may not acquire the lock, create directories, append ledger records, clean up or update snapshots. The focused test `M3: read-only diagnostic filesystem view never creates or mutates paths` passes on Node 22 Linux with temporary paths; Windows acceptance remains pending.


## Offline continuation after 2026-10-18 handoff — source only

- `cli.mjs` now exports `createReadOnlyDiagnosticDeps({root})` and `diagnosticMain(['diagnose'|'head'], {root})` for **offline/temporary test roots only**. It opens the EXISTING ledger without creating it, explicitly constructs `RealDisk(root, {readOnly:true})`, refuses missing or empty history, and routes only the two read-only commands. Neither the disabled installed bootstrap nor the protected production command dispatcher calls this entry. This is not M4 activation.
- `offline_readiness.mjs::assessOfflineLayout(explicitFolder)` is a metadata-only classifier for synthetic/owner-selected directory shapes. It distinguishes absent, legacy-v7-shaped, fresh-predeployment-shaped, mixed and unsafe layouts, without opening keys, authorization values, or other private data. The result is **not** a trusted inspection of Windows ACLs, an attestation of a completed installation, or a migration. Unknown and existing layouts always remain untouched.
- `FileLedgerStore.createNew()` refuses a first-time genesis before **any directory creation** if the root contains legacy v7 artifacts, unknown entries, nonempty staging/journal/evidence/temporary work, or invalid links or existing ledger contents. Recognized empty M3 layouts remain possible for explicitly authorized future initialization; the method is not reachable through the disabled production bootstrap.
- The real disk and durable staging/journal maps now reject link/junction directories for inspection, including the `data` directory itself. This narrows the risk of read-only diagnostics following links into unrelated directories.
- The six added offline regression cases and the original M3 synthetic cases run without deploying, elevating, accessing passphrases or modifying protected data. The Windows-only cases are **still not verified** on Linux.

Remaining owner-controlled blockers are unchanged: actual v7 migration assessment on the owner's machine, Windows PowerShell/ACL validation, G0b elevated named-pipe proof, G2 installed-system checks, and an explicit M4 activation decision. **Do not run the v7 installer or predeployment installer as part of this offline continuation.**

## Filesystem ledger identity protection (offline-only source update)

`FileLedgerStore` now pins the ledger's device and file ID when first opened and rechecks the pathname and the opened handle before appending or truncating. Its append open excludes `O_CREAT`; a missing ledger cannot be silently recreated by a delayed append. Replaced files, hard links and symlink substitution are refused before writes. Three temporary-file regressions cover lost, replaced and hard-linked ledger paths. These checks are independent of, and **do not replace**, the G0b elevated-boundary and G2 Windows identity/ACL/restart tests.

## Offline source integration (October 19, 2026)

The prepared command path now accepts asynchronous staged pipe intake: it checks the staged file identity, size, SHA-256, and framed operation, removes only the verified intake files **before** approval, and refuses unexpected entries. Owner confirmation and passphrase signing may also be asynchronous; synchronous synthetic callers remain supported. Register/restore approvals use the protected in-payload masking policy, not a callback supplied by the ordinary toolbox. These are **source-level changes, not permission to activate** the installed command runner. `createProductionDeps()` and the bootstrap still explicitly refuse activation.

The prepared `owner_console.mjs` exposes interactive owner review and hidden passphrase callbacks for the asynchronous approval path. It does not elevate, install or enable M4; these source helpers are inert until a separately authorized owner-controlled launch.
