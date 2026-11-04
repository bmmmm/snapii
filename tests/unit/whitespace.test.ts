// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTextTransform,
  collapse,
  isIconText,
  isPreserved,
  type LineText,
  normalizeLines,
} from "../../src/shared/whitespace.ts";

test("collapse: normal, nowrap and pre-line fold [ \\t\\n\\r\\f]+ into one space", () => {
  for (const ws of ["normal", "nowrap", "pre-line", "collapse", "preserve-breaks"]) {
    assert.equal(collapse("a \t\n\r\f b\n\nc", ws), "a b c", ws);
  }
});

test("collapse: pre, pre-wrap and break-spaces keep spaces verbatim, drop the line break", () => {
  for (const ws of ["pre", "pre-wrap", "break-spaces", "preserve", "preserve-spaces"]) {
    assert.equal(collapse("  two  spaces\n", ws), "  two  spaces", ws);
    assert.equal(isPreserved(ws), true, ws);
  }
  assert.equal(isPreserved("normal"), false);
});

test("collapse: non-breaking spaces are content, not collapsible", () => {
  assert.equal(collapse("a\u00a0\u00a0 b", "normal"), "a\u00a0\u00a0 b");
});

test("applyTextTransform: uppercase incl. sharp s and Turkish dotted i", () => {
  assert.equal(applyTextTransform("straße", "uppercase", "de"), "STRASSE");
  assert.equal(applyTextTransform("istanbul", "uppercase", "tr"), "İSTANBUL");
  assert.equal(applyTextTransform("istanbul", "uppercase", null), "ISTANBUL");
  assert.equal(applyTextTransform("abc", "uppercase", "not a tag!"), "ABC");
});

test("applyTextTransform: lowercase, capitalize, none", () => {
  assert.equal(applyTextTransform("MIXED Case", "lowercase", "en"), "mixed case");
  assert.equal(applyTextTransform("don't (stop) me now", "capitalize", "en"), "Don't (Stop) Me Now");
  assert.equal(applyTextTransform("as is", "none", "en"), "as is");
});

test("applyTextTransform: capitalize starts a word after a dash, a quote and other punctuation, as Firefox and Chromium do", () => {
  // Measured in Firefox 155 and Chromium 153 (text-transform on "xx<c>yy").
  assert.equal(
    applyTextTransform("e-mail co\u2011op state\u2013of\u2014art", "capitalize", "en"),
    "E-Mail Co\u2011Op State\u2013Of\u2014Art",
  );
  for (const c of '.,:;!?/\\"\u201c&@*#%\u2026') {
    assert.equal(applyTextTransform(`xx${c}yy`, "capitalize", "en"), `Xx${c}Yy`, JSON.stringify(c));
  }
  // An apostrophe, a middle dot, a connector, a digit and a soft hyphen go on inside a word.
  for (const c of "'\u2019\u00b7_1\u00ad") {
    assert.equal(applyTextTransform(`xx${c}yy`, "capitalize", "en"), `Xx${c}yy`, JSON.stringify(c));
  }
  assert.equal(applyTextTransform("3.5kg U.S.A. e.g.", "capitalize", "en"), "3.5kg U.S.A. E.G.");
  // A run that begins after the hyphen a word wrapped at starts a word; one that begins inside it does not.
  assert.equal(applyTextTransform("op", "capitalize", "en", "o-"), "Op");
  assert.equal(applyTextTransform("op", "capitalize", "en", "oo"), "op");
});

test("isIconText: only private-use code points (and spaces)", () => {
  assert.equal(isIconText("\ue001"), true);
  assert.equal(isIconText(" \ue001 \u{f0001} "), true);
  assert.equal(isIconText("\ue001 Settings"), false);
  assert.equal(isIconText("   "), false);
  assert.equal(isIconText(""), false);
});

const run = (text: string, line: number, preserved = false): LineText => ({ text, line, preserved });

test("normalizeLines: strips line-edge spaces and the second space at a join", () => {
  const out = normalizeLines([run(" Read ", 0), run(" the docs ", 0), run("next", 1), run(" line ", 1)]);
  assert.deepEqual(
    out.map((r) => r.text),
    ["Read ", "the docs", "next", " line"],
  );
});

test("normalizeLines: drops runs that end up empty, keeps a lone separator space", () => {
  const out = normalizeLines([run(" ", 0), run("foo", 0), run(" ", 0), run("bar", 0), run(" ", 0)]);
  assert.deepEqual(
    out.map((r) => r.text),
    ["foo", " ", "bar"],
  );
});

test("normalizeLines: preserved runs keep their spaces", () => {
  const out = normalizeLines([run("  indented  ", 0, true), run(" tail ", 0)]);
  assert.deepEqual(
    out.map((r) => r.text),
    ["  indented  ", " tail"],
  );
});

test("applyTextTransform: capitalize keeps a run that starts inside a word lower-case", () => {
  // foo<b>bar</b>, a slice cut at the capture edge, a wrapped word: the page shows one word.
  assert.equal(applyTextTransform("bar", "capitalize", "en", "oo"), "bar");
  assert.equal(applyTextTransform("pture", "capitalize", "en", "ca"), "pture");
  assert.equal(applyTextTransform("t", "capitalize", "en", "n'"), "t");
  // After a space, a block start or an opening bracket a word begins.
  assert.equal(applyTextTransform("bar", "capitalize", "en", "o "), "Bar");
  assert.equal(applyTextTransform("bar", "capitalize", "en", ""), "Bar");
  assert.equal(applyTextTransform("bar", "capitalize", "en", " ("), "Bar");
  // The prefix is dropped whole, also when its own letter changes length.
  assert.equal(applyTextTransform("traße", "capitalize", "de", " ß"), "traße");
});

test("applyTextTransform: capitalize title-cases digraphs, Georgian and Greek with ypogegrammeni like both engines", () => {
  // Firefox 155 and Chromium 153 agree on titlecase for exactly these: ǆ -> ǅ, ᾳ -> ᾼ, a title-case or
  // Georgian Mkhedruli letter stays as it is. toUpperCase would give Ǆ, ΑΙ and Mtavruli.
  assert.equal(applyTextTransform("ǆungla ᾳx ǉ ǌ ǳ ᾀ ῃ ῳ", "capitalize", "en"), "ǅungla ᾼx ǈ ǋ ǲ ᾈ ῌ ῼ");
  assert.equal(applyTextTransform("ǅ ǈ ǋ ǲ ᾈ ᾼ ა ჿ", "capitalize", "en"), "ǅ ǈ ǋ ǲ ᾈ ᾼ ა ჿ");
  assert.equal(applyTextTransform("ǆ", "capitalize", null), "ǅ");
  assert.equal(applyTextTransform("ǆ", "capitalize", "not a tag!"), "ǅ");
  // Only capitalize: uppercase keeps the full upper-case mapping.
  assert.equal(applyTextTransform("ǆ ᾳ", "uppercase", "en"), "Ǆ ΑΙ");
});

test("applyTextTransform: capitalize keeps the upper-case mapping where the engines disagree on titlecase", () => {
  // ß, ligatures, Ǆ and the Greek and Armenian letters whose titlecase is two code points: Firefox
  // title-cases (Ss, Fi, ǅ), Chromium keeps ß and ﬁ. snapii stays with toUpperCase until they agree.
  assert.equal(applyTextTransform("ßa ﬁx ﬆy Ǆz ᾲw և", "capitalize", "de"), "SSa FIx STy Ǆz ᾺΙw ԵՒ");
});
