# Google compliance inquiry — Gmail inbox assistant

**Prepared:** 2026-10-24  
**Status:** Draft for the project owner to send through the Google Cloud OAuth Verification Center/support channel. Not sent by this repository session.

## Subject

Clarification requested: personal-use Gmail gmail.readonly app, GitHub-hosted processing, ChatGPT transfer, and restricted-scope security assessment

## Message

Hello Google OAuth / API Services User Data Policy team,

I operate a single-user, personal-use application and would like written guidance on the correct compliance path before enabling it again.

The application uses the Gmail API with the restricted https://www.googleapis.com/auth/gmail.readonly scope. At my explicit request, it searches a bounded number of recent Inbox messages and uses the selected message text to answer an email-related question or produce a summary. It does not send or modify email and does not fetch attachments.

The current implementation runs on a GitHub-hosted GitHub Actions runner. Gmail message plaintext is processed transiently in runner memory, then the response is encrypted to a temporary session public key. Only ciphertext is posted as a comment to a public GitHub pull request. The ciphertext is then decrypted in my active assistant session and selected message content is transferred to OpenAI's ChatGPT service for the requested answer or summary. The public repository contains no intended plaintext email. The runner is a third-party server, and encryption occurs after plaintext processing there.

The application is for one user. I understand Google's published personal-use exception may remove the OAuth verification requirement for apps with fewer than 100 users, but that all apps must still comply with the applicable user-data policies. I also see Google's restricted-scope guidance stating that apps with access to restricted data from or through a third-party server must undergo a security assessment, and the Workspace policy listing generative-AI summaries as an approved Gmail productivity example while prohibiting one-time/manual email-export use cases.

Before any reactivation, could you please answer the following for this exact architecture?

1. **Permitted use case:** Does owner-directed, request-by-request Gmail question-answering and summarization through ChatGPT fit the approved Gmail productivity use case for generative-AI summaries, or does the request/response bridge to a separate AI service fall outside the permitted use case? What specific changes, if any, are required?
2. **Security assessment:** Does the personal-use OAuth verification exception also exempt this one-user application from the restricted-scope third-party-server security assessment, or is a CASA assessment still required because the GitHub-hosted runner processes plaintext Gmail data? Please identify the applicable assessment tier and the official process to initiate it. If an assessment is required, should I wait for a Google/App Defense Alliance notification before engaging an assessor?
3. **Limited Use and transfer to OpenAI:** Is transferring only the user-selected Gmail content to OpenAI's ChatGPT service, with explicit consent immediately before each request, permitted under the Workspace User Data and Developer Policy and Limited Use restrictions? Which OpenAI product/account controls or contractual terms must be in place to satisfy Google's restrictions on third-party transfers and AI/ML model training or improvement?
4. **Privacy policy and consent:** Is a publicly accessible privacy notice at https://gitback2life-art.github.io/gitback2life/privacy.html, together with an in-context disclosure and affirmative consent before each retrieval, sufficient in principle? Are there additional required disclosures, deletion controls, or consent records for this personal-use scenario?
5. **OAuth configuration:** Which exact OAuth consent-screen fields, verification-center submissions, scope declarations, or evidence are required for this use case if the app remains personal-use and is not intended for additional users?
6. **Written closure criteria:** Please list the requirements that must be satisfied before I enable the hosted reader, including any approval or assessment evidence I should retain.

The reader is currently paused. Its GitHub Actions workflow has a separate fail-closed compliance gate, which will remain disabled until the applicable requirements and the architecture's permitted use are resolved. I will not treat successful technical tests or the personal-use verification exception as proof of policy approval.

I can provide a sanitized architecture diagram, the exact scope declaration, the public privacy notice, and source/test evidence if needed. I will not include email contents, OAuth credentials, refresh tokens, private keys, or other secrets in this inquiry.

Thank you for clarifying the applicable policy and the required next steps.

## Official references

- Restricted-scope verification and security assessment: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Workspace User Data and Developer Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Personal-use OAuth verification exception: https://support.google.com/cloud/answer/13464323?hl=en
- App Defense Alliance CASA Tier 2 process: https://appdefensealliance.dev/casa/tier-2/tier2-overview
