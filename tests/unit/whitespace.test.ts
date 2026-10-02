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
