/**
 * Hand-built image headers, for the parsers in `web/src/lib/media/dimensions.ts` and the
 * upload path that depends on them.
 *
 * These are **synthesised rather than committed as binary fixtures**, and the reason is
 * that a checked-in JPEG proves nothing a reader can see. The dimension parser's whole job
 * is to read two integers out of a structure at a known offset; a fixture file states
 * neither the offset nor the integers, so a test built on one passes or fails for reasons
 * invisible in the diff. Every builder below writes the structure the specification
 * describes, in the open, so a test that reads `jpeg({ width: 4032, height: 3024,
 * orientation: 6 })` is stating exactly what it is asserting about.
 *
 * They carry headers and no image data, which is all any of the parsers reads — none of
 * them decodes a pixel, by design. Nothing here is a valid image to a decoder, and nothing
 * in the suite decodes one: `cf.image` is the outbound interceptor's third vendor, so the
 * transform never runs locally.
 */

function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    for (const byte of part) flat.push(byte);
  }
  return new Uint8Array(flat);
}

function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function chars(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/**
 * A TIFF block holding one IFD0 entry: the orientation.
 *
 * `II` is little-endian, which is what an iPhone writes. The 42 is TIFF's own magic
 * number — the only constant in the format that exists purely to be checked.
 */
function tiffWithOrientation(orientation: number): number[] {
  return [
    ...chars("II"),
    ...u16le(42),
    ...u32le(8), // IFD0 begins 8 bytes into the TIFF block
    ...u16le(1), // one entry
    ...u16le(0x0112), // Orientation
    ...u16le(3), // SHORT
    ...u32le(1), // one value
    ...u16le(orientation), // stored in the first half of the 4-byte value field
    ...u16le(0),
    ...u32le(0), // no IFD1
  ];
}

export interface JpegOptions {
  readonly width: number;
  readonly height: number;
  /** EXIF orientation. Omit for a file with no EXIF block at all. */
  readonly orientation?: number;
  /**
   * Which start-of-frame marker carries the dimensions. `0xc0` is baseline and `0xc2`
   * progressive — the one a parser matching only `0xc0` silently fails on.
   */
  readonly sofMarker?: number;
  /**
   * Filler bytes written into an APP0 segment before the frame header, so a test can push
   * the dimensions past a given offset.
   */
  readonly padding?: number;
}

/** A JPEG header: APP0, an optional EXIF APP1, a frame header, and the start of the scan. */
export function jpeg(options: JpegOptions): Uint8Array {
  const { width, height, orientation, sofMarker = 0xc0, padding = 0 } = options;

  const app0 = [
    0xff,
    0xe0,
    ...u16be(2 + 14 + padding),
    ...chars("JFIF\0"),
    0x01,
    0x02,
    0x00,
    ...u16be(1),
    ...u16be(1),
    0x00,
    0x00,
    ...new Array<number>(padding).fill(0),
  ];

  const exif =
    orientation === undefined
      ? []
      : (() => {
          const tiff = tiffWithOrientation(orientation);
          return [0xff, 0xe1, ...u16be(2 + 6 + tiff.length), ...chars("Exif\0\0"), ...tiff];
        })();

  const sof = [
    0xff,
    sofMarker,
    ...u16be(8 + 3 * 3),
    8, // sample precision
    ...u16be(height),
    ...u16be(width),
    3, // components
    ...new Array<number>(9).fill(0),
  ];

  return bytes([0xff, 0xd8], app0, exif, sof, [0xff, 0xda, ...u16be(2)]);
}

export function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, ...chars("PNG"), 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    chars("IHDR"),
    u32be(width),
    u32be(height),
    [8, 2, 0, 0, 0],
  );
}

/** The extended container, which a WebP gets as soon as it has alpha, animation or metadata. */
export function webpExtended(width: number, height: number): Uint8Array {
  return bytes(
    chars("RIFF"),
    u32le(30),
    chars("WEBP"),
    chars("VP8X"),
    u32le(10),
    [0x10, 0, 0, 0],
    u24le(width - 1),
    u24le(height - 1),
  );
}

/** Plain lossy WebP: the size lives in the VP8 bitstream header, 14 bits per axis. */
export function webpLossy(width: number, height: number): Uint8Array {
  return bytes(
    chars("RIFF"),
    u32le(26),
    chars("WEBP"),
    chars("VP8 "),
    u32le(14),
    [0x00, 0x00, 0x00], // frame tag
    [0x9d, 0x01, 0x2a], // start code
    u16le(width),
    u16le(height),
  );
}

/** Lossless WebP: both axes packed into one 32-bit little-endian word, less one. */
export function webpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return bytes(
    chars("RIFF"),
    u32le(21),
    chars("WEBP"),
    chars("VP8L"),
    u32le(9),
    [0x2f],
    u32le(packed >>> 0),
  );
}

export interface HeicOptions {
  readonly width: number;
  readonly height: number;
  /**
   * The `irot` box's angle, in units of 90° counter-clockwise. `1` and `3` transpose the
   * axes; `0` and `2` do not.
   */
  readonly irot?: number;
  /** An EXIF orientation carried the way HEIF carries it, instead of an `irot` box. */
  readonly exifOrientation?: number;
  /**
   * A second, smaller `ispe` — the thumbnail a camera embeds. The parser must not read the
   * file as thumbnail-sized.
   */
  readonly thumbnail?: { readonly width: number; readonly height: number };
}

/**
 * A HEIC file's boxes, in the order an encoder writes them: the brand, then the property
 * container holding one `ispe` per stored item.
 */
export function heic(options: HeicOptions): Uint8Array {
  const ispe = (width: number, height: number) => [
    ...u32be(20),
    ...chars("ispe"),
    ...u32be(0), // version and flags
    ...u32be(width),
    ...u32be(height),
  ];

  const irot =
    options.irot === undefined
      ? []
      : [...u32be(9), ...chars("irot"), options.irot & 0x03];

  const exif =
    options.exifOrientation === undefined
      ? []
      : (() => {
          const tiff = tiffWithOrientation(options.exifOrientation);
          return [
            ...u32be(8 + 4 + tiff.length),
            ...chars("Exif"),
            ...u32be(0), // the offset from here to the TIFF header
            ...tiff,
          ];
        })();

  return bytes(
    u32be(24),
    chars("ftyp"),
    chars("heic"),
    u32be(0),
    chars("heic"),
    chars("mif1"),
    chars("meta"),
    chars("iprp"),
    chars("ipco"),
    options.thumbnail ? ispe(options.thumbnail.width, options.thumbnail.height) : [],
    ispe(options.width, options.height),
    irot,
    exif,
  );
}

/**
 * Bytes that are not an image of any kind. A PDF, which is the file a shelter actually
 * sends by accident.
 */
export function notAnImage(): Uint8Array {
  return bytes(chars("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"));
}
