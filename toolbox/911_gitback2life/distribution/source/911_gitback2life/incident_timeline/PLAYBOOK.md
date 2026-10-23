# Incident response playbook for small organizations

Adapted from the gitback2life security suite incident playbook. Works for real incidents and practice exercises.
Record roles ("board_secretary", "web_volunteer"), not names or personal contact details.

| Stage | What it means | Common examples for a rescue or shelter |
|---|---|---|
| recognize | Record when and how the problem was noticed, what is known, and what is not. | A directory check reports the website redirects elsewhere; donors say the donate page looks wrong. |
| contain | Stop further harm without destroying evidence. Decide; this playbook issues no commands. | Ask the organization to pause the donate link; directory maintainer temporarily hides the website link. |
| preserve | Keep minimal evidence: UTC times, links, hashes, screenshots with metadata removed (`metadata_scrub`). | `safe_backup` of the site files; `github_evidence snapshot`; archive captures listed by `domain_research`. |
| scope | Work out what is actually affected, using evidence. | Is it the domain (registration/DNS), the host, one page, or the checker? `domain_research all <domain>`. |
| notify_assessment | Decide who must or should be told, by whom, and when. Never sent by these tools. | The organization itself, the directory maintainer, the registrar or host. Requires explicit approval. |
| recover | Restore only after the cause, access and credentials are understood. | Renew/recover the domain, reset accounts with two-step login, restore from `safe_backup`. |
| follow_up | Owner, date and corrective tasks. | Add the domain to `org_registers` with renewal date and auto-renew; schedule a review. |

## Scenarios
`website_redirect`, `domain_expiry`, `account_takeover`, `data_exposure`, `content_logging`, `service_outage`, `other`.

## Rules of thumb
- A redirect to an unrelated site has several possible causes: expired or resold domain, DNS or hosting mistake,
  a legitimate move, outdated directory data, or a compromise. Treat each as a hypothesis until evidence decides.
- Use `fact_status`: `confirmed` (seen directly), `reported` (someone said so), `unknown`, `simulated` (exercises only).
- Missing decisions stay unresolved. Record shortcomings honestly; an exercise's example answers are not evidence.
