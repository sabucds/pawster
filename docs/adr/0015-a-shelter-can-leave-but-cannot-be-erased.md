# A shelter can leave, but it cannot be erased

Every other exit on this platform was designed for a natural person. A subscriber who asks to be
forgotten is forgotten, on the clocks [ADR 0010](0010-subscriber-data-retention.md) derived from
each record's purpose. A shelter is not a subscriber. It is a **publisher**, and adopters relied on
what it published: [ADR 0001](0001-no-automatic-unlisting.md) promised that an animal is never
deleted and that its page stays reachable saying what happened — a promise made to adopters, which
the shelter cannot waive on their behalf. So ADR 0010's reasoning does not transfer, and the honest
answer is the asymmetric one: **a shelter may leave without being erased.**

**Departure is a deliberate, dated fact on the shelter, and it is not a verification outcome.**
Standing already lives in an append-only log, which makes that log the obvious place to put
"withdrawn" — and it is the wrong place.
[ADR 0003](0003-verification-is-an-append-only-log.md) defines that log as the judgements a
*platform admin* has made about one shelter, with `decidedBy` an admin's email address. A shelter
withdrawing itself is not a judgement about it. Filing it there would make `decidedBy` polymorphic
over two unrelated kinds of actor, and would make "current standing" — the log's whole read model —
ambiguous between *we trust them* and *they are still here*. Those are different facts and they
have to be separately readable, because a departed shelter's verification history stays true.

**Leaving delists immediately and destroys the contact surface after thirty days.** The two halves
are separated because they answer to different risks. Delisting must be immediate or the platform
is lying to adopters for a month. Destruction must wait, because [ADR 0013](0013-shelters-sign-in-with-an-emailed-code.md)
gave a shelter one shared account under one inbox, with no per-person accounts and therefore no
second person to countersign: a single volunteer holding the phone can end an organisation's entire
presence, irreversibly, in one session. The window is what stands in for the countersign that does
not exist. During it the shelter can still sign in — the session epoch is bumped at destruction,
not at request — and cancelling is one click that restores everything.

**What is destroyed is the means of reaching and authenticating the shelter; what survives is what
it published.** Departure erases **contact points** and the **account email**, and bumps the
session epoch. It keeps the **display name**, the **animals** and their archive pages, and the
**verification log**. The line is not arbitrary: a shelter is an organisation and its name and
publication record are not its personal data, but a contact point is routinely a volunteer's
personal WhatsApp number or Instagram handle, and the account email is a credential. Erasing the
contact points is in any case *already required* — the listing rule is
`listed = available AND shelter verified AND shelter has at least one contact point`, so a shelter
with no contact points is delisted by machinery that already exists.

**The animals are archived, and no fourth animal state is added.** Revocation delists without
archiving so that re-verification restores everything (ADR 0003); departure must not behave that
way, because revocation is a contested judgement that may be appealed while departure is a fact
about the world — those animals genuinely are not adoptable through that shelter any more, and
leaving them merely delisted models them as recoverable when nothing is coming back. But the three
animal states stay three: the archive page reads the shelter's departure and words itself from it,
rather than the platform inventing a per-animal state to carry a shelter-level fact. Their photo
derivatives drop on the ordinary twelve-month archive clock, because departure is no reason to
degrade an adopter's memory of an animal faster than an adoption does.

**The public sentence is platform-authored and fixed; a departing shelter writes no farewell.**
Free text published here would live on pages that outlive the shelter and can never be edited
afterwards, because by then nobody holds the credential to correct it. That is unowned text with no
correction path, on the one page whose entire job under issue #17 is to be honest with an adopter
about to spend a message.

## Consequences

- **Dormancy never becomes departure on its own, and there is no departure job beyond the grace
  expiry.** A ninety-day silence turning into a mass archive is exactly the invisible auto-unlisting
  ADR 0001 exists to forbid, and per issue #6 a scheduled writer that never fires is undetectable.
  The one clock this ADR does add — the thirty-day destruction — rides the purge preamble ADR 0010
  already runs inside the daily digest Cron Trigger, under the same Healthchecks.io watchdog, so it
  introduces no new schedule and no new silent-failure surface. It is one nullable `departedAt`
  column and one more statement in a job that exists.
- **The ceremony is a session plus the typed shelter display name, with no admin in the loop.**
  [ADR 0002](0002-no-admin-accounts.md) spent its argument keeping the maintainer out of the
  routine path, and putting a human in front of every departure would undo that for an event whose
  reversibility the grace window already covers.
- **`evidence` on a verification entry is constrained at write time, not redacted at departure.**
  The log outliving its subject is correct — it records *our* judgements, and ADR 0003 forbids a
  later act erasing the reasoning behind an earlier one — but `evidence` is free text and is the
  one field in which a natural person can end up ("hablé con María, la coordinadora"). Redacting it
  afterwards means parsing prose that cannot be reliably parsed, so the admin decision page states
  instead that evidence describes public artifacts, never people. Fixing this at the source is
  affordable only because ADR 0002 made that page a single surface under our control.
- **A departed shelter cannot recover its old identity, and returning means registering afresh.**
  Issue #20 made the account email the anchor for recovery, and departure destroys it. A returning
  organisation is a new shelter with a new verification history; its former animals stay archived
  under the old one. This is the same conclusion issue #11 reached in ruling animal transfer between
  shelters out of scope, arrived at from the other direction.
- **An in-flight adoption conversation is unaffected, and that is not luck.** Contact happens off
  the platform, so an adopter already talking to a shelter on WhatsApp keeps that thread; the
  platform never knew about it and takes nothing away. The archive page stating what happened is
  the whole of what the platform owes them.
- **The digest needs no change.** Archived animals do not match subscriptions, and sent-set rows
  prune ninety days after an animal unlists under ADR 0010, so a departure drains itself.
- **`/privacy` gains two shelter rows**, since ADR 0010 established that the retention table *is*
  the notice: contact points and account email, *erased thirty days after departure is requested*;
  published animals, archive pages and verification entries, *kept indefinitely*, with the reason
  stated — the archive is a promise to adopters and the log is the record of our own decisions.
