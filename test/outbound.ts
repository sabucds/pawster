/**
 * The single outbound-`fetch` interceptor.
 *
 * One dispatcher, not one fake per vendor. Everything Pawster sends to the outside world
 * — Resend, Healthchecks.io, and the `cf.image` transform pipeline — leaves through
 * `globalThis.fetch`, so replacing that one function is enough to see all of it, and it
 * lands in one ordered call log. That is what lets "exactly one email per recipient under
 * idempotency key X" be a single assertion against a single list, instead of a question
 * asked of three different mocks that each know only their own half.
 *
 * It is here rather than in a workspace because two Workers use it and neither owns it.
 *
 * Cloudflare's own `fetchMock` used to be the obvious alternative. It is gone: as of
 * `@cloudflare/vitest-plugin@1.1.4` (and `@cloudflare/vitest-pool-workers@0.22.0`, which
 * is the same package under its former name) `cloudflare:test` no longer exports it — only
 * the unexported `MockAgent` shape survives in the type file. See
 * `docs/testing-seams.md`.
 *
 * ## Why a global patch works here
 *
 * The Vitest plugin runs the Worker under test in the same isolate as the test file, so a
 * global mock installed by a test applies to the Worker too. This is documented on `SELF`
 * itself: "this `main` worker runs in the same isolate/context as tests, so any global
 * mocks will apply to it too."
 */

/** The three outbound destinations Pawster has, and the only three it may have. */
export type Vendor = "resend" | "healthchecks" | "cf.image";

export interface RecordedCall {
  vendor: Vendor;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /**
   * Present only on `cf.image` calls: the transform the image pipeline was asked for.
   * Recorded because the transform is the interesting part — the URL is just our own
   * token-gated original route (ADR 0012).
   */
  imageTransform?: Record<string, unknown>;
}

export type VendorHandler = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch that reached the dispatcher without a registered destination. */
export interface Violation {
  url: string;
  method: string;
  reason: string;
}

type FetchArgs = Parameters<typeof fetch>;

const HOSTS: Record<string, Vendor> = {
  "api.resend.com": "resend",
  "hc-ping.com": "healthchecks",
};

/**
 * Replies used when a test does not care what the vendor said. Each is the shape the real
 * vendor returns on success, so a test that only cares about *being called* does not have
 * to spell one out, and a test that cares can override it.
 */
const DEFAULT_HANDLERS: Record<Vendor, VendorHandler> = {
  resend: () =>
    Response.json({ id: `re_${crypto.randomUUID()}` }, { status: 200 }),
  healthchecks: () => new Response("OK", { status: 200 }),
  "cf.image": () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }),
};

export class OutboundInterceptor {
  readonly calls: RecordedCall[] = [];
  readonly violations: Violation[] = [];

  #handlers = new Map<Vendor, VendorHandler>();
  #original: typeof fetch | undefined;

  /**
   * Replace `globalThis.fetch`. Safe to call twice; the second call is a no-op, so a
   * suite-wide setup file and a test that wants its own instance do not fight.
   */
  install(): void {
    if (this.#original) return;
    this.#original = globalThis.fetch;
    globalThis.fetch = ((...args: FetchArgs) =>
      this.#dispatch(...args)) as typeof fetch;
  }

  restore(): void {
    if (!this.#original) return;
    globalThis.fetch = this.#original;
    this.#original = undefined;
  }

  reset(): void {
    this.calls.length = 0;
    this.violations.length = 0;
    this.#handlers.clear();
  }

  /** Override the reply for one vendor. Returns `this` so registrations chain. */
  on(vendor: Vendor, handler: VendorHandler): this {
    this.#handlers.set(vendor, handler);
    return this;
  }

  callsTo(vendor: Vendor): RecordedCall[] {
    return this.calls.filter((call) => call.vendor === vendor);
  }

  /**
   * Fail the test if anything tried to leave for a destination the dispatcher does not
   * know. Thrown *and* recorded: the throw stops the caller, and the record survives a
   * Worker that catches its own errors — a `scheduled()` handler wrapped in try/catch
   * would otherwise swallow the escape and leave the suite green.
   */
  assertNoViolations(): void {
    if (this.violations.length === 0) return;
    const lines = this.violations.map(
      (v) => `  ${v.method} ${v.url} — ${v.reason}`,
    );
    throw new Error(
      `Outbound fetch escaped the interceptor:\n${lines.join("\n")}\n\n` +
        "Every outbound destination must be registered in test/outbound.ts. " +
        "If Pawster has genuinely grown a fourth vendor, add it to Vendor and HOSTS " +
        "there; if it has not, this is a bug in the code under test.",
    );
  }

  async #dispatch(...args: FetchArgs): Promise<Response> {
    const call = await describeCall(...args);

    if (!call) {
      const [input, init] = args;
      const url = urlOf(input);
      const violation: Violation = {
        url,
        method: methodOf(input, init),
        reason: `no vendor is registered for host "${hostOf(url)}"`,
      };
      this.violations.push(violation);
      throw new Error(
        `Outbound fetch to an unregistered host: ${violation.method} ${violation.url}`,
      );
    }

    this.calls.push(call);
    const handler = this.#handlers.get(call.vendor) ?? DEFAULT_HANDLERS[call.vendor];
    return handler(call);
  }
}

function urlOf(input: FetchArgs[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function methodOf(input: FetchArgs[0], init: FetchArgs[1]): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && input instanceof Request) return input.method;
  return "GET";
}

/**
 * Classify and record one outbound call, or return `undefined` if it belongs to nobody.
 *
 * A `cf.image` transform is recognised by the request options rather than by its host,
 * because its host is our own token-gated original route (ADR 0012) and so cannot be told
 * from an ordinary same-origin fetch any other way.
 */
async function describeCall(
  ...args: FetchArgs
): Promise<RecordedCall | undefined> {
  const [input, init] = args;
  const request = typeof input === "object" && input instanceof Request ? input : undefined;
  const url = urlOf(input);
  const method = methodOf(input, init);

  const cf = (init as { cf?: { image?: Record<string, unknown> } } | undefined)?.cf
    ?? (request as unknown as { cf?: { image?: Record<string, unknown> } } | undefined)?.cf;
  const imageTransform = cf?.image;

  const vendor: Vendor | undefined = imageTransform
    ? "cf.image"
    : HOSTS[hostOf(url)];
  if (!vendor) return undefined;

  // `forEach` rather than `Object.fromEntries`: the Workers `Headers` is not typed as
  // iterable, so spreading it fails to compile even though it works at runtime.
  const headerEntries: Record<string, string> = {};
  new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
    headerEntries[key] = value;
  });

  const call: RecordedCall = {
    vendor,
    method,
    url,
    headers: headerEntries,
    body: await bodyOf(request, init),
  };
  if (imageTransform) call.imageTransform = imageTransform;
  return call;
}

async function bodyOf(
  request: Request | undefined,
  init: FetchArgs[1],
): Promise<string | null> {
  if (init?.body != null) {
    return typeof init.body === "string"
      ? init.body
      : await new Response(init.body as BodyInit).text();
  }
  if (request?.body) return await request.clone().text();
  return null;
}

/**
 * The one instance the setup file installs. Tests import it, register replies on it, and
 * read its call log; they do not construct their own, because a second instance would be
 * a second dispatcher and that is the thing this file exists to prevent.
 */
export const outbound = new OutboundInterceptor();
