/**
 * The browser island: two fetches on load, and no network afterwards.
 *
 * Everything it decides is decided elsewhere. `domain/`'s `parseIndex` reads the file,
 * `selectListed` filters and orders it, `cardModel` and `renderCard` build the cards, and
 * `criteriaFromForm` maps the panel onto the criteria the digest matcher takes. What is left
 * here is the part that needs a document: fetching, listening, and writing to the DOM.
 *
 * That split is deliberate and it is the only way this code is tested at all — `web/`'s suite
 * runs in a `workerd` isolate with no document in it (`docs/testing-seams.md`), so a rule
 * living in this file would be a rule no test could reach. Every acceptance criterion #56
 * states about filtering or about a card is asserted against the modules above, and what
 * cannot be: that the *wiring* is right.
 *
 * ## Why filtering issues no request, structurally
 *
 * `fetch` appears exactly once in this file, in {@link loadIndex}, and it is called exactly
 * once — from {@link startListing}, before any listener is attached. The change handler calls
 * `selectListed`, which is a pure function over an array already in memory. So "filtering
 * across all six axes issues zero network requests" is not a promise about behaviour that
 * could regress quietly; it is a property of there being nothing in the handler's reach that
 * could make a request.
 *
 * ## The two fetches, and why there are two
 *
 * The index never changes underneath anyone — its key is a hash of its bytes and it is served
 * `immutable` — so the only thing that moves is the pointer at `i/current.json`, which is a
 * hundred bytes marked `no-store`. That costs one extra round trip on a first load and repays
 * it on every load after: with the catalogue unchanged, a returning adopter's index fetch is a
 * browser cache hit on an immutable object, which is **zero requests and zero bytes** against
 * 33.4 KB or at best a 304 under a stable key (ADR 0018). On a metered Venezuelan connection
 * that trade is not close.
 *
 * Both objects are read straight out of R2, so a page load costs no Worker invocation and no
 * CPU — the whole of what ADR 0007 buys.
 */

import type { IndexPointer, ListedAnimal, Region } from "@pawster/domain";
import {
  INDEX_POINTER_KEY,
  normaliseRegion,
  parseIndex,
  selectListed,
} from "@pawster/domain";
import { cardModel, renderCard } from "./card.ts";
import { criteriaFromForm, searchFromCriteria } from "./criteria.ts";

/** What the page's shell gives the island, baked in at build time. */
interface ListingElements {
  readonly root: HTMLElement;
  readonly form: HTMLFormElement;
  readonly grid: HTMLElement;
  readonly status: HTMLElement;
  readonly regions: HTMLElement;
  readonly mediaBase: string;
}

/**
 * The index, through the pointer that names it.
 *
 * Neither response is checked for a `Content-Encoding`: the index is stored gzipped with the
 * header set, and a browser decompresses that transparently before `text()` sees it. What
 * happens if R2 declines to serve the header back is ADR 0018's third open measurement, and
 * the failure is loud in the only way that matters here — the JSON parses either way, and the
 * cost is bytes on the wire rather than a broken listing.
 */
async function loadIndex(mediaBase: string): Promise<readonly ListedAnimal[]> {
  const pointerResponse = await fetch(`${mediaBase}/${INDEX_POINTER_KEY}`, {
    /**
     * The pointer is the one object in the read path that may be served out of date, and it
     * carries `no-store` for that reason. Saying so on the request as well costs nothing and
     * survives a future in which something between the browser and the bucket does cache.
     */
    cache: "no-store",
  });
  if (!pointerResponse.ok) {
    throw new Error(`pointer: ${pointerResponse.status}`);
  }
  const pointer = (await pointerResponse.json()) as IndexPointer;

  const indexResponse = await fetch(`${mediaBase}/${pointer.key}`);
  if (!indexResponse.ok) throw new Error(`index: ${indexResponse.status}`);

  return parseIndex(await indexResponse.text()).animals;
}

/**
 * The regions to offer, taken from the index rather than from a table.
 *
 * There is no region reference data in the platform yet — `domain/`'s `Region` is deliberately
 * "the one axis with no compile-time vocabulary", because regions follow a country's
 * administrative divisions (ADR 0005) and seeding a second country must be a lookup rather
 * than an edit to a union. Until that lookup exists, the honest set of regions to offer an
 * adopter is the set that has animals in it: a checkbox for a state with nothing in it is a
 * filter that can only ever empty the page.
 *
 * Sorted with `localeCompare` so `Anzoátegui` and `Aragua` order the way a Spanish reader
 * expects rather than by code point.
 */
export function regionsIn(animals: readonly ListedAnimal[]): readonly Region[] {
  return [...new Set(animals.map((animal) => animal.region))].sort((left, right) =>
    left.localeCompare(right, "es"),
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * The region checkboxes, which are the one part of the panel the page could not prerender.
 *
 * The other five axes are closed vocabularies known at build time, so they are in the static
 * HTML and work before this script runs at all.
 */
function renderRegions(
  container: HTMLElement,
  regions: readonly Region[],
  checked: ReadonlySet<string>,
): void {
  container.innerHTML = regions
    .map((region) => {
      const safe = escapeAttribute(region);
      /**
       * The control's value is the region **as the shelter typed it**, because it is also the
       * label an adopter reads, and `criteriaFromForm` normalises it on the way out. Whether
       * it arrives back pre-checked from a shared link is asked on the *normalised* form,
       * since the link carries the identifier: `?regions=miranda` has to tick `Miranda`.
       */
      return `<label class="axis-option"><input type="checkbox" name="regions" value="${safe}"${
        checked.has(normaliseRegion(region)) ? " checked" : ""
      } /> ${safe}</label>`;
    })
    .join("");
}

/**
 * How many animals the current filters leave, said in Spanish and agreeing with the number.
 *
 * The empty case says what to do about it rather than only that there is nothing, because the
 * most likely cause is a filter combination rather than an empty platform.
 */
export function statusLine(shown: number, total: number): string {
  if (total === 0) {
    return "Todavía no hay animales publicados.";
  }
  if (shown === 0) {
    return "Ningún animal coincide con esos filtros. Quita alguno para ver más.";
  }
  if (shown === total) {
    return shown === 1 ? "1 animal" : `${shown} animales`;
  }
  return shown === 1 ? `1 animal de ${total}` : `${shown} animales de ${total}`;
}

/**
 * Wire the panel to the index, and render once.
 *
 * The clock is read once per render rather than once per card, so every card on a screen
 * derives its band and its staleness from the same instant — two cards disagreeing about
 * "today" because a render crossed midnight is a small thing, but it is free to prevent.
 */
export async function startListing(elements: ListingElements): Promise<void> {
  const { form, grid, status, regions, mediaBase } = elements;

  let animals: readonly ListedAnimal[];
  try {
    animals = await loadIndex(mediaBase);
  } catch {
    /**
     * The listing is empty in a way that says so, rather than empty in a way that looks like
     * an empty platform. The most likely cause on a first deploy is the CORS policy the
     * bucket needs — ADR 0018 calls that out as a new provisioning step precisely because
     * "without it the listing is empty in a way that looks like a broken index rather than a
     * missing header".
     */
    status.textContent =
      "No pudimos cargar la lista de animales. Prueba a recargar la página.";
    status.dataset.state = "failed";
    return;
  }

  /**
   * The panel's initial state comes from the URL, so a shared link opens filtered.
   *
   * The five closed axes are matched on their value directly — those are vocabulary tokens and
   * the query carries them verbatim. Regions go through {@link renderRegions}, which normalises
   * before comparing, and are excluded from this loop so the two rules do not both claim them.
   */
  const initial = new URLSearchParams(window.location.search);
  renderRegions(
    regions,
    regionsIn(animals),
    new Set(initial.getAll("regions").map(normaliseRegion)),
  );
  /** `forEach` for the reason `./criteria.ts` records: no `DOM.Iterable` in the lib set. */
  form
    .querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:not([name="regions"])',
    )
    .forEach((control) => {
      if (initial.getAll(control.name).includes(control.value)) {
        control.checked = true;
      }
    });

  const render = (): void => {
    const criteria = criteriaFromForm(form);
    const now = new Date();
    const shown = selectListed(animals, criteria, now);

    grid.innerHTML = shown
      .map((animal) => renderCard(cardModel(animal, now, mediaBase)))
      .join("");
    status.textContent = statusLine(shown.length, animals.length);
    status.dataset.state = shown.length === 0 ? "empty" : "showing";

    /**
     * `replaceState` and not `pushState`: ticking four boxes in a row would otherwise put
     * four entries in the history and make the back button a way to un-tick them one at a
     * time. The URL is here to be copied and reloaded, not to be navigated.
     */
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${searchFromCriteria(criteria)}`,
    );
  };

  /**
   * One listener on the form rather than one per control, which is what lets the region
   * checkboxes be created after this line without anything having to re-bind. `change`
   * rather than `input`, because every control here is a checkbox and the two are the same
   * event for one — with none of the per-keystroke work a text field would bring.
   */
  form.addEventListener("change", render);
  /** Nothing to submit to: the page it would post to is this page, with no server behind it. */
  form.addEventListener("submit", (event) => event.preventDefault());

  render();
}
