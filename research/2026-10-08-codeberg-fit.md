# Codeberg — What It Is and Whether gitback2life Should Use It

**Research date:** 2026-10-08

## What is Codeberg?

Codeberg is a community-driven, non-profit software-development platform operated by Codeberg e.V. It is a hosted software forge built on Forgejo, a free/libre Git hosting platform.

In practical terms, think of it as:

**GitHub-like project hosting, but built around a nonprofit/free-software community rather than a commercial company.**

Codeberg provides public Git repositories plus common project tools such as issues, pull requests, releases, wikis, and repository activity. It also offers Codeberg Pages for publishing static websites. citeturn442924search2turn442924search3turn224766search2

Codeberg describes itself as a privacy-friendly alternative to commercial services such as GitHub. Most of its services run on its own hardware in Berlin, with some supporting infrastructure provided elsewhere. citeturn442924search2turn442924search1

## Why might gitback2life use it?

### 1. A second home for the code

Right now GitHub is the primary home of gitback2life.

A separate Codeberg repository could provide an independent public copy of the project's source. That reduces dependence on one hosting provider and gives the project another place people can find the work.

This is a resilience/independence benefit, not a requirement.

### 2. It matches the project's values

gitback2life is already trying to keep costs low, protect pseudonymous identity, document real work, and build toward greater independence.

Codeberg is explicitly nonprofit, community-driven, free/libre-oriented, and privacy-friendly. That makes its philosophy more compatible with the project's direction than simply opening another commercial social account. citeturn442924search2

### 3. It may put the project in front of a different technical community

Codeberg is centered on free/libre software development. That means the useful audience there is likely to be more interested in source code, documentation, issues, and open collaboration than a general social-media audience.

That is potentially useful for a technical project, but the project should not assume it will automatically produce traffic, followers, or opportunities.

### 4. It provides another static-site option

Codeberg Pages can host static websites on a codeberg.page address or a custom domain. It supports repository websites and user/organization websites. citeturn224766search2

That could become useful later, but gitback2life already has GitHub Pages working. We do not need a second website host simply because one exists.

## Why should we NOT rush to use it?

### It adds maintenance

A second code host means another account, another repository, another place to update documentation, and another place to protect privacy.

Duplicate infrastructure is only worthwhile when it gives us a real benefit.

### Codeberg is specifically oriented toward free/libre software

Codeberg says it expects public projects to attach a suitable free/libre license so others can reuse and adapt the work. It also says it is not intended to be a general-purpose host for commercial/proprietary projects. citeturn442924search1turn442924search0

The gitback2life repository currently does not have a root LICENSE file.

That means we should **not create a Codeberg mirror yet**. First we need an explicit project decision about licensing the public code.

### A mirror is not automatic

Codeberg does not encourage unattended mirrors that continuously pull from other hosting sites because those mirrors have historically consumed substantial resources. Its documentation recommends manual mirroring with Git when a mirror is actually needed. citeturn442924search1

So we should think of Codeberg as a deliberate secondary project home, not an automatic GitHub duplicate.

## Privacy fit

Codeberg's documentation says repositories can be public, and profile visibility can be configured. A public profile makes non-private repositories visible to everyone; a limited profile can restrict repository visibility to logged-in users. citeturn224766search5

For gitback2life, the intended setup would be a public pseudonymous project account, using only the project identity and dedicated project contact information.

The fact that Codeberg emphasizes privacy is a positive fit, but it does not remove the need to review every profile field before publishing.

## My recommendation

**Do not create the Codeberg account yet.**

The idea is worth keeping, but it is not our next task.

The correct sequence is:

**GitHub primary home → public documentation → decide whether the project's source should be explicitly open-licensed → only then consider Codeberg as a secondary code home.**

That keeps the project simple and prevents us from creating infrastructure merely because we can.

## What Codeberg would add if we eventually use it

The most sensible future role would be:

**Codeberg = secondary public code home / independence backup**

Not:

- another social-media account
- a replacement for GitHub right now
- another website we have to maintain
- a promise of additional traffic
- a reason to duplicate every project process immediately

## Current decision

**Status: Candidate — not adopted.**

The project has documented why Codeberg might be useful and why it should not be added yet.

A future decision should be based primarily on:

1. whether we want the public source explicitly open-licensed;
2. whether a second code home provides enough resilience/discovery value to justify maintenance;
3. whether the project has enough public code worth mirroring.

## Official sources

- Codeberg: What is Codeberg? https://docs.codeberg.org/getting-started/what-is-codeberg/
- Codeberg FAQ: https://docs.codeberg.org/getting-started/faq/
- Codeberg licensing: https://docs.codeberg.org/getting-started/licensing/
- Codeberg repository guide: https://docs.codeberg.org/getting-started/first-repository/
- Codeberg Pages: https://docs.codeberg.org/codeberg-pages/
- Codeberg repository permissions/privacy: https://docs.codeberg.org/collaborating/repo-permissions/
