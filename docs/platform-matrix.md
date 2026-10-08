# gitback2life — Platform Matrix

Last reviewed: 2026-10-08

| Platform | Intended use | Cost | Current status | Notes |
|---|---|---:|---|---|
| GitHub | Source code + public project history | Free tier | Ready | Public repository: gitback2life-art/gitback2life |
| GitHub Pages | Primary static project site | Available with eligible public GitHub Free repositories | Needs one-time manual Pages source setup | Workflow is prepared for GitHub Actions; repository Settings → Pages → Build and deployment → Source must be set to GitHub Actions before the first manual deployment. |
| Cloudflare Pages | Alternative static hosting | Free plan | Backup | Candidate for a later second deployment path. |
| Hashnode | Developer writing / build journal | Free account | Candidate | Re-check current terms, publishing rules, and account requirements immediately before use. |
| Codeberg | Secondary public code home / independence backup | Free account | Candidate — not adopted | Community-driven nonprofit software forge built on Forgejo. Strong values/privacy fit, but public projects are expected to use a suitable free/libre license. Do not create a mirror until licensing and the value of a second code home are explicitly decided. |
| Reddit / r/Assistance | Possible support request | Free | Later | Current requester eligibility and posting rules must be checked immediately before use. |

## Recommended order

1. Finish/verifiy GitHub Pages setup.
2. Document the existing task-management project.
3. Establish one developer-writing presence only if it serves a clear purpose.
4. Establish a secondary code home only when it serves a real purpose.
5. Build genuine community participation before any support request.

## Current OpenAI support research

OpenAI's current Help Center documents two separate mechanisms:
- **ChatGPT gift cards:** currently available for purchase/redemption in the United States, with eligibility depending on account/billing conditions.
- **Gifting credits:** a separate feature that is rolling out gradually and has its own purchase/redemption requirements.

These are research findings, not a permanent project promise. Verify the current official documentation immediately before publishing or initiating a support transaction.

## Verification sources

- GitHub Pages publishing: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- GitHub Pages automatic deployment: https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically
- OpenAI gift cards: https://help.openai.com/en/articles/20001491-buying-and-redeeming-openai-gift-cards
- OpenAI gifted credits: https://help.openai.com/en/articles/20001417
- Hashnode Code of Conduct: https://hashnode.com/code-of-conduct
- Hashnode Terms: https://hashnode.com/terms
- Codeberg FAQ: https://docs.codeberg.org/getting-started/faq/
- Codeberg Pages: https://docs.codeberg.org/codeberg-pages/
- r/Assistance rules: https://www.reddit.com/r/Assistance/wiki/rules/

## Rule

Re-check platform terms immediately before creating an account, publishing, or requesting support. This document is a planning record, not a permanent guarantee of eligibility.


## Codeberg fit

Codeberg is a community-driven nonprofit software-development platform built on Forgejo. It provides public Git repositories and related project tools, plus Codeberg Pages. It is a potential secondary public code home for gitback2life rather than a replacement for GitHub. citeturn442924search2turn442924search3turn224766search2

For this project, the main potential benefits are resilience/independence from one hosting provider, a second public location for the source, and alignment with a free/libre/privacy-friendly community. The main reasons not to add it immediately are maintenance overhead and Codeberg's expectation that public works carry a suitable free/libre license. citeturn442924search1turn442924search0

Current recommendation: **candidate only**. GitHub remains the primary project home.

## Public code licensing

The repository currently uses a custom `LICENSE.txt` rather than a standard open-source license.

This is now a deliberate decision point before any Codeberg mirror is created. GitHub notes that a public repository without an open-source license does not grant the broad reuse rights associated with open source. Codeberg recommends standard free/libre licensing and warns against unnecessary custom-license proliferation. citeturn421314search1turn705930search0

A new GitHub issue tracks the decision: **#10 — Decide public code licensing**.

No license change has been made.