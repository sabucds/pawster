# Digest delivery: per-recipient sends, a sent-set, and a day-sharded run

_Scheduling and queueing follow ADR 0006: the run is a Cloudflare Cron Trigger and a
Cloudflare Queue, not the QStash this was first drafted against. The decisions below —
per-recipient sends, the sent-set, and the day shard — are independent of that choice._

The digest is the one subsystem Pawster exists for, and it has to run on a free tier whose
binding constraint is not what the research predicted. Resend Broadcasts were chosen for the
digest on the strength of being metered by contacts stored (1,000 free) rather than by sends
— but a Broadcast is a single shared `html` whose only personalisation is substitution of
stored contact properties. There is no loop, no iteration, no per-contact collection. "Here
are the seven dogs matching your filters" is not expressible, so **Broadcasts cannot carry a
Pawster digest at all**, and the 1,000-contact allowance is worth nothing to us.

That puts the digest on the transactional path, where the ceiling is **100 emails per day and
3,000 per month**, counted per *recipient* rather than per request, and shared with every
other mail the platform sends. Three decisions follow from it.

**Send one email per recipient, not a batch.** Resend's batch endpoint takes up to 100
per-entry-distinct emails for one rate-limit unit, which sounds made for this. It is a trap
here: its idempotency key covers the whole payload, so a resumed run that drops one recipient
gets `409`, and a resumed run with a fresh key re-sends everyone who already received it. Its
sole advantage — one rate-limit unit per hundred — is worthless against a 10 req/s limit we
could not approach if we tried, because our daily ceiling is 100 emails. So each recipient
gets `POST /emails` under a deterministic idempotency key of `digest/<period>/<subscriberId>`,
which buys per-recipient idempotency and per-recipient failure isolation. Batch is the right
call the day volume justifies a paid plan, and not before.

**A per-subscription sent-set is the source of truth for "new", not a watermark.** The
free-scheduled-execution research recommended a `last_sent_at` watermark advanced only on
confirmed send, to absorb both a missed run and a duplicate one. A sent-set does everything
the watermark does and three things it cannot. A shelter that publishes an animal with the
wrong region and fixes it the next day is invisible to a watermark that has already moved
past; overflow beyond the per-email cap is silently dropped by a watermark and survives in a
sent-set; and a re-listed animal can be reasoned about explicitly. The candidate set for a
subscription is therefore *matches the criteria* AND *currently listed* AND *not already sent
to this subscription*. `matchableSince` on the animal — bumped when a filter-axis attribute
or availability changes — exists only to make that query cheap, never to decide the answer.
`lastDigestAt` survives as a reporting field.

**Shard the run by day, with a reserved quota floor.** Every subscriber carries a stored send
day, assigned at opt-in to the least-loaded day of the week, so a weekly digest becomes seven
bounded daily runs sharing one Cron Trigger. This is one code path at ten subscribers and
at six hundred, where an overflow-when-needed design has a mode that is only ever exercised in
production. The digest's daily budget is `100 - 30`: shelter magic links, opt-in mails and
confirmation nudges always win, and a shard that exceeds its budget sends its longest-waiting
subscribers and defers the rest to tomorrow. A digest arriving a day late is a non-event; a
shelter that cannot log in because a digest ate the quota is an outage.

## Consequences

- **The $0 ceiling is ~500 weekly subscribers, not ~1,000.** Seven full shards give ~700
  sends/week, which is ~3,033/month against a 3,000 cap, and transactional mail draws on the
  same pool. The trigger to move to paid is the subscriber count crossing ~500, or a single
  day's shard needing more than 70 sends.
- **Retry lives at two levels and must not fight itself.** Cloudflare Queues retries delivery
  of the enqueue message and then dead-letters it; per-recipient idempotency keys make a
  redelivered message a no-op for anyone already sent. Resend's idempotency window is 24 hours,
  which the one-shard-per-day design keeps us inside — a resume that misses the day re-sends,
  and the sent-set is what stops it. Queue messages are retained 24 hours on the Free plan and
  are not the source of truth either: a message lost to retention is picked up by the next
  run, because the sent-set still says who has not been sent to.
- **Nothing inside Cloudflare can tell us the Cron Trigger never fired**, so a Healthchecks.io
  check is pinged once per daily run at completion, with a two-hour grace, and the dead-letter
  queue's consumer pings its `/fail` endpoint. The watchdog must live outside Cloudflare or it
  shares the failure it exists to detect. Per run, not per batch: a check per batch turns a
  quiet day into a false alarm.
- **We host the entire unsubscribe flow.** `List-Unsubscribe` and `List-Unsubscribe-Post` are
  automatic for Broadcasts only, so every digest sets both headers itself and we serve a GET
  page that unsubscribes on load plus a POST endpoint returning 202.
- **We deliberately do not mirror subscribers into Resend Contacts**, which also rules out
  `topic_id` opt-out enforcement. It would put consent — the one piece of state that must have
  a single owner — in a second system, to guard against a divergence that cannot occur, since
  one-click unsubscribe posts to our own endpoint. Resend's account-wide suppression list still
  protects us from hard bounces and complaints without any contact record existing.
- **A suppressed send still spends quota**, which is why bounces and complaints retire a
  subscriber in our own database rather than being left to Resend's suppression list alone.
- **`DigestRun` and `DigestDelivery` records are written for every run**, because Resend
  retains events for 30 days and "did she get it?" will be asked later than that.
