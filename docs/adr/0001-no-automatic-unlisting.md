# No automatic unlisting; staleness is display, not state

Pawster never observes an adoption — the conversation happens off-platform on WhatsApp — so nothing tells us a dog found a home. The obvious fix is expiry: unlist an animal the shelter hasn't confirmed in N days. We deliberately don't. A ghost listing costs an adopter one wasted message; an auto-unlisted animal that was genuinely available costs an adoption, which is the entire point of the platform, and does so invisibly. Instead an animal carries `lastConfirmedAt`, staleness is **derived from it at read time** into display bands (fresh / ageing / stale) that change how an animal is labelled and sorted but never whether it is listed, and only a shelter's own action moves an animal out of `Available`.

## Consequences

- There is no expiry job, and there should not be one. A persisted `Stale` state would need a scheduled writer, and a scheduled writer that never fires is undetectable (see the free-scheduled-execution research, issue #6) — derived staleness has no moving parts.
- The listing is prerendered, so deriving staleness is build-time work and does not touch the 10 ms per-invocation CPU ceiling.
- Ghost listings are an accepted, permanent cost, mitigated by an honest "last confirmed" date, a monthly per-shelter confirmation nudge, and adopter ghost reports that flag but never unlist.
