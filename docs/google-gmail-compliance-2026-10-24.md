# Google Gmail data-use compliance — 2026-10-24

## Current status

**Hosted inbox access remains paused.** Request-channel PR #41 is closed while compliance work is prepared. The hosted workflow now requires a separate GB2L_INBOX_GOOGLE_COMPLIANCE_READY=true variable in addition to the existing enable flag. Keep the new variable unset or false until the external requirements below are satisfied.

This note records policy requirements and implementation status. It is not a claim that Google has approved the application or that an independent security assessment has passed.

## Project facts

- This is a personal-use project with one user.
- The hosted reader uses the Gmail gmail.readonly scope.
- The workflow runs on a GitHub-hosted ubuntu-latest runner.
- The reader processes Gmail message text on that runner before encrypting the response.
- The encrypted response is posted as a comment on a public GitHub pull request. Message plaintext is not intended to be logged or posted to GitHub.
- The intended feature is to retrieve relevant messages on the owner's explicit request so ChatGPT can answer a question, summarize, or analyze them.

## Google policy facts

1. Google's personal-use exception generally removes the OAuth verification requirement for an app used by fewer than 100 users. Google says all apps still must comply with its API Services User Data Policy.
2. Google lists productivity features such as generative-AI summaries among approved Gmail-scope use cases and lists one-time or manual email-export applications among disallowed use cases. The actual application behavior must fit an approved case; changing its name is not sufficient. Google has not approved this exact request-and-return architecture, so the allowed-use-case classification remains open.
3. Google classifies Gmail scopes that read message bodies or metadata as restricted. Its current restricted-scope verification guidance says apps able to access restricted data from or through a third-party server must undergo a security assessment by a Google-approved assessor and describes reassessment at least every 12 months.
4. Google requires a public privacy policy, clear in-context disclosure of data accessed and sharing, affirmative consent immediately before collection, minimum necessary permissions, user help for managing and deleting data, and compliance with the Limited Use restrictions. Publishing a privacy policy alone does not satisfy all of these requirements.
5. Google's Limited Use rules restrict transfers to those needed to provide the approved, prominent user-facing feature and only with user consent. They restrict use of Google user data to train or improve AI/ML models beyond the user's personalized model for that feature. The selected OpenAI service and account settings must be checked against this requirement before reactivation.
6. Personal use is a stated exception to OAuth verification, but the published third-party-server security-assessment requirement does not state that personal use waives the assessment.

## Official sources checked on 2026-10-24

- Google Workspace User Data and Developer Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Restricted scope verification and security assessment: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Personal-use OAuth verification exception: https://support.google.com/cloud/answer/13464323?hl=en
- App Defense Alliance — CASA Tier 2 process and notification: https://appdefensealliance.dev/casa/tier-2/tier2-overview
- App Defense Alliance — self-initiated assessment details: https://appdefensealliance.dev/casa/casa-self-start

## Work prepared in this repository change

- Expanded privacy.html, already linked from the public site, to disclose the Gmail assistant's data access, processing path, sharing, retention boundaries, consent, and deletion controls.
- Added an explicit per-request consent requirement to the assistant client and encrypted inbox protocol. The request contains the consent notice version and UTC timestamp; requests without the attestation are rejected.
- Bumped the request protocol from V1 to V2 so older requests without the consent attestation are rejected.
- Added a fail-closed runtime and workflow gate. The hosted reader cannot run unless GB2L_INBOX_GOOGLE_COMPLIANCE_READY=true is explicitly configured.
- Closed request-channel PR #41 to stop new hosted reads while compliance remains unresolved.

## External steps still required before re-enabling

1. **Assessment applicability first:** Check the Google Cloud OAuth project's owner/developer email for an official CASA notification and ask Google's OAuth verification support in writing whether the personal-use exception applies to the separate server-side assessment requirement for this exact architecture. Google's restricted-scope page states that every app with restricted-data access through a third-party server must undergo an assessment, while listing personal use under verification exceptions without explicitly saying it waives the assessment. App Defense Alliance says Google/its partners initiate required Tier 2 CASA by notification and warns the old self-scanning process is deprecated. Do not buy a self-initiated Tier 3 assessment before Google confirms which assessment is needed. If Google confirms that assessment is required, follow the official notification and use the Google-approved assessor; reassessment is at least every 12 months.
2. **OAuth configuration:** After the privacy page is published on GitHub Pages, set the OAuth client's privacy-policy URL to https://gitback2life-art.github.io/gitback2life/privacy.html. This Google Cloud Console change cannot be made through the GitHub repository.
3. **Consent operation:** For each new request, the assistant must display the in-context disclosure and wait for an explicit affirmative response immediately before creating an encrypted V2 request. The client refuses to prepare a request without consent_confirmed=True.
4. **Confirm the actual use case and AI data handling:** Ensure Google's approved Gmail-use-case rule accepts this exact request-driven email question-answering workflow; confirm that the selected OpenAI service and account settings satisfy Google's Limited Use restrictions. Do not infer approval from a successful technical test.
5. **Validation:** Run inbox tests and workflow checks. Review the OAuth grant, privacy notice, deletion instructions, and consent flow. Keep the GitHub Actions compliance-ready variable unset or false until steps 1–4 are complete.
6. **Resume deliberately:** Reopen PR #41 and set GB2L_INBOX_ENABLED=true and GB2L_INBOX_GOOGLE_COMPLIANCE_READY=true only after the above requirements are done and recorded.

## Important limitation

A repository change cannot purchase or perform Google's independent security assessment, configure the Google Cloud OAuth consent screen, or certify that Google will accept the architecture. This change prepares the controls and documentation, and keeps the hosted feature paused. It does not represent external approval.
