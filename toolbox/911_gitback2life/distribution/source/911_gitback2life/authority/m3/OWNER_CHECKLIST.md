# Owner checklist: future gates G0b, G2, M4 (documentation only)

**This is not a request to run anything now.** Each gate needs the owner's separate, explicit decision. Nothing in the
toolbox performs these steps. Register `update` writes stay disabled until M4 is decided.

## Status at v15

| Gate | What it proves | Status |
|---|---|---|
| G0a | Lock, launcher, pipe prototypes (synthetic, non-elevated) | PASS (v11 review) |
| M1-M3 | Ledger, state machine, register rules, renderer, restore trees, real-file backend (including missing-ledger refusal), signer, exporter, command entry (synthetic) | PASS (synthetic, v14 and v15 logs) |
| Installer for the M3 layout | Creates the protected layout, backs up and rolls back, writes a diagnostics ZIP | **NOT AUTHORED (v14, v15).** In v14 a safety check stopped Claude writing it and said not to produce that content again, so v15 did not attempt it. Someone other than Claude must write it, and it must be independently reviewed. **Do not run the old v7 `authority/install.ps1` for M3.** |
| G0b | The privilege boundary on the real machine: the non-elevated toolbox cannot write the protected folder, ledger or keys; the launcher env proof holds when elevated | PENDING (owner-run) |
| G2 | Durability on the real machine: an interrupted approval recovers from the files alone after a restart | PENDING (owner-run) |
| M4 | Turning on production wiring and register `update` writes | PENDING (owner decision, after G0b and G2) |

## What the owner will do, only after choosing deployment

1. **Get an installer.** It must cover the M3 layout (`data/`, `staging/`, `journal/`, `evidence/`, `ledger/` with the
   lock file, the launcher, the bootstrap and `installed_manifest.json`) and be independently reviewed before use. The
   v7 `authority/install.ps1` does not cover this layout and must not be used for it. On first install, the ledger must
   be created only through `FileLedgerStore.createNew()`. Any later missing ledger is refused as lost history.
2. **Keep a backup first.** Save a copy of the current protected authority folder and its key files, and keep it offline.
3. **G0b (owner-run, elevated once).** Install to the protected folder. Then, from a normal (non-elevated) window,
   confirm that writes to the protected folder, the ledger and the key are refused. Keep the console output.
4. **G2 (owner-run).** Approve one synthetic change against a test register, interrupt it, restart, and confirm that
   `recover` completes or cancels it as recorded and that `diagnose` reports no unresolved transactions.
5. **Review.** Send the G0b/G2 outputs (with no keys or passphrases) for independent review.
6. **M4 decision.** Only then decide whether to enable production wiring. `createProductionDeps` in `cli.mjs` refuses
   until that change is made and reviewed.

## Never

- Never paste the passphrase or private key into a chat, a file, or a support ZIP.
- Never run any of this from the toolbox folder with elevation.
- Never delete `evidence/` or the ledger to "fix" a conflict. Use `adopt` or `reconcile`.
