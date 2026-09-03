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
leaving. Never published - adopters reach a shelter through its contact points. It is the
shelter's whole credential: confirmation links and one-time codes are both sent here, so
control of this inbox is what it means to be this shelter. Losing it is therefore not a
password reset but a question of identity, answered out of band.
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
and says what happened - including that its shelter has left the platform, where that is
what happened; an animal is never deleted.
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

### Photos

**Photo**:
One image of an animal, contributed by its shelter. An animal carries between one and six,
ordered, and the platform keeps no photo an adopter never sees - what is stored is the set
of derivatives, never the file the shelter sent.
_Avoid_: Image, picture, media, asset, foto

**Primary Photo**:
The first photo in an animal's order, and the one every single-image surface shows: the
listing card, the digest email and the social preview. A shelter chooses it by ordering,
and reordering makes a different photo primary.
_Avoid_: Cover photo, main photo, hero, featured photo, thumbnail

**Derivative**:
One of the fixed set of resized, reformatted copies of a photo that the platform serves.
Produced once when the photo is uploaded and never afterwards, so a photo's derivatives
are the only form in which it exists.
_Avoid_: Variant, rendition, size, transform, resize

**Upload Session**:
A shelter's in-progress work assembling an animal's photos before the animal exists.
Holds photos that have been accepted and turned into derivatives but belong to nothing
yet; a shelter may resume one for a day, after which it is simply abandoned. Abandonment
is a fact about elapsed time and the absence of an animal, never a state anything sets.
Nothing in a session is visible to an adopter.
_Avoid_: Draft, pending animal, staging, unsaved animal, abandoned state

**Unreferenced Derivative**:
A derivative the platform still stores that nothing points at: no animal carries it and no
resumable upload session holds it. It arises from an abandoned session, a deleted photo, a
promoted primary, or an animal whose photos have been dropped. Because a derivative's key
is its content, two animals can point at one object, so being unreferenced is a fact about
every reference in the platform and never a fact about the object itself.
_Avoid_: Orphan, stale object, dangling derivative, garbage

**Reclamation**:
The nightly pass that deletes every unreferenced derivative and measures what the platform
actually stores. It is how any storage the platform no longer owes anyone is given back,
whatever left it behind - so no path has to remember to clean up after itself.
_Avoid_: Garbage collection, cleanup, sweep, pruning, vacuum

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

### Access

**One-Time Code**:
A short numeric credential sent to a shelter's account email, which the shelter types back
to begin a session. Deliberately a code rather than a link, because a link in an inbox is
fetched by mail scanners with no human behind them, and because the inbox and the browser
are routinely on different devices. Only one is ever outstanding per shelter: requesting
another retires the last, the same way a confirmation nudge retires its predecessor.
_Avoid_: OTP, PIN, magic link, password, token

**Session**:
The state a shelter holds after proving control of its account email, carrying the writes a
confirmation may not make - contact points, photos, descriptions, new animals, and the
account email itself. Belongs to the shelter rather than to a person, so it is shared and
delegated exactly as the account email is, and records nothing about which volunteer acted
under it. Ends by lapsing, by being revoked wholesale, or by the account email changing.
_Avoid_: Login, sign-in, cookie, token, staff account

**Capability**:
The narrow permission a signed link carries without granting a session: confirming animals
and changing an animal's state, and nothing else. Named apart from Session because the
distinction is the security boundary rather than an implementation detail - a leaked link
must not become an account.
_Avoid_: Permission, scope, grant, access level

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
its own. A judgement the platform makes and may reverse, which is what separates it from
a Departure the shelter makes about itself.
_Avoid_: Suspension, ban, deactivation, departure

**Dormant Shelter**:
A shelter with no activity of any kind for ninety days. Its animals stay listed and carry
a shelter-level notice; dormancy is a statement about the shelter, not about the animals.
Silence never becomes a Departure: only the shelter itself can leave.
_Avoid_: Inactive, abandoned, lapsed, churned

**Departure**:
A shelter's own dated decision to leave the platform, archiving all of its animals at once
and, after a grace period, destroying every means of reaching or authenticating it - its
contact points and its account email. What it published survives: a departed shelter keeps
its display name, its animals' archive pages and its verification entries, because the
archive is a promise made to adopters rather than to the shelter, and the verification log
records the platform's own judgements. A shelter can therefore leave without being erased,
and one that returns registers afresh rather than reclaiming what it left.
_Avoid_: Deletion, closure, offboarding, account deletion, cancellation, revocation
