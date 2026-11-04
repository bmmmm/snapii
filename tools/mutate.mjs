// SPDX-License-Identifier: GPL-3.0-or-later
// A plain mutation test: changes one operator or number at a time in the named
// source files, runs the unit tests and reports each mutant the tests let
// through. No dependency, no AST: binary operators are matched with the spaces
// Biome's formatter puts around them, comments and string/regex lines are
// skipped. Survivors still need reading: some are equivalent.
//
//   node tools/mutate.mjs src/shared/tiles.ts [more files…] [--lines 90-100] [--tests 'glob']
//
// The source file is restored after every mutant, also on Ctrl-C.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const tests = option("--tests", "tests/unit/**/*.test.ts");
const lines = option("--lines", null);
const [from, to] = lines ? lines.split("-").map(Number) : [1, Number.POSITIVE_INFINITY];
const files = args;
if (files.length === 0) {
  console.error("usage: node tools/mutate.mjs <file.ts>… [--lines a-b] [--tests glob]");
  process.exit(2);
}

/** [pattern, replacement] pairs; each match of a pattern is one mutant. */
const OPERATORS = [
  [/ && /g, " || "],
  [/ \|\| /g, " && "],
  [/ \?\? /g, " || "],
  [/ === /g, " !== "],
  [/ !== /g, " === "],
  [/ < /g, " <= "],
  [/ <= /g, " < "],
  [/ > /g, " >= "],
  [/ >= /g, " > "],
  [/ < /g, " > "],
  [/ > /g, " < "],
  [/ \+ /g, " - "],
  [/ - /g, " + "],
  [/ \* /g, " / "],
  [/ \/ /g, " * "],
  [/ \*\* /g, " * "],
  [/\bMath\.min\(/g, "Math.max("],
  [/\bMath\.max\(/g, "Math.min("],
  [/\bMath\.floor\(/g, "Math.ceil("],
  [/\bMath\.ceil\(/g, "Math.floor("],
  [/\bMath\.round\(/g, "Math.floor("],
  [/\btrue\b/g, "false"],
  [/\bfalse\b/g, "true"],
  [/!(?=[\w(.])/g, ""],
];

/** Numbers outside identifiers: n → n + 1, and n → 0 where n is not 0. */
const NUMBER = /(?<![\w.])(0x[0-9a-f]+|\d+(?:\.\d+)?(?:e-?\d+)?)(?![\w.])/gi;

const isCode = (line) => {
  const t = line.trim();
  if (t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
  if (t.startsWith("import ") || t.startsWith("export {") || t.startsWith("export type")) return false;
  return true;
};

/** The code part of a line: no trailing comment, strings and regex literals blanked out. */
function codeMask(line) {
  const noComment = line.replace(/\s\/\/ .*$/, "");
  return noComment
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => " ".repeat(m.length))
    .replace(/\/(?![\s/*])(?:\\.|[^/\n])+\/[gimsuy]*/g, (m) => " ".repeat(m.length))
    .padEnd(line.length, " ");
}

function* mutants(source) {
  const all = source.split("\n");
  for (let i = Math.max(0, from - 1); i < Math.min(all.length, to); i++) {
    const line = all[i];
    if (!isCode(line)) continue;
    const mask = codeMask(line);
    const at = (index, length) => mask.slice(index, index + length).trim() !== "";
    for (const [pattern, replacement] of OPERATORS) {
      for (const m of mask.matchAll(pattern)) {
        if (!at(m.index, m[0].length)) continue;
        const changed = line.slice(0, m.index) + replacement + line.slice(m.index + m[0].length);
        yield { line: i + 1, before: m[0].trim(), after: replacement.trim() || "(removed)", text: changed };
      }
    }
    for (const m of mask.matchAll(NUMBER)) {
      const n = Number(m[1]);
      const variants = [String(n + 1)];
      if (n !== 0) variants.push("0");
      for (const v of variants) {
        const changed = line.slice(0, m.index) + v + line.slice(m.index + m[0].length);
        yield { line: i + 1, before: m[1], after: v, text: changed };
      }
    }
  }
}

function run() {
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=20000", tests], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return r.status === 0 && r.signal === null;
}

let current = null;
const restore = () => {
  if (current) writeFileSync(current.file, current.source);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

if (!run()) {
  console.error("the tests fail without any mutant");
  process.exit(1);
}

let total = 0;
let survived = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  current = { file, source };
  const lines = source.split("\n");
  try {
    for (const m of mutants(source)) {
      total++;
      const copy = [...lines];
      copy[m.line - 1] = m.text;
      writeFileSync(file, copy.join("\n"));
      if (run()) {
        survived++;
        console.log(`SURVIVED ${file}:${m.line}  ${m.before} → ${m.after}  |  ${m.text.trim()}`);
      }
    }
  } finally {
    restore();
    current = null;
  }
}
console.log(`${total} mutants, ${total - survived} killed, ${survived} survived`);
