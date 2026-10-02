// SPDX-License-Identifier: GPL-3.0-or-later
// Decides which URL (if any) a captured element links to. Pure: the content
// script reads the attributes, this decides.

export interface LinkCandidate {
  /** Local name of the element, e.g. "a", "area", "button". */
  tag: string;
  /** href attribute (xlink:href for SVG links); for buttons the formaction. */
  href: string | null;
  role: string | null;
  /** The element's base URL (document.baseURI, honours <base>). */
  baseURL: string;
  /** URL of the captured page, to recognise same-page anchors. */
  pageURL: string;
  /** href came from a button's formaction attribute. */
  formaction?: boolean;
}

// A link in a saved file is only worth keeping if it still leads somewhere
// when opened from disk: no script, no page-local blobs, no local files.
const KEPT_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function samePage(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
}

/**
 * Only real links count: a and area with an href (a[role=button][href] is
 * still a link). Buttons, [role=button] without href, formaction and
 * data-href yield null because a link cannot reproduce a form submission or
 * a script handler. Same-page anchors are dropped unless they carry a text
 * directive, which makes them meaningful outside the page.
 */
export function linkFor(c: LinkCandidate | null): string | null {
  if (!c) return null;
  const tag = c.tag.toLowerCase();
  if (tag !== "a" && tag !== "area") return null;
  const raw = c.href?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, c.baseURL);
  } catch {
    return null;
  }
  if (!KEPT_SCHEMES.has(url.protocol)) return null;
  if (url.protocol !== "mailto:" && !url.hash.includes(":~:text=")) {
    try {
      if (samePage(url, new URL(c.pageURL))) return null;
    } catch {
      // Unparsable page URL: nothing to compare against, keep the link.
    }
  }
  return url.href;
}
