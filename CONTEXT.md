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

**Subscription**:
A standing request from an email address to receive digests matching a set of filter-axis
criteria. Managed entirely through signed links; never behind a login.
_Avoid_: Alert, watch, saved search, newsletter signup

**Digest**:
One periodical email sent to a subscription, containing the animals newly matching its
criteria since the last digest. The unit of delivery, not the unit of scheduling.
_Avoid_: Newsletter, notification, alert email

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
