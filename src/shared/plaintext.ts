// SPDX-License-Identifier: GPL-3.0-or-later
// "Copy text" as text/plain: the visible lines exactly as collected, so the
// plain text matches what the capture shows (text-transform included).
import type { TextRun } from "./types.ts";

/**
 * Runs of one visual line are joined without separator (normalizeLines has
 * already placed the spaces between them); a new line starts a new text
 * line, a new block an empty line in between.
 */
export function runsToPlainText(runs: readonly TextRun[]): string {
  let out = "";
  let prev: TextRun | undefined;
  for (const run of runs) {
    if (prev && run.line !== prev.line) out += run.block === prev.block ? "\n" : "\n\n";
    out += run.text;
    prev = run;
  }
  return out;
}
