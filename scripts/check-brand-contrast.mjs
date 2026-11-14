#!/usr/bin/env node
/**
 * Checks every text and border pair the brand manual promises (issue #106), and reports what
 * the token block weighs gzipped.
 *
 *   node scripts/check-brand-contrast.mjs            # reads the ```css block in docs/brand.md
 *   node scripts/check-brand-contrast.mjs web/src/styles/base.css
 *
 * Fails if a pair is under its minimum: 4.5:1 for text (WCAG 1.4.3 AA), 3:1 for field borders
 * and focus rings (WCAG 1.4.11).
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const path = process.argv[2] ?? "docs/brand.md";
const src = readFileSync(path, "utf8");
const css = path.endsWith(".md") ? src.match(/```css\n([\s\S]*?)```/)[1] : src;
const tokens = Object.fromEntries([...css.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

const lum = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((h) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum, where it appears]
const PAIRS = [
  ["--ink", "--page", 4.5, "body text"],
  ["--ink", "--surface", 4.5, "text on cards"],
  ["--ink-soft", "--page", 4.5, "secondary text"],
  ["--ink-soft", "--surface", 4.5, "secondary text on cards"],
  ["--brand", "--page", 4.5, "wordmark, links"],
  ["--brand", "--surface", 4.5, "links on cards"],
  ["--surface", "--brand", 4.5, "primary button, pressed chip"],
  ["--surface", "--brand-dark", 4.5, "primary button, hover"],
  ["--brand-dark", "--brand-tint", 4.5, "secondary button, current tab"],
  ["--ok", "--surface", 4.5, "verified label"],
  ["--ok", "--ok-bg", 4.5, "verified tag"],
  ["--aged", "--page", 4.5, "stale date"],
  ["--aged", "--surface", 4.5, "stale date on cards"],
  ["--aged-ink", "--aged-bg", 4.5, "staleness notice"],
  ["--warn", "--surface", 4.5, "warning text"],
  ["--urgent-ink", "--surface", 4.5, "errors, destructive button"],
  ["--urgent-ink", "--urgent-bg", 4.5, "urgent tag"],
  ["--surface", "--urgent-ink", 4.5, "urgent badge"],
  ["--surface", "--whatsapp", 4.5, "WhatsApp button"],
  ["--surface", "--instagram", 4.5, "Instagram button"],
  ["--field-line", "--surface", 3, "form field border"],
  ["--brand", "--page", 3, "focus ring"],
];

let failed = 0;
for (const [fg, bg, min, where] of PAIRS) {
  if (!tokens[fg] || !tokens[bg]) {
    console.log(`MISSING ${fg} or ${bg} (${where})`);
    failed++;
    continue;
  }
  const r = ratio(tokens[fg], tokens[bg]);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)}:1  ${fg} on ${bg}  (${where}, needs ${min})`);
}

const min = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};:,])\s*/g, "$1").trim();
console.log(`\ntoken block, minified: ${min.length} B raw, ${gzipSync(min, { level: 9 }).length} B gzipped`);
process.exit(failed ? 1 : 0);
