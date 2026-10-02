// SPDX-License-Identifier: GPL-3.0-or-later
// `drive timing`: bundles the extension's own extraction and text-fragment
// code (src/, via esbuild) into a script for Marionette's content sandbox,
// an X-ray sandbox over the page like the content script's, and times
// textFragmentURL for the overlay's current selection. The range is rebuilt
// the way session.ts builds it: the picked element's contents, or for a drag
// the first to the last collected text run that scrolls with the page.
import { build } from "esbuild";

const ENTRY = `
import { collectTextRunsDetailed } from "./src/content/extract/collect.ts";
import { anchorSources, textFragmentURL } from "./src/content/fragment.ts";
import { composedParent, docRectOf } from "./src/content/overlay/pick.ts";

const near = (a, b) =>
  Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
  Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;

/** The element whose box the overlay selected (same rule as the overlay: docRectOf). */
function pickedElement(sel) {
  const cx = Math.min(Math.max(sel.x - scrollX + sel.width / 2, 0), innerWidth - 1);
  const cy = Math.min(Math.max(sel.y - scrollY + sel.height / 2, 0), innerHeight - 1);
  for (const hit of document.elementsFromPoint(cx, cy)) {
    for (let e = hit; e; e = composedParent(e)) {
      if (e.localName.startsWith("snapii-")) break;
      if (near(docRectOf(e), sel)) return e;
    }
  }
  return null;
}

function isBefore(a, aOffset, b, bOffset) {
  const at = document.createRange();
  at.setStart(a, aOffset);
  return at.comparePoint(b, bOffset) > 0;
}

/** session.ts fragmentFor: selectionRange, drag branch, over anchorSources. */
function runsRange(all) {
  const sources = anchorSources(all);
  let first;
  let last;
  for (const s of sources) {
    if (s.node.getRootNode() !== document) continue;
    if (!first || isBefore(s.node, s.start, first.node, first.start)) first = s;
    if (!last || isBefore(last.node, last.end, s.node, s.end)) last = s;
  }
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}

export async function run(sel, mode, runs) {
  const host = document.querySelector("snapii-overlay") ?? undefined;
  const t0 = performance.now();
  const { runs: textRuns, sources, stats } = await collectTextRunsDetailed(document, sel, { skip: host });
  const collectMs = performance.now() - t0;
  let element = null;
  let range = null;
  if (mode === "element") {
    const el = pickedElement(sel);
    if (el) {
      element = el.localName + (el.id ? "#" + el.id : "");
      range = document.createRange();
      range.selectNodeContents(el);
    }
  }
  if (!range) range = runsRange(sources);
  if (!range) return { mode, element, collectMs, textRuns: textRuns.length, status: "INVALID_SELECTION (no range)" };
  const ms = [];
  let result = null;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = textFragmentURL(range, location.href);
    ms.push(Math.round((performance.now() - t) * 10) / 10);
  }
  return {
    mode,
    element,
    rangeFrom: element ? "element" : "runs",
    collectMs: Math.round(collectMs * 10) / 10,
    textNodes: stats.textNodes,
    textRuns: textRuns.length,
    fragmentMs: ms,
    status: result.status,
    url: result.url,
    note: "fragment.ts gives up after GENERATION_TIMEOUT_MS (status TIMEOUT)",
  };
}
`;

/** A function body for WebDriver:ExecuteScript: (selection, mode, runs) → timing report. */
export async function timingScript(root) {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: "ts", sourcefile: "drive-timing.ts" },
    bundle: true,
    format: "iife",
    globalName: "__snapiiTiming",
    target: "firefox140",
    write: false,
    logLevel: "silent",
  });
  return `${out.outputFiles[0].text}\nreturn __snapiiTiming.run(arguments[0], arguments[1], arguments[2]);`;
}
