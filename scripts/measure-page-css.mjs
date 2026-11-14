#!/usr/bin/env node
/**
 * What each prerendered page ships, and what the shared base adds to it (issue #96).
 *
 *   npm run build --workspace @pawster/web && node scripts/measure-page-css.mjs
 *
 * Reads `web/dist/client/**\/*.html`. Server-rendered pages (the animal page) are not in that
 * folder, but Astro inlines their CSS the same way. Fails if any page links a stylesheet,
 * because `build.inlineStylesheets: "always"` is supposed to rule that out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const root = new URL("../web/dist/client/", import.meta.url);
const gz = (s) => gzipSync(s, { level: 9 }).length;

const base = readFileSync(new URL("../web/src/styles/base.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1")
  .trim();
console.log(`base.css, minified: ${base.length} B raw, ${gz(base)} B gzipped`);

const pages = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".html"));
let linked = 0;
for (const page of pages.sort()) {
  const html = readFileSync(new URL(page, root), "utf8");
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
  const links = (html.match(/<link[^>]*rel="?stylesheet/g) ?? []).length;
  linked += links;
  console.log(
    `${page}: page ${html.length} B / ${gz(html)} B gz, inline CSS ${css.length} B, stylesheet links ${links}`,
  );
}
if (linked > 0) throw new Error(`${linked} stylesheet link(s) found; CSS should be inline`);
