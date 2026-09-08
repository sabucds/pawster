# Admins have no accounts; verification happens through signed email links

Pawster has exactly one platform admin, so building an authenticated admin area — login, session, list view, nav — would be a whole surface maintained for one person. Instead a shelter's registration emails the admin a **signed link** that opens a single unstyled page: an evidence textarea and verify/refuse buttons. Submitting it writes the verification entry, publishes the shelter's animals and mails the shelter. There is no admin account, no admin role in the auth system, and no admin UI to keep in step with the rest of the app.

## Considered Options

- **Hand-editing a row in the database console** — rejected. Verification is not a flag flip; it has side effects (the shelter's animals go live, the shelter must be told). A hand-edited row fires none of them, leaving three manual steps to remember at 11pm.
- **A minimal authenticated `/admin` route** — the runner-up. Genuinely small, but it requires admins to exist in the auth system, and it puts the action behind a login on a phone at the moment you least want friction.

## Consequences

- The map's "one auth system, for shelters and admins" narrows to **shelters only**. `Platform Admin` is a domain role with no corresponding account.
- A verification's `decidedBy` is therefore an **email address string, not a foreign key** — there is no user table to point at.
- **The admin's inbox is the admin credential.** Accepted at this stake level; mitigated by expiring links (7 days for a verification decision, 24 hours for the pending list, which enumerates every waiting shelter and is the higher-value target).
- Verification links are reusable within their window, because the decision is idempotent — a second click shows current state rather than deciding twice.
- **Revocation is deliberately not on a signed link.** It is the rare adversarial action and is done by hand. **Narrowed by [ADR 0019](0019-a-verification-entry-cites-what-the-admin-saw.md)**, which should be read with this bullet: revocation is not on a link *any email carries*, and is not reachable from any page or form, but it is performed by posting a `revocation` capability that only a maintainer at a terminal holding the platform's signing secret can mint. The letter of this sentence said "not on a signed link" and issue #53 built one; the sentence's reason — that the rare adversarial action must never be one click from an inbox — is what the narrowing preserves, and the reason revocation goes through a capability at all is that a hand-written `INSERT` delists a shelter's animals while telling the shelter nothing, which issue #45 requires it to be told.
- No cron guards the queue. A shelter is told it will hear back within 3 days and invited to reply if it doesn't, making the shelter an external dead-man's switch — the same pattern the scheduled-execution research (issue #6) landed on, and chosen for the same reason: a schedule that never fires is undetectable.
