# Age bands are derived from an estimated birth date, never stored

A shelter that picks `Puppy` for a street dog in 2026 leaves that dog labelled a puppy
forever, because nothing ever revisits the choice. We instead store an estimated date of
birth alongside the basis for it (documented, vet estimate, or shelter guess) and derive
the age band at read time, exactly as staleness is derived (ADR 0001). There is no
`Unknown` band: a vet or an experienced volunteer can always place an animal within a
band, and "unknown" as a stored value is only a guess that has been excused from ageing.

## Consequences

- An animal graduates between bands on its own, with no scheduled writer. This is the
  same shape as staleness and for the same reason: a job that never fires is undetectable.
- Graduation composes with the digest for free. The per-subscription sent-set (issue #10)
  means a dog crossing from `Puppy` into `Young` reaches subscribers of the new band who
  have never been sent it, and is not re-sent to those who have.
- Precision is carried, not faked. The UI renders the basis ("about 2 years"), so a
  shelter guess never reads as a birthday.
- Band thresholds differ by species, so they live in code next to the derivation rather
  than in the data. Changing a threshold silently re-bands every animal at once, which is
  correct but worth knowing before editing the numbers.
