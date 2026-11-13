/**
 * The digest email's HTML: a list, not a gallery (issue #64).
 *
 * A row per unit with a 72px thumbnail, the name, one meta line and one provenance line. **No
 * description**, deliberately; it is the first thing to revisit if click-through disappoints.
 * A section per search, headed by its criteria as chips, so a subscriber can see which search
 * produced which animals.
 *
 * **Fluid-first.** The outer table is `width:100%;max-width:600px` and every row is
 * `table-layout:fixed` with `overflow-wrap:anywhere` on its text. The classic fixed-600 table
 * plus a media query truncated mid-word at 390px, and many clients drop `<style>` anyway, so
 * every style here is inline and no width is wider than a phone.
 *
 * The words are `web/`'s, imported rather than copied, so the email says an animal exactly the
 * way its listing card does. One language, es-VE, for the reason `nudge.ts` gives.
 *
 * **"Now" is the run's period, never the clock at delivery.** A redelivery still reads today's
 * rows, so its body can differ from the first send's, and Resend answers the reused key with a
 * 409. `resend.ts` takes that 409 as sent.
 */

import { deriveAgeBand } from "@pawster/domain";
import { animalUrl } from "@pawster/web/src/lib/animals/address.ts";
import {
  bondedGroupLine,
  groupProvenanceLine,
  metaLine,
  namesList,
  provenanceLine,
} from "@pawster/web/src/lib/animals/words.ts";
import { describeCriteria } from "@pawster/web/src/lib/axis-labels.ts";
import { escapeHtml } from "@pawster/web/src/lib/listing/card.ts";
import { derivativeKey } from "@pawster/web/src/lib/photos/keys.ts";
import type { DigestSection } from "./env.ts";
import type { DigestRowAnimal } from "./store.ts";

/** The thumbnail is the 144×144 JPEG derivative, drawn at half size for high-density screens. */
const THUMBNAIL_PX = 72;

/** A search with no criteria matches everything, and still needs a chip to say so. */
const ANY_ANIMAL_CHIP = "Cualquier animal";

export interface DigestEmail {
  sections: readonly DigestSection[];
  /** Every animal the sections show, by id. A missing one is dropped from its row. */
  animals: ReadonlyMap<string, DigestRowAnimal>;
  /** The run's day. Ages and "confirmed N days ago" are read as of this, not the clock. */
  asOf: Date;
  siteOrigin: string;
  mediaBase: string;
  manageUrl: string;
  unsubscribeUrl: string;
}

export async function renderDigestHtml(email: DigestEmail): Promise<string> {
  const sections: string[] = [];
  for (const section of email.sections) {
    const rows: string[] = [];
    for (const unit of section.units) {
      const members = unit.flatMap((id) => email.animals.get(id) ?? []);
      if (members.length > 0) rows.push(await row(members, email));
    }
    sections.push(sectionHtml(section, rows));
  }

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nuevas coincidencias</title></head><body style="margin:0;padding:0;background:#f6f5f2;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;table-layout:fixed;border-collapse:collapse;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1f1f1f;"><tr><td style="padding:16px;overflow-wrap:anywhere;"><h1 style="margin:0;font-size:20px;">Nuevas coincidencias</h1></td></tr>${sections.join("")}${footer(email)}</table></body></html>`;
}

function sectionHtml(section: DigestSection, rows: readonly string[]): string {
  const values = describeCriteria(section.criteria).flatMap((axis) => axis.values);
  const chips = (values.length > 0 ? values : [ANY_ANIMAL_CHIP])
    .map(
      (value) =>
        `<span class="chip" style="display:inline-block;margin:0 4px 4px 0;padding:2px 8px;border-radius:12px;background:#ece9e2;font-size:13px;">${escapeHtml(value)}</span>`,
    )
    .join("");
  const more =
    section.more > 0
      ? `<p style="margin:0 0 8px;font-size:14px;color:#555555;">${moreLine(section.more)}</p>`
      : "";
  return `<tr><td class="section" style="padding:8px 16px;overflow-wrap:anywhere;"><p style="margin:0 0 8px;">${chips}</p>${rows.join("")}${more}</td></tr>`;
}

/** "and N more matches": plain text, no link, because the listing has no URL for a search yet. */
function moreLine(more: number): string {
  return more === 1 ? "y 1 coincidencia más" : `y ${more} coincidencias más`;
}

/** One unit's row. A bonded group is one row with the first member's photo and link. */
async function row(
  members: readonly DigestRowAnimal[],
  email: DigestEmail,
): Promise<string> {
  const [first] = members as [DigestRowAnimal, ...DigestRowAnimal[]];
  const band = (member: DigestRowAnimal) =>
    deriveAgeBand(member.species, member.estimatedBirthDate, email.asOf);
  const lone = members.length === 1;
  const name = namesList(members.map((member) => member.name));
  const meta = lone
    ? metaLine(first, band(first))
    : bondedGroupLine(members.map((member) => ({ ...member, band: band(member) })));
  const provenance = lone
    ? provenanceLine(first, email.asOf)
    : groupProvenanceLine(members, first.region, first.lastConfirmedAt, email.asOf);
  const href = escapeHtml(animalUrl(email.siteOrigin, first.id, first.name));

  const thumbnail =
    first.sourceDigest === null
      ? ""
      : `<a href="${href}"><img src="${escapeHtml(`${email.mediaBase}/${await derivativeKey(first.sourceDigest, "digestThumbnail")}`)}" width="${THUMBNAIL_PX}" height="${THUMBNAIL_PX}" alt="${escapeHtml(name)}" style="display:block;width:${THUMBNAIL_PX}px;height:${THUMBNAIL_PX}px;border:0;border-radius:6px;"></a>`;

  return `<table class="row" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 12px;"><tr><td width="${THUMBNAIL_PX}" style="width:${THUMBNAIL_PX}px;vertical-align:top;">${thumbnail}</td><td style="padding-left:12px;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;"><a href="${href}" style="font-weight:bold;color:#1f1f1f;">${escapeHtml(name)}</a><br><span style="font-size:14px;">${escapeHtml(meta)}</span><br><span style="font-size:13px;color:#666666;">${escapeHtml(provenance)}</span></td></tr></table>`;
}

/**
 * Silence first, because an empty week must not read as a broken platform. Then the manage link,
 * which is the subscriber's only way back in (there are no passwords), and the same unsubscribe
 * link the `List-Unsubscribe` header carries.
 */
function footer(email: DigestEmail): string {
  return `<tr><td style="padding:16px;border-top:1px solid #dddddd;font-size:13px;color:#555555;overflow-wrap:anywhere;"><p style="margin:0 0 8px;">Solo te escribimos cuando hay coincidencias nuevas. Si no llega nada, es que no hubo.</p><p style="margin:0 0 8px;"><a href="${escapeHtml(email.manageUrl)}" style="color:#555555;">Cambiar mis búsquedas</a> · <a href="${escapeHtml(email.unsubscribeUrl)}" style="color:#555555;">Darme de baja</a></p><p style="margin:0;">Recibes esto porque activaste tu búsqueda en Pawster.</p></td></tr>`;
}
