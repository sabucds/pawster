import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const html = readFileSync(process.argv[2], "utf8");
const js = html.split("<script>")[1].split("/* ================================================================ *\n * HARNESS")[0];
const { SCREENS, SHARED, BASE } = new Function(js + "; return { SCREENS, SHARED, BASE };")();
const rows = [];
for (const [sk, S] of Object.entries(SCREENS)) for (const [vk, v] of Object.entries(S.v)) {
  const out = [];
  for (const c of Object.keys(S.casos)) {
    const body = v.body(c);
    const page = `<!doctype html><html lang="es-VE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pawster</title><style>${SHARED}${BASE}${v.css}</style></head><body>${body}</body></html>`;
    if (/—/.test(body)) out.push(`${c}:EMDASH`);
    if (/sesi[oó]n|OTP|PIN|clave/i.test(body)) out.push(`${c}:BADWORD`);
    out.push(`${c} ${(gzipSync(page).length / 1024).toFixed(1)}`);
  }
  rows.push(`${sk} ${vk}: ${out.join(" · ")}`);
}
console.log(rows.join("\n"));
