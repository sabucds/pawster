# A verification entry cites what the admin saw, and drifting from it emails the admin

[ADR 0003](0003-verification-is-an-append-only-log.md) rules out an expiry job for verification, and
[ADR 0002](0002-no-admin-accounts.md) rules out a cron over the verification queue — both on issue
#6's finding that a scheduled writer which never fires is undetectable. That leaves a real gap the
two ADRs name but do not close: a shelter is checked against the public presence it had on the day,
and nothing re-checks it afterwards. A verified shelter can rename itself and replace every contact
point, and the entry that verified it still reads as current.

So **a verification entry stores a snapshot of the two artifacts it attests to** — the shelter's
display name and its set of contact points, exactly as the decision page rendered them — and **when a
verified shelter edits away from that snapshot, the admin is emailed once.** The check gets a
dead-man's switch instead of a schedule: nothing runs on a timer, and the one event that can
invalidate a judgement announces itself.

## Considered options

**Match the evidence text against the shelter's fields.** The obvious reading of "the contact point
the admin cited" is the one the admin typed into the evidence box. Rejected: it is substring matching
over free prose, so `instagram.com/refugiolosteques` in the evidence would not match
`@refugiolosteques` in the contact point, and a WhatsApp number written with spaces would not match
one written without. It fails in both directions — silently missing the drift it exists to catch, and
firing on a coincidence — and neither failure is visible to anyone.

**Re-verify on a schedule.** Rejected by ADR 0003 and ADR 0002 before this ticket existed, and the
reasoning is unchanged: a job that quietly stops running leaves every shelter looking freshly
checked.

**Store nothing and compare against the shelter row.** There is nothing to compare against — the
shelter row *is* the current values. A snapshot is the only way to know what the admin was looking
at, which is why it belongs on the entry rather than anywhere else.

**Ask the admin which artifacts they cited.** A checkbox per contact point on the decision page.
Rejected as a form that would be filled in wrongly at 11pm: everything on the page was in front of
the admin, so the honest snapshot is all of it, and asking a person to mark which parts of what they
just read counted is a question with no wrong-looking answer.

## Consequences

- **The snapshot is what a page rendered, so what the page renders is now load-bearing.** The
  decision page shows the display name and the contact points and deliberately does not show the
  account email; if it ever grows another shelter fact, that fact is either cited or it is not, and
  the answer has to be decided rather than inherited.
- **Contact points are compared as a set, so reordering is not a drift.** The order decides which
  channel an adopter is offered first, which is a real decision (`CONTEXT.md`, *Contact Point*) — but
  every channel on the list was in front of the admin, so promoting one checked channel over another
  is not a change to what was checked. The stored form is sorted, which makes that property a
  property of the encoding rather than of the comparison.
- **The switch fires on the transition, not on the mismatch.** One email per drift, so a shelter that
  keeps editing after the first warning does not keep mailing the admin, and a verified shelter is
  not an unbounded mail tap. A shelter that restores the cited values and then changes them again
  sends a second email, which is correct: the site matched what was checked, and then stopped.
- **A refused or pending shelter's edits send nothing**, because nothing of theirs is visible and
  there is no stale check to warn about — the same reason ADR 0008 never nudges those shelters.
- **`decidedBy` comes out of the signed link, not out of configuration.** ADR 0002 made it "an email
  address string, not a foreign key"; this adds that it is the address *a link was sent to*, so a
  later change of admin cannot rewrite who decided what.
- **Admin links get their own secret, `ADMIN_LINK_SECRET`.** ADR 0013's argument for few secrets
  holds, and this is the fourth anyway, on the test `ORIGINAL_SECRET` already passed: rotating this
  invalidates the admin's own outstanding links and costs one command, while rotating
  `SIGN_IN_SECRET` invalidates One-Time Codes already sitting in forty inboxes. The emergency that
  rotates one must not be an emergency for the other.
- **Decision email is capped per trailing day, and refusing to send is safe.** Registration is
  unauthenticated and unbounded, so handing it an email hands an attacker Resend's daily quota — and
  the first thing that starves is sign-in mail, which is an outage. The cap is safe precisely because
  ADR 0002 already declined to guard the queue with a cron: the shelter was promised an answer in
  three days and invited to chase, and the pending list still holds every registration whose mail was
  refused. The queue can lose a notification; it cannot lose an entry.
- **This ADR amends ADR 0002's revocation bullet, and that bullet now says so.** ADR 0002 wrote
  "**Revocation is deliberately not on a signed link.** It is the rare adversarial action and is done
  by hand", and the implementation here does put it on one — a `revocation` capability, posted to
  `/api/admin/revoke`. Recording the amendment rather than quietly reinterpreting the sentence is the
  point of these files, so: what holds is the *reason*, which is that the rare adversarial action
  must never be one click from an inbox. There is no revoke button, no revoke page and no revoke
  form; no email has ever carried a `revocation` token; and `DECIDABLE_OUTCOMES` structurally
  excludes `Revoked` from what an emailed link's parser can even return.

  What changed is the alternative it was measured against. ADR 0002 was weighing a link against *by
  hand*, and by hand meant a `INSERT` in a database console — which delists every animal a shelter
  has published and tells the shelter nothing. Issue #45 requires that "a refusal or a Revocation
  arrive as a real email inviting a reply, so that a mistake about me is correctable by a human", and
  a console cannot send that email. So the capability exists to make the entry and the mail one act,
  the same act a refusal is. The bar it sets is higher than the button ADR 0002 refused, not lower:
  revoking needs the platform's own signing secret and a command (`scripts/admin-link.mjs`), where
  verifying needs only the inbox a link arrived in.
