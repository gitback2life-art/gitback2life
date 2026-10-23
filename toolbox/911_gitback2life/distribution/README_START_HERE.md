# 911 GitBack2Life — Email Communications development update

The project owner explicitly requested a **dedicated Email Communications tool** after the original 13-tool release. This development package therefore has **14 public tools**, including all original 13 unchanged groups. It does not add remote PC access.

## Safe Windows development staging

1. Extract the ZIP.
2. Double-click `STAGE_TO_APPROVED_TEMP.cmd`. It verifies **both** SHA-256 manifests, runs one consolidated, synthetic Windows acceptance check, and stages a new directory without overwriting previous builds.
3. Open the staged directory and double-click `TOOLBOX.cmd` to open the existing mouse-and-number-key UI. Email Communications appears as tool 14 (`0` then `5`).
4. With no owner-configured protected email backend, the Email Communications action displays **not configured** and cannot send anything.

The one-click stager uses the existing project `Temp` folder if present; otherwise it uses the current Windows user's local application-data folder. The support ZIP is saved to the current user's Downloads folder. No protected authority installation, Gmail connection, mail sending, live network check, or production deployment is performed by staging.

## Developer handoff / release limits

Read `source/911_gitback2life/email_communications/README.md` and `source/911_gitback2life/EMAIL_COMMUNICATIONS_REVIEW.md` before connecting or deploying. The change includes encrypted protected-backend draft storage, explicit content-bound human approval, Gmail send-only OAuth logic, restricted HTTPS email backend, connection management, incident timeline metadata and synthetic tests. None of the Google API account configuration, protected backend and operator credentials, or live sending has been provisioned by this package. Never distribute the server secrets or real case files in the Toolbox or a GitHub repository.

This work is based on the latest supplied Toolbox source ZIP, **not** a verified authoritative GitHub branch. No GitHub branch or PR has been created, no production branch modified, and no email sent. A review in the correct repository and controlled owner's live test remain mandatory before release approval.
