// SPDX-License-Identifier: GPL-3.0-or-later
// Where a word begins and ends in a line of text: Copy text takes a word the
// region cuts whole. DOM-free.

const SPACE = /\s/;

/** White space as \s has it (no-break and ideographic space included), by code unit. */
function isSpace(c: number): boolean {
  if (c < 0x80) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  return SPACE.test(String.fromCharCode(c));
}

// Scripts written without spaces between words, and the punctuation of
// Japanese: a stretch without white space is a sentence there, not a word.
const UNSPACED =
  /[\p{sc=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}]/u;

const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** The offset of the code point before i. */
const back = (text: string, i: number): number =>
  i - (i > 1 && isLow(text.charCodeAt(i - 1)) && isHigh(text.charCodeAt(i - 2)) ? 2 : 1);

/** The code point at i is of a script written without spaces. */
function unspaced(text: string, i: number): boolean {
  const cp = text.codePointAt(i);
  return cp !== undefined && UNSPACED.test(String.fromCodePoint(cp));
}

// The segmenter reads its whole input, and a word of such a script is a few
// characters long: it gets this much of the text on either side.
const WINDOW = 128;

let segmenter: { lang: string | null; words: Intl.Segmenter } | null = null;

function wordsOf(lang: string | null): Intl.Segmenter {
  if (segmenter?.lang === lang) return segmenter.words;
  let words: Intl.Segmenter;
  try {
    words = new Intl.Segmenter(lang ?? undefined, { granularity: "word" });
  } catch {
    // Malformed lang attribute: RangeError from the locale lookup.
    words = new Intl.Segmenter(undefined, { granularity: "word" });
  }
  segmenter = { lang, words };
  return words;
}

/**
 * The word of text[from, to) that holds the character at `at`, as offsets
 * (end exclusive): the stretch without white space around it, so that
 * punctuation, a hyphenated compound, "3,5" and a URL stay in one piece.
 * White space at `at` is its own piece. Where the stretch holds a script
 * written without spaces, it parts where `Intl.Segmenter` sees a word
 * boundary beside a character of such a script: "東京に行く" gives "東京",
 * and "e-mail" before it stays whole.
 */
export function wordAt(
  text: string,
  at: number,
  lang: string | null = null,
  from = 0,
  to = text.length,
): { start: number; end: number } {
  if (isSpace(text.charCodeAt(at))) return { start: at, end: at + 1 };
  let start = at;
  while (start > from && !isSpace(text.charCodeAt(start - 1))) start--;
  let end = at + 1;
  while (end < to && !isSpace(text.charCodeAt(end))) end++;
  if (!UNSPACED.test(text.slice(start, end))) return { start, end };

  let lo = Math.max(start, at - WINDOW);
  if (lo > start && isLow(text.charCodeAt(lo))) lo--;
  let hi = Math.min(end, at + WINDOW);
  if (hi < end && isLow(text.charCodeAt(hi))) hi++;
  let s = lo;
  let e = hi;
  for (const piece of wordsOf(lang).segment(text.slice(lo, hi))) {
    const b = lo + piece.index;
    if (b === lo || !(unspaced(text, b) || unspaced(text, back(text, b)))) continue;
    if (b > at) {
      e = b;
      break;
    }
    s = b;
  }
  // No boundary inside the window: a long spaced stretch (a URL), which ends
  // where the other script begins.
  if (s === lo) while (s > start && !unspaced(text, back(text, s))) s = back(text, s);
  if (e === hi) while (e < end && !unspaced(text, e)) e += (text.codePointAt(e) ?? 0) > 0xffff ? 2 : 1;
  return { start: s, end: e };
}

/**
 * Whether a word can go on past the character at `at` (any code unit of it)
 * into a neighbouring piece of text: not past white space, and not past a
 * character of a script written without spaces, where two pieces side by
 * side are two words as likely as one.
 */
export function runsOn(text: string, at: number): boolean {
  const i = at > 0 && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1)) ? at - 1 : at;
  const cp = text.codePointAt(i);
  if (cp === undefined) return false;
  const ch = String.fromCodePoint(cp);
  return !SPACE.test(ch) && !UNSPACED.test(ch);
}
