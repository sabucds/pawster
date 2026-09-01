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
