# v16 predeployment installer SOURCE CANDIDATE — not run

This module was added by independent reviewer as a **fresh-install predeployment candidate**, because Claude v15 did not author the new installer. This is deliberately **not a production-authority activation**. It copies verified code and establishes a protected layout, then leaves genesis, keys, approval signing, and protected writes **disabled**.

- `owner_predeployment.cmd`: one-click non-elevated **read-only plan**; verifies every bundled payload fingerprint, prints a plan, writes a redacted diagnostic support ZIP. No install.
- `owner_predeployment_PROTECTED_ONLY.cmd`: **not to be run now**. After separate owner authorization, an elevated console invokes `-Deploy`, with a typed confirmation. It never auto-elevates or migrates a pre-existing authority.
- `owner_predeployment.ps1`: preflight, default plan, protected fresh layout, explicit ACL split, copy and hash verification, lock-file ACL, safe refusal on existing installed roots, rollback of only a brand-new folder, compact diagnostics ZIP.
- `payload/` and `payload_manifest.json`: fixed modules/source filenames with SHA-256, generated for this delivery.
- `bootstrap_predeployment.mjs`: installed as `bootstrap.mjs`, verifies environment and known hashes then **always refuses** until later gates. It is not the real production bootstrap.

## Crucial incomplete items (do not misrepresent)

1. The design's owner-reviewed runtime hash, pinned ledger-genesis hash, and complete production bootstrap are not implemented. An installation-time measured hash is only a preliminary fingerprint, *not independent trust*.
2. First-time genesis/key creation and protected production command plumbing are gated by M4. No ledger is created by this candidate. Production authority is non-operational after predeployment.
3. Existing v7 installations require a separately designed, owner-approved migration. This first-install candidate refuses any existing authority folder. It must never overwrite a ledger, key, master, approval, journal or evidence.
4. Windows PowerShell 5.1 behavior, ACL inheritance/ownership, Windows filesystem semantics, reparse/hard links and elevated named pipe controls are **not yet owner tested**. The code has only static non-elevated review in a Linux environment. G0b and G2 are still pending.
5. This is intended as source for expert review and for Claude's downstream integration; **do not run deployment** on the owner's machine yet.

## How to progress without more micro-batches

Review this full v16 source in one pass, correct any actual safety defect, then prepare an owner-run acceptance plan for the existing G0b/G2 gates. Do not repeat unrelated M1/M2/M3 tests. Do not enable M4 or pretend these source-only checks are Windows deployment proof.

## v16.1 safety correction (source only)

The deployment script now refuses competing destination creation atomically via `CreateDirectoryW`, verifies installed ACL rules by reading them back, and preserves any unknown/modified files during rollback. Support ZIP names are unique. These are source changes, **not Windows-tested**. See the top-level README and checks/installer_safety_changes.diff.


## Offline source continuation (2026-10-18 follow-up)

The reviewed source package includes `m3/offline_readiness.mjs`, fail-closed diagnostic dispatch functions, and stricter first-time ledger preflight. `build_payload.py` copies these files into a source-only payload and refreshes `payload_manifest.json` hashes. This synchronizes review bytes **only**. The bundled bootstrap still intentionally refuses every invocation; the PowerShell candidate remains **unverified on Windows and not authorized to run**. No source changes in this continuation imply permission to deploy, migrate a v7 authority, sign, initialize the genesis ledger, or activate protected register updates.

## Offline engineering batch: strict source/payload verification (2026-10-18)

- `verify_payload.py` is a **read-only source-tree checker**, not a trust anchor, installer, or installed-authority verifier. It permits exactly 15 review modules, checks SHA-256 and byte counts against the fixed source locations, rejects unknown payload files/directories, reparse points/symlinks, hard-linked files and manifest collisions. It never opens the installed protected authority root.
- `build_payload.py` now preserves unfamiliar files instead of recursively deleting and replacing `payload/`. It atomically replaces only known source-derived files and writes the manifest last. An interrupted export may leave a mismatching manifest and must be treated as a refused payload until reviewed/rebuilt; it is not a production deployment.
- The PowerShell predeployment source candidate's `CheckManifest` now walks every payload directory explicitly and refuses unlisted folders, links/junctions and case-insensitive name collisions instead of relying on a file-only recursive enumeration. **This changed PowerShell code has not been executed or accepted on Windows.**
- An additional M3 backend fix pins the real ledger's filesystem identity and opens existing files for append *without create*. A disappeared/replaced/hard-linked ledger refuses mutation; synthetic tests run only against temporary files.
- Offline verification: `python -m unittest discover -s _audit_regression -p test_deployment_payload_verifier.py` (9 pass) and `node --import ./regression_harness/network_guard.mjs --test authority/m3/m3.test.mjs` (17 pass, 4 Windows-only skipped). **No owner gate, installation, ACL readback, migration, M4 or G0b/G2 authorization was performed.**

## October 19 source continuation

The inactive payload now contains the protected `m2/masking.mjs` policy alongside the M2 approval workflow (17 reviewed source modules). The PowerShell source candidate also applies the C# `SecurityAttributesSize()` workaround for the previously observed PowerShell 5.1 marshalling failure. It has not been run on Windows after this source update. No deployment, installer activation, migration, owner grant, or installed-authority change is implied. Temporary development/test packages use the owner-designated project `Temp` folder, not `C:\ProgramData`.
