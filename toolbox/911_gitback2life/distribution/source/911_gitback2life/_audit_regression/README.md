# Adapted copies of the second-round audit's regression tests

The independent second-round audit (SECOND_ROUND_AUDIT.md) shipped three test files. They imported an
extracted copy of the v2 bundle. Those originals are **preserved unchanged** outside this toolbox, as evidence.
The files here are **separate copies adapted to run against the working toolbox**:

| File here | Original (unchanged) |
|---|---|
| `audit_adversarial.test.mjs` | `audit_adversarial.mjs` |
| `audit_transport.test.mjs` | `audit_transport.mjs` |
| `test_audit_adversarial.py` | `audit_adversarial.py` |

Run them from the toolbox folder:

```
node --import ./regression_harness/network_guard.mjs --test --test-reporter=spec _audit_regression/audit_adversarial.test.mjs _audit_regression/audit_transport.test.mjs
python -I _audit_regression/test_audit_adversarial.py -v
```

The `.test.mjs` names mean the normal suite (`"*/*.test.mjs"`) runs them too.

## What was changed, and why

Nothing in an assertion was loosened to make a test pass. Every change is one of the following.

### 1. Plumbing (all three files)
- Imports point at the working toolbox instead of the extracted audit copy.
- Fixtures are created in a throwaway folder under `.test_tmp/` (named `audit-<uuid>`) and removed afterwards.
  The toolbox owner's rule is that nothing is created outside the toolbox folder.
- "Outside the toolbox" is therefore **simulated**. Node uses `safeWrite`'s `root` option with a stand-in box
  and a sibling `outside` folder, both inside the throwaway folder. Python patches `gb2l_core.TOOLBOX_ROOT` the
  same way. The boundary under test (a write must not leave its root) is the same; only the location differs.

### 2. Originals kept as `test.skip`, each next to a replacement (interface changed by an architectural fix)
| Original | Why it cannot pass as written | Replacement checks the same boundary by |
|---|---|---|
| F01 "approval cannot be manufactured without human interaction" | Under the chosen attestation model, any process that can write the scope file can write an attestation. The toolbox has no protected approval authority, so no honest code can make this pass. | `F01 replacement`: old "human-only" records (`approved_via`/`check`) are refused; an attestation's result says it is "an operator's statement, not proof that a person approved"; the policy files must not claim automated processes cannot approve. The residual weakness is asserted openly in `incident_intake.test.mjs` ("KNOWN LIMIT (F01)"). |
| F02-live "redirect requires approval for each exact destination" | It injects the old domain-only `allowHop` (`inScope`), which is exactly the check that was replaced. | `F02 live replacement`: uses the real CLI authorizer `liveHopAuthorizer`. The redirect to an unattested URL is not contacted; once that exact URL is attested it is. |
| F04 "sandbox cache junction is compatible with safe writes" | It asserts that the sandbox script creates a junction and that `safeWrite` writes through it. Passing would need the junction guard disabled, which the task forbids. | `F04 replacement`: the script contains no junction and sets `GITBACK2LIFE_STATE_ROOT = 'C:\gb2l-state'`; only that exact state root is accepted; writes to a directly addressed state root work; a junction inside it is still refused. |

### 3. One-line additions
- **F02 passive test:** `.catch(() => {})` was added after `politeFetch(...)`. The fix refuses the redirect by
  **throwing** (fail closed); the original awaited without a catch, so the refusal itself failed the test. The
  assertion (`outside.example` never contacted) is unchanged.

### 4. Python
- `scope()` in the original is the minimal four-field object the audit showed Python wrongly accepted (F12). It is
  kept as `minimal_scope()` and used **only** in the F12 test, which now expects it to be rejected. Tests that need
  a permitting scope use a complete scope (`scope()`), because Python now validates the same shared contract
  as Node (`_shared/scope_schema.json`).
- F11 is split in two: F11a uses the real CLI with a junction inside the toolbox, and F11b uses `run()` with a
  stand-in root and a junction to a sibling "outside" folder (the escape the audit reproduced). Junctions are
  made with `_winapi.CreateJunction` (no admin rights needed).

## v6 independent review (v7 round)
| File here | What it is |
|---|---|
| `v6_independent_checks.test.mjs` | Adapted copy of the reviewer's Node checks (original preserved unchanged in the v6 audit folder). Only the import paths and fixture folder changed; assertions unchanged. |
| `test_v6_independent.py` | Adapted copy of the reviewer's Python checks (same rules). |
| `test_v6_replacements.py` | A **replacement** for the reviewer's V6-01 Python check, kept beside the unchanged original. v7 moved signed authorizations into the protected folder, so the original passes for a weaker reason (no authorization found at all). The replacement stores the signature where v7 looks, adds a control showing it verifies, then repeats the reviewer's swap at verify time and asserts the unsigned scope is still refused and that the verifier received the bytes Python parsed. A third test repeats the swap at the **persistence recheck** (before a write) and asserts the protected authority refuses it and no output exists. |
| `v7_regressions.test.mjs` | The toolbox's own regressions for V6-02 to V6-07, initialization and the privileged write (pinned PowerShell including a planted `powershell.exe` on PATH; rights cases with Python parity; malformed images; zip regions; JSON masking with Python parity; detection with files and dangling junctions; init lifecycle; approve writing only inside the protected folder). |
| `test_v7_regressions.py` | Python: the backup image rule (core-only images kept byte-for-byte, anything else refused for backups); the JPEG rebuild (post-scan metadata dropped, trailers refused); ACL reads using the pinned PowerShell with a constructed environment. |

## v7 independent review (v8 round)
| File here | What it is |
|---|---|
| `v7_independent_checks.test.mjs` | Adapted copy of the reviewer's v7 Node checks (original preserved unchanged in the v7 audit folder). Only imports and the fixture folder (under `.test_tmp`, removed afterwards) changed; assertions unchanged. |
| `test_v7_independent.py` | Adapted copy of the reviewer's v7 Python checks, including the two update-approval tests (V7-01). ROOT and fixture cleanup only; assertions unchanged. |

`v7_regressions.test.mjs` and `test_v7_regressions.py` gained tests for this round: PNG transparency, palette and padding rules; exact JPEG segment structure; zip entry names; sensitive JSON objects (all with Python parity); and update commands refusing for lack of approval (and only after the change validated).

## v8 independent review (v9 round)
| File here | What it is |
|---|---|
| `v8_independent_checks.test.mjs` | Adapted copy of the reviewer's v8 Node checks (original preserved unchanged in the audit folder). Imports point at the toolbox; the test's output folder (`root`) is a fresh `.test_tmp` folder, removed afterwards. Assertions unchanged, including the control that the pixel still uses index 255: V8-01 was fixed by clearing unused entries in place, not by renumbering. |
| `test_v8_independent.py` | Adapted copy of the reviewer's v8 Python checks. Its inputs are the reviewer's two evidence files, copied byte-for-byte into `fixtures/v8/` (the original reads them from beside itself, where the original Node test saved them). One added sanity check confirms each fixture carries the synthetic token. Outputs are removed in tearDown. Assertions unchanged. |
| `v8_regressions.test.mjs` | Own tests: sparse indices across 1/2/4/8-bit and several rows, with rendered colour and alpha compared by an independent decoder; persisted bytes (Node `safeWrite` and the Python storage path); exact backups (dirty refused, clean kept byte-for-byte); padding cleanup; bounded decompression (overrun, overrun by one byte, truncated, short, trailing, concatenated, over budget, with Python parity); an instrumented check that Python asks zlib for at most the expected size plus one byte and never flushes. |

## v9 independent review (v10 round)
| File here | What it is |
|---|---|
| `v9_independent_limits.test.mjs` | Adapted copy of the reviewer's Node decompression instrumentation (original preserved unchanged in the v9 audit folder). Only the import path changed; assertions unchanged. |

`v8_regressions.test.mjs` gained one check pinning the corrected size examples in `image_policy.mjs` (V9-D01): an 8K RGB header is refused before decompression; 4K RGBA and 4096 x 4095 RGBA fit the budget.

```
python -I _audit_regression/test_v6_independent.py -v
python -I _audit_regression/test_v6_replacements.py -v
python -I _audit_regression/test_v7_regressions.py -v
python -I _audit_regression/test_v7_independent.py -v
python -I _audit_regression/test_v8_independent.py -v
```

## Tests added outside this folder
Each fix also has tests in the tool's own test file, for example:
- `common.test.mjs` (F05 hardlink)
- `incident_intake.test.mjs` (F01 attestation, F12 mid-run stop)
- `polite.test.mjs` (F06 lock and transient reuse)
- `output.test.mjs` (F08)
- `case_packet.test.mjs` (F09)
- `ledger.test.mjs` (F10)
- `domain_research.test.mjs` (derived-target authorization, `deny_actions`)
- `test_python_tools.py` (F12 schema parity)
