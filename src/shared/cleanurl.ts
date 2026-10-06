// SPDX-License-Identifier: GPL-3.0-or-later
// The page's own address for the copied links: the query without the
// parameters that only say where a visitor came from, and the hash without a
// text directive. Pure.

// Exact names of campaign and click-ID parameters (lower case); a name that
// can also mean something to the page itself (ref, source, si) is not here.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "srsltid",
  "msclkid",
  "yclid",
  "ysclid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "_ga",
  "_gl",
  "mkt_tok",
  "vero_id",
  "ref_src",
]);
const TRACKING_PREFIXES = ["utm_", "mtm_", "pk_", "hsa_", "oly_"];

function isTracking(pair: string): boolean {
  const raw = pair.split("=", 1)[0] ?? "";
  let name: string;
  try {
    name = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    name = raw;
  }
  name = name.toLowerCase();
  return TRACKING_PARAMS.has(name) || TRACKING_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * `href` without a `#:~:text=` directive and, with `removeTrackers`, without
 * tracking parameters; what is left (other parameters in their order and
 * spelling, a plain fragment such as `#section`) stays; an empty `?` goes with
 * the trackers. A non-http(s) or unparsable address comes back as it was.
 */
export function cleanPageUrl(href: string, removeTrackers = true): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  // Split by hand: URLSearchParams would re-encode what the page wrote.
  if (removeTrackers) {
    url.search = url.search
      .slice(1)
      .split("&")
      .filter((pair) => pair !== "" && !isTracking(pair))
      .join("&");
  }
  const directive = url.hash.indexOf(":~:");
  if (directive !== -1) {
    const kept = url.hash.slice(0, directive);
    url.hash = kept === "#" ? "" : kept;
  }
  return url.href;
}
