# Subscriber retention: erase on a clock, remember only a refusal

Two obligations pull in opposite directions and both are non-negotiable. CAN-SPAM's opt-out
duty has no sunset — 15 U.S.C. §7704(a)(4)(A)(i) makes it unlawful to mail someone more than
ten business days after they asked you to stop, and there is no re-permission clock anywhere
in the statute. Honouring that forever requires remembering the address forever. Meanwhile
the decent thing, and the thing a subscriber with no account will actually ask for, is that
we forget them entirely. "Delete on unsubscribe" is therefore not available in every case,
and pretending otherwise would produce a privacy notice that is false.

The resolution is not ours to invent; it is settled guidance, and the ICO states it plainly:
*"If someone no longer wants you to use their information for direct marketing purposes, you
should put their details onto a suppression or 'do not contact' list, instead of deleting
them... keeping a suppression list isn't for direct marketing purposes. You are keeping this
list so that you can comply with your statutory obligations... there is no automatic right
for people to have their information on such a list deleted."* The same guidance sets the
bound: *"only keep the minimum amount of information needed."* So the shape of the answer is
erase everything, retain one entry, and make that entry as close to nothing as it can be
while still doing its job.

**A Do-Not-Contact entry is an HMAC, not a hash.** It stores `HMAC-SHA256(key = pepper,
message = normalised address)`, a reason, and a date — no address, nothing else. The signup
form computes the same HMAC over what was typed and refuses on a match. The construction is
forced by two constraints pointing the same way. Matching requires *deterministic* digests,
which rules out per-record salting, and the ICO warns that a shared salt leaves you exposed
to brute force — email address space is small enough to enumerate, so a bare `sha256(address)`
protects nobody. Its remedy is a pepper *"stored separately from hashes in a secure
environment"*, which is precisely a keyed MAC. That also sidesteps the guidance's preference
for slow hashes, which would have fought the 10 ms CPU ceiling: slowness only buys anything
when the attacker knows the salt, and an attacker who steals this table without the key cannot
compute a single candidate. Two honest limits: a Do-Not-Contact entry is still personal data —
hashing reduces breach blast radius, it does not create an exemption — and it is *ours*,
covering only complaints, because a hard bounce is self-healing (opt-in completes only if the
mailbox works) and Resend re-suppresses bounces account-wide anyway.

**Unsubscribing and erasure are different asks and get different mechanisms.** Conflating them
is the standard mistake, and here it would be actively harmful: the one-click unsubscribe has
no confirmation page, deliberately, so that a mailbox provider can safely fetch it — which
guarantees accidental unsubscribes from link prefetchers and mis-taps. Erasing on the spot
would turn every one of those into the permanent loss of three saved searches. So unsubscribe
stops sending immediately and leaves the subscriber dormant for **90 days**, after which the
row erases itself; erasure is a separate, explicit button offered on both the manage page and
the unsubscribe landing page. The automatic expiry is what stops the grace period from
quietly becoming indefinite retention.

**Every other retention period is derived from what the record is for, never guessed.** An
unconfirmed opt-in is an address we hold no consent for at all, so it is hard-deleted at seven
days, with at most one opt-in mail per address per 24 hours in the meantime and an identical
neutral response on every path, so the form cannot be used either as a mailbomb or as an
oracle for who is subscribed. A `Digest Delivery` names one person and exists to answer "did
she get it?" after Resend's 30-day event window lapses, so it keys on `subscriberId`, never on
an address, and lives 90 days. A `Digest Run` is counts with nobody's data in it, so it is
kept indefinitely: a few hundred rows a year, and the only long-run evidence that the digest
is running rather than silently dead. Sent-set rows abandon the 180-day figure penciled in
during the digest design; a row's only job is to stop one animal reaching one subscription
twice, which it can only do while that animal could still match, so rows are pruned **90 days
after the animal unlists**. That is stricter than 180 days for the common case of an adopted
animal and unbounded for a long-listed one, which removes the day-181 bug where a still-listed
animal would be re-sent as "new". Erasing a subscriber destroys all of it immediately,
whatever the clocks say.

**We record no consent evidence beyond the click itself.** No primary source — not Resend's
terms or AUP, not Google's or Yahoo's sender rules, not CAN-SPAM, not RFC 8058 — imposes any
retention obligation on proof of consent for this fact pattern. Resend's DPA §7.1 asks that
*"a record of consent to processing is maintained with respect to each Data Subject"*, with no
duration and hedged by "if applicable"; the opt-in click satisfies it. A single-use HMAC link
delivered to a mailbox and returned proves control of that mailbox, which is strictly stronger
than an IP address proving that some device somewhere typed it in. IP is therefore recorded
only on the *unconfirmed* row, where it serves rate limiting, and dies with the seven-day
purge. Confirmed subscribers carry no IP at all.

## Consequences

- **The purges run as a preamble to the daily digest run**, inside the same Cron Trigger
  and under the same Healthchecks.io watchdog, writing their counts into the `Digest Run`
  summary. A retention policy with no job behind it is a lie, and a second schedule would be
  a second thing that can die silently. The 10 ms CPU ceiling is not a constraint on a handful
  of database-side `DELETE`s. Lag equals the run's own lag, which periods of 7 and 90 days
  absorb without harm. *(Extended by
  [ADR 0016](0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md), which hangs
  derivative reclamation off this same preamble on this same reasoning, and writes its reclaimed
  counts and measured bytes into the same `Digest Run` summary.)*
- **The pepper must never rotate, and losing it fails open.** It lives as a secret outside the
  database; if it is rotated or lost, every Do-Not-Contact entry silently stops matching and
  the platform resumes mailing people who reported it as spam, with no alarm anywhere. A fixed
  canary string is HMAC'd at boot and compared against a stored constant so a wrong pepper
  fails loudly and immediately.
- **"Delete everything" is scoped honestly, because a subprocessor tail exists that we cannot
  clear.** Resend retains email and log data for 30 days on every plan below Enterprise, keeps
  backups for 7 days, and maintains its own automatic suppression list holding addresses in
  *plaintext*. Local hashing protects our database, not theirs. The privacy notice says so in
  the row a careful reader will check.
- **Two subscribers can hold no working link, and both are covered by existing surfaces.** The
  manage token is rotated on unsubscribe, so an unsubscribed subscriber's route is the
  "delete everything" button on the unsubscribe landing page itself, plus a published contact
  address; no fresh token is issued there, which would undo what the rotation defends against.
  A subscriber who never matches anything receives no digest and therefore no footer, so the
  opt-in success page and the 90-day "still nothing" nudge both carry the manage link,
  guaranteeing a live link at least quarterly.
- **The manage page is the subject-access response.** Address, up to three subscriptions, send
  day, opt-in date, last-sent date is the whole of what we hold; an export flow would show
  nothing the page does not. One page, with the delete button on it, replaces a request
  process we would otherwise have to build and staff.
- **Refusing a complaint-retired address re-subscription is a decency decision, not a
  compliance one**, and the map should not borrow authority it lacks. Resend nowhere states
  that re-sending after a complaint violates its terms; enforcement is an aggregate 0.08%
  complaint rate, and an address can be manually un-suppressed. We refuse anyway.
