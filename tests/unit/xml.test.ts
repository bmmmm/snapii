// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt, xmlAttr, xmlText } from "../../src/shared/svg/xml.ts";

test("xmlText: escapes & < > and leaves quotes alone", () => {
  assert.equal(xmlText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(xmlText('say "hi"'), 'say "hi"');
  assert.equal(xmlText("]]>"), "]]&gt;");
});

test("xmlText: & is escaped once, first (no double escaping of the other entities)", () => {
  assert.equal(xmlText("<&>"), "&lt;&amp;&gt;");
  assert.equal(xmlText("&lt;"), "&amp;lt;");
  assert.equal(xmlText("&amp;"), "&amp;amp;");
});

test("xmlAttr: additionally escapes the double quote", () => {
  assert.equal(xmlAttr('a "b" & <c>'), "a &quot;b&quot; &amp; &lt;c&gt;");
  assert.equal(xmlAttr('"Helvetica Neue", Arial'), "&quot;Helvetica Neue&quot;, Arial");
  assert.equal(xmlAttr("&"), "&amp;");
});

test("xmlAttr: tab, newline and carriage return survive attribute-value normalization as references", () => {
  assert.equal(xmlAttr("a\tb\nc\rd"), "a&#9;b&#10;c&#13;d");
  assert.equal(xmlText("a\tb\nc\rd"), "a\tb\nc\rd");
});

// XML 1.0 (5th ed.) Char, written out independently of the implementation.
const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

test("xmlText: every single UTF-16 code unit is kept iff XML 1.0 allows it", () => {
  const wrong: string[] = [];
  for (let cu = 0; cu <= 0xffff; cu++) {
    const ch = String.fromCharCode(cu);
    if (ch === "&" || ch === "<" || ch === ">") continue;
    const kept = xmlText(ch) === ch;
    // A lone surrogate is never valid, whatever its code unit value.
    const valid = isXmlChar(cu);
    if (kept !== valid) wrong.push(`U+${cu.toString(16).padStart(4, "0")}`);
  }
  assert.deepEqual(wrong, []);
});

test("xmlText: C0 controls are stripped except tab, newline, carriage return", () => {
  assert.equal(xmlText("a\u0000b\u0001c\u0008d\u000be\u000cf\u000eg\u001fh"), "abcdefgh");
  assert.equal(xmlText("a\tb\nc\rd"), "a\tb\nc\rd");
  assert.equal(xmlText("a\u007fb\u0080c"), "a\u007fb\u0080c");
});

test("xmlText: lone surrogates and non-characters are stripped, valid pairs kept", () => {
  assert.equal(xmlText("a\ud800b"), "ab");
  assert.equal(xmlText("a\udc00b"), "ab");
  assert.equal(xmlText("a\ud800\ud800b"), "ab");
  assert.equal(xmlText("a\udc00\ud800b"), "ab");
  assert.equal(xmlText("a\ud83d"), "a");
  assert.equal(xmlText("a\ufffeb\uffffc"), "abc");
  assert.equal(xmlText("a\ud83d\ude00b"), "a\ud83d\ude00b");
  assert.equal(xmlText("\u{10000}\u{10ffff}"), "\u{10000}\u{10ffff}");
  assert.equal(xmlText("a\ufffdb"), "a\ufffdb");
});

test("xmlAttr: strips invalid characters as well", () => {
  assert.equal(xmlAttr('a\u0000"b\ud800'), "a&quot;b");
});

test("xmlText: empty string", () => {
  assert.equal(xmlText(""), "");
  assert.equal(xmlAttr(""), "");
});

test("fmt: at most two decimals, no trailing zeros", () => {
  assert.equal(fmt(1), "1");
  assert.equal(fmt(100), "100");
  assert.equal(fmt(1.5), "1.5");
  assert.equal(fmt(2.1), "2.1");
  assert.equal(fmt(1.234), "1.23");
  assert.equal(fmt(1.236), "1.24");
  assert.equal(fmt(0.1 + 0.2), "0.3");
  assert.equal(fmt(-3.456), "-3.46");
  assert.equal(fmt(1234567.891), "1234567.89");
});

test("fmt: never emits -0", () => {
  assert.equal(fmt(-0), "0");
  assert.equal(fmt(0), "0");
  assert.equal(fmt(-0.001), "0");
  assert.equal(fmt(0.004), "0");
});

test("fmt: non-finite input still yields a valid number", () => {
  assert.equal(fmt(Number.NaN), "0");
  assert.equal(fmt(Number.POSITIVE_INFINITY), "0");
  assert.equal(fmt(Number.NEGATIVE_INFINITY), "0");
});
