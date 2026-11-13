/**
 * The filter panel's state as a URL, both ways.
 *
 * This is the whole of what the listing adds to filtering, and the smallness is the point:
 * **the rules are `domain/`'s**. `parseCriteria` decides what is a value on each axis and
 * silently drops the rest; `matches` decides what a criteria means. Issue #56 requires that
 * the island import `domain/` rather than reimplement any rule, and `domain/src/criteria.ts`
 * was written naming this consumer — "the browser filter panel (#56) submits the same axes
 * from the same closed vocabularies, and a panel that accepted a value the matcher would
 * ignore is a filter that silently lies."
 *
 * So what is left here is a mapping between a query string and the axis-keyed object that
 * parser already takes. No vocabulary, no validation, no defaults.
 *
 * ## Why the panel's state lives in the URL at all
 *
 * Because filtering issues no request, there is nothing else that could remember it: a
 * reload, a back button, or a link sent to somebody would otherwise land on the unfiltered
 * listing. The spec's own reason is stronger than convenience — sharing is how a listing
 * spreads here — and #17 built the same thing for the same reason: every control reflected in
 * the URL, so a specific view is shareable.
 *
 * The query keys are the **axis names**, matching `SubscriptionCriteria` one for one. A second
 * set of names would be a second vocabulary to keep in step with the first, and the failure
 * would be a filter that reads a parameter nobody writes.
 */

import type { SubscriptionCriteria } from "@pawster/domain";
import { parseCriteria } from "@pawster/domain";

/**
 * The six axes, as the query names them. Typed as `keyof SubscriptionCriteria`, so an axis
 * added to the criteria without being added here does not compile — the same guarantee
 * `matching.ts` gives its own axis table, and worth having for the same reason: an axis
 * missing from this list is a filter control whose value is silently discarded.
 */
export const AXIS_PARAMS = [
  "species",
  "regions",
  "sizes",
  "sexes",
  "ageBands",
  "goodWith",
] as const satisfies readonly (keyof SubscriptionCriteria)[];

export type AxisParam = (typeof AXIS_PARAMS)[number];

/**
 * A query string as a criteria, through `domain/`'s parser.
 *
 * `getAll` on every axis, so several regions arrive as several values of one parameter —
 * "Carabobo or Aragua, I'll drive" is one criteria and one URL. An axis absent from the query
 * is absent from the object, which `matching.ts` makes mean "constrains nothing", so the
 * unfiltered listing needs no special case anywhere.
 */
export function criteriaFromSearch(search: string): SubscriptionCriteria {
  const params = new URLSearchParams(search);
  const raw: Record<string, readonly string[]> = {};
  for (const axis of AXIS_PARAMS) {
    const values = params.getAll(axis);
    if (values.length > 0) raw[axis] = values;
  }
  return parseCriteria(raw);
}

/**
 * A criteria as a query string, canonically.
 *
 * Canonical because `parseCriteria` already returns each axis deduplicated and in its
 * vocabulary's own order, and this walks {@link AXIS_PARAMS} rather than the object's keys —
 * so two adopters who checked the same boxes get the same URL to send each other, whichever
 * order they clicked them in.
 *
 * Returns `""` for an empty criteria rather than `"?"`, so the unfiltered listing's address is
 * the page's own.
 */
export function searchFromCriteria(criteria: SubscriptionCriteria): string {
  const params = new URLSearchParams();
  for (const axis of AXIS_PARAMS) {
    for (const value of criteria[axis] ?? []) params.append(axis, value);
  }
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
}

/**
 * Every checked box in the panel, as a criteria.
 *
 * Read from the form rather than tracked in a variable of its own: the checkboxes *are* the
 * state, and a copy of them kept beside them is a second answer that can disagree — the same
 * argument `db/` makes for having no `listed` column. It goes through
 * {@link criteriaFromSearch} so that a value arriving from a control and the same value
 * arriving from a shared link are parsed by one function.
 */
export function criteriaFromForm(form: HTMLFormElement): SubscriptionCriteria {
  const params = new URLSearchParams();
  /**
   * `forEach` rather than `for…of`, because `tsconfig.base.json` sets `lib: ["ES2022"]` and
   * does not add `DOM.Iterable` — so a `FormData` is not a typed iterable here even though it
   * is one at runtime. Widening the lib set for the whole package to iterate one form would be
   * a large change for a small convenience, and this reads no worse.
   */
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") params.append(key, value);
  });
  return criteriaFromSearch(params.toString());
}
