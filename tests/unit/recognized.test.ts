// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { runsToPlainText } from "../../src/shared/plaintext.ts";
import { readingExtent, recognizedIn, withRecognized } from "../../src/shared/recognized.ts";
import type { DocRect, TextRun } from "../../src/shared/types.ts";

/** A run 20 px high whose box is `x`, `top`, `width`. */
const run = (text: string, x: number, top: number, width: number, line: number, block: number): TextRun => ({
  text,
  x,
  y: top + 16,
  top,
  width,
  height: 20,
  fontFamily: "sans-serif",
  fontSize: 20,
  fontWeight: 400,
  fontStyle: "normal",
  color: "#000",
  lang: null,
  dir: "ltr",
  href: null,
  line,
  block,
});

const texts = (runs: readonly TextRun[]): string[] => runs.map((r) => r.text);

test("readingExtent: sideways without limit, up and down by the region's height", () => {
  const region = { x: 100, y: 500, width: 200, height: 40 };
  const extent = readingExtent(region, null);
  assert.deepEqual([extent?.y, extent?.height], [460, 120]);
  // An image far wider than the region is read as wide as it is.
  const banner = { x: -300, y: 400, width: 5000, height: 300 };
  assert.ok(extent && extent.x <= banner.x && extent.x + extent.width >= banner.x + banner.width);
});

test("readingExtent: cut to the viewport where only that can be captured", () => {
  const region = { x: 100, y: 500, width: 200, height: 40 };
  const viewport = { x: 0, y: 480, width: 1280, height: 715 };
  assert.deepEqual(readingExtent(region, viewport), { x: 0, y: 480, width: 1280, height: 100 });
  // A selection scrolled out of sight shows no image that could be captured.
  assert.equal(readingExtent(region, { x: 0, y: 2000, width: 1280, height: 715 }), null);
});

// One recognised line, "The quick brown": 30, 50 and 50 px wide at x 10, 50 and 110.
const LINE = [
  run("The ", 10, 100, 30, 0, 0),
  run("quick ", 50, 100, 50, 0, 0),
  run("brown", 110, 100, 50, 0, 0),
];

test("recognizedIn: a word the region's edge runs through is taken whole, one outside is not", () => {
  // The left edge cuts "quick" (20 px of it inside), the right one "brown" (30 px).
  const region = { x: 80, y: 90, width: 60, height: 40 };
  const taken = recognizedIn(LINE, region);
  assert.deepEqual(texts(taken), ["quick ", "brown"]);
  assert.equal(runsToPlainText(taken), "quick brown");
  // The boxes stay the words' own: they say where the text stands.
  assert.deepEqual(
    taken.map((r) => [r.x, r.width]),
    [
      [50, 50],
      [110, 50],
    ],
  );
});

test("recognizedIn: a word counts with half its height in the region", () => {
  const half = recognizedIn(LINE, { x: 0, y: 110, width: 200, height: 100 });
  assert.equal(runsToPlainText(half), "The quick brown");
  // 8 of 20 px: the line above the selection is not part of it.
  assert.deepEqual(recognizedIn(LINE, { x: 0, y: 112, width: 200, height: 100 }), []);
  assert.deepEqual(recognizedIn(LINE, { x: 0, y: 0, width: 200, height: 108 }), []);
});

test("recognizedIn: what is left of a line is spaced anew, lines stay apart", () => {
  const two = [...LINE, run("fox ", 10, 130, 30, 1, 0), run("jumps", 50, 130, 50, 1, 0)];
  // Only the first word of each line: the space after it goes.
  const taken = recognizedIn(two, { x: 0, y: 90, width: 45, height: 70 });
  assert.deepEqual(texts(taken), ["The", "fox"]);
  assert.equal(runsToPlainText(taken), "The\nfox");
  const wider = recognizedIn(two, { x: 0, y: 90, width: 70, height: 70 });
  assert.deepEqual(texts(wider), ["The ", "quick", "fox ", "jumps"]);
  assert.equal(runsToPlainText(wider), "The quick\nfox jumps");
});

test("recognizedIn: nothing recognised, nothing taken; a run of spaces is no word", () => {
  const region = { x: 0, y: 0, width: 500, height: 500 };
  assert.deepEqual(recognizedIn([], region), []);
  assert.deepEqual(texts(recognizedIn([run("  ", 10, 100, 30, 0, 0), LINE[2] as TextRun], region)), [
    "brown",
  ]);
});

/** A DOM line 300 px wide at `top`. */
const domLine = (text: string, top: number, line: number, block: number, x = 0): TextRun =>
  run(text, x, top, 300, line, block);

/** An image's recognised line at `top`, as recognizedIn leaves it. */
const imageLine = (text: string, top: number, line: number, block: number, x = 0): TextRun[] =>
  recognizedIn(
    text.split(" ").map((w, i) => run(`${w} `, x + i * 60, top, 50, line, block)),
    { x: -1e6, y: -1e6, width: 2e6, height: 2e6 },
  );

test("withRecognized: nothing recognised leaves the DOM runs as they are", () => {
  const dom = [domLine("Only text.", 0, 0, 0)];
  assert.equal(withRecognized(dom, []), dom);
});

test("withRecognized: an image between two paragraphs is a block of its own between them", () => {
  const dom = [domLine("Before the picture.", 0, 0, 0), domLine("After the picture.", 200, 1, 1)];
  const text = withRecognized(dom, imageLine("Summer Sale", 90, 0, 0));
  assert.equal(runsToPlainText(text), "Before the picture.\n\nSummer Sale\n\nAfter the picture.");
});

test("withRecognized: above all text it comes first, below it last, alone it is the text", () => {
  const dom = [domLine("A paragraph", 100, 0, 0), domLine("of two lines.", 120, 1, 0)];
  assert.equal(
    runsToPlainText(withRecognized(dom, imageLine("Headline", 20, 0, 0))),
    "Headline\n\nA paragraph\nof two lines.",
  );
  assert.equal(
    runsToPlainText(withRecognized(dom, imageLine("Caption", 300, 0, 0))),
    "A paragraph\nof two lines.\n\nCaption",
  );
  assert.equal(runsToPlainText(withRecognized([], imageLine("Just this", 300, 0, 0))), "Just this");
});

test("withRecognized: an image's lines stay lines, two images stay two blocks in their order", () => {
  const dom = [domLine("Intro.", 0, 0, 0)];
  const first = [...imageLine("Line one", 50, 0, 0), ...imageLine("line two", 80, 1, 0)];
  const second = imageLine("Other image", 200, 2, 1);
  assert.equal(
    runsToPlainText(withRecognized(dom, [...first, ...second])),
    "Intro.\n\nLine one\nline two\n\nOther image",
  );
});

test("withRecognized: a picture beside a paragraph follows it and does not split it", () => {
  // Four lines flow past a picture on their right, whose text stands beside lines two and three.
  const dom = [0, 1, 2, 3].map((i) => domLine(`Line ${i + 1}`, i * 20, i, 0));
  const next = domLine("Next paragraph.", 120, 4, 1);
  const text = withRecognized([...dom, next], imageLine("In the picture", 25, 0, 0, 320));
  assert.equal(runsToPlainText(text), "Line 1\nLine 2\nLine 3\nLine 4\n\nIn the picture\n\nNext paragraph.");
});

test("withRecognized: a picture left of the text it stands beside comes before it", () => {
  const dom = [domLine("Beside the picture.", 40, 0, 0, 400), domLine("Below it.", 200, 1, 1, 0)];
  const text = withRecognized(dom, imageLine("Logo", 40, 0, 0, 0));
  assert.equal(runsToPlainText(text), "Logo\n\nBeside the picture.\n\nBelow it.");
});

test("withRecognized: the DOM runs keep their numbers, the images' never collide with them", () => {
  const dom = [
    run("Two ", 0, 0, 40, 0, 0),
    run("runs.", 40, 0, 50, 0, 0),
    domLine("Second block.", 200, 1, 1),
  ];
  // The pass numbers its lines and blocks from 0 as well.
  const text = withRecognized(dom, imageLine("Picture", 90, 0, 0));
  assert.deepEqual(
    text.filter((r) => r.line >= 0).map((r) => [r.text, r.line, r.block]),
    dom.map((r) => [r.text, r.line, r.block]),
  );
  const fromImage = text.filter((r) => r.line < 0);
  assert.deepEqual(texts(fromImage), ["Picture"]);
  assert.ok(fromImage.every((r) => r.block < 0));
  assert.equal(runsToPlainText(text), "Two runs.\n\nPicture\n\nSecond block.");
});

test("withRecognized: far down a long page the order is the same", () => {
  const dy = 40_000;
  const dom = [domLine("Before.", dy, 0, 0), domLine("After.", dy + 200, 1, 1)];
  const region: DocRect = { x: 0, y: dy + 80, width: 400, height: 40 };
  const words = recognizedIn(
    [run("Deep ", 10, dy + 90, 50, 0, 0), run("down", 70, dy + 90, 50, 0, 0)],
    region,
  );
  assert.equal(runsToPlainText(withRecognized(dom, words)), "Before.\n\nDeep down\n\nAfter.");
});
