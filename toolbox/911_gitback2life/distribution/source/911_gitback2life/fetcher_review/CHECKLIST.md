# Redirect / fetcher security review checklist

Use with `node fetcher_review.mjs scan <local copy>`. This is a code-review aid, not an exploit tool.
Never test by sending requests to real internal addresses or third-party infrastructure; use mocked
fetch/URL/DNS fixtures (see `regression_harness`).

## 1. URL provenance
- [ ] Where does each fetched URL come from (data file, user input, a page it fetched earlier)?
- [ ] Who can change that source (maintainers only, anyone with a PR, the organization's own website)?
- [ ] Is the URL normalized/validated once at input, or at every use?

## 2. Redirects
- [ ] List every call that follows redirects automatically (`redirect: 'follow'`, library defaults).
- [ ] Is each hop's destination validated before it is contacted, or only the first URL?
- [ ] Is there a maximum hop count?
- [ ] Is the *page role* (primary site vs intake/source/contact page) kept with each result?

## 3. Destination restrictions
- [ ] Schemes limited to http/https?
- [ ] Credentials in URLs rejected?
- [ ] Ports restricted?
- [ ] Private, loopback, link-local (incl. 169.254.169.254 cloud metadata), multicast and reserved IPs blocked, for IPv4 and IPv6, including IPv4-mapped IPv6?
- [ ] DNS answer validated and *pinned* for the connection (DNS-rebinding / TOCTOU)?

## 4. Resource limits
- [ ] Timeouts on connect and total time?
- [ ] Response size cap, and is the body read at all when only headers are needed?
- [ ] Concurrency and retry limits?

## 5. Content handling
- [ ] Is fetched content ever executed, rendered, or written to disk?
- [ ] Is fetched content echoed into logs, issues, or commits (possible injection or secret leakage)?

## 6. Runtime network policy
- [ ] What does the CI/runtime environment actually block? Cite the workflow/config file, do not assume.
- [ ] Would a hosted runner reach anything sensitive if a guard failed?

## Reporting
- Label each item: confirmed (shown in code at a cited commit/line), conditional (risk if X), or not assessed.
- A redirect-handling weakness is **conditional** unless a path and impact are demonstrated safely offline.
