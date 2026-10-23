# M1: synthetic ledger and state-machine prototype (change-approval design revision 3.3)

**Prototype only.**
- Nothing here is installed or used by any tool.
- It works against a **simulated disk**, never the real filesystem.
- Its tests generate a **synthetic Ed25519 key** that exists only for the test run.
- Register `update` writes stay disabled; the production authority is unchanged.

| File | What it implements | Design |
|---|---|---|
| `ledger.mjs` | The record format (length bounded before slicing, sequence, chain, checksum), read-only verification (intact / torn / corrupt), and append only at a verified end | §4 |
| `engine.mjs` | The startup order; sessions; scopes, stops, denies and revocations as authorization events; approve commit (T1); apply with journal, consumption and per-target re-checks (T2 to T8b); recovery (T9 to T16); signed single-use decisions embedded in the ledger (recovery decisions, `adopt`, `reconcile`); new epoch (T18); read-only `diagnose` | §§4, 8, 9, 11, 12 |
| `m1.test.mjs` | Focused tests, including conditions 2 and 3, the decision crash window, and crash injection at every apply step | §20 groups A, B, D, E, F, I |

**Run** (from the toolbox folder):
```
node --import ./regression_harness/network_guard.mjs --test --test-reporter=spec authority/m1/m1.test.mjs
```

**Not in M1** (later milestones):
- the interactive display, ingestion over the pipe, and the real command-line entry points (M2);
- restore trees, the installer and the toolbox request builders (M3);
- anything elevated or installed (G0b, G2, M4).

In M1, a simulated crash is an exception thrown at a named point. It leaves the simulated disk and the ledger
exactly as written, which models a **killed process**. **It is not a power-loss test**; power-loss states are
addressed in the design (§15) and remain simulated-state checks.
