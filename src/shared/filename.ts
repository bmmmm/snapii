// SPDX-License-Identifier: GPL-3.0-or-later
// Download file name: `snapii <title or host> <YYYY-MM-DD HH-MM-SS>.svg`.
// The title comes from the page, so everything a file system or
// downloads.download() could read as a path or reject is removed.

import type { PageMeta } from "./types.ts";

export const MAX_FILENAME_LENGTH = 120;
const PREFIX = "snapii";
const EXTENSION = ".svg";

// Path and Windows-reserved characters, control characters (C0, DEL, C1),
// invisible format characters (bidi overrides could disguise the extension)
// and line/paragraph separators.
const UNSAFE = /[/\\:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function clean(text: string): string {
  return text.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim();
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const two = (n: number): string => String(n).padStart(2, "0");

/** Local time of `iso` as `YYYY-MM-DD HH-MM-SS`; "" when it is not a date. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return `${date} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

/** Never empty, at most MAX_FILENAME_LENGTH characters including `.svg`. */
export function makeFilename(page: PageMeta): string {
  const time = stamp(page.capturedAt);
  const fixed = PREFIX.length + EXTENSION.length + 1 + (time ? time.length + 1 : 0);
  const name = cut(clean(page.title) || clean(host(page.url)), MAX_FILENAME_LENGTH - fixed);
  return `${[PREFIX, name, time].filter((part) => part !== "").join(" ")}${EXTENSION}`;
}
