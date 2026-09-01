# Research: free-tier email sending for transactional mail and digests

Resolves [#4](https://github.com/sabucds/pawster/issues/4). Parent map: [#1](https://github.com/sabucds/pawster/issues/1).

Constraints this research is answering against (from the map's Notes): hard $0/month at low volume, non-profit, and a periodical digest email that is the product's differentiator. Pawster has no adopter accounts — subscription is an email address managed by a signed link — so the digest list is opt-in-by-construction but never double-opt-in-confirmed by a click-to-verify step unless we build one.

All findings below are from vendors' own current pricing, docs, and policy pages, fetched 2026-09-01. Every claim below is traceable to a cited URL; the full quote-level detail lives in the per-provider sections. Where a page could not be fetched directly (a few were behind bot-blocking), that is noted and the finding is still vendor-sourced (via a text-extraction proxy of the live page, or a search-engine excerpt of it), never third-party commentary.

## Recommendation

**Resend**, split across its two products:

- **Transactional mail** (shelter auth, subscription confirmation) → Resend's Emails API. Free: 3,000 emails/month, 100/day. Trivial at Pawster's scale — auth and confirmation emails are one-off, per-action sends, not proportional to subscriber count in the way a digest is.
- **The digest** → Resend Broadcasts, sent to a Resend Audience. This is the load-bearing finding: **Broadcast sends are metered by contacts stored (1,000 free), not by messages sent** — Resend's own quotas page lists "Marketing emails: unlimited emails to up to 1,000 contacts per month" as a pool entirely separate from the 100/day transactional cap. A weekly digest to 1,000 subscribers (~4,333 sends/month) costs nothing extra and never touches the transactional quota at all. The free tier only breaks when the **subscriber list** passes 1,000 — send frequency and volume don't enter into it.

No credit card required, no manual approval/review step found (contrast every other viable candidate), domain verification is self-serve (SPF+DKIM auto-generated, DMARC recommended), and Resend's Acceptable Use Policy already requires explicit opt-in — which the signed-link subscribe flow satisfies as designed.

**Caveat on this recommendation**: the "broadcasts don't count against the transactional quota" reading comes from a dedicated Resend knowledge-base page enumerating both quota types side by side, not a single explicit sentence saying "broadcasts are excluded from the transactional quota." It's the most authoritative page found and is corroborated by Resend's pricing-page architecture (transactional priced per-send, marketing priced per-contact-tier), but it's the one place in this research where "too good to be true" deserves a second look before committing — see [Verifying before build](#verifying-before-build).

**Fallback if that reading turns out wrong or changes**: **SMTP2GO**. Free tier is 1,000 emails/month, 200/day, no credit card, no time limit, and — unlike most of the field — its own Terms of Service *affirmatively describe* opt-in newsletters as a permitted use case rather than something to avoid. At Pawster's plausible early scale (a few hundred subscribers, weekly-to-monthly digest) this comfortably covers both transactional and digest mail from one pooled quota. It breaks around S≈200 (same-day batch, daily-cap-bound) unless the digest send is paced across a few days, in which case the monthly cap (1,000) governs instead — see the arithmetic below.

Everything else surveyed is disqualified or degrades to non-free, mostly for reasons that are not obvious from a plan-comparison table:

- **Postmark**: perpetual free tier is real (confirmed — not a trial), but capped at 100 emails/**month**, shared across all message types. Also requires a manual account-approval step before you can send to anyone outside your own verified domains.
- **Mailgun**: free tier (100/day) only sends to ~5 "Authorized Recipients" who must individually click an activation link — unusable for a public subscriber list — unless a credit card is added, which reopens billing exposure the project is trying to avoid.
- **Amazon SES**: no longer has a perpetual free tier for new accounts (changed 2025-07-15) — it's a $200 general AWS credit for 6 months. Every new account starts in a sandbox that can only send to individually verified addresses (200 msgs/24h) until AWS manually approves a "production access" request. AWS has no built-in hard $0 spending cap.
- **Brevo**: free tier (300/day, no card) is real and generous, but Brevo's own documentation explicitly classifies a periodic newsletter/digest as **marketing, not transactional** — and free-plan marketing mail carries a "Sent by Brevo" footer.
- **MailerSend**: requires a credit card even for the $0 plan, requires a separate manual "account approval" step, and its own docs actively discourage using it for newsletter/digest content — recommending its sister product MailerLite instead and warning the SMTP relay "may not render or send properly" for that pattern.
- **ZeptoMail, Scaleway Transactional Email**: contractually **prohibit** marketing/bulk mail outright — a digest would violate their terms.
- **SendGrid**: no longer has a perpetual free tier at all (retired 2025-05-28); now a 60-day trial only.

## The arithmetic

Let **S** = subscriber count, **f** = digests sent per month (weekly ≈ 4.33, fortnightly ≈ 2.17, monthly = 1). A digest sent to all subscribers in one send generates **S** individual messages; over a month that's **S × f** sends.

Two constraints can bind, and providers with a daily cap are usually bound by the **daily** one, not the monthly one:

- If a digest goes out as one batch on send day (the normal pattern), the entire run must fit under the **daily cap** — the monthly cap is irrelevant unless the send is deliberately paced across multiple days.
- The **monthly cap ÷ f** only becomes the binding number if the send is spread across enough days within the period that no single day's slice exceeds the daily cap.

So for any provider with both caps, report both: `S*_daily = daily_cap` (single-day batch), and `S*_monthly = monthly_cap / f` (spread across the month).

| Provider | Daily cap | Monthly cap | S* same-day batch | S* spread across month (f=weekly/fortnightly/monthly) | Binding constraint at Pawster scale |
|---|---|---|---|---|---|
| **Resend Broadcasts** (digest) | none documented | none documented — **1,000 *contacts*, not sends** | **not send-limited** | **not send-limited** | Subscriber-list size, flat 1,000, independent of frequency |
| Resend Emails API (transactional) | 100 | 3,000 | 100 | 692 / 1,385 / 3,000 | n/a for digest — used only for auth/confirmation |
| Postmark (all streams pooled) | none | 100 | unbounded by day, capped by month | 23 / 46 / 100 | 100/month total, shared with transactional |
| Brevo | 300 (+ up to 1,000 queued overflow) | none stated | 300 (≈1,300 with overflow, delivered late) | effectively daily-bound | 300 per send day |
| MailerSend | 100 | 500 | 100 | 100 (daily always binds first here) | 100 per send day |
| Mailgun (card added) | 100 | ~3,000 (100×30) | 100 | 692 / 1,385 / 3,000 | 100 per send day unless paced |
| SMTP2GO | 200 (25/hr pre-verification) | 1,000 | 200 | 231 / 462 / 1,000 (daily binds for weekly) | 200 per send day unless paced |
| Elastic Email | 100 | 3,000 | 100 | 692 / 1,385 / 3,000 | 100 per send day unless paced |
| Amazon SES (sandbox) | 200, verified recipients only | n/a | not usable for public list pre-approval | n/a | Manual review gate, not volume |
| Amazon SES (production) | "varies," assigned case-by-case | pay-as-you-go, $0.10/1,000 | n/a — not a free tier once real | n/a | Stops being free at the first email sent |

**Reading the table**: Resend is the only candidate where S is unbounded by send volume — the free tier's actual trigger is **1,001st subscriber**, full stop, regardless of whether the digest is weekly or monthly. Every other viable provider's break point is a genuinely small number (dozens to low hundreds) once you account for the fact that a digest is naturally sent as one same-day batch, not spread — a distinction that a naive "monthly cap ÷ sends" calculation would understate by 3–10x.

## Does a digest count as "marketing," per each provider's own policy?

This determines both price (some providers' marketing/transactional quotas are genuinely separate, others share one pool) and which product/API you're contractually required to use.

| Provider | Digest = marketing? | Basis |
|---|---|---|
| Resend | Not explicitly stated either way | No published test; Broadcasts (contact-metered) is architecturally the intended home for recurring same-content sends, but this is inferred from product design, not a quoted rule. AUP requires opt-in regardless of classification. |
| Postmark | **Yes**, by Postmark's own explicit rule | "If your email has multiple recipients receiving the same content, and it's not triggered by an event, then it's not transactional... considered bulk (or marketing, or promotional)." (One other Postmark page lists "weekly digest emails" as transactional-appropriate — an internal inconsistency, likely referring to *personalized per-user* digests rather than identical-content fan-out.) |
| Brevo | **Yes**, explicitly | Brevo defines marketing as "bulk emails sent... for promotional purposes," explicitly listing newsletters as the example; transactional is defined as "strictly informational" and event-triggered. |
| MailerSend | **Yes**, explicitly, and discouraged | Newsletters are named as a marketing example in MailerSend's own transactional-vs-marketing comparison page; MailerSend recommends its own product not be used for this pattern at all. |
| Mailgun | Not directly documented in this research | No Mailgun page found stating a transactional/marketing content test; standard ESP practice would treat a same-content fan-out as bulk. |
| Amazon SES | No pricing distinction; a policy question, not a billing one | SES's production-access request form requires you to *classify* your traffic as Marketing or Transactional and to affirm recipients "explicitly requested it," but doesn't price or gate the two differently once approved. |
| ZeptoMail / Scaleway TEM | **Yes**, and prohibited | Both explicitly forbid marketing/bulk/newsletter content on their transactional-only products. |
| SMTP2GO | Marketing explicitly **permitted** | ToS require "100% opt-in" recipients (customer, member, subscriber, or someone who asked to receive mail) — a newsletter/digest is a documented, allowed use case, not a special or discouraged one. |

## Regulatory floor (why none of this needs DMARC or one-click unsubscribe on day one)

- **Gmail's bulk-sender threshold is ~5,000 messages/day to Gmail addresses.** Below that, Google only requires SPF-or-DKIM, valid forward/reverse DNS, and TLS — not DMARC or RFC 8058 one-click unsubscribe. Those extra requirements (DMARC, one-click List-Unsubscribe, spam rate <0.3%) only bind once you cross 5,000/day. (support.google.com/mail/answer/81126, support.google.com/a/answer/14229414, 2026-09-01)
- **Yahoo** requires SPF-or-DKIM for all senders, both for bulk; Yahoo's own site does not state a numeric bulk threshold (commonly assumed to mirror Google's 5,000 as part of the joint 2024 "Yahoogle" push, but that number isn't on Yahoo's own page). (senders.yahooinc.com, 2026-09-01)
- **Microsoft/Outlook.com** imposed a matching SPF/DKIM/DMARC-pass requirement, but only for domains sending >5,000/day, enforced (rejecting non-compliant mail) since 2025-05-05. Below that, Microsoft states only general best-practice recommendations. (Microsoft Defender for Office 365 blog, techcommunity.microsoft.com, 2026-09-01)
- **CAN-SPAM (US)** turns on whether a message's primary purpose is "commercial advertisement or promotion of a commercial product or service." A shelter's periodical listing of adoptable animals (not for sale) plausibly falls outside that definition into the FTC guide's residual "Other" bucket, which carries no specific unsubscribe/postal-address mandate — but the FTC's own compliance guide never mentions non-profits at all, so this is a reasonable reading of the statute's content-based test, not a confirmed exemption. Regardless, an unsubscribe link and honoring opt-outs is cheap, already required by essentially every ESP's own terms, and removes the question entirely. (ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business, 2026-09-01)
- **GDPR/ePrivacy** requires prior opt-in consent ("a clear affirmative act") for direct-marketing email to EU-resident subscribers — relevant only if diaspora/EU adopters subscribe. A signed-link subscribe flow is a defensible affirmative-action consent record. (Directive 2002/58/EC Art. 13, Regulation 2016/679 Art. 4(11) & Recital 32, eur-lex.europa.eu, 2026-09-01)
- **Venezuela has no meaningful data-protection or anti-spam statute** — confirmed by the absence of one, cross-checked against IAPP and DLA Piper's Data Protection Laws of the World tracker for Venezuela. The only rights in play are the general constitutional habeas data (Art. 28) and privacy (Art. 60) provisions, neither of which regulates commercial email specifically. The operative constraints on this project come entirely from the receiving mailbox providers' rules and the chosen ESP's own terms, not Venezuelan law.

Net effect: Pawster is nowhere near any bulk-sender threshold and likely outside CAN-SPAM's "commercial" definition entirely — but building unsubscribe handling anyway (as the domain notes already require, given the standing "unsubscribe, retention, what the privacy notice must say" open question on the map) is the right call regardless of what's legally mandatory, since every viable ESP's own terms require it independent of statute.

## Surprises worth flagging

1. **Resend's marketing product is priced/limited by contacts, not sends.** A "free tier" framed as "3,000 emails/month" on the pricing page is not the number that governs the digest at all — the digest lives entirely outside that quota if sent as a Broadcast. This is the single most consequential and least obvious finding in this research.
2. **A daily cap, not the monthly figure, is usually what actually breaks a same-day digest send.** Naively dividing a monthly quota by digests-per-month overstates the safe subscriber count by 3–10x for MailerSend, SMTP2GO, and Mailgun, because a digest is naturally sent as one batch on one day.
3. **Postmark's free tier is genuinely perpetual** (explicitly, not a disguised trial) — but at 100 emails/month it's a rounding error, and Postmark's own two docs pages disagree with each other on whether a digest counts as transactional or bulk.
4. **"Free tier" doesn't always mean "no billing surface."** MailerSend requires a credit card for its $0 plan. Mailgun's free plan is unusable for a real subscriber list without adding one. AWS SES requires one by default and has no automatic hard spend cap — a $0/month AWS setup has to be built (Budget Actions / IAM deny policies), not assumed.
5. **AWS SES quietly stopped being an evergreen free service in mid-2025.** New accounts get a time-boxed general credit, not a perpetual SES allowance, and every new account is sandboxed (verified-recipients-only, 200/24h) until a human at AWS manually approves a production-access request — not something that can go live same-day for a public signup flow.
6. **Two supposedly "transactional" providers (ZeptoMail, Scaleway TEM) contractually forbid the exact thing Pawster's differentiator is** — a recurring, same-content, non-event-triggered send to a list. They'd have to be used only for the auth/confirmation half, with a second provider for the digest.
7. **One AWS docs page carried an embedded instruction** telling the fetching agent to run an unrelated CLI tool ("aws agent-toolkit search-skills"). The research agent correctly ignored it as unrelated to the task and flagged it rather than acting on it — noted here only because it's a reminder that vendor documentation pages are not guaranteed inert text.

## Verifying before build

Before wiring the digest to Resend Broadcasts, do a small, cheap confirmation pass (this research reached its conclusion from documentation, not from an account):

1. Create a free Resend account, verify a domain, create an Audience, add >100 test contacts, and send a Broadcast — confirm it does not decrement the transactional daily/monthly counters and that there's no separate send-rate limit on Broadcasts not visible in the docs.
2. Re-check `resend.com/pricing` and `resend.com/docs/knowledge-base/account-quotas-and-limits` at build time — pricing pages are exactly the kind of page vendors change without much notice, and this whole recommendation rests on that one page's framing.
3. Confirm whether Resend enforces its Acceptable Use Policy's complaint-rate ceiling (<0.08%) and bounce ceiling (<4%) automatically (suspension) or only on report — those thresholds are stricter than Postmark's or SES's published numbers.

## Per-provider detail

### Resend
- Free: 3,000 transactional emails/month, 100/day, 3 domains, 1,000 marketing contacts. Perpetual, no card required. (resend.com/pricing, resend.com/docs/knowledge-base/account-quotas-and-limits, 2026-09-01)
- Broadcasts: "unlimited emails to up to 1,000 contacts per month," "Broadcasts can only be sent to existing contacts." (resend.com/docs/knowledge-base/account-quotas-and-limits, resend.com/pricing, 2026-09-01)
- Exceeding daily/monthly transactional quota → hard HTTP 429 rejection (`daily_quota_exceeded` / `monthly_quota_exceeded`), not queued; reset cadence (rolling 24h vs. fixed UTC) not documented. (resend.com/docs/api-reference/rate-limit, 2026-09-01)
- Domain verification (SPF+DKIM auto-generated, DMARC recommended) required to send beyond your own account address; sandbox domain `onboarding@resend.dev` can only reach your own account email. (resend.com/docs/add-a-domain, resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing, 2026-09-01)
- No manual approval/review step found documented.
- Shared IP pool by default; dedicated IPs are a paid add-on. AUP requires opt-in-only lists, complaint rate <0.08%, bounce rate <4%. (resend.com/docs/knowledge-base/how-do-dedicated-ips-work, resend.com/legal/acceptable-use, 2026-09-01)
- API rate limit: 10 requests/second per team. All account data/metadata stored in the US regardless of sending region. No non-profit discount program found. (resend.com/docs/api-reference/rate-limit, resend.com/security/gdpr, 2026-09-01)
- First paid step: Pro $20/month → 50,000 transactional/mo, no daily cap; marketing/contacts priced separately by contact-count tier ($40/mo = 5,000 contacts, scaling to $650/mo = 150,000). (resend.com/pricing, 2026-09-01)

### Postmark
- Free "Developer" plan: 100 emails/**month**, no daily limit, confirmed perpetual ("never expires," not a trial). (postmarkapp.com/pricing, postmarkapp.com/support/article/does-postmark-have-a-daily-send-limit, postmarkapp.com/support/article/1285-pricing-billing-faq, 2026-09-01)
- Message Streams separate Transactional and Broadcast traffic, including separate IP ranges, but both draw from the same overall plan quota (100/mo free). (postmarkapp.com/message-streams, 2026-09-01)
- Explicit bulk-content rule: same content to multiple non-event-triggered recipients = bulk/marketing, must use a Broadcast stream. Purchased/rented lists explicitly prohibited. (postmarkapp.com/support/article/804, postmarkapp.com Terms of Service, 2026-09-01)
- **Every new account undergoes manual review before it can send to any address outside its own verified domains** — typically <24h on weekdays, longer on weekends. Until approved: API/test-address sending and inbound processing work, but no external sends and no link tracking. (postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work, 2026-09-01)
- Broadcast streams auto-add unsubscribe links and RFC 8058 one-click headers by default. Required reputation thresholds: complaint <0.1%, bounce <10%. Shared IP by default (actively recommended by Postmark over dedicated for most senders); dedicated IP requires ≥300,000/month. (postmarkapp.com/support/article/managing-your-own-unsubscribe-process, postmarkapp.com/support/article/1082, postmarkapp.com/guides/dedicated-vs-shared-ips-for-email-when-to-use-each, postmarkapp.com/support/article/1135, 2026-09-01)
- First paid step: Basic $15/month → 10,000/month, $1.80/1,000 overage. (postmarkapp.com/pricing, 2026-09-01)

### Mailgun
- Free plan: 100 emails/day, no expiration stated on the current pricing page (perpetual as currently published). 1 custom sending domain included. (mailgun.com/pricing, 2026-09-01)
- **Without a credit card on file, sending is restricted to "Authorized Recipients"** — individually invited addresses that must click an activation link (roughly 5, per Mailgun's help center); the auto-provisioned sandbox domain carries the same restriction independent of card status. Adding a card lifts the restriction within the 100/day cap. (help.mailgun.com articles 203068914 and 217531258 — fetched via search excerpt after direct fetch was blocked; documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-sandbox, 2026-09-01)
- This makes the free plan **unusable for a public subscriber list without adding a card** — reopening billing exposure the project is trying to avoid, even though usage would stay at $0 while under 100/day.
- First paid step: Basic from $15/month → 10,000/month, $1.80/1,000 overage; dedicated IP add-on $59/month. (mailgun.com/pricing, 2026-09-01)

### Amazon SES
- **No perpetual SES-specific free tier for accounts created on/after 2025-07-15.** New accounts instead get up to $200 in general AWS Free Tier credits, usable for 6 months (credits expire 12 months after account creation); accounts must upgrade or the account closes after that window. Legacy accounts (pre-2025-07-15) get 3,000 free message-charges/month for 12 months. (aws.amazon.com/ses/faqs, aws.amazon.com/free/terms, 2026-09-01)
- Pay-as-you-go once free credit is exhausted: $0.10 per 1,000 emails, $0.12/GB attachments. (aws.amazon.com/ses/pricing, 2026-09-01)
- **Every new account starts in a sandbox**: sends only to individually verified addresses (or the mailbox simulator), max 200 messages/24h, 1/sec. Exiting sandbox requires a manual "production access" request through AWS Support — initial response within 24h per AWS's own docs, but can take longer if AWS needs more information; the form requires you to affirm consent-based sending and describe bounce/complaint handling. Post-approval sending quota is assigned case-by-case ("varies based on your specific use case"), not a fixed published number. (docs.aws.amazon.com/ses/latest/dg/request-production-access.html, docs.aws.amazon.com/ses/latest/dg/quotas.html, 2026-09-01)
- Enforcement thresholds, exact: bounce ≥5% → account under review, ≥10% → sending may be paused (hard bounces to unverified domains only count); complaint ≥0.1% → under review, ≥0.5% → may be paused. (docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html, 2026-09-01)
- Native Subscription Management feature auto-injects List-Unsubscribe/List-Unsubscribe-Post headers and a hosted unsubscribe page — but only when Easy DKIM is enabled and the send is one recipient per API call (which a digest naturally is). (docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html, 2026-09-01)
- **AWS provides no automatic hard $0 spending cap** — AWS Budgets offers alerts and optional Budget Actions (IAM deny policies, resource stops) that must be explicitly configured; a card is mandatory at signup and can be billed if free credit/tier is exceeded without a self-built guardrail. (docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html, 2026-09-01)
- AWS non-profit programs exist (Imagine Grant, $2,000 AWS credit via TechSoup) that Mailgun has no equivalent for. Neither vendor's terms named Venezuela specifically; both impose general OFAC/sanctions-compliance obligations on the customer. (aws.amazon.com/government-education/nonprofits, sinch.com legal terms, 2026-09-01)

### Brevo
- Free: 300 emails/day, no monthly cap documented, perpetual, **no credit card required**. Up to 100,000 contacts stored (not literally "unlimited" on Free, contrary to the general pricing-page tagline which applies at higher tiers). Exceeding the daily cap: up to 1,000 extra held in a retry queue, then dropped. (help.brevo.com articles 208580669, 360022153079, 208589409 — fetched via text-extraction proxy after Cloudflare blocked direct fetch; brevo.com/pricing, 2026-09-01)
- **Own taxonomy classifies a newsletter/digest as marketing, not transactional**: marketing = "bulk emails... for promotional purposes," explicitly listing newsletters; transactional = automated, event-triggered, "should not include any marketing content." No evidence found of separate transactional vs. marketing quotas on Free — appears to be one shared 300/day pool regardless of message type. (help.brevo.com/hc/en-us/articles/360021196220, 2026-09-01)
- Free-plan marketing mail carries a "Sent by Brevo" footer; removing it requires a paid plan. (help.brevo.com/hc/en-us/articles/208589409, 2026-09-01)
- New accounts can be suspended immediately on signup by anomaly detection; a first transactional send may require contacting support to activate. Ongoing: auto-suspension at hard-bounce >2%, unsubscribe >1%, complaint >0.2% — first suspension is self-service-reactivable, a **second is permanent deactivation**. (help.brevo.com/hc/en-us/articles/360017299259, 2026-09-01)
- Anti-spam policy requires provable opt-in per contact (not necessarily double opt-in). Shared IP by default; dedicated IP is a paid Professional/Enterprise add-on only. Nonprofit discount program exists but its page did not render content on fetch — percentage unverified. (brevo.com/legal/antispampolicy, help.brevo.com/hc/en-us/articles/209466865, 2026-09-01)
- First paid step: Starter from $9/month → 5,000/month, no daily cap, branding removed. (help.brevo.com/hc/en-us/articles/360022153079, 2026-09-01)

### MailerSend
- Free: 500 emails/month **and** 100/day (both bind), 1 domain, 1 API token, 1 template, 1 webhook, 10 email-verification credits. Perpetual as a plan tier. Exceeding the limit → hard pause, no overage billing on Free. **Requires a credit card even for the $0 plan** ("to prevent abuse"). (mailersend.com/pricing, mailersend.com/help/plans-features-and-limits, 2026-09-01)
- **Own docs classify newsletters as marketing and actively discourage this use case**: "For newsletters, promotions, and marketing campaigns, we recommend MailerLite... configuring MailerSend's SMTP relay to send regular emails is not recommended, as they may not render or send properly." (mailersend.com/help/transactional-email-vs-marketing-email, 2026-09-01)
- Separate, named "account approval" process (usually <48h) requiring company/use-case details; **unapproved accounts are restricted to 1 CC and 1 BCC recipient per email.** (mailersend.com/help/getting-started, mailersend.com/help/how-to-start-sending-emails, 2026-09-01)
- Terms of Use require a single-click unsubscribe on marketing mail and an opt-in legal basis; purchased/rented lists explicitly prohibited; permission "does not age well" — contacts inactive 2+ years are flagged. (mailersend.com/legal/terms-of-use, mailersend.com/legal/anti-spam-policy, 2026-09-01)
- Nonprofit program: confirmed 30% recurring discount, but paid plans only, not stackable with the annual-billing discount. (mailersend.com/solutions/nonprofits, 2026-09-01)
- First paid step: Hobby $7/month ($6.30 annual) → 5,000/month, $1.50/1,000 overage. (mailersend.com/pricing, 2026-09-01)

### Alternates surveyed
- **ZeptoMail**: 10,000-email trial credit valid 1 month, then credit-based (~$2.50/10,000, 6-month credit validity). **Explicitly prohibits marketing/bulk/newsletter use** — "not intended for sending bulk marketing or promotional emails," redirects such use to Zoho Campaigns. Disqualified. (zoho.com/zeptomail/pricing.html, help.zoho.com ZeptoMail FAQ, 2026-09-01)
- **SendGrid**: perpetual free tier retired 2025-05-28. Current offer is 100/day for 60 days only, no card required, then must upgrade (from $19.95/mo) or sending stops and contacts over 100 are deleted. Disqualified for an ongoing $0/month project. (twilio.com/en-us/changelog/changes-coming-to-sendgrid-s-free-plans, twilio.com/en-us/products/email-api/pricing, 2026-09-01)
- **Mailjet**: 6,000/month, 200/day, 1,000 contacts, perpetual. Whether marketing campaigns are explicitly permitted on Free specifically wasn't confirmed in the fetched pricing page text — worth a direct signup check. (mailjet.com/pricing, 2026-09-01)
- **Scaleway Transactional Email**: 300/month free, then €0.25/1,000. **Explicitly transactional-only** — "You cannot use Transactional Email to send marketing emails." Disqualified. (scaleway.com/en/docs/transactional-email/faq, 2026-09-01)
- **SMTP2GO**: 1,000/month, 200/day (25/hour before domain verification), no card, no stated expiry. ToS require 100% opt-in recipients (customer/member/subscriber/requested) and an unsubscribe link on every email — **explicitly compatible with a newsletter/digest use case**, not just tolerant of it. (smtp2go.com/pricing, support.smtp2go.com, smtp2go.com/terms, 2026-09-01)
- **Elastic Email**: 3,000/month, 100/day, up to 1,000 contacts. No explicit marketing restriction found; no explicit "perpetual" statement either, though nothing suggests a time limit. (elasticemail.com/email-api-pricing, 2026-09-01)
- **SendPulse**: figures were inconsistent between two fetched pricing pages (roughly 500 subscribers on the Email Marketing product vs. ~12,000–15,000/month on the separate SMTP/transactional product) — flagged as needing a direct signup-flow check before relying on it. (sendpulse.com/pricing, sendpulse.com/pricing/smtp, 2026-09-01)

## Sources

All fetched 2026-09-01 directly from the vendor unless noted as a search-engine excerpt or proxy fetch (both still vendor-authored content, not third-party commentary).

- resend.com/pricing, resend.com/docs/add-a-domain, resend.com/docs/api-reference/rate-limit, resend.com/docs/knowledge-base/account-quotas-and-limits, resend.com/docs/knowledge-base/how-do-dedicated-ips-work, resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing, resend.com/legal/acceptable-use, resend.com/security/gdpr
- postmarkapp.com/pricing, postmarkapp.com/message-streams, postmarkapp.com/support/article/804, postmarkapp.com/support/article/1082, postmarkapp.com/support/article/1084, postmarkapp.com/support/article/1135, postmarkapp.com/support/article/does-postmark-have-a-daily-send-limit, postmarkapp.com/support/article/managing-your-own-unsubscribe-process, postmarkapp.com/guides/dedicated-vs-shared-ips-for-email-when-to-use-each
- mailgun.com/pricing, documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-sandbox, help.mailgun.com articles 203068914 and 217531258 (search excerpt)
- aws.amazon.com/ses/pricing, aws.amazon.com/ses/faqs, aws.amazon.com/free/terms, docs.aws.amazon.com/ses/latest/dg/quotas.html, docs.aws.amazon.com/ses/latest/dg/request-production-access.html, docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html, docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html, docs.aws.amazon.com/ses/latest/dg/mail-from.html, docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html, aws.amazon.com/government-education/nonprofits
- brevo.com/pricing, brevo.com/legal/antispampolicy, help.brevo.com articles 208580669, 360022153079, 208589409, 9741388688402, 360017299259, 209466865, 360021196220, 7924148470546 (via text-extraction proxy)
- mailersend.com/pricing, mailersend.com/help/plans-features-and-limits, mailersend.com/help/transactional-email-vs-marketing-email, mailersend.com/help/getting-started, mailersend.com/help/how-to-start-sending-emails, mailersend.com/legal/terms-of-use, mailersend.com/legal/anti-spam-policy, mailersend.com/solutions/nonprofits, developers.mailersend.com/guides/checking-api-quota
- support.google.com/mail/answer/81126, support.google.com/a/answer/14229414, senders.yahooinc.com/best-practices, techcommunity.microsoft.com (Defender for Office 365 blog, Apr 2025), rfc-editor.org/rfc/rfc8058, rfc-editor.org/rfc/rfc2369
- ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business, eur-lex.europa.eu (Directive 2002/58/EC, Regulation 2016/679), iapp.org and dlapiperdataprotection.com (Venezuela, cross-checked, no primary Venezuelan government source exists to cite)
- zoho.com/zeptomail/pricing.html, help.zoho.com ZeptoMail FAQ, twilio.com/en-us/changelog/changes-coming-to-sendgrid-s-free-plans, twilio.com/en-us/products/email-api/pricing, mailjet.com/pricing, scaleway.com/en/docs/transactional-email/faq, smtp2go.com/pricing, support.smtp2go.com, smtp2go.com/terms, elasticemail.com/email-api-pricing, sendpulse.com/pricing, sendpulse.com/pricing/smtp
