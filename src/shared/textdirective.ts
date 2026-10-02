// SPDX-License-Identifier: GPL-3.0-or-later
// Text-fragment URLs (`#:~:text=…`) from a generated fragment. Pure, so the
// encoding rules are unit-tested without a page.

/** The shape fragment-generation-utils returns on SUCCESS. */
export interface TextFragment {
  textStart: string;
  textEnd?: string;
  prefix?: string;
  suffix?: string;
}

// '-' and ',' are the directive's own delimiters; encodeURIComponent leaves
// '-' alone, so it is encoded by hand ('&' and ',' are already handled).
const encodePart = (s: string): string => encodeURIComponent(s).replace(/-/g, "%2D");

/** "text=[prefix-,]start[,end][,-suffix]", every part percent-encoded. */
export function serializeTextDirective(f: TextFragment): string {
  const parts: string[] = [];
  if (f.prefix) parts.push(`${encodePart(f.prefix)}-`);
  parts.push(encodePart(f.textStart));
  if (f.textEnd) parts.push(encodePart(f.textEnd));
  if (f.suffix) parts.push(`-${encodePart(f.suffix)}`);
  return `text=${parts.join(",")}`;
}

/**
 * url with directive as its fragment directive. An existing fragment stays
 * (the page may need it to show the right view); a previous directive is
 * replaced, since two would compete for the highlight.
 */
export function withTextDirective(url: string, directive: string): string {
  const hashAt = url.indexOf("#");
  if (hashAt < 0) return `${url}#:~:${directive}`;
  const hash = url.slice(hashAt + 1);
  const directiveAt = hash.indexOf(":~:");
  const kept = directiveAt < 0 ? hash : hash.slice(0, directiveAt);
  return `${url.slice(0, hashAt)}#${kept}:~:${directive}`;
}
