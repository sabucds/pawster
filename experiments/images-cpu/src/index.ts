/**
 * Throwaway probe Worker for issue #34: does a Cloudflare Images transformation's
 * encode/decode CPU count against the Worker's 10 ms Free-plan CPU budget?
 *
 * Nothing here is production code. It is deployed, measured, and deleted.
 *
 * The whole design is subtraction. A Worker invocation's CPU time includes the
 * isolate's own startup and the cost of draining a body, so an absolute reading
 * for `/binding` says nothing on its own. Every transform endpoint has a control
 * endpoint that does the identical I/O and none of the transform, and the answer
 * is the difference:
 *
 *   binding encode CPU  =  CPU(/binding)  - CPU(/control/fetch)
 *   cf.image encode CPU =  CPU(/cfimage)  - CPU(/control/fetch)
 *
 * `/cfimage` is the documented-safe form (Cloudflare states verbatim that waiting
 * on `fetch()` does not count toward CPU time), so its difference is the noise
 * floor of the measurement. If `/binding` sits on that floor too, the binding is
 * safe; if it sits milliseconds above it, the binding spends our budget.
 *
 * Source images are served by this same Worker's Static Assets, so the whole
 * experiment lives on one `workers.dev` hostname with no bucket, no public R2 and
 * no second origin. That is deliberate: it also tests #19's open claim that the
 * `cf.image` fetch form works on any zone hosting a Worker, `workers.dev`
 * included.
 */

interface Env {
  IMAGES: ImagesBinding;
  ASSETS: Fetcher;
}

/** Cache-busting is not optional. A repeated identical transformation is served
 *  from cache and encodes nothing, which would read as 0 ms of CPU and be wrong.
 *  Every request carries a distinct `bust`, which makes the source URL distinct,
 *  which makes the transformation distinct. It costs one metered transformation
 *  per measured sample — a few dozen against the 5,000/month ceiling. */
function sourceUrl(request: Request, name: string, bust: string): string {
  const u = new URL(request.url);
  u.pathname = `/fixtures/${name}`;
  u.search = `?bust=${encodeURIComponent(bust)}`;
  return u.toString();
}

/** Pull the whole body through without keeping it. Both the transform paths and
 *  their controls do exactly this, so the cost cancels in the subtraction. */
async function drain(body: ReadableStream | null): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }
  return bytes;
}

/** The binding names formats as MIME types; `cf.image` names them with its own
 *  vocabulary, where JPEG is `baseline-jpeg`. Same output, two spellings. */
type BindingFormat = ImageOutputOptions["format"];
function toBindingFormat(fmt: string): BindingFormat {
  return (
    fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : fmt
  ) as BindingFormat;
}
function toCfImageFormat(fmt: string): string {
  return fmt === "jpeg" ? "baseline-jpeg" : fmt;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Every endpoint reports the same envelope, so the runner can join a response to
 *  its trace event by `probe` without parsing per-endpoint shapes. */
type Probe = Record<string, unknown> & { probe: string; ok: boolean };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const q = url.searchParams;
    const bust = q.get("bust") ?? crypto.randomUUID();
    const src = q.get("src") ?? "phone.jpg";
    const fmt = q.get("fmt") ?? "jpeg";
    const width = Number(q.get("w") ?? "144");
    const height = q.get("h") ? Number(q.get("h")) : undefined;
    const fit = q.get("fit") ?? undefined;
    const gravity = q.get("gravity") ?? undefined;

    try {
      switch (url.pathname) {
        /* ---- floor: what an invocation costs before it does anything ---- */
        case "/noop":
          return json({ probe: "noop", ok: true } satisfies Probe);

        /* ---- control: fetch the source and drain it, no transform ----
         * This is the number subtracted from both transform endpoints. */
        case "/control/fetch": {
          const res = await fetch(sourceUrl(request, src, bust));
          const bytes = await drain(res.body);
          return json({
            probe: "control/fetch",
            ok: res.ok,
            src,
            status: res.status,
            bytes,
          } satisfies Probe);
        }

        /* ---- form A: env.IMAGES binding ----
         * The undocumented one. Bytes stream from the source fetch through the
         * transform and out; if the encode runs in our isolate, it lands here. */
        case "/binding": {
          const source = await fetch(sourceUrl(request, src, bust));
          if (!source.ok || !source.body) {
            return json(
              { probe: "binding", ok: false, error: `source ${source.status}` },
              502,
            );
          }
          const transform: Record<string, unknown> = { width };
          if (height !== undefined) transform.height = height;
          if (fit) transform.fit = fit;
          if (gravity) transform.gravity = gravity;

          /* `output()` resolves to a result handle; `response()` is synchronous
           * on that handle. Chaining `.response()` straight off `output()` — as
           * the docs example reads — does not type-check against the published
           * types, and this is where an encode would have to happen if it
           * happens in our isolate at all. */
          const result = await env.IMAGES.input(source.body)
            .transform(transform as ImageTransform)
            .output({ format: toBindingFormat(fmt) });
          const out = result.response();
          const bytes = await drain(out.body);
          return json({
            probe: "binding",
            ok: out.ok,
            src,
            fmt,
            transform,
            status: out.status,
            contentType: result.contentType(),
            bytes,
          } satisfies Probe);
        }

        /* ---- form B: fetch(url, { cf: { image } }) ----
         * The documented-safe one, and the only form documenting `gravity`.
         * Its difference from the control is the measurement's noise floor. */
        case "/cfimage": {
          const image: Record<string, unknown> = {
            width,
            format: toCfImageFormat(fmt),
          };
          if (height !== undefined) image.height = height;
          if (fit) image.fit = fit;
          if (gravity) image.gravity = gravity;

          const res = await fetch(sourceUrl(request, src, bust), {
            cf: { image, cacheTtl: 0, cacheEverything: false },
          } as RequestInit);
          const bytes = await drain(res.body);
          return json({
            probe: "cfimage",
            ok: res.ok,
            src,
            fmt,
            image,
            status: res.status,
            /* Cloudflare reports a refused transformation here rather than by
             * throwing — 9422 is the "out of transformations" code #19 named. */
            cfResizedHeader: res.headers.get("cf-resized"),
            contentType: res.headers.get("content-type"),
            bytes,
          } satisfies Probe);
        }

        /* ---- subrequest accounting ----
         * Images is absent from the documented subrequest list, so we find the
         * answer by standing at the edge of the Free plan's 50 and taking one
         * more step. `/subreq?n=49&tail=binding` makes 49 cheap fetches and then
         * one binding transform: if the binding consumes a subrequest that is
         * the 50th and it survives, and n=50 must fail. `tail=fetch` is the
         * control that proves where the wall actually is. */
        case "/subreq": {
          const n = Number(q.get("n") ?? "49");
          const tail = q.get("tail") ?? "fetch";
          let completed = 0;
          try {
            for (let i = 0; i < n; i++) {
              const r = await fetch(sourceUrl(request, "tiny.txt", `${bust}-${i}`));
              await r.arrayBuffer();
              completed++;
            }
            if (tail === "binding") {
              const s = await fetch(sourceUrl(request, "small.jpg", bust));
              const t = await env.IMAGES.input(s.body!)
                .transform({ width: 32 })
                .output({ format: "image/jpeg" });
              await drain(t.response().body);
            } else {
              const r = await fetch(sourceUrl(request, "tiny.txt", `${bust}-tail`));
              await r.arrayBuffer();
            }
            return json({
              probe: `subreq/${tail}`,
              ok: true,
              n,
              completed,
              tailSucceeded: true,
            } satisfies Probe);
          } catch (e) {
            return json({
              probe: `subreq/${tail}`,
              ok: false,
              n,
              completed,
              tailSucceeded: false,
              error: String(e),
            } satisfies Probe);
          }
        }

        /* ---- what the binding can tell us about the input ----
         * `.info()` is documented as free to call, so it also answers whether the
         * binding will even accept HEIC before we spend a transformation on it. */
        case "/info": {
          const source = await fetch(sourceUrl(request, src, bust));
          const info = await env.IMAGES.info(source.body!);
          return json({ probe: "info", ok: true, src, info } satisfies Probe);
        }

        default:
          return json(
            {
              probe: "index",
              ok: true,
              endpoints: [
                "/noop",
                "/control/fetch?src=&bust=",
                "/binding?src=&w=&h=&fmt=&fit=&gravity=&bust=",
                "/cfimage?src=&w=&h=&fmt=&fit=&gravity=&bust=",
                "/subreq?n=&tail=fetch|binding&bust=",
                "/info?src=&bust=",
              ],
            } satisfies Probe,
            404,
          );
      }
    } catch (e) {
      /* An error is a result, not a failure of the run: 9422 (out of
       * transformations), 1102 (exceededCpu) and "Too many subrequests" are all
       * findings the ticket asked for by name. */
      return json(
        {
          probe: url.pathname,
          ok: false,
          error: String(e),
          name: (e as Error)?.name,
        } satisfies Probe,
        500,
      );
    }
  },
};
