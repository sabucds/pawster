# Pawster

A platform where animal shelters publish animals available for adoption, and adopters
browse them and subscribe to periodical email digests of animals matching their criteria.
Built for Venezuelan shelters first, modelled to work anywhere.

## Language

### Actors

**Shelter**:
An organisation that takes in animals and publishes them for adoption. Holds an account
on the platform, must be verified before its animals appear publicly, and publishes under
a display name that is its public identity.
_Avoid_: Rescue, refugio, organisation, NGO

**Account Email**:
The single shelter-level address a shelter holds its account under, and the only address
the platform writes to. Deliberately not a named person's, so it survives a volunteer
leaving. Never published - adopters reach a shelter through its contact points. Because
confirmation links are sent here, it is also the shelter's credential for confirming
animals.
_Avoid_: Owner email, admin email, login email, notification address, primary user

**Contact Point**:
A public channel - WhatsApp, Instagram, email or phone - through which an adopter reaches
a shelter about an animal. Distinct from the shelter's account email, which is auth
identity and is never published.
_Avoid_: Contact details, channel, handle

**Adopter**:
A member of the public looking to adopt. Has no account and no password; identified only
by an email address when they subscribe.
_Avoid_: User, customer, adoptante

**Platform Admin**:
The maintainer who verifies shelters. A role in the domain, not in the auth system: an
admin holds no account and is identified only by the email address a signed link was
sent to.
_Avoid_: Moderator, superuser

### Publishing

**Animal**:
A single adoptable creature, published by exactly one shelter and never transferred to
another. Carries the structured attributes a digest can filter on, plus free-text
description and photos.
_Avoid_: Pet, listing, post, mascota

**Listing**:
The public, visible state of an animal. An animal is listed while it is available, its
shelter is verified, and that shelter offers at least one contact point. Only a shelter's
own action ends a listing; silence never does.
_Avoid_: Advert, publication, post

**Confirmation**:
A shelter's deliberate write to one animal - an edit, a new photo, or an explicit
"still available" click - which records that the animal was true as of that moment.
A confirmation of any member of a bonded group confirms the whole group. It may be made
from a session or from a confirmation nudge, without logging in; either way it records
which of the two it was.
_Avoid_: Refresh, renewal, bump, touch

**Confirmation Nudge**:
The monthly email asking one shelter to confirm the animals it has left unconfirmed for
thirty days, listing them so the shelter can confirm them all at once or say which have
gone. One per shelter and never one per animal, because animals go stale a shelterful at
a time. A nudge is answered by acting on it, not by opening it.
_Avoid_: Reminder, ping, chase, re-confirmation request

**Staleness**:
How long ago an animal was last confirmed, derived at read time and never stored. It
changes how an animal is labelled and ordered, never whether it is listed.
_Avoid_: Expiry, aged out, inactive, decay

**Archive**:
The retained record of an animal that has left the listing. Its page stays reachable
and says what happened; an animal is never deleted.
_Avoid_: Soft delete, trash, closed, removed

**Bonded Group**:
Two or more animals of one shelter that must be adopted together. They change state,
are confirmed, and appear in a digest as a single unit; a group that falls below two
members dissolves.
_Avoid_: Pair, litter, bundle, package

**Urgency**:
A shelter's mark on an animal whose situation cannot wait, always carrying a written
reason. A flag rather than a scale, and capped per shelter, because an uncapped scale
drifts to all-high and stops meaning anything.
_Avoid_: Priority, severity, critical, featured

### Filtering

**Filter Axis**:
A structured attribute of an animal that an adopter may filter or subscribe on: species,
region, size, age band, sex, and the good-with flags. Every axis draws its values from a
closed vocabulary owned by the platform and never extended by a shelter. Which axes apply
depends on species. Attributes outside this set are display-only and never filterable.
_Avoid_: Tag, facet, category

**Age Band**:
The stage of life an animal is in - Puppy or Kitten, Young, Adult, Senior - derived at
read time from its estimated date of birth and never stored, with thresholds that differ
by species. An animal therefore graduates between bands on its own.
_Avoid_: Age group, life stage, age range

**Size**:
The adult size a dog is expected to reach - Small, Medium, Large, Giant. Asked of dogs
only, and always about the adult animal, so for a puppy it is a prediction rather than
an observation.
_Avoid_: Weight, build, breed size

**Good-With Flag**:
What is known about an animal's tolerance of children, of dogs, and of cats - each one
yes, no, or not known. A filter on a good-with flag excludes only a known no; not known
is shown and labelled, never hidden.
_Avoid_: Temperament, compatibility, sociability

**Region**:
The sub-national area an animal is located in, within a country. An animal carries its
own region and inherits its country from its shelter, because a shelter may foster an
animal far from its own base. Regions follow a country's administrative divisions, and
an adopter may filter on several at once.
_Avoid_: Location, city, state, area

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
An append-only log of the judgements a platform admin has made about one shelter, each
entry capturing the outcome, the methods used and the evidence noted. A log rather than
a flag, because acceptable evidence differs by country and because a later judgement
must never erase the reasoning behind an earlier one. A shelter's current standing is
the latest entry; a shelter with no entries is awaiting verification.
_Avoid_: Approval, KYC, validation, verified flag

**Revocation**:
A verification entry that withdraws a shelter's standing, delisting its animals without
archiving them. Rare, adversarial, and always deliberate: verification never lapses on
its own.
_Avoid_: Suspension, ban, deactivation

**Dormant Shelter**:
A shelter with no activity of any kind for ninety days. Its animals stay listed and carry
a shelter-level notice; dormancy is a statement about the shelter, not about the animals.
_Avoid_: Inactive, abandoned, lapsed, churned
