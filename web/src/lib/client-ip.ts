/**
 * The caller's address, as a bucket key rather than as an identity.
 *
 * One implementation for both unauthenticated endpoints that spend mail — shelter sign-in
 * (ADR 0013) and subscriber signup (ADR 0010) — because the two limits differ in their
 * numbers and not at all in what they consider one caller. Two copies would have been two
 * places to fix the IPv6 note below.
 *
 * Read from the header directly instead of through `Astro.clientAddress`, which throws when
 * the adapter cannot supply one — an exception on a rate-limit path is a worse failure than a
 * coarse bucket. The fallback lumps every request with no `CF-Connecting-IP` into one bucket,
 * which is the conservative direction: unattributable traffic shares a single allowance
 * rather than each getting a fresh one.
 *
 * **The bucket is the whole address, which an IPv6 caller can walk out of.** A residential
 * IPv6 allocation is typically a /64, so rotating the low 64 bits gives a caller a fresh
 * allowance as often as it likes. Bucketing IPv6 by its /64 would close that, and is not done
 * here because the limit it backs is the *cheap* one on both paths — the per-address caps and
 * the global ceilings are what actually protect the mail budget, and none of them can be
 * walked out of this way. What an IPv6 rotator gets is unbounded D1 writes, which is a cost
 * worth naming and the reason this is a note rather than a shrug.
 */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unattributed";
}
