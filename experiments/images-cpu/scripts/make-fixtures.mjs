#!/usr/bin/env node
/**
 * Builds the fixtures the probe Worker serves as Static Assets.
 *
 *   phone.jpg   ~12 MP, ~3 MB   the representative phone photo #34 asks for
 *   phone.heic  the same image   because iPhones shoot HEIC by default
 *   small.jpg   64x64            cheap input for the subrequest probe
 *   tiny.txt    a few bytes      cheap target for the subrequest probe
 *
 * Prefer a real photograph:
 *
 *   node scripts/make-fixtures.mjs ~/Pictures/IMG_4821.HEIC
 *
 * Encode cost tracks pixel count, so a synthesised image is a fair proxy for the
 * CPU question — but only a real photo settles whether the pipeline chokes on
 * what an actual iPhone produces (its EXIF, its colour profile, its subsampling).
 * With no argument this synthesises one, and says so in the manifest, so the
 * resolution comment can be honest about which was measured.
 *
 * macOS only: conversion is `sips`, which is the one image tool guaranteed to be
 * on the machine and the only easy route to a real HEIC.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures");
const tmp = join(root, ".tmp");

const WIDTH = 4032; // an iPhone's long edge
const HEIGHT = 3024; // 12.2 MP, the same count a phone reports
const TARGET_BYTES = 3_000_000;

/**
 * A 24-bit BMP is the simplest thing `sips` will read: no compression, no CRC,
 * no dependency. 36 MB on disk for a moment, then deleted.
 */
function writeBmp(path, pixels, width, height) {
  const rowBytes = width * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const dataSize = (rowBytes + pad) * height;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + dataSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(dataSize, 34);
  writeFileSync(path, Buffer.concat([header, pixels]));
}

/**
 * A photograph is smooth regions plus fine texture, and it is the texture that
 * decides the file size. `detail` scales the texture only, so the search below
 * can hit a byte target without changing the pixel count the CPU question turns
 * on.
 */
function synthesise(detail) {
  const rowBytes = WIDTH * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const buf = Buffer.alloc((rowBytes + pad) * HEIGHT);
  let o = 0;
  for (let y = HEIGHT - 1; y >= 0; y--) {
    // BMP rows run bottom-up.
    const fy = y / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const fx = x / WIDTH;
      // Smooth base: a sky-to-ground sort of field, cheap to compress.
      const base =
        140 +
        70 * Math.sin(fx * 3.1 + fy * 1.7) +
        40 * Math.cos(fy * 5.3 - fx * 2.2);
      // Texture: deterministic high-frequency noise, which is what costs bytes.
      const n =
        Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
      const grain = (n - Math.floor(n) - 0.5) * detail;
      const edge = 30 * Math.sin((fx * fx + fy * fy) * 60);
      const r = base + grain + edge;
      const g = base * 0.92 + grain * 0.9 - edge * 0.4;
      const b = base * 0.78 + grain * 1.1 + edge * 0.2;
      buf[o++] = Math.max(0, Math.min(255, b | 0));
      buf[o++] = Math.max(0, Math.min(255, g | 0));
      buf[o++] = Math.max(0, Math.min(255, r | 0));
    }
    o += pad;
  }
  return buf;
}

function sips(args) {
  return execFileSync("sips", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const supplied = process.argv[2];
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(tmp, { recursive: true });

  const jpg = join(fixtures, "phone.jpg");
  const heic = join(fixtures, "phone.heic");
  let provenance;

  if (supplied) {
    if (!existsSync(supplied)) {
      console.error(`no such file: ${supplied}`);
      process.exit(1);
    }
    // A real photo is used as-is except for the format conversions, so its pixel
    // count and its EXIF are whatever the camera actually wrote.
    sips(["-s", "format", "jpeg", supplied, "--out", jpg]);
    sips(["-s", "format", "heic", supplied, "--out", heic]);
    provenance = { kind: "real-photograph", source: supplied };
  } else {
    // Land near 3 MB by bisecting on texture amplitude. Four passes is enough to
    // get inside 20%, and the manifest records what was actually achieved rather
    // than what was aimed at.
    const bmp = join(tmp, "synth.bmp");
    let lo = 0;
    let hi = 220;
    let bytes = 0;
    let detail = 90;
    for (let i = 0; i < 5; i++) {
      detail = (lo + hi) / 2;
      writeBmp(bmp, synthesise(detail), WIDTH, HEIGHT);
      sips(["-s", "format", "jpeg", "-s", "formatOptions", "80", bmp, "--out", jpg]);
      bytes = statSync(jpg).size;
      process.stderr.write(
        `  detail ${detail.toFixed(1)} -> ${(bytes / 1e6).toFixed(2)} MB\n`,
      );
      if (Math.abs(bytes - TARGET_BYTES) < TARGET_BYTES * 0.1) break;
      if (bytes < TARGET_BYTES) lo = detail;
      else hi = detail;
    }
    sips(["-s", "format", "heic", jpg, "--out", heic]);
    provenance = {
      kind: "synthesised",
      note:
        "Not a photograph. Pixel count is faithful; JPEG entropy is approximated. " +
        "Re-run with a real phone photo before treating any HEIC-specific result as final.",
      detail,
    };
  }

  // The subrequest probe needs inputs whose own cost is negligible, so that the
  // only thing the 50-subrequest wall is measuring is the count.
  sips(["-Z", "64", "-s", "format", "jpeg", jpg, "--out", join(fixtures, "small.jpg")]);
  writeFileSync(join(fixtures, "tiny.txt"), "x\n");

  const dims = (p) =>
    sips(["-g", "pixelWidth", "-g", "pixelHeight", p])
      .toString()
      .match(/\d+/g)
      ?.slice(-2)
      .map(Number) ?? [];

  const [w, h] = dims(jpg);
  const manifest = {
    generatedAt: new Date().toISOString(),
    provenance,
    files: {
      "phone.jpg": { bytes: statSync(jpg).size, width: w, height: h },
      "phone.heic": { bytes: statSync(heic).size },
      "small.jpg": { bytes: statSync(join(fixtures, "small.jpg")).size },
    },
  };
  writeFileSync(
    join(fixtures, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  rmSync(tmp, { recursive: true, force: true });

  console.log(JSON.stringify(manifest, null, 2));
  console.log(
    `\nfixtures ready in ${fixtures} — ${(manifest.files["phone.jpg"].bytes / 1e6).toFixed(2)} MB / ${w}x${h} (${((w * h) / 1e6).toFixed(1)} MP)`,
  );
}

main();
