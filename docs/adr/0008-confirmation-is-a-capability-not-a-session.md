# Confirmation is a capability, not a session

[ADR 0001](0001-no-automatic-unlisting.md) removed automatic unlisting and bought the listing's
honesty entirely with one monthly confirmation nudge per shelter, which makes that email the
load-bearing member of the whole staleness design. A password prompt is where a load-bearing
member snaps: the person who actually runs a Venezuelan shelter's account is often a volunteer on
a shared phone, with a credential set once, months ago, by someone who has since moved on. So the
nudge carries a **signed confirmation link** granting a narrow, reversible capability — confirm-all,
plus marking an individual animal `Adopted` or `NoLongerAvailable` — and **never a session**. The
shelter's account email becomes its confirmation credential, exactly as
[ADR 0002](0002-no-admin-accounts.md) made the admin's inbox the admin credential.

## Considered options

**Login required.** Rejected: it puts the system's only password in front of one of its least
consequential surfaces while adopters and the platform admin both operate on signed links, and it
gates the mechanism the listing's honesty depends on behind the password hygiene of the shelters
most likely to go stale.

**A confirmation link that mints a session.** Rejected: the leak blast radius becomes the whole
account, which dissolves the capability boundary below.

## Consequences

- **The capability boundary is the point of this ADR.** A confirmation link may confirm and may
  change an animal's state. It may **not** touch the shelter's contact points — rewriting a
  WhatsApp number silently redirects every adopter enquiry to a stranger and nothing on the page
  would look wrong — nor photos, descriptions, new animals, or the account email itself. Those
  stay behind a session. The confirm page links out to the login screen; it never bypasses it.
- **The privilege ordering is counter-intuitive, so don't "simplify" it.** Confirm-all looks like
  the harmless verb and mark-adopted like the dangerous one. The reverse is true: marking an
  animal adopted is loud and one-click reversible (relisting keeps the same identity and history),
  while a stranger confirming forty stale animals corrupts the one signal this whole design rests
  on, silently and unfalsifiably.
- **A confirmation link must never mutate on `GET`.** Outlook Safe Links, corporate mail scanners
  and link prefetchers fetch URLs with no human behind them; a confirm-on-`GET` link would have
  robots manufacturing the platform's own freshness signal. The link opens a page rendering live
  state and every write is a `POST` from it. This is why there is no true "one tap" confirm — and
  it applies equally to ADR 0002's verification-decision links, where a scanner silently verifying
  a shelter would be worse.
- **Links are reusable and expire by supersession**: each nudge retires its predecessor, and
  changing the account email invalidates every outstanding link. There is no revoke button. This
  requires server-side state — the newest nudge per shelter, keyed to the current account email —
  so a purely stateless signed payload cannot express this scope.
- **Forwarding is delegation, not a leak to be prevented.** A bearer link is a bearer link;
  single-use would mostly mean the volunteer clicks it and the director then cannot. A confirmation
  records whether it came from a link or a session, so provenance survives. This is also how a
  shelter delegates confirmation at zero user-management cost — **a shelter-auth decision should
  not undo it by inventing per-person staff accounts.**
- **A nudge is "answered" by a `POST`**, not by being opened. There is no open-tracking pixel: the
  same scanners would trip it. A shelter that reads every nudge and acts on none goes dormant,
  correctly.
- Pending and revoked shelters are never nudged — nothing of theirs is visible, so there is no
  honesty to maintain. Dormant shelters are nudged until ADR 0001's three-strike rule stops it,
  because their animals *are* still listed.
- A shelter can request a fresh link from an unauthenticated form that only ever sends to the
  registered account email. It must answer identically whether or not the address is registered,
  or it becomes a shelter-enumeration oracle.
