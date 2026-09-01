# Pawster

A platform where animal shelters publish animals available for adoption, and adopters
browse them and subscribe to periodical email digests of animals matching their criteria.
Built for Venezuelan shelters first, modelled to work anywhere.

## Language

### Actors

**Shelter**:
An organisation that takes in animals and publishes them for adoption. Holds an account
on the platform and must be verified before its animals appear publicly.
_Avoid_: Rescue, refugio, organisation, NGO

**Adopter**:
A member of the public looking to adopt. Has no account and no password; identified only
by an email address when they subscribe.
_Avoid_: User, customer, adoptante

**Platform Admin**:
The maintainer who verifies shelters. Not a shelter role.
_Avoid_: Moderator, superuser

### Publishing

**Animal**:
A single adoptable creature published by exactly one shelter. Carries the structured
attributes a digest can filter on, plus free-text description and photos.
_Avoid_: Pet, listing, post, mascota

**Listing**:
The public, visible state of an animal. An animal is listed while it is available and
its shelter is verified. Only a shelter's own action ends a listing; silence never does.
_Avoid_: Advert, publication, post

**Confirmation**:
A shelter's deliberate write to one animal - an edit, a new photo, or an explicit
"still available" click - which records that the animal was true as of that moment.
_Avoid_: Refresh, renewal, bump, touch

**Staleness**:
How long ago an animal was last confirmed, derived at read time and never stored. It
changes how an animal is labelled and ordered, never whether it is listed.
_Avoid_: Expiry, aged out, inactive, decay

**Archive**:
The retained record of an animal that has left the listing. Its page stays reachable
and says what happened; an animal is never deleted.
_Avoid_: Soft delete, trash, closed, removed

**Filter Axis**:
A structured attribute of an animal that an adopter may filter or subscribe on: species,
region, size, age band, sex, and the good-with flags. Attributes outside this set are
display-only and never filterable.
_Avoid_: Tag, facet, category

### Subscription

**Subscriber**:
An email address that has opted in to receive digests. The thing that consents, bounces,
complains and unsubscribes. Holds up to three subscriptions; has no account and no password.
_Avoid_: User, contact, lead, subscriber account

**Subscription**:
One standing set of filter-axis criteria belonging to a subscriber. A subscriber may hold
three, so "dogs in Caracas" and "cats in Maracay" are two subscriptions rather than one
broadened search. Managed entirely through signed links; never behind a login.
_Avoid_: Alert, watch, saved search, newsletter signup

**Opt-In**:
A subscriber's proof, through a single-use link, that the address is genuinely theirs. Nothing
is ever sent to an address that has not opted in. Named apart from Confirmation, which belongs
to shelters and animals and means something else entirely.
_Avoid_: Confirmation, verification, signup, double opt-in

**Digest**:
One periodical email sent to a subscriber, carrying a section per subscription of the animals
that match it and have not been sent to it before. The unit of delivery, not the unit of
scheduling; an animal matching two of a subscriber's subscriptions appears once.
_Avoid_: Newsletter, notification, alert email

**Send Day**:
The weekday a subscriber's digest arrives, fixed at opt-in and the same every week. A property
of the subscriber, not of the schedule, which is what makes a weekly digest seven bounded
daily runs.
_Avoid_: Schedule, cadence, slot, cohort

**Digest Run**:
One day's execution of the digest, covering the subscribers whose send day it is. The unit of
scheduling, of retry, and of the record kept afterwards.
_Avoid_: Job, batch, cron, blast

**Retirement**:
The platform's own decision to stop sending to a subscriber, because the address hard-bounced
or its owner reported us as spam. Distinct from unsubscribing, which is the subscriber's
decision. A complaint retirement is permanent; a bounce retirement is not.
_Avoid_: Deactivation, ban, bounce, churn

**Erasure**:
The destruction of everything Pawster holds about a subscriber. Distinct from unsubscribing,
which only stops the sending: a subscriber who unsubscribes keeps their subscriptions for
ninety days in case the click was an accident, and is erased automatically at the end of it.
Erasure leaves behind only a Do-Not-Contact entry, and only where one is owed.
_Avoid_: Deletion, purge, removal, forget me

**Do-Not-Contact**:
A one-way fingerprint of an address that reported us as spam, kept forever so the signup form
can refuse it. The residue of a Retirement that outlives the subscriber it belonged to: it can
answer whether an address is refused and nothing else, because it holds no address to read.
Ours alone, and distinct from the suppression list our email provider keeps in plaintext.
_Avoid_: Suppression, blocklist, tombstone, ban list

### Trust

**Verification**:
A record that a platform admin judged a shelter to be genuine, capturing the method used
and the evidence noted. A record rather than a flag, because acceptable evidence differs
by country.
_Avoid_: Approval, KYC, validation

**Region**:
The sub-national area a shelter operates in and an animal is located in, within a country.
Both country and region are modelled data, never hardcoded.
_Avoid_: Location, city, state, area

**Dormant Shelter**:
A shelter with no activity of any kind for ninety days. Its animals stay listed and carry
a shelter-level notice; dormancy is a statement about the shelter, not about the animals.
_Avoid_: Inactive, abandoned, lapsed, churned
