/**
 * The listing surface's own es-VE copy: the urgency chip, and what the page says about how
 * many animals it is showing.
 *
 * Three modules hold words for this page and the split is by *what kind of word it is*, which
 * is the split ADR 0018 and `../axis-labels.ts` already draw between them:
 *
 * - `../animals/words.ts` — words that describe **a particular animal** and therefore agree
 *   with its sex: the meta line, the provenance line, the good-with phrases.
 * - `../axis-labels.ts` — the **six criteria vocabularies** as a filter offers them, checked
 *   against `domain/` with `satisfies`, shared with the digest's signup form.
 * - here — the copy that is about **the listing itself** rather than about an animal or an
 *   axis. Nothing in it agrees with anything, which is why it is a table and not a function.
 *
 * It exists because the alternative was these strings sitting in `./island.ts`, whose own
 * header limits it to "fetching, listening, and writing to the DOM" — and a module that
 * declares a scope and then holds five Spanish sentences is a module whose scope is decoration.
 * `../axis-labels.ts` puts the rule plainly: prose stays where it is read, and this is read on
 * the listing.
 */

/**
 * The chip beside an urgent animal's name. `CONTEXT.md`'s canonical rendering of Urgency is
 * `urgente`; the chip shouts it and the written reason stays on the animal page (#17).
 */
export const URGENT_CHIP_LABEL = "Urgente";

/**
 * How many animals the current filters leave, said in Spanish and agreeing with the number.
 *
 * Four cases, and the two zero cases are different problems that read differently. An empty
 * platform is a fact about Pawster; nothing matching is a fact about the filters, so it says
 * what to do about it — the likelier cause on a listing with six axes is one checkbox too
 * many, and an adopter who reads "no hay animales" would leave.
 */
export function statusLine(shown: number, total: number): string {
  if (total === 0) return "Todavía no hay animales publicados.";
  if (shown === 0) {
    return "Ningún animal coincide con esos filtros. Quita alguno para ver más.";
  }
  if (shown === total) return shown === 1 ? "1 animal" : `${shown} animales`;
  return shown === 1 ? `1 animal de ${total}` : `${shown} animales de ${total}`;
}

/**
 * Shown when the index could not be read, and it says the listing failed rather than saying
 * the platform is empty.
 *
 * The distinction is the whole value of the sentence. ADR 0018 flags the bucket's CORS policy
 * as a new provisioning step precisely because "without it the listing is empty in a way that
 * looks like a broken index rather than a missing header" — so the one thing this must not do
 * is render as an empty listing. It offers a reload because that is the only action an adopter
 * has, and it is the action that works once somebody has applied the header.
 */
export const INDEX_UNREADABLE =
  "No pudimos cargar el listado de animales. Prueba a recargar la página.";
