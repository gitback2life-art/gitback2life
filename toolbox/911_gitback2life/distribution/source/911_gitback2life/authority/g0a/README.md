# G0a: synthetic, non-elevated prototype (change-approval design revision 3.2)

**Prototype only. Nothing here is installed, used by any tool, or able to write protected data.**
- The production authority, `install.ps1` and the register writes are unchanged.
- Register `update` writes stay disabled.
- No real key or passphrase exists anywhere in this folder.

| File | What it prototypes | Design |
|---|---|---|
| `exclusive_lock.mjs` | The command-wide lock: an OS-held exclusive open handle (libuv `UV_FS_O_EXLOCK`, `0x10000000`), with a startup self-test and bounded waiting | §5 |
| `launcher/authority.cmd` | The trusted launch boundary: `cmd /d /s /c`, an environment cleared without any child `cmd`, argument checks without `findstr` or a pipe, an absent optional argument omitted | §14.1, [3.1], [3.2] |
| `launcher/bootstrap.mjs` | The built-ins-only bootstrap: exact flags and environment; module hashes verified **before** dynamic `import()`; testkit refused; a constructed environment for the PowerShell helper | §14.1 |
| `launcher/prototype_module.mjs`, `launcher/helper_env.ps1` | Stand-ins for a protected module and the PowerShell helper | |
| `request_pipe.mjs` | Request ingestion: frame format, bounds checked before allocation, streamed staging, end-of-stream and timeouts, name rules, one connection, local pipe names only | §6, §7, §14.3 |
| `lock.test.mjs`, `launcher.test.mjs`, `frame.test.mjs` | The G0a tests | §20 groups B, C, D (protocol half), I-21, I-22 |

**How to run** (from the toolbox folder; Windows; non-elevated):
```
node --import ./regression_harness/network_guard.mjs --test --test-reporter=spec authority/g0a/lock.test.mjs authority/g0a/launcher.test.mjs authority/g0a/frame.test.mjs
```
- The launcher tests run against **throwaway copies** in a temporary folder.
- The pipe tests use random `\\.\pipe\gb2l-<hex>` names and temporary staging folders.
- These tests are one folder deeper than the normal suite's `*/*.test.mjs` pattern, so they run only when named.

**Prototype differences from production:**
- The bootstrap uses its own folder as the authority root, because the tests run it from throwaway copies; production
  uses the fixed constant.
- The bootstrap verifies the module hashes against a test-written manifest, not one whose hash is anchored in the
  ledger genesis record (that is M1).

**Not done here, and not claimed:**

| Item | Gate | Why it is not done here |
|---|---|---|
| The elevated pipe server's privilege boundary: first-instance flag, DACL, remote-client rejection, medium versus elevated client (impersonation) | **G0b, owner-run** | Needs an elevated process |
| Per-user AutoRun **not** running inside the launch: the design avoids every child `cmd`, but the behaviour was not exercised | **G2, owner-run** | Setting a per-user AutoRun registry value would modify the owner's machine |
| The lock file's ACL in the real protected folder (no Users entry) | **G2** | The installed folder is not created in G0a. A synthetic ACL fixture on a temporary file was tested. |
| Ledger, sessions, epochs, decisions, reconcile, recovery | **M1** | Not G0a scope. Conditions 2 and 3 are specified in design §1b and are tested in M1. |
