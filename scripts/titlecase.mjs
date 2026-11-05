// SPDX-License-Identifier: GPL-3.0-or-later
// Prints the TITLECASE table in src/shared/whitespace.ts from the Unicode
// Character Database. Run by hand when the Unicode version changes:
//   curl -O https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
//   curl -O https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt
//   node scripts/titlecase.mjs UnicodeData.txt SpecialCasing.txt
//
// The table holds the letters whose titlecase is one code point other than
// their full uppercase, minus the uppercase letters (Ǆ Ǉ Ǌ Ǳ: Chromium
// title-cases them, Firefox keeps them). Firefox 155 and Chromium 153
// capitalize exactly these to their titlecase (measured over every code point
// whose titlecase differs from its uppercase, with no lang and with en, el,
// tr, lt, nl, az, ka, hr); on the rest (ß, ﬁ, և, ᾲ, Ǆ — titlecase of two code
// points, or an uppercase letter) the engines differ.
import { readFileSync } from "node:fs";

const [unicodeData, specialCasing] = process.argv.slice(2);
if (!unicodeData || !specialCasing) {
  console.error("usage: node scripts/titlecase.mjs UnicodeData.txt SpecialCasing.txt");
  process.exit(1);
}

const cps = (field) =>
  field
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((h) => Number.parseInt(h, 16));

/** code point -> { category, upper: number[], title: number[] }, full mappings. */
const chars = new Map();
for (const line of readFileSync(unicodeData, "utf8").split("\n")) {
  const f = line.split(";");
  if (f.length < 15) continue;
  const cp = Number.parseInt(f[0], 16);
  const upper = f[12] ? cps(f[12]) : [cp];
  chars.set(cp, { category: f[2], upper, title: f[14] ? cps(f[14]) : upper });
}
for (const line of readFileSync(specialCasing, "utf8").split("\n")) {
  const f = line.replace(/#.*/, "").split(";");
  // Conditional mappings (a fifth field: language or context) are not the default.
  if (f.length < 5 || f[4].trim()) continue;
  const c = chars.get(Number.parseInt(f[0], 16));
  if (!c) continue;
  c.title = cps(f[2]);
  c.upper = cps(f[3]);
}

const offsets = [];
for (const [cp, { category, upper, title }] of [...chars].sort((a, b) => a[0] - b[0])) {
  if (category === "Lu" || title.length !== 1 || (upper.length === 1 && upper[0] === title[0])) continue;
  const offset = title[0] - cp;
  const last = offsets.at(-1);
  if (last && last[1] === cp - 1 && last[2] === offset) last[1] = cp;
  else offsets.push([cp, cp, offset]);
}
const hex = (n) => `0x${n.toString(16)}`;
console.log(offsets.map(([a, b, o]) => `  [${hex(a)}, ${hex(b)}, ${o}],`).join("\n"));
