# Research: free-tier image storage and delivery for animal photos

Resolves [#5](https://github.com/sabucds/pawster/issues/5). Feeds the stack decision in [#9](https://github.com/sabucds/pawster/issues/9).
Researched 2026-09-01 against vendor pricing and docs pages only. Every number below is cited to the page that owns it.

## Answer up front

**Store and serve from Cloudflare R2, on a custom domain attached to a Cloudflare zone, serving pre-generated derivatives.**

The premise of the ticket — that egress binds before storage — is true for every option surveyed *except* the one we should pick. R2 charges nothing for egress, ever, at any volume. That single fact reorders the entire comparison: on R2 the binding resource is the 10 GB-month storage allowance, which at our page-weight budget is roughly 12,500 animals; on every other free tier the binding resource is monthly bandwidth, and it binds one to two orders of magnitude sooner.

The cost of choosing R2 is that it is storage, not an image service. It will not resize or convert anything for you. We therefore generate derivatives at upload time and store them, which is the right shape for us anyway (see [Why pre-generate](#why-pre-generate-rather-than-transform-on-the-fly)).

## The model

All arithmetic below rests on these figures. They are assumptions, not measurements; they are stated so they can be argued with and so the break-even points can be recomputed when reality disagrees.

### What one animal costs in bytes

A shelter uploads phone photos: 2–5 MB JPEGs, call it 3 MB each, 4 photos per animal (`M = 4`). We do **not** store those. On upload we produce a fixed derivative set and discard the original:

| Derivative | Dimensions | Format | Size | Count | Subtotal |
|---|---|---|---|---|---|
| Card thumbnail | 400px long edge | AVIF/WebP | ~20 KB | 4 | 80 KB |
| Detail image | 1280px long edge | AVIF/WebP | ~140 KB | 4 | 560 KB |
| Social preview (`og:image`) | 1200×630 | JPEG (client compat) | ~90 KB | 1 | 90 KB |

**≈ 730 KB per animal. Round to 0.8 MB** for metadata and slack.

For contrast, the naive path — store the originals, serve them scaled by CSS — is **12 MB per animal stored** and roughly 15× the bytes on the wire. That difference is the whole decision, and it is a decision we make in application code, not one the vendor makes for us.

### Storage at N animals

`N` is **cumulative, not concurrent**. An adopted animal's photos stay on disk unless something deletes them; a shelter that rehomes 30 animals a year still occupies 30 animals' worth of storage. Any retention policy we adopt later moves these numbers, and there is currently no such policy.

| N animals | Disciplined (0.8 MB) | Naive originals (12 MB) |
|---|---|---|
| 500 | 0.4 GB | 6 GB |
| 2,000 | 1.6 GB | 24 GB |
| 5,000 | 4.0 GB | 60 GB |
| 12,500 | 10 GB | 150 GB |

### Egress per session

Three delivery profiles, because the same catalogue can cost wildly different bandwidth depending on choices we control:

- **Lean** — 24 cards per page, one page viewed, AVIF thumbnails, 2 detail pages opened, gallery images lazy-loaded so only the hero plus one more loads:
  `24 × 20 KB + 2 × (140 + 140) KB` = **≈ 1.0 MB/session**
- **Ordinary** — 2 grid pages, 3 detail pages, most of each gallery loaded:
  `48 × 20 KB + 3 × 4 × 140 KB` = **≈ 2.7 MB/session**
- **Naive** — originals served, resized by the browser:
  `48 × 3 MB` = **≈ 144 MB/session**

The naive column is not a strawman. It is the default behaviour of an `<img src={photo.url}>` against a bucket of unprocessed uploads, and it is what happens if nobody makes an explicit decision.

### Monthly egress

| Sessions/mo | Lean (1.0 MB) | Ordinary (2.7 MB) | Naive (144 MB) |
|---|---|---|---|
| 3,000 | 3 GB | 8 GB | 432 GB |
| 10,000 | 10 GB | 27 GB | 1.4 TB |
| 30,000 | 30 GB | 81 GB | 4.3 TB |

Two loads on top of this that are easy to forget:

- **Digest emails.** 1,000 subscribers × 4 weekly digests × 6 thumbnails × 20 KB ≈ **0.5 GB/month**. Small, and smaller still in practice because Gmail proxies and caches images once per image rather than once per recipient. Not a driver, but it is not zero, and it scales with subscribers rather than sessions.
- **Social preview fetches.** WhatsApp is how listings will actually spread in Venezuela, and every share causes an unfurl fetch of the `og:image` — from the sharer's client and again from recipients' clients in some configurations. A listing shared into five group chats can pull its preview image dozens of times. Keep `og:image` under 100 KB.

**The headline ratio:** at 10,000 sessions/month the lean profile moves **10 GB of egress against 4 GB of stored bytes for 5,000 animals** — and egress recurs every month while storage is paid once. Egress overtakes storage almost immediately on any provider that meters both, which is exactly why the free tiers that look generous on storage are the ones that fail first.

## The Cloudflare CDN terms-of-service trap

This is the finding most likely to be missed, and it applies to *any* stack that puts a Cloudflare free zone in front of an image-heavy site — including stacks that store images somewhere else entirely.

Cloudflare's Service-Specific Terms, section **"Content Delivery Network (Free, Pro, or Business)"**, say:

> Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN.

> Cloudflare reserves the right to disable or limit your access to or use of the CDN, or to limit your End Users' access to certain of your resources through the CDN, if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files.

— <https://www.cloudflare.com/service-specific-terms-application-services/>

A gallery of adoption photos is, unambiguously, "a disproportionate percentage of pictures". So:

- Proxying an image-heavy origin through a free Cloudflare zone, with images served from that origin, is the thing this clause is aimed at.
- Serving the images from R2, Images, or a Worker is the **sanctioned** route — those are the named products. This is a second, independent reason to choose R2 over "any bucket plus Cloudflare in front".
- **Honest caveat:** the sentence says *Paid* Services, and the R2 free tier is not paid. Whether the R2 free allowance counts as "using the Developer Platform" for this clause is genuinely ambiguous in the text. Being on the $5/month Workers Paid plan removes the ambiguity entirely. Under the hard-$0 constraint we sit in the grey zone deliberately, and we should record that we know we are there — this clause, not any quota, is the most likely reason Cloudflare ever contacts us.

## Why pre-generate rather than transform on the fly

The instinct is to store one image and let the CDN produce sizes and formats per request. On free tiers that instinct is expensive, because on-the-fly transformation is the feature vendors most consistently withhold or meter hardest:

- It is the metered unit on Cloudinary (transformations consume the same credits as bandwidth) and on ImageKit.
- It is **Pro-only** on Supabase.
- It has its own separate monthly counter on Cloudflare Images — 5,000 unique transformations, **recurring every calendar month**, cached or not.
- R2 does not offer it at all.

Generating a fixed derivative set at upload time converts a *recurring, traffic-proportional* cost into a *one-off, catalogue-proportional* one. Roughly 0.8 MB of stored derivatives per animal buys immunity from every transformation quota in this document. It also makes page weight deterministic, which matters more here than usual: on a metered Venezuelan connection the exact byte count of a listing page is a product decision, and a derivative set we control is one we can measure in CI.

The cost is flexibility — a new breakpoint or a format change means a backfill over the whole catalogue. At our N that backfill is minutes of compute, so this is the cheap side of the trade.

## Provider by provider

### Cloudflare R2 (+ Images transformations) — the recommendation

| | Free tier |
|---|---|
| Storage | **10 GB-month** (Standard class only) |
| **Egress** | **Free. Unmetered. At any volume.** |
| Class A ops (writes) | 1,000,000/month |
| Class B ops (reads) | 10,000,000/month |
| Transformations | **5,000 unique/calendar month** via Images Free plan |
| Max object | 5 TiB (5 GiB single-part upload) |
| Overage | billed, not blocked: $0.015/GB-month, $0.36/M Class B |

Sources: <https://developers.cloudflare.com/r2/pricing/>, <https://developers.cloudflare.com/r2/platform/limits/>, <https://developers.cloudflare.com/r2/buckets/public-buckets/>, <https://developers.cloudflare.com/images/pricing/>, <https://developers.cloudflare.com/images/transform-images/>, <https://developers.cloudflare.com/images/get-started/limits/>

The decisive sentence, verbatim from the R2 pricing page:

> Egressing directly from R2, including via the Workers API, S3 API, and r2.dev domains does not incur data transfer (egress) charges and is free.

There is no bandwidth quota to exhaust. The naive 144 MB/session profile at 30,000 sessions/month — 4.3 terabytes — costs exactly $0 in egress on R2 and would be unservable on every other provider here. (We should still not do it: the bytes cost *our users* money even when they cost us none. But it means a mistake is a product bug, not a bill.)

**Arithmetic.**

- **Storage:** 10 GB ÷ 0.8 MB = **~12,500 animals.** This is the binding constraint.
- **Egress:** never binds.
- **Class B (reads):** a lean session makes ~28 image requests. 10M ÷ 28 = **~357,000 sessions/month** before reads bind — and that is the *pessimistic* figure assuming zero cache hits. With a custom domain in front, most requests are served from Cloudflare's edge cache and never reach the bucket.
- **Class A (writes):** 9 objects per animal. 1M ÷ 9 = **~111,000 animals ingested per month.** Never binds.

So R2's walls sit at 12,500 animals / 357,000 sessions, against Supabase's 1,250 animals / ~3,000 sessions. That is roughly **two orders of magnitude** of headroom difference, and it comes from one line item.

#### Cloudflare Images Free is real, and it is the part people get wrong

A standalone Images **Free** plan exists and includes the transformation engine:

> By default, all users are on the Images Free plan. The Free plan includes access to the transformations feature, which lets you optimize images stored outside of Images, like in R2.

What the paid plan buys is *storage inside Images*, not the ability to transform. So `R2 origin + /cdn-cgi/image/...` resizing and AVIF/WebP conversion is a genuinely $0 combination — the only one in this survey that offers on-the-fly transformation for free.

Two details that matter:

- **`format=auto` counts as one transformation, not two.** Verbatim: *"if `width=100,format=auto/thumbnail.jpg` is served to some users as AVIF and to others as WebP, then this counts as one unique transformation instead of two."* Free AVIF negotiation for one unit is the best value in this entire document.
- **The 5,000 counter resets every calendar month and re-counts cached images.** *"The first request for each unique version within a calendar month is billed as one unique transformation, regardless of cache status."* The budget is therefore *5,000 distinct (image × parameter-set) pairs served per month*, recurring — not 5,000 lifetime. At 5 variants per animal that is **~1,000 distinct animals viewed per month**, every month, forever.

That last point is why the recommendation is still to pre-generate. On-the-fly transformation via Images Free is a perfectly good way to start and will carry us to about 1,000 actively-viewed animals; pre-generating derivatives into R2 removes the ceiling entirely and moves the binding constraint back to the 10 GB of storage. Exceeding the transformation allowance is not billed — *"You will not be charged for exceeding the limits in the Free plan"* — you get HTTP 9422 and broken images, with `onerror=redirect` available as a fallback to the original.

#### The r2.dev trap

The free public bucket URL is not a production asset:

> Managed public bucket access through an `r2.dev` subdomain is not intended for production usage and has a variable rate limit applied to it.

Requests beyond "hundreds of requests/second" get 429s, throughput is throttled, and critically:

> To use features like WAF custom rules, **caching**, access controls, or Bot Management, you must configure your bucket behind a custom domain. These capabilities are not available when using the `r2.dev` development url.

**r2.dev is not CDN-cached**, so every single image view becomes a billable Class B `GetObject` — it turns the one R2 meter that could plausibly bind into the meter you hit fastest. Cloudflare also warns against CNAME-ing your own domain at it: *"This is an unsupported access path."*

The fix is a custom domain, which requires *"a zone in the same account as the R2 bucket."* Usefully, a **partial (CNAME) setup** satisfies this — you do **not** have to move the domain's nameservers to Cloudflare. Given the map already accepts a domain name as the one permitted cost, this constraint is already paid for. Also note: transformations have the same requirement and cannot run on a Cloudflare-provided dev subdomain (error 9524 explicitly calls out `pages.dev`).

#### What a Free *zone* does not give you

- **No HMAC token authentication.** *"Access to the `is_timed_hmac_valid_v0()` HMAC validation function requires a Cloudflare Pro, Business, or Enterprise plan."* Signed-URL protection at the edge is off the table; R2 S3 presigned URLs (1 second to 7 days) still work for uploads.
- **WAF custom rules: 5 maximum, no regex.**
- **Scrape Shield hotlink protection covers `gif, ico, jpg, jpeg, png` only** — not WebP or AVIF. Since our derivatives are exactly WebP/AVIF, this feature cannot protect them. It matters less than it sounds: with egress free, hotlinking costs us nothing but Class B ops, of which we have 10M. On ImageKit or Supabase the same hotlink would be an outage.
- **Do not put a Worker in the image path.** Workers Free is 100,000 requests/day, resetting midnight UTC, with Error 1027 above it. Serving directly from an R2 custom domain has no daily cap; adding a Worker imposes one for no benefit here.

#### Unverified, and worth five minutes before committing

1. **Whether Images Free transformations work on a Free-tier Cloudflare zone.** No current doc states a zone-plan gate and the product is badged "Available on Free and Paid plans", but legacy Image Resizing historically required Pro+. This is the single fact that would invalidate the $0 plan — check it in the dashboard.
2. **Whether a cache hit on a custom domain avoids a billable Class B op.** Strongly implied ("does not contact origin"), never stated. Budget as if it does not.
3. **Whether activating the R2 subscription requires a card on file.** Docs say "complete the checkout flow" without mentioning payment details.
4. Whether the 5,000 transformations allowance is per account or per zone. Account-level is the natural reading; unstated.

### Supabase Storage — egress binds, and it binds hard

| | Free plan |
|---|---|
| Storage | 1 GB |
| Egress | 5 GB uncached + 5 GB cached, **shared across Database, Auth, Realtime, Edge Functions and Storage** |
| Transformations | **Pro-only** |
| Max upload | 50 MB |
| Overage | not billed — *restricted* |
| First paid $ | $25/mo (Pro) |

Sources: <https://supabase.com/pricing>, <https://supabase.com/docs/guides/platform/manage-your-usage/egress>, <https://supabase.com/docs/guides/storage/serving/image-transformations>, <https://supabase.com/docs/guides/platform/free-project-pausing>, <https://supabase.com/docs/guides/platform/billing-faq>

**Arithmetic.** Storage: 1 GB ÷ 0.8 MB = **~1,250 animals**. Egress: 5 GB ÷ 1.0 MB lean = **5,000 sessions/month**, and that is the *optimistic* number because the same 5 GB also carries every API response, auth call and Realtime message. Call it **~3,000 real sessions/month**. On the ordinary profile it is closer to 1,200.

**What binds: egress**, at roughly a quarter of the animal count that storage would allow.

Three things make this worse than the table suggests:

1. **Image transformations are Pro-only**, stated verbatim: *"Image Resizing is currently enabled for Pro Plan and above."* Free-tier Supabase is a plain bucket.
2. **Exceeding quota does not bill you, it restricts you** — documented restrictions include pausing projects, switching the database to read-only, and *"Responding with a 402 status code for all API requests"*. A bandwidth spike does not cost money; it takes the whole site down, database included. For a $0 project that is arguably the correct failure mode, but it must be a conscious choice.
3. **Free projects pause after 1 week of inactivity**, and you get two active free projects per org. A shelter directory that is quiet over the holidays can go to sleep. (Vendor pages conflict on the restore window — the docs say 1 year, the changelog says 90 days. Plan for 90.)

Note also that no hotlink protection is documented, and a public bucket URL is freely hotlinkable — someone else's traffic spending your 5 GB.

### UploadThing — genuinely unmetered egress, but only 2 GB of shelf

| | Free plan ("2GB App") |
|---|---|
| Storage | 2 GB, **shared across all your apps** |
| Egress | **Unlimited, not charged** |
| Transformations | none, at any tier |
| Max upload | 4 MB default for images (configurable in the file route); platform ceiling undocumented |
| Private files | **paid-only** |
| First paid $ | $10/mo |

Sources: <https://uploadthing.com/pricing>, <https://docs.uploadthing.com/blog/usage-based>, <https://docs.uploadthing.com/file-routes>, <https://docs.uploadthing.com/working-with-files>

The vendor is explicit: *"Unlike all of our competitors, we don't charge for things like seats, requests, or bandwidth."*

**Arithmetic.** Egress: unbounded, so it never binds. Storage: 2 GB ÷ 0.8 MB = **~2,500 animals**. That is the whole story.

**What binds: storage**, at ~2,500 animals.

This is the closest runner-up to R2 and deserves credit for it — the free tier's shape is right, and 2,500 animals is a plausible two-to-three year horizon for a Venezuelan shelter directory. It loses on three points: 2.5× less runway than R2 for the same bytes, no private files on the free tier (everything is publicly reachable by URL), and the storage quota is shared across every app on the account, so a future side project competes with Pawster for it. Its first paid step is cheaper than everyone else's at $10/mo, which is a real point in its favour if we ever do break.

### Cloudinary — one fungible pool, and a punitive failure mode

| | Free plan |
|---|---|
| Allowance | **25 credits/month**, fungible |
| Conversion | 1 credit = 1 GB storage = 1 GB delivered bandwidth = 1,000 transformations |
| Transformations | yes, incl. `f_auto`/`q_auto` |
| AVIF | **no** on free |
| Max image | 10 MB, 25 MP |
| Reset | rolling 30 days |
| First paid $ | **$99/mo** (Plus, 225 credits) |

Sources: <https://cloudinary.com/pricing>, <https://cloudinary.com/pricing/compare-plans>, <https://cloudinary.com/documentation/developer_onboarding_faq_credits>, <https://cloudinary.com/documentation/transformation_counts>, <https://cloudinary.com/documentation/image_optimization>, <https://cloudinary.com/documentation/ts_why_is_my_account_disabled_and_how_can_i_recover_my_disabled_account>

**Arithmetic.** Everything competes for the same 25 GB-equivalent. At 2,000 animals: storage 1.6 GB = 1.6 credits. Transformations are billed only when a *new* derived asset is generated — *"multiple requests to the identical transformation URL do not affect transformation counts"* — so 9 variants × 2,000 animals = 18,000 transformations = **18 credits in the month you backfill the catalogue**, then ~1 credit/month for new intake. Steady state leaves roughly **22 credits for bandwidth = ~22,000 lean sessions/month** (~8,000 ordinary). That is the most generous bandwidth headroom of any metered provider here.

**What binds: egress**, at ~22,000 lean sessions/month — but a bulk re-encode can make transformations bind instead for one month, which is a nasty trap when you change a breakpoint.

Two disqualifying details for this project:

- **AVIF is not available.** *"If your account plan uses the image bandwidth metric, AVIF, animated AVIF and JPEG XL aren't supported for `f_auto` by default."* Free is a bandwidth-metric plan. AVIF is typically 20–30% smaller than WebP at equal quality — on metered Venezuelan connections that is precisely the saving we care most about, and Cloudinary's free tier is the one option that withholds it.
- **Overage disables the account, and then deletes the data.** *"eventually the account will be automatically disabled"*, and *"After 30 days, all product environments and their assets, metadata, and settings are permanently removed."* Combined with a $99/mo first paid step, the recovery path from a traffic spike is either a large bill or total data loss on a 30-day clock. That risk profile does not belong in a non-profit side project.

### ImageKit — the closest thing to a fair fight, on separate meters

| | Forever-free plan |
|---|---|
| Storage | **3 GB** (fixed cap; uploads stop) |
| Bandwidth | **20 GB/month** (delivery stops) |
| Metering | four independent meters, not fungible |
| Transformations | yes, unmetered — paid for through bandwidth only; **AVIF not gated** |
| Max image | 25 MB |
| Reset | 1st of the month |
| First paid $ | **$9/mo** + PAYG |

Sources: <https://imagekit.io/plans/>, <https://imagekit.io/docs/how-pricing-works>, <https://imagekit.io/docs/media-delivery-basic-security>

Note the pricing page moved: `imagekit.io/pricing` now 404s, and the current numbers (3 GB storage, 20 GB bandwidth) are **lower** than the 5 GB / 25 GB that stale third-party comparison articles still quote. This is exactly why the ticket asked for primary sources.

**Arithmetic.** Storage: 3 GB ÷ 0.8 MB = **~3,750 animals**. Bandwidth: 20 GB ÷ 1.0 MB = **20,000 lean sessions/month** (~7,400 ordinary). Bandwidth is measured on the *optimized output*, which is generous — a 500 KB original delivered at 30 KB counts as 30 KB.

**What binds: it depends, and this is the one genuine toss-up.** The crossover is at roughly **5.3 sessions per animal per month**: below that, storage binds first; above it, bandwidth does. A 2,000-animal directory doing 20,000 sessions/month (10 views per animal) hits bandwidth first. A 3,500-animal directory doing 8,000 sessions hits storage first. Either way, both walls arrive at a similar scale, which at least means no single number surprises you.

Its failure mode is the best of the metered options: meters are independent and degrade separately — bandwidth exhausted breaks image delivery but leaves the account intact; storage exhausted blocks uploads but keeps serving. No account disabling, no purge clock. And the upgrade cliff is $9/mo, not $99.

The one hard limitation: **referrer-based hotlink protection is enterprise-only** — *"to prevent hotlinking and advanced restrictions based on HTTP referrer, IP, country, etc., you should use advanced security features available on the enterprise plan."* Signed URLs are available on free as a partial substitute. Since bandwidth is a hard-stop meter, an unprotected hot link is a denial-of-service on your own images.

### Backblaze B2 — honourable mention, not surveyed in the ticket

10 GB storage always free; egress free up to **3× average monthly stored data**, then $0.01/GB (<https://www.backblaze.com/cloud-storage/pricing>). At 4 GB stored that is 12 GB/month of free egress — better than Supabase, worse than R2, and with no transformation layer. Worth knowing it exists as a second-source backup target; not worth choosing over R2, whose egress allowance is not a multiple of anything.

## Where each provider breaks

Using 0.8 MB/animal of stored derivatives and the lean 1.0 MB/session delivery profile. "Breaks at" is whichever wall arrives first.

| Provider | Storage wall (animals) | Egress wall (sessions/mo) | **Binds first** | Failure mode | First paid $ |
|---|---|---|---|---|---|
| **Cloudflare R2** | **12,500** | never (egress free); reads ≈357,000 | **Storage** | billed, not blocked | $0.015/GB |
| UploadThing | 2,500 | never (bandwidth free) | **Storage** | undocumented; likely upload block | $10/mo |
| ImageKit | 3,750 | 20,000 | **toss-up** (crossover ≈5.3 sessions/animal/mo) | that meter hard-stops | $9/mo |
| Cloudinary | ~25,000 if all credits went to storage | ~22,000 after storage + transformation credits | **Egress** (shared pool) | **account disabled, purge at 30 days** | $99/mo |
| Supabase | 1,250 | ~5,000 nominal, **~3,000 real** (shared with DB/API) | **Egress** | 402 on all API requests; project pauses | $25/mo |
| Backblaze B2 | 12,500 | 3× stored ≈ 12,000 | Egress | billed at $0.01/GB | $0.01/GB |

**Is egress the binding constraint?** Yes — for four of the six, and decisively so for the two that look most convenient (Supabase, Cloudinary). It is *not* binding for R2 and UploadThing, and that is precisely what makes them the right answers. The way to win a bandwidth-constrained problem is to pick a provider that does not meter bandwidth.

## Recommendation

**Cloudflare R2, custom domain (partial CNAME setup is sufficient), pre-generated derivatives, `format=auto` transformations on Images Free as a convenience layer.**

Concretely:

1. Shelter uploads originals via an S3 presigned URL straight to R2 — the bytes never transit our app server, which keeps us inside whatever request-size limit the eventual host imposes.
2. A post-upload job re-encodes to the fixed derivative set (4 thumbnails, 4 detail images, 1 `og:image`) and writes them back to R2. Discard the original, or keep it in the Infrequent Access class if we want a re-encode source — noting the free tier does **not** cover Infrequent Access.
3. Serve derivatives from the custom domain. No Worker in the path.
4. Enforce the page-weight budget in CI, because on R2 nothing else will: the provider has stopped being the thing that tells us we are shipping too many bytes, and our users are on metered connections.

**Runway:** ~12,500 animals and effectively unbounded traffic at $0. If we ever pass 10 GB, the eleventh gigabyte costs 1.5 cents and nothing breaks. That is the only option here whose overage is a rounding error rather than a $25–$99 step or an outage.

**Second choice: UploadThing.** Unmetered bandwidth, 2,500 animals, $10 first step, and a much simpler setup. Choose it if the Cloudflare zone requirement turns out to be a real obstacle, and accept the 5× shorter storage runway and public-by-default files.

**Do not choose Supabase Storage for images** even if we choose Supabase for the database — which is a live possibility, and these are separable decisions. Its 5 GB egress is shared with every database and auth call, transformations are Pro-only, and blowing the quota returns 402 on *all* API requests. Putting images on that same meter means a photo-heavy month takes down the database too. Keep the meters separate.

## Things that would surprise someone who assumed this was easy

1. **Egress is the usual binding constraint, and the winning move is to sidestep it rather than optimise it.** R2's free unlimited egress is not a generous tier; it is Cloudflare's standing anti-AWS position, and it does not expire.
2. **Free-tier overage failure modes differ far more than the quotas do.** Cloudinary disables the account and purges assets after 30 days. Supabase returns 402 on the whole API and pauses the project. ImageKit stops delivering images. R2 charges 1.5 cents. For a non-profit with no card-on-file safety net, that column matters more than the GB column.
3. **On-the-fly transformation is the feature most consistently withheld.** Supabase gates it behind Pro; Cloudinary spends the same credits on it as on bandwidth; Cloudflare's allowance re-counts every calendar month even for cached images. Only Cloudflare Images Free offers it at genuinely $0, and only for 5,000 unique variants a month.
4. **Cloudflare's CDN terms restrict serving "a disproportionate percentage of pictures" on Free/Pro/Business zones**, and name the Developer Platform, Images and Stream as the products that make it permissible. This constrains *any* stack fronted by a free Cloudflare zone, and it is a terms problem rather than a quota problem — no dashboard will warn you.
5. **Cloudinary's free tier cannot serve AVIF.** *"If your account plan uses the image bandwidth metric, AVIF… aren't supported for `f_auto` by default."* The one provider whose whole pitch is optimisation withholds the best format from free users, on exactly the metric where our users pay per megabyte.
6. **ImageKit's published free tier is smaller than the internet thinks.** 3 GB storage and 20 GB bandwidth today, against the 5 GB / 25 GB still quoted in comparison articles, and `imagekit.io/pricing` now 404s. Every number in a listicle is a number from an unknown date.
7. **Cloudflare's own hotlink protection does not cover WebP or AVIF** — `gif, ico, jpg, jpeg, png` only. Harmless on R2 where egress is free; an outage vector on any hard-stop bandwidth meter.
8. **Storage is cumulative and nothing here has a retention policy.** Adopted animals keep their photos forever unless we decide otherwise. The 12,500-animal figure is a lifetime total, not a concurrent one, and a deletion or archival policy is a real product decision we have not yet made.
