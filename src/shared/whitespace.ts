// SPDX-License-Identifier: GPL-3.0-or-later
// Text of a run as the user sees it: CSS white-space collapsing,
// text-transform, and the space clean-up where runs of one line meet.
// DOM-free; the content script passes computed style values in.

// white-space (legacy keywords) and white-space-collapse values that keep
// spaces as authored. Everything else collapses.
const PRESERVING = new Set(["pre", "pre-wrap", "break-spaces", "preserve", "preserve-spaces"]);

export function isPreserved(whiteSpace: string): boolean {
  return PRESERVING.has(whiteSpace);
}

/**
 * Collapses one line's slice of a text node like CSS does: runs of
 * [ \t\n\r\f] become one space (normal, nowrap, pre-line). Preserved text
 * stays verbatim except for segment breaks: inside a single line slice a
 * newline can only be the break that ends it, never a glyph.
 */
export function collapse(text: string, whiteSpace: string): string {
  if (isPreserved(whiteSpace)) return text.replace(/[\n\r]/g, "");
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

function upper(s: string, lang: string | null): string {
  try {
    return s.toLocaleUpperCase(lang ?? undefined);
  } catch {
    // Malformed lang attribute: RangeError from the locale lookup.
    return s.toUpperCase();
  }
}

function lower(s: string, lang: string | null): string {
  try {
    return s.toLocaleLowerCase(lang ?? undefined);
  } catch {
    return s.toLowerCase();
  }
}

/**
 * Applies the computed text-transform. uppercase may change the length
 * (ß -> SS); the renderer's textLength absorbs that. capitalize upper-cases
 * the first letter of every whitespace-separated word, so "don't" keeps its t.
 */
export function applyTextTransform(text: string, transform: string, lang: string | null): string {
  if (transform.includes("uppercase")) return upper(text, lang);
  if (transform.includes("lowercase")) return lower(text, lang);
  if (transform.includes("capitalize")) {
    return text.replace(
      /(^|\s)([^\s\p{L}\p{N}]*)(\p{L})/gu,
      (_, sp, lead, ch) => sp + lead + upper(ch, lang),
    );
  }
  return text;
}

// Private Use Area: icon fonts map their glyphs here; the text is meaningless.
const ICON_ONLY = /^[\s\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]*$/u;

/** True for text that consists of icon-font code points (and spaces) only. */
export function isIconText(text: string): boolean {
  return ICON_ONLY.test(text) && /\S/.test(text);
}

export interface LineText {
  text: string;
  line: number;
  /** Authored spaces are content (white-space: pre and friends). */
  preserved?: boolean;
}

/**
 * Removes collapsible spaces the browser does not render where runs meet:
 * at the start and end of a line, and the second of two spaces across a run
 * boundary. Runs left empty are dropped. Geometry is untouched because these
 * spaces have zero width in the layout as well.
 */
export function normalizeLines<T extends LineText>(runs: readonly T[]): T[] {
  const out: T[] = [];
  let lineStart = 0;
  const closeLine = () => {
    // Trailing collapsible spaces of the line, possibly across several runs.
    while (out.length > lineStart) {
      const last = out[out.length - 1] as T;
      if (last.preserved) break;
      const text = last.text.replace(/ +$/, "");
      if (text) {
        out[out.length - 1] = { ...last, text };
        break;
      }
      out.pop();
    }
  };
  for (const [i, run] of runs.entries()) {
    if (i > 0 && run.line !== runs[i - 1]?.line) {
      closeLine();
      lineStart = out.length;
    }
    let text = run.text;
    if (!run.preserved) {
      const prev = out.length > lineStart ? out[out.length - 1] : undefined;
      if (!prev || (!prev.preserved && prev.text.endsWith(" "))) text = text.replace(/^ +/, "");
    }
    if (text) out.push(text === run.text ? run : { ...run, text });
  }
  closeLine();
  return out;
}
