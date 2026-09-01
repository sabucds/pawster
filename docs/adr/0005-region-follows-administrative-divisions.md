# Region follows administrative divisions, and adopters filter on several at once

Caracas spans Distrito Capital and Miranda, so a region list that mirrors Venezuela's
estados splits the country's largest adopter population across two filter values. The
alternative was to curate the list editorially - collapsing the Caracas metro into one
`Gran Caracas` value - but we keep the list mechanically administrative and make region
**multi-select** on both browse and subscription instead, which reduces the split to one
extra checkbox.

## Consequences

- Multi-select is worth having on its own merits: the real adopter is "Carabobo or
  Aragua, I'll drive", which a single-value axis cannot express.
- Subscription carries a **set** of regions. This is a constraint arriving after the
  digest design (issue #10) was settled; the sent-set model absorbs it, but the
  subscription's stored criteria must hold a set, not a scalar.
- Region reference data stays defensible against a public source, and seeding a second
  country is a lookup rather than a judgement call about where a metro area ends.
- An animal carries its own region and inherits its country from its shelter, because
  a Caracas shelter fostering a dog in Valencia is routine. The shelter's own region is
  a default for new animals and nothing more.
