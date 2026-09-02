# Shelters sign in with an emailed one-time code, and the session is a cookie plus an epoch

Every other actor on this platform is already authenticated by control of an inbox: the platform
admin decides verifications through a signed link because [ADR 0002](0002-no-admin-accounts.md) gave
admins no accounts, a shelter confirms its animals through a signed link because
[ADR 0008](0008-confirmation-is-a-capability-not-a-session.md) made the account email the
confirmation credential, and a subscriber manages its subscriptions through a signed link under
[ADR 0010](0010-subscriber-data-retention.md). Shelter sign-in is the last credential decision, and
it serves exactly one kind of user, since ADR 0002 removed admins from the auth system entirely.

**A shelter signs in by requesting a six-digit code, which is emailed to its account email and typed
into the page it already has open.** The session that follows is a signed cookie carrying the shelter
id, an issued-at and a session epoch, validated against a `sessionEpoch` column on the shelter row.
There is no password, no OAuth, and no session table.

**A code rather than a link, and this is the non-obvious part.** ADR 0008 established that an emailed
link must never mutate on `GET`, because Outlook Safe Links, corporate mail scanners and link
prefetchers fetch URLs with no human behind them. A magic link that minted a session on `GET` would
therefore be consumed by the scanner before the shelter ever tapped it — the failure would look like
an expired link, on a mechanism the shelter cannot work around. A typed code has no such surface:
nothing is fetched, so there is nothing to consume. It also survives the situation this project
actually has, where the account email opens on a shared shelter phone while the browser doing the
publishing is somewhere else; a link assumes one device, a code does not.

## Considered options

**Password.** Rejected, and not primarily on the CPU ceiling the way it was first framed. The
Workers runtime **hard-caps PBKDF2 iterations** — `workerd` throws `"Pbkdf2 failed: iteration counts
above <max> are not supported"`, reported at 100,000 — against OWASP's current recommendation of
600,000 for PBKDF2-HMAC-SHA256, so even the runtime's *maximum* is roughly a sixth of the
recommendation. `argon2` is explicitly absent from the supported `node:crypto` surface. `scrypt` is
available and would probably serve, but Cloudflare publishes no figure for what fits in 10 ms of CPU,
so choosing it means accepting an unmeasured factor. The decisive argument is cheaper than any of
that: a password needs a reset flow, a reset flow is an email flow, so the password option **arrives
at the emailed-credential path anyway** and adds a stored secret on the way. Cloudflare's own
basic-auth example is labelled "not suitable for production use" and points at Access instead.

**OAuth.** Rejected: it means Google or Facebook, and binds the organisation's identity to a personal
account that a shelter may not have, may share informally, and will lose along with the volunteer who
created it. That is the same failure ADR 0008 was written to avoid, reintroduced through a vendor.

**Cloudflare Access.** Rejected despite [ADR 0006](0006-cloudflare-as-the-single-platform.md)'s
preference for staying on one platform, because it is a workforce product. Its free tier covers 50
users; a seat is consumed on authentication and inactive users are not released by default, so 40-odd
shelters with several volunteers each exhausts it permanently. The Zero Trust service-specific terms
permit substituting a seat only on an End User's "termination or reassignment to another job
function" and forbid reselling in a "service bureau relationship" — language about staff, not
customers. It remains a candidate for gating our own admin surfaces, never the shelters'.

**A stateless signed cookie with no epoch.** Rejected: it cannot be revoked before expiry, which the
recovery path below depends on.

**KV for session or code state.** Rejected on two documented limits: 1,000 writes/day on the Free
plan, which a sliding session rewriting its expiry per request would exhaust, and eventual
consistency, which would make revocation lag exactly when it matters.

## Consequences

- **The session is long on purpose: 90 days, sliding.** ADR 0008 already removed the high-frequency
  reason to sign in — confirmation, the monthly act the listing's honesty depends on, needs no
  session at all. A session is only needed to publish an animal, change photos or edit contact
  points, which is rare. So a short session buys little and spends the scarce resource, which is
  email: at 90 days roughly 40 shelters generate about 0.4 sign-ins a day, where 7 days would cost
  fifteen times the mail for no gain in the common case.
- **Revocation is one integer.** Bumping `sessionEpoch` on the shelter row invalidates every live
  session at once, and an authenticated request reads that row anyway to render the publishing area,
  so the check costs nothing. Sliding refresh re-issues the *cookie* rather than writing to the
  database, so there is no per-request write. Changing the account email bumps the epoch, extending
  ADR 0008's rule that an email change invalidates every outstanding link.
- **There is no per-session revocation and no list of active sessions, and that costs nothing here.**
  Per-session granularity would only mean something if a shelter had per-person logins, and ADR 0008
  forbids inventing those — forwarding is delegation, at zero user-management cost. The same
  reasoning has a real price attached, stated plainly: **a session write records nothing about which
  human made it**, so "who deleted the photos" is unanswerable. This is the most likely thing on this
  ADR to be regretted, and the cheapest thing to add later, since adding identities does not
  invalidate the epoch mechanism.
- **The code is stored hashed, and superseded rather than accumulated.** Six digits, ten-minute
  expiry, single use, five attempts and then the code dies; one outstanding code per shelter, a new
  request retiring the previous one — the same "expire by supersession" rule ADR 0008 chose for
  links, rather than a second retirement model. The row lives in D1 holding an HMAC-SHA256 of the
  code, the same primitive ADR 0010 chose for Do-Not-Contact and cheap enough to ignore the CPU
  ceiling; a plaintext column would hand live login codes to anything that gets query access. Expired
  and superseded rows are cleared by the daily purge ADR 0010 already runs, so this needs no job.
- **Sign-in mail has priority over the digest, but a bounded one.** Both share Resend's 100
  emails/day. At the digest's own ceiling of roughly 500 weekly subscribers, sharded across seven
  days, the digest wants about 71 a day, leaving about 29. Sign-in wins that contention because the
  digest is **re-runnable by construction** — the per-subscription sent-set in
  [ADR 0009](0009-digest-delivery-and-retry.md) makes a re-run the retry — while a shelter that
  cannot get its code is locked out and cannot publish at all.
- **Unbounded priority would have been a way to silence the product, so the allocation is capped.**
  The code-request form is unauthenticated by necessity, because ADR 0008 requires it to answer
  identically whether or not an address is registered, or it becomes a shelter-enumeration oracle.
  With unbounded priority, anyone could exhaust the digest's quota by requesting codes. So: one code
  per address per five minutes, a per-address daily cap, an IP rate limit — the shape ADR 0010 chose
  for the subscriber form — and a **global ceiling of about 20 sign-in sends a day**, far above the
  0.4 expected and bounding any attack to a fifth of the quota. When the ceiling is hit the honest
  behaviour is to tell the shelter to try tomorrow, never to eat the digest.
- **Losing the inbox is recovered out of band by the platform admin, recorded as a verification-log
  entry** ([ADR 0003](0003-verification-is-an-append-only-log.md)). There is no self-service path
  that is not also an account-takeover path: the account email is the single root of trust, there are
  no admin accounts, there is no password to reset, and document-based verification is out of scope.
  The only check available is the judgement the platform already made about this shelter's public
  presence, so recovery re-establishes contact through that same public presence — and the
  append-only log is where a decision of that weight belongs.
- **Sign-in adds no server-rendered route.** The form is static and posts to an action endpoint, so
  [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md)'s rule that the Worker should run as
  rarely as possible survives: the Worker runs on the code request, on the code check, and on the
  authenticated publishing routes that were already server-rendered.
- **Two numbers here are reported rather than documented** and should be treated as such: the
  PBKDF2 iteration cap is not in Cloudflare's published docs (it lives in the closed-source limit
  enforcer), and the Zero Trust free tier's 50-user figure survives only in a 2020 blog post. Neither
  is load-bearing — the decision holds if both are wrong — but do not cite them as settled fact.
