# Email Communications — handoff and release recommendation

**Source basis:** owner's latest available 13-tool `911_GitBack2Life_13_Tool_All_Workflows_Reliability_20261020.zip`, not the historical public GitHub website. Source archive was inspected and extended in a separate working copy; protected authority source was not installed or activated.

**Files added:** `email_communications/email_service.mjs`, `email_communications/protected_backend.mjs`, `email_communications/email_client.mjs`, `email_communications/email_service.test.mjs`, `email_communications/README.md`, this note. Existing registry, WinForms navigation, scope service list, relevant tests, original README note and the acceptance script updated for the dedicated owner-requested tool.

**Control boundaries:** Gmail OAuth web client secret/token stored only in protected backend configuration/encrypted backend store; `gmail.send` scope only; fixed sender; one recipient and plain text only; exact-content approval; no unattended sends; lock and in-flight checkpoint before sending; ambiguous result never retried; metadata-only timeline. For the backend to send, a separate protected authority installation and explicit owner deployment/approval are mandatory. OAuth connections remain unconfigured in this patch.

**Integration caveat:** The existing protected authority subsystem is intentionally inactive, so automated offline tests prove failure/success behavior of the new engine with mocked authorization and Gmail, **not** that real sending is deployable from this staging ZIP. The Web OAuth callback and the connected Gmail identity also require a real protected HTTPS service and consent flow. Ensure operator ACLs and deployed backend network boundaries receive human review.

**Review recommendation:** Keep as a **draft / review-only code change**. Do not merge, deploy, enable sending or claim production readiness until the real source repository and working branch are identified; a maintainer reviews this change; native Windows installation and GUI are verified; the authenticated Google account and protected owner-authorization chain are tested; and the owner explicitly authorizes a designated harmless test recipient.

## Verification evidence (this build)

Node.js full offline suite: 437 passed, 12 skipped, zero failed. Python regression suite could not be certified on this Linux environment: a Windows-only `_winapi` import and two older deployment-payload count assertions failed. The new email service tests use synthetic, non-delivering transports only. See top-level BUILD_NOTES.md. No Gmail connection or send, Windows GUI interaction, backend HTTPS integration or GitHub PR was performed.
