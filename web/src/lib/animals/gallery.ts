/**
 * An animal's photographs as the public page renders them: a URL, a box to reserve, and an
 * `alt`.
 *
 * ## Where the bytes are served from
 *
 * Straight out of `pawster-media` over its `r2.dev` hostname, with no Worker in the path.
 * [ADR 0014](../../../../docs/adr/0014-the-domain-is-free-and-lives-outside-cloudflare.md)
 * settles that: *"Serve images from `r2.dev` now, and from a cached Worker when volume
 * justifies it. No R2 custom domain, now or later."* The rate limit is real and undocumented,
 * and it is the trigger to build the cached Worker rather than a reason to route through one
 * today — a Worker in front of every photo spends the 100,000 requests/day cap ADR 0007's whole
 * posture exists to protect.
 *
 * The hostname is a `var` rather than a constant here, because it is an account-level fact
 * recorded in `docs/provisioning-record.md`, not a decision this module makes. That also keeps
 * the switch to a cached Worker a config change plus one route, with nothing in this file to
 * find.
 *
 * ## Why the keys are recomputed
 *
 * A derivative's key is a hash of the source bytes' digest plus the spec, and `db/` deliberately
 * stores none of them: *"storing them would be storing a derived value that could disagree with
 * the function that derives it"* (`upload_session_photos`). So the page hashes, one `crypto.
 * subtle.digest` per photo per derivative — six photos is six digests of a 70-character string,
 * which is arithmetic rather than work, and `docs/measurements.md` records what the whole route
 * costs.
 */

import type { Database } from "@pawster/db";
import { derivativeDimensions } from "@pawster/domain";
import { derivativeKey } from "../photos/keys.ts";
import { listSessionPhotos } from "../photos/store.ts";

/** One photograph, ready for an `<img>`. */
export interface GalleryPhoto {
  readonly url: string;
  /**
   * The derivative's real dimensions, not the source's.
   *
   * They go on the tag as `width` and `height` attributes, which is what reserves the box
   * before the bytes arrive. The prototype measured a page with photos blocked and a page with
   * photos loaded at an identical document height because of exactly this, and it also found
   * the way to get it wrong: `max-width: 100%` without `height: auto` makes the browser honour
   * the attributes over the box's aspect ratio and stretches the photo. Both halves are needed.
   */
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

/**
 * Everything the page shows of an animal's photographs.
 *
 * The social preview is separate from the gallery rather than its first member, because it is
 * a different derivative of the same photograph and it is never rendered on the page — it goes
 * in a `<meta>` tag for whatever WhatsApp or a search engine fetches. Folding the two together
 * would put a 1200×630 crop in the gallery.
 */
export interface AnimalGallery {
  /** In the shelter's order. Empty for an archived animal whose photos have been dropped. */
  readonly photos: readonly GalleryPhoto[];
  /**
   * The 1200×630 JPEG of the **primary photo**, or `null` where the animal has none.
   *
   * The primary is position 0 and nothing else: `CONTEXT.md` makes it "the one every
   * single-image surface shows: the listing card, the digest email and the social preview", and
   * a shelter chooses it by ordering. So this reads the first row rather than looking for a
   * flag, and reordering the photos changes the preview with no other write.
   */
  readonly socialPreviewUrl: string | null;
}

/**
 * The public URL of one derivative, given its content-addressed key.
 *
 * Absolute, and it has to be: a social preview URL is fetched by WhatsApp's crawler from
 * outside any page context, so a relative path would resolve against nothing.
 */
function publicUrl(mediaOrigin: string, key: string): string {
  return `${mediaOrigin.replace(/\/+$/, "")}/${key}`;
}

/**
 * An animal's gallery, or an empty one.
 *
 * **An empty gallery is a normal outcome rather than an error**, which is issue #57's
 * "the archive page must render correctly with no photos at all". Photos drop on the ordinary
 * twelve-month retention clock, so an animal archived long enough ago has a session with no
 * rows left in it — and the page it produces is an ordinary page with no images, not a 404 and
 * not a broken `<img>`.
 *
 * The photographs are reached through `uploadSessionId`, because that is the only link an
 * animal has to them (ADR 0012: the animal names the session it was assembled from, and the
 * session never names the animal).
 */
export async function readAnimalGallery(
  db: Database,
  animal: { readonly uploadSessionId: string; readonly name: string },
  mediaOrigin: string,
): Promise<AnimalGallery> {
  const rows = await listSessionPhotos(db, animal.uploadSessionId);
  if (rows.length === 0) return { photos: [], socialPreviewUrl: null };

  const alt = `Foto de ${animal.name}`;
  const photos = await Promise.all(
    rows.map(async (row) => {
      const { width, height } = derivativeDimensions(
        "detailImage",
        row.width,
        row.height,
      );
      return {
        url: publicUrl(
          mediaOrigin,
          await derivativeKey(row.sourceDigest, "detailImage"),
        ),
        width,
        height,
        alt,
      };
    }),
  );

  return {
    photos,
    socialPreviewUrl: publicUrl(
      mediaOrigin,
      // `rows` is ordered by position and non-empty, so this is position 0 — the primary.
      await derivativeKey(rows[0]!.sourceDigest, "socialPreview"),
    ),
  };
}
