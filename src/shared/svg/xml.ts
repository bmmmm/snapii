// SPDX-License-Identifier: GPL-3.0-or-later
// XML 1.0 serialisation helpers. The renderer builds the document by string
// concatenation, so every value that originates on a page goes through one of
// these before it reaches the output.

// Everything outside the XML 1.0 `Char` production. The `u` flag makes the
// class match whole code points: a valid surrogate pair is kept, an unpaired
// surrogate (no `Char` form) is removed. U+FFFE/U+FFFF are invalid too.
const INVALID_XML_CHARS = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/** Escape character data: `& < >`; drop characters XML 1.0 cannot carry. */
export function xmlText(s: string): string {
  return s.replace(INVALID_XML_CHARS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * As {@link xmlText}, plus `"` — for double-quoted attribute values. Tab,
 * newline and carriage return become references: a parser normalizes the
 * literal ones to spaces (XML 1.0 § 3.3.3).
 */
export function xmlAttr(s: string): string {
  return xmlText(s)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/**
 * Format a number for an attribute: at most two decimals, no trailing zeros,
 * never "-0". Non-finite input becomes "0" so a single bad measurement cannot
 * make the whole document invalid (the capture itself is worth more than one
 * misplaced invisible run).
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // toFixed rounds from the exact binary value; Number() drops the trailing
  // zeros, and String(-0) is already "0" (toFixed(-0.001) is "-0.00").
  return String(Number(n.toFixed(2)));
}
