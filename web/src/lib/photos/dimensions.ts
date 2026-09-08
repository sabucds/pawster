/**
 * How big an image is, read out of its **header** rather than by decoding it.
 *
 * This exists for one line in [ADR 0012](../../../../docs/adr/0012-derivatives-are-generated-once-at-upload.md):
 * "reject any input over 12 MB or beyond a maximum dimension *before storing anything*".
 * A dimension is not in the HTTP request anywhere — only the file knows it — so the only
 * way to refuse before the write is to look at the first few hundred bytes of the file
 * itself. Every parser below reads a fixed structure at a known offset and decodes no pixel
 * data, which is what keeps this arithmetic rather than the image work ADR 0012 moved out
 * of our isolate entirely.
 *
 * ## Why the answer is *display* dimensions
 *
 * An iPhone writes a landscape frame and an orientation tag saying "turn this 90°". The
 * upright image is the transposed one, and it is the only version that will ever exist —
 * the original is discarded after seven days and every derivative is generated from it
 * upright. So a photo's size is its size *after* rotation, and everything downstream, from
 * the dimension refusal to the row in D1, is told that number.
 *
 * Getting this wrong is not a rounding error. ADR 0012 rejected resizing in the browser
 * partly because "EXIF orientation is undocumented on old devices", and the failure it
 * describes is the one this file is written against: "a shelter would see none of these as
 * an error. It would see its animal published with a sideways, oversized, wrongly-encoded
 * photo."
 *
 * ## Why it never asks for a rotation
 *
 * Nothing here produces a `rotate` for `cf.image`, and that is deliberate. Cloudflare's
 * image pipeline applies the source's own orientation and then discards the metadata — a
 * WebP or PNG output carries none at all — so an upright result is what it returns. Passing
 * `rotate` on top of that would rotate an already-upright image a second time, which is a
 * worse failure than the one it was meant to prevent, and silent in the same way. This file
 * reads the tag only to know *what size the result will be*.
 *
 * See `docs/measurements.md` for what is and is not verified about that behaviour offline.
 */

/**
 * The image's dimensions as they will be displayed, and the orientation that got them
 * there.
 */
export interface ImageSize {
  /** After rotation. */
  readonly width: number;
  /** After rotation. */
  readonly height: number;
  /**
   * Whether the file carries a tag saying its stored pixels are not upright. Recorded so a
   * test can assert the transposition actually happened rather than assert two numbers that
   * would also be right by accident for a square photo.
   */
  readonly rotated: boolean;
}

/**
 * How much of the file the parsers are given.
 *
 * Generous on purpose. A JPEG's SOF marker sits after however many APP segments the camera
 * felt like writing — an iPhone's EXIF block with a thumbnail in it routinely runs past
 * 64 KB — and a HEIC's `meta` box is before the image data but after a `ftyp` and whatever
 * else the encoder put first. 256 KB is a fiftieth of the 12 MB an upload may be and covers
 * every real file; a header that needs more than this is not a photograph.
 */
export const HEADER_BYTES = 256 * 1024;

/** Big-endian, which is what every format here but WebP and GIF uses. */
function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0))
  );
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16)) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * EXIF orientations 5 through 8 are the transposing ones — the four that involve a quarter
 * turn. 1 through 4 are upright or mirrored, and neither swaps the axes.
 */
function transposes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

function sized(width: number, height: number, rotated: boolean): ImageSize {
  return rotated
    ? { width: height, height: width, rotated: true }
    : { width, height, rotated: false };
}

/**
 * The EXIF `Orientation` tag (0x0112) out of a TIFF header, or 1 if it is not there.
 *
 * `bytes` starts at the TIFF header — the `II`/`MM` that follows the `Exif\0\0` marker in
 * a JPEG APP1 segment, and that is also how EXIF is embedded in HEIF. The byte order is
 * whatever those two characters say, which is why every read below goes through a pair
 * chosen at runtime rather than a fixed endianness.
 */
function readExifOrientation(bytes: Uint8Array, start: number, end: number): number {
  const marker = ascii(bytes, start, 2);
  if (marker !== "II" && marker !== "MM") return 1;
  const little = marker === "II";
  const u16 = (offset: number) =>
    little ? u16le(bytes, offset) : u16be(bytes, offset);
  const u32 = (offset: number) =>
    little ? u32le(bytes, offset) : u32be(bytes, offset);

  if (u16(start + 2) !== 42) return 1;
  const ifd0 = start + u32(start + 4);
  if (ifd0 + 2 > end) return 1;

  const entries = u16(ifd0);
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) !== 0x0112) continue;
    // A SHORT value is stored in the first two bytes of the 4-byte value field, in the
    // file's own byte order — not right-aligned, which is the reflex and is wrong on
    // big-endian files.
    const orientation = u16(entry + 8);
    return orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

/**
 * JPEG: walk the marker chain to the frame header, picking up EXIF on the way.
 *
 * The dimensions are in whichever SOF marker the encoder used, and there are a dozen of
 * them — baseline, progressive, arithmetic-coded, lossless. They all carry height and width
 * at the same offsets, so this accepts the whole `C0`-`CF` range minus the four that are
 * not frame headers (`C4` Huffman tables, `C8` reserved, `CC` arithmetic-coding
 * conditioning). Matching only `C0` and `C2` is the common shortcut and it silently fails
 * on a progressive JPEG some phones produce.
 */
function parseJpeg(bytes: Uint8Array): ImageSize | null {
  let orientation = 1;
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Fill bytes between segments are legal; anything else means we have lost the chain.
      offset++;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: the entropy-coded data begins, and there is no frame header after it.
    if (marker === 0xda) return null;

    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    const segment = offset + 4;

    if (marker === 0xe1 && ascii(bytes, segment, 6) === "Exif\0\0") {
      orientation = readExifOrientation(
        bytes,
        segment + 6,
        Math.min(offset + 2 + length, bytes.length),
      );
    }

    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      // precision(1) height(2) width(2)
      const height = u16be(bytes, segment + 1);
      const width = u16be(bytes, segment + 3);
      if (width === 0 || height === 0) return null;
      return sized(width, height, transposes(orientation));
    }

    offset += 2 + length;
  }
  return null;
}

/** PNG: IHDR is mandatory and always the first chunk, at a fixed offset. */
function parsePng(bytes: Uint8Array): ImageSize | null {
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === 0 || height === 0) return null;
  // PNG has no orientation of its own — an `eXIf` chunk may carry one, but no browser
  // honours it and neither does the image pipeline, so an upright read is the truthful one.
  return sized(width, height, false);
}

/**
 * WebP: three container shapes, and a file may be any of them.
 *
 * `VP8X` is the extended header a file gets when it has animation, alpha or metadata, and
 * it states the canvas size directly. Otherwise the size is packed into the lossy (`VP8 `)
 * or lossless (`VP8L`) bitstream header, at 14 bits per axis in both, which is why a WebP
 * cannot be over 16,383 on a side at all.
 */
function parseWebp(bytes: Uint8Array): ImageSize | null {
  if (ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X") {
    // Two 24-bit little-endian values, each stored as one less than the true size.
    const width =
      ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1;
    const height =
      ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1;
    return sized(width, height, false);
  }

  if (chunk === "VP8 ") {
    // The 3-byte frame tag, then the start code 9d 01 2a, then two 14-bit dimensions.
    if (
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return null;
    }
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    return sized(width, height, false);
  }

  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const packed = u32le(bytes, 21);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    return sized(width, height, false);
  }

  return null;
}

/**
 * HEIC/HEIF: the size is in an `ispe` box and the rotation in an `irot`, both inside the
 * property container of the `meta` box.
 *
 * This scans for the four-character box names rather than walking the ISO-BMFF tree from
 * the root, and the shortcut is worth stating plainly because it is the one parser here
 * that is not exact. Walking the tree properly means `meta` → `iprp` → `ipco` → the
 * property list, then `iinf`/`ipma` to find *which* properties belong to the *primary*
 * item — several hundred lines to answer a question a scan answers in ten, for a file
 * format whose whole purpose here is to be handed straight to Cloudflare.
 *
 * The scan is safe in the direction that matters. A HEIC holds several `ispe` boxes — the
 * full image and the thumbnails the camera embedded — and taking **the largest** is
 * guaranteed to be at least the primary image, so a file that would break the pipeline's
 * dimension ceiling can never read as one that fits. The failure mode left is the harmless
 * one: an exotic file whose largest stored item is not the one displayed reads as slightly
 * too big and is refused when it need not have been.
 */
function parseHeif(bytes: Uint8Array): ImageSize | null {
  let best: { width: number; height: number } | null = null;
  let rotated = false;

  for (let offset = 4; offset + 4 <= bytes.length; offset++) {
    const name = ascii(bytes, offset, 4);

    if (name === "ispe") {
      // version+flags(4), width(4), height(4)
      if (offset + 16 > bytes.length) continue;
      const width = u32be(bytes, offset + 8);
      const height = u32be(bytes, offset + 12);
      if (width > 0 && height > 0) {
        if (best === null || width * height > best.width * best.height) {
          best = { width, height };
        }
      }
      continue;
    }

    if (name === "irot") {
      // One byte; the low two bits are the rotation in units of 90° counter-clockwise.
      if (offset + 5 > bytes.length) continue;
      const angle = (bytes[offset + 4] ?? 0) & 0x03;
      if (angle === 1 || angle === 3) rotated = true;
      continue;
    }

    if (name === "Exif") {
      // HEIF wraps EXIF the same way JPEG does, minus the APP1 segment: a 4-byte offset to
      // the TIFF header, then the TIFF header itself.
      if (offset + 8 > bytes.length) continue;
      const tiff = offset + 4 + 4 + u32be(bytes, offset + 4);
      if (tiff + 8 <= bytes.length && transposes(readExifOrientation(bytes, tiff, bytes.length))) {
        rotated = true;
      }
    }
  }

  if (best === null) return null;
  return sized(best.width, best.height, rotated);
}

/**
 * The image's display dimensions, or `null` if these bytes are not an image of a type the
 * platform accepts.
 *
 * `null` is a refusal, and a deliberately indiscriminate one: a truncated file, a PDF
 * renamed to `.jpg`, a format Cloudflare would have taken and `domain/` does not. The
 * caller cannot tell them apart and does not need to — every one of them means the same
 * thing to a shelter, and the alternative is storing bytes we cannot describe.
 *
 * **The declared content type is not consulted.** The magic bytes are, so a HEIC a browser
 * labelled `image/jpeg` — which happens, because the label comes from the operating
 * system's guess at a file extension — is read as what it is rather than parsed as what it
 * claims. A caller that wants the two to agree can compare {@link sniffContentType}.
 */
export function readImageSize(header: Uint8Array): ImageSize | null {
  const type = sniffContentType(header);
  if (type === "image/jpeg") return parseJpeg(header);
  if (type === "image/png") return parsePng(header);
  if (type === "image/webp") return parseWebp(header);
  if (type === "image/heic" || type === "image/heif") return parseHeif(header);
  return null;
}

/**
 * What these bytes actually are, from their magic number, or `null`.
 *
 * The set is exactly `domain/`'s `ACCEPTED_ORIGINAL_TYPES`, because a type this cannot name
 * is a type the platform does not accept, and having the two lists differ would mean either
 * sniffing something we then refuse or refusing something we could have read.
 */
export function sniffContentType(header: Uint8Array): string | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header[0] === 0x89 &&
    ascii(header, 1, 3) === "PNG" &&
    header[4] === 0x0d &&
    header[5] === 0x0a
  ) {
    return "image/png";
  }
  if (ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (ascii(header, 4, 4) === "ftyp") {
    // The brand says which flavour of ISO-BMFF this is. `mif1`/`msf1` are the generic HEIF
    // brands and `heic`/`heix`/`hevc`/`hevx`/`heim`/`heis` the HEVC-coded ones an iPhone
    // writes; `avif` is deliberately absent, since `domain/` does not accept it.
    const brand = ascii(header, 8, 4);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) {
      return "image/heic";
    }
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  return null;
}
