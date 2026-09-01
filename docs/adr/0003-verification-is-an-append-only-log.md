# Verification is an append-only log that never expires

A shelter's standing changes over time — pending, verified, possibly revoked, possibly verified again — and each change is a judgement made from evidence that differs by country. We store it as an **append-only log of verification entries** (outcome, methods, evidence, decidedAt, decidedBy) rather than a status column on Shelter, and derive current standing from the latest entry. Mutating a single row in place would destroy the evidence behind the previous decision, which is exactly what you want when a revoked shelter appeals or you are asked how an organisation was vetted.

## Consequences

- **There is no `verified` boolean on Shelter, and there should not be one.** Keeping a denormalised status column alongside the log gives two sources of truth that drift; at this scale (tens of shelters, prerendered listing) the read cost is build-time work and the drift risk is the larger one.
- **Pending is the absence of any entry**, not a stored state. Registration writes no verification row at all.
- **Verification never expires, and there is no expiry job** — for the reason ADR 0001 gives about animals. An expiry job that silently un-verifies a shelter delists every one of its animals, invisibly, costing adoptions; and per issue #6, a scheduled writer that never fires is undetectable.
- Revocation delists a shelter's animals via the existing `listed = available AND shelter verified` rule, but does **not** archive them, so re-verification restores everything with no data loss.
- The verifier is modelled as the platform admin, with **no room left for shelter-to-shelter vouching**. If it ever ships it is one nullable column and a method value on a table of a few dozen rows; pre-building a polymorphic verifier for a feature that may never exist is heavier than the problem.
- A shelter can register and add animals before being verified; nothing lists until verification. This needs no new state, because the listing rule already covers it.
