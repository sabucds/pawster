import { describe, expect, it } from "vitest";
import {
  HEADER_BYTES,
  readImageSize,
  sniffContentType,
} from "../src/lib/media/dimensions.ts";
import {
  heic,
  jpeg,
  notAnImage,
  png,
  webpExtended,
  webpLossless,
  webpLossy,
} from "./fixtures/images.ts";

/**
 * The parser that makes ADR 0012's "reject... beyond a maximum dimension *before storing
 * anything*" possible at all. A dimension appears in no HTTP header, so the only place to
 * find one before the write is the file's own header.
 */
describe("readImageSize", () => {
  it("reads a baseline JPEG", () => {
    expect(readImageSize(jpeg({ width: 4032, height: 3024 }))).toEqual({
      width: 4032,
      height: 3024,
      rotated: false,
    });
  });

  it("reads a progressive JPEG, which a parser matching only SOF0 would miss", () => {
    // Some phones write progressive by default, and the common shortcut — accept 0xc0 and
    // 0xc2 and nothing else — fails on arithmetic-coded and lossless frames too.
    for (const sofMarker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcd]) {
      expect(readImageSize(jpeg({ width: 800, height: 600, sofMarker }))).toEqual({
        width: 800,
        height: 600,
        rotated: false,
      });
    }
  });

  it("does not mistake a Huffman table for a frame header", () => {
    // 0xc4 sits inside the SOFn range and is not a frame header. Reading it as one would
    // take two bytes of a coding table as the image's dimensions.
    expect(readImageSize(jpeg({ width: 800, height: 600, sofMarker: 0xc4 }))).toBeNull();
  });

  it("transposes a JPEG that carries a quarter-turn orientation", () => {
    // An iPhone writes the sensor's landscape frame and a tag saying to turn it. The
    // upright image — the only one that will ever exist — is the transposed one.
    expect(readImageSize(jpeg({ width: 4032, height: 3024, orientation: 6 }))).toEqual({
      width: 3024,
      height: 4032,
      rotated: true,
    });
  });

  it("leaves the mirroring orientations alone", () => {
    // 1 through 4 are upright or flipped, and neither swaps the axes. Treating "not 1" as
    // "rotated" is the reflex and would transpose half of them wrongly.
    for (const orientation of [1, 2, 3, 4]) {
      expect(readImageSize(jpeg({ width: 4032, height: 3024, orientation }))).toEqual({
        width: 4032,
        height: 3024,
        rotated: false,
      });
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(readImageSize(jpeg({ width: 4032, height: 3024, orientation }))?.rotated).toBe(
        true,
      );
    }
  });

  it("finds a frame header past a fat EXIF block", () => {
    // The reason HEADER_BYTES is 256 KB rather than a few hundred: a camera's EXIF, with
    // its embedded thumbnail, routinely pushes the frame header past 64 KB.
    const fat = jpeg({ width: 4032, height: 3024, padding: 60_000 });
    expect(fat.length).toBeGreaterThan(60_000);
    expect(fat.length).toBeLessThan(HEADER_BYTES);
    expect(readImageSize(fat)).toEqual({ width: 4032, height: 3024, rotated: false });
  });

  it("reads a PNG", () => {
    expect(readImageSize(png(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
      rotated: false,
    });
  });

  it("reads all three WebP container shapes", () => {
    expect(readImageSize(webpExtended(2000, 1500))).toEqual({
      width: 2000,
      height: 1500,
      rotated: false,
    });
    expect(readImageSize(webpLossy(2000, 1500))).toEqual({
      width: 2000,
      height: 1500,
      rotated: false,
    });
    expect(readImageSize(webpLossless(2000, 1500))).toEqual({
      width: 2000,
      height: 1500,
      rotated: false,
    });
  });

  it("reads a HEIC, which is what an iPhone actually uploads", () => {
    // ADR 0012's second count against resizing in the browser: Chrome cannot decode HEIC in
    // a canvas at all, and Cloudflare accepts it on the Free plan.
    expect(readImageSize(heic({ width: 4032, height: 3024 }))).toEqual({
      width: 4032,
      height: 3024,
      rotated: false,
    });
  });

  it("takes the largest ispe, never the embedded thumbnail's", () => {
    // A HEIC holds one per stored item. Reading the thumbnail's would let a 40-megapixel
    // file present itself as 320x240 and clear a ceiling it does not fit under.
    expect(
      readImageSize(
        heic({ width: 8064, height: 6048, thumbnail: { width: 320, height: 240 } }),
      ),
    ).toEqual({ width: 8064, height: 6048, rotated: false });
  });

  it("transposes a HEIC rotated by an irot box", () => {
    for (const angle of [1, 3]) {
      expect(readImageSize(heic({ width: 4032, height: 3024, irot: angle }))).toEqual({
        width: 3024,
        height: 4032,
        rotated: true,
      });
    }
    for (const angle of [0, 2]) {
      expect(readImageSize(heic({ width: 4032, height: 3024, irot: angle }))).toEqual({
        width: 4032,
        height: 3024,
        rotated: false,
      });
    }
  });

  it("transposes a HEIC rotated by an EXIF tag instead", () => {
    // HEIF may carry either, and exporters disagree about which. A shelter has no
    // influence over the choice, so both have to work.
    expect(
      readImageSize(heic({ width: 4032, height: 3024, exifOrientation: 8 })),
    ).toEqual({ width: 3024, height: 4032, rotated: true });
  });

  it("refuses bytes that are not an image", () => {
    expect(readImageSize(notAnImage())).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    // A JPEG truncated before its frame header: the scan reaches the start of the scan
    // segment and gives up rather than reading past the end of the buffer.
    expect(readImageSize(jpeg({ width: 100, height: 100 }).slice(0, 4))).toBeNull();
  });

  it("refuses a GIF, which domain/ does not accept", () => {
    // Cloudflare would take it; every derivative is a still, so an animation would publish
    // as one frame with no error anywhere.
    const gif = new Uint8Array([
      ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
      0x40, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(sniffContentType(gif)).toBeNull();
    expect(readImageSize(gif)).toBeNull();
  });
});

describe("sniffContentType", () => {
  it("names each accepted type from its magic bytes", () => {
    expect(sniffContentType(jpeg({ width: 1, height: 1 }))).toBe("image/jpeg");
    expect(sniffContentType(png(1, 1))).toBe("image/png");
    expect(sniffContentType(webpLossy(1, 1))).toBe("image/webp");
    expect(sniffContentType(heic({ width: 1, height: 1 }))).toBe("image/heic");
  });

  it("reads the bytes rather than the label the browser guessed", () => {
    // The label comes from the operating system's guess at a file extension, and a HEIC
    // renamed `.jpg` is a real thing a shelter sends. What matters is what the file is.
    const heicBytes = heic({ width: 4032, height: 3024 });
    expect(sniffContentType(heicBytes)).toBe("image/heic");
    expect(readImageSize(heicBytes)).not.toBeNull();
  });

  it("refuses AVIF, which shares HEIF's container and is not on the accepted list", () => {
    const avif = new Uint8Array([
      0, 0, 0, 24,
      ...[..."ftypavif"].map((c) => c.charCodeAt(0)),
      0, 0, 0, 0,
    ]);
    expect(sniffContentType(avif)).toBeNull();
  });
});
