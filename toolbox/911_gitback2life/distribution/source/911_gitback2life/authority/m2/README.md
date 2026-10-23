# M2: commands, review renderer and register operations (change-approval design revision 3.4)

**Prototype only.**
- Nothing here is installed or used by any tool.
- It drives the M1 engine against its **simulated disk**.
- Tests sign with a **synthetic Ed25519 key** generated for the test run.
- Register `update` writes stay disabled in the toolbox; the production authority is unchanged.

| File | What it implements | Design |
|---|---|---|
| `register_rules.mjs` | The register validators and `register_update`, ported from the toolbox's Python tools and parity-tested against them | §7 |
| `renderer.mjs` | The review display: untrusted text escaped to printable ASCII, tagged fences, a gutter, counted wrapping, a 2,000-line refusal, strict UTF-8 | §13 |
| `commands.mjs` | `approveChange`: parse the ingested request, compute and validate the proposed register, refuse content masked storage would change, stage, review, confirmation code after the review, sign (injected signer), M1 commit, optional apply | §§7, 10 |
| `m2.test.mjs` | Focused tests | §20 groups F, G, end to end |

**Run** (from the toolbox folder):
```
node --import ./regression_harness/network_guard.mjs --test --test-reporter=spec authority/m2/m2.test.mjs
```

**Prototype differences, still pending:**

| Item | Milestone |
|---|---|
| Signing with the passphrase-protected key at an elevated console | M3/M4 |
| Ingestion over the real pipe server (G0b) | G0b, owner-run |
| A protected copy of the masked-storage check (the tests pass the toolbox's) | M3 |
| Restore trees and the installer | M3 |
