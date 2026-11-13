# The demo shelter is a flag on the shelter

The first public deploy needs animals on the listing before any real shelter has joined. Without
them the deploy proves nothing about the listing, the animal page, the archive or the contact
path, and anyone who opens the URL sees an empty page. The maintainer runs a demo shelter and
publishes a few animals through it.

Those animals must never be mistaken for real ones. An adopter who messages about one is wasting
a trip, and an adopter mailed one in a digest has been sent a fake. So the demo shelter has to be
told apart from every real shelter in two places: on every public page that shows its animals,
and in the digest matcher.

**Decision: `shelters.demo`, a boolean column that defaults to false.** Only
`scripts/seed-demo-shelter.mjs` sets it. No page, form or admin action can.

## What the flag changes

- **Listing.** Nothing about whether an animal lists. The listing rule (`isListed`) is unchanged,
  so demo animals list like any other, and the deploy exercises the real path. The filter index
  carries the flag as `e: 1`, which it writes only for demo animals, so real animals carry no
  extra bytes.
- **Card.** A card shows "Ejemplo, no está en adopción" over the photo. It is not in the name box
  because that box is clipped at two lines. A bonded group gets the label if any member is a demo
  animal.
- **Animal page.** A notice under the back link, on both the live page and the archive page. A
  line under "Refugio verificado" saying the shelter is a demonstration. The `<title>`, `og:title`
  and `og:description` start with the label too, because those are what a forwarded link shows
  before anyone opens it.
- **Digest.** `digestCandidates` drops every unit (an animal alone, or a bonded group) that has
  any demo member. The check is on the whole unit, so a group whose shared group id mixes a demo
  animal with a real one is dropped too. A demo animal in an email is the worse failure, and
  missing one real animal for one week is the cheaper one.

The contact buttons stay. They reach the maintainer's own contact point, and the deploy is meant
to show that the adopter path works end to end.

## Rejected

**A reserved verification method, such as `demo`.** The verification log is append-only, and each
re-verification writes a new entry with its own methods. An admin re-verifying the shelter later
would drop the marker unless they remembered to tick it again. It would also put a fact about
what the shelter *is* into a record of what an admin *checked*.

**A separate environment with its own D1 and Workers.** It doubles the setup and the free-tier
quota, and both environments would share Resend's daily send limit. Most of all, the live URL is
the one that needs content, and a separate environment would leave it empty.

**Seed rows in a migration.** Migrations run against every database, including the test pool's,
and the seed needs the maintainer's real inbox and WhatsApp number. Those belong in a command run
once against production, not in the repository.

## The seed

`scripts/seed-demo-shelter.mjs` prints SQL for `wrangler d1 execute`. It writes the shelter, one
WhatsApp contact point, and one Verified entry. Every insert is guarded, so running it twice
changes nothing. The maintainer then signs in as the shelter and publishes animals through the
normal UI.

The Verified entry has **no methods**. The admin decision page refuses a Verified outcome without
one, and that rule is right for real shelters: every method means "the admin checked a real public
presence". None of them is true of a shelter the maintainer made up, so the script writes the
entry directly, with evidence that says so. The admin history shows that evidence and an empty
method list.

## Consequences

- The demo shelter gets the nudges, the dormancy notice and the contact-drift emails a real
  shelter would, at the maintainer's inbox. That is useful: it is the only way to see them in
  production before a real shelter does.
- Retiring the demo is a normal departure (ADR 0015). Its archive pages keep their labels.
- A second demo shelter would need a second run of the script with a different id, which it does
  not support. One is enough.
