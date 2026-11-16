// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { runsOn, wordAt } from "../../src/shared/words.ts";

/** The word of `text` at the character after the "|" in `at`. */
function word(at: string, lang: string | null = null): string {
  const text = at.replace("|", "");
  const { start, end } = wordAt(text, at.indexOf("|"), lang);
  return text.slice(start, end);
}

test("wordAt: the stretch without white space around the character, from any character of it", () => {
  assert.equal(word("alpha |beta gamma"), "beta");
  assert.equal(word("alpha bet|a gamma"), "beta");
  assert.equal(word("|alpha beta"), "alpha");
  assert.equal(word("alpha bet|a"), "beta");
  assert.deepEqual(wordAt("alpha beta gamma", 7), { start: 6, end: 10 });
});

test("wordAt: punctuation, a hyphenated compound, a number and a URL stay in one piece", () => {
  assert.equal(word("He said (well-kno|wn, e.g. that"), "(well-known,");
  assert.equal(word("costs 3|,5 kg"), "3,5");
  assert.equal(word("see https://exa|mple.org/a?b=1). Then"), "https://example.org/a?b=1).");
  assert.equal(word("it's a do|n't."), "don't.");
  assert.equal(word("a col·lec|ció b"), "col·lecció");
});

test("wordAt: white space is a piece of its own, one character of it", () => {
  assert.deepEqual(wordAt("a  b", 1), { start: 1, end: 2 });
  assert.deepEqual(wordAt("a\tb", 1), { start: 1, end: 2 });
  // No-break and ideographic space part words like any other.
  assert.equal(word("a b|c　d"), "bc");
});

test("wordAt: the limits keep a word inside its line", () => {
  // "well-" ends one line, "known" starts the next.
  assert.deepEqual(wordAt("aa well-known", 10, null, 8, 13), { start: 8, end: 13 });
  assert.deepEqual(wordAt("aa well-known", 4, null, 3, 8), { start: 3, end: 8 });
});

test("wordAt: surrogate pairs stay whole, from either half", () => {
  const text = "ab 😀😀cd ef";
  assert.deepEqual(wordAt(text, 3), { start: 3, end: 9 });
  assert.deepEqual(wordAt(text, 4), { start: 3, end: 9 });
  assert.deepEqual(wordAt(text, 8), { start: 3, end: 9 });
});

test("wordAt: a script written without spaces parts where the segmenter sees a word", () => {
  assert.equal(word("東|京に行くe-mailを書く。", "ja"), "東京");
  assert.equal(word("東京|に行くe-mailを書く。", "ja"), "に");
  assert.equal(word("東京に行|くe-mailを書く。", "ja"), "行く");
  // The Latin word between keeps its hyphen, which the segmenter alone would part.
  assert.equal(word("東京に行くe-m|ailを書く。", "ja"), "e-mail");
  assert.equal(word("東京に行くe-mailを書く|。", "ja"), "。");
  // Thai: no spaces inside a phrase.
  assert.equal(word("ภา|ษาไทยเขียนยาก", "th"), "ภาษา");
  // A language tag the page made up is no reason to fail.
  assert.equal(word("東|京に行く", "not a language"), "東京");
});

test("wordAt: an astral Han character is one of its script, whole", () => {
  // U+20BB7 is a surrogate pair.
  const text = "a 𠮷野家 b";
  const { start, end } = wordAt(text, 3, "ja");
  assert.ok(start === 2 && end >= 4 && end <= 6, `${start}..${end}`);
  assert.equal(text.codePointAt(start), 0x20bb7);
});

test("wordAt: a long stretch before a script without spaces is not cut at the segmenter's window", () => {
  const url = `https://example.org/${"a".repeat(400)}`;
  const text = `see ${url}東京に行く`;
  assert.equal(text.slice(...Object.values(wordAt(text, 10, "ja"))), url);
  assert.equal(text.slice(...Object.values(wordAt(text, 4 + url.length - 1, "ja"))), url);
  assert.equal(text.slice(...Object.values(wordAt(text, 4 + url.length, "ja"))), "東京");
});

test("wordAt: a megabyte without a space is one word, found without reading it twice over", () => {
  const text = "x".repeat(1_000_000);
  const t0 = performance.now();
  assert.deepEqual(wordAt(text, 500_000), { start: 0, end: 1_000_000 });
  assert.ok(performance.now() - t0 < 1000);
});

test("runsOn: a word can go on past a letter, a digit or punctuation, not past white space", () => {
  assert.equal(runsOn("foo", 2), true);
  assert.equal(runsOn("foo-", 3), true);
  assert.equal(runsOn("foo ", 3), false);
  assert.equal(runsOn("foo ", 3), false);
  assert.equal(runsOn("", 0), false);
  // Either half of a pair.
  assert.equal(runsOn("a😀", 1), true);
  assert.equal(runsOn("a😀", 2), true);
});

test("runsOn: not past a character of a script written without spaces", () => {
  assert.equal(runsOn("東京", 1), false);
  assert.equal(runsOn("東京", 0), false);
  assert.equal(runsOn("ไทย", 2), false);
  assert.equal(runsOn("𠮷", 1), false);
});
