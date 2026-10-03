// SPDX-License-Identifier: GPL-3.0-or-later
// The folder snapii saves into, written as a path inside Firefox's download
// folder: downloads.download takes a path relative to that folder and rejects
// an absolute one or any `..`, so an extension cannot name another place (the
// "Ask where to save" dialog is the way to pick one). Missing folders are
// created by Firefox. Used by the options page and the popup to check what
// is typed, and by the background to accept only what they would store.
// The rules are what downloads.download answered on Fx157 (macOS): it refuses
// an absolute path ("/x", "~/x"), `..`, a name that starts or ends with a dot
// (".hidden", "a."), the characters below, a no-break or other special space,
// and fails on a name over 255 bytes. It accepts "%" but saves it as "_", so
// the folder would not be the one typed: refused here too.
// Chromium (measured on 153, Linux) refuses all of that as well, and on top
// the names Windows reserves on any system: see CHROMIUM_RESERVED.

import type { BuildTarget } from "./manifest.ts";
import { browserWords, TARGET } from "./target.ts";

/** 80 UTF-16 units are at most 240 UTF-8 bytes, so any one folder name fits in 255. */
export const MAX_FOLDER_LENGTH = 80;

export type FolderProblem = "absolute" | "parent" | "dot" | "unsafe" | "reserved" | "too-long";

/** `folder` is the normalised path: segments joined by "/", "" for the download folder itself. */
export type FolderCheck = { ok: true; folder: string } | { ok: false; reason: FolderProblem };

// A path root: "/", "\", "~", "~/…", a drive letter.
const ABSOLUTE = /^([/\\]|~([/\\]|$)|[A-Za-z]:)/;
// The characters Windows reserves, "%", controls, invisible format characters,
// line separators and every space but the plain one (no-break, em, thin, …): the set
// filename.ts strips from titles, minus the path separators.
const UNSAFE_SEGMENT = /[:*?"<>|%\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

// What Chromium's downloads.download answered "Invalid filename" to: a name
// that starts or ends with "~", a Windows device name with or without
// extensions, the shell's own extensions (a class id among them) and two of
// its file names.
const CHROMIUM_RESERVED =
  /^~|~$|^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(\.|$)|\.(lnk|local|scf|url|\{[0-9a-f-]+\})$|^(desktop\.ini|thumbs\.db)$/i;

export function checkFolder(input: string, target: BuildTarget = TARGET): FolderCheck {
  const text = input.trim();
  if (ABSOLUTE.test(text)) return { ok: false, reason: "absolute" };
  const segments = text
    .split(/[/\\]/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return { ok: false, reason: "parent" };
  if (segments.some((s) => s.startsWith(".") || s.endsWith("."))) return { ok: false, reason: "dot" };
  if (segments.some((s) => UNSAFE_SEGMENT.test(s))) return { ok: false, reason: "unsafe" };
  if (target === "chromium" && segments.some((s) => CHROMIUM_RESERVED.test(s))) {
    return { ok: false, reason: "reserved" };
  }
  const folder = segments.join("/");
  if (folder.length > MAX_FOLDER_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, folder };
}

/** The rule behind the folder setting, as the options page and the error say it. */
export function insideDownloads(target: BuildTarget = TARGET): string {
  const { browser, extensions } = browserWords(target);
  return `${browser} lets ${extensions} save only inside its Downloads folder`;
}

/** Why a folder is refused, for a status line. */
export function describeFolderProblem(reason: FolderProblem, target: BuildTarget = TARGET): string {
  switch (reason) {
    case "absolute":
      return `${insideDownloads(target)}, so no full path. Use a name like snapii or Pages/snapii.`;
    case "parent":
      return 'A folder cannot contain ".." (it would leave the Downloads folder).';
    case "dot":
      return "A folder name cannot start or end with a dot.";
    case "unsafe":
      return 'A folder name cannot contain : * ? " < > | % , control characters or spaces other than the plain one.';
    case "reserved":
      return "This folder name is reserved by the browser (a name such as CON, one that starts or ends with ~, or one that ends in .lnk).";
    case "too-long":
      return `Use at most ${MAX_FOLDER_LENGTH} characters.`;
  }
}
