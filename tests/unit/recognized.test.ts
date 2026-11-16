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

test("readingExtent: an image is read whole, wherever in it the selection lies", () => {
  const image = { x: 40, y: 40, width: 420, height: 150 };
  // The same line picked 2 px higher and 2 px lower: nothing of the selection decides what is read.
  for (const y of [62, 64, 66]) {
    assert.deepEqual(readingExtent(image, { x: 127, y, width: 131, height: 20 }, null, 2), image);
  }
});

test("readingExtent: an image too large for a crop at full resolution is read in a band, sideways without limit, up and down by the region's height", () => {
  const region = { x: 100, y: 100, width: 200, height: 40 };
  // 6 000 000 crop px at 2 px per CSS px are 1 500 000 CSS px²: a banner of just that is read whole.
  const banner = { x: -300, y: 0, width: 5000, height: 300 };
  assert.deepEqual(readingExtent(banner, region, null, 1), banner);
  // One CSS px higher it is not, and still as wide as it is.
  assert.deepEqual(readingExtent({ ...banner, height: 301 }, region, null, 1), {
    x: -300,
    y: 60,
    width: 5000,
    height: 120,
  });
  // The capture's own resolution counts where it is higher than that of the crop.
  const photo = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(readingExtent(photo, region, null, 2), photo);
  assert.deepEqual(readingExtent(photo, region, null, 3), { x: 0, y: 60, width: 1000, height: 120 });
});

test("readingExtent: cut to the viewport where only that can be captured", () => {
  const region = { x: 100, y: 500, width: 200, height: 40 };
  const viewport = { x: 0, y: 480, width: 1280, height: 715 };
  // What the viewport shows of the image, whole; of one too large, the band in it.
  const image = { x: 50, y: 300, width: 600, height: 400 };
  assert.deepEqual(readingExtent(image, region, viewport, 2), { x: 50, y: 480, width: 600, height: 220 });
  const background = { x: 0, y: 0, width: 1280, height: 9000 };
  assert.deepEqual(readingExtent(background, region, viewport, 3), {
    x: 0,
    y: 480,
    width: 1280,
    height: 100,
  });
  // A selection scrolled out of sight shows no image that could be captured.
  assert.equal(readingExtent(image, region, { x: 0, y: 2000, width: 1280, height: 715 }, 2), null);
  // Nor one whose visible part no word of the selection can stand in: it starts below the band (460–580).
  assert.equal(readingExtent(image, region, { x: 0, y: 600, width: 1280, height: 715 }, 2), null);
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

/** An image 300 px wide at `x`, from `top` to `bottom`. */
const picture = (top: number, bottom: number, x = 0): DocRect => ({
  x,
  y: top,
  width: 300,
  height: bottom - top,
});

test("withRecognized: nothing recognised leaves the DOM runs as they are", () => {
  const dom = [domLine("Only text.", 0, 0, 0)];
  assert.equal(withRecognized(dom, [], []), dom);
});

test("withRecognized: an image between two paragraphs is a block of its own between them", () => {
  const dom = [domLine("Before the picture.", 0, 0, 0), domLine("After the picture.", 200, 1, 1)];
  const text = withRecognized(dom, imageLine("Summer Sale", 90, 0, 0), [picture(40, 180)]);
  assert.equal(runsToPlainText(text), "Before the picture.\n\nSummer Sale\n\nAfter the picture.");
});

test("withRecognized: above all text it comes first, below it last, alone it is the text", () => {
  const dom = [domLine("A paragraph", 100, 0, 0), domLine("of two lines.", 120, 1, 0)];
  assert.equal(
    runsToPlainText(withRecognized(dom, imageLine("Headline", 20, 0, 0), [picture(0, 80)])),
    "Headline\n\nA paragraph\nof two lines.",
  );
  assert.equal(
    runsToPlainText(withRecognized(dom, imageLine("Caption", 300, 0, 0), [picture(160, 340)])),
    "A paragraph\nof two lines.\n\nCaption",
  );
  assert.equal(
    runsToPlainText(withRecognized([], imageLine("Just this", 300, 0, 0), [picture(160, 340)])),
    "Just this",
  );
});

test("withRecognized: an image's lines stay lines, two images stay two blocks in their order", () => {
  const dom = [domLine("Intro.", 0, 0, 0)];
  const first = [...imageLine("Line one", 50, 0, 0), ...imageLine("line two", 80, 1, 0)];
  const second = imageLine("Other image", 200, 2, 1);
  assert.equal(
    runsToPlainText(withRecognized(dom, [...first, ...second], [picture(40, 110), picture(180, 240)])),
    "Intro.\n\nLine one\nline two\n\nOther image",
  );
});

test("withRecognized: a picture beside a paragraph follows it and does not split it", () => {
  // Four lines flow past a picture on their right, whose text stands beside lines two and three.
  const dom = [0, 1, 2, 3].map((i) => domLine(`Line ${i + 1}`, i * 20, i, 0));
  const next = domLine("Next paragraph.", 120, 4, 1);
  const text = withRecognized([...dom, next], imageLine("In the picture", 25, 0, 0, 320), [
    picture(0, 70, 320),
  ]);
  assert.equal(runsToPlainText(text), "Line 1\nLine 2\nLine 3\nLine 4\n\nIn the picture\n\nNext paragraph.");
});

test("withRecognized: a picture left of the text it stands beside comes before it", () => {
  const dom = [domLine("Beside the picture.", 40, 0, 0, 400), domLine("Below it.", 200, 1, 1, 0)];
  const text = withRecognized(dom, imageLine("Logo", 40, 0, 0, 0), [picture(20, 80)]);
  assert.equal(runsToPlainText(text), "Logo\n\nBeside the picture.\n\nBelow it.");
});

test("withRecognized: a paragraph of two lines beside a picture stays whole when the picture's words are level with the gap between its lines", () => {
  // The picture's one line of words (62–82) starts below the middle of the paragraph's first line (50)
  // and above that of its second (74): by the words' own box it would stand between the two.
  const paragraph = (x: number): TextRun[] => [
    domLine("A paragraph", 40, 0, 0, x),
    domLine("of two lines.", 64, 1, 0, x),
  ];
  const left = withRecognized(paragraph(320), imageLine("In the picture", 62, 0, 0, 20), [picture(0, 300)]);
  assert.equal(runsToPlainText(left), "In the picture\n\nA paragraph\nof two lines.");
  const right = withRecognized(paragraph(0), imageLine("In the picture", 62, 0, 0, 340), [
    picture(0, 300, 320),
  ]);
  assert.equal(runsToPlainText(right), "A paragraph\nof two lines.\n\nIn the picture");
});

test("withRecognized: a picture that starts beside a paragraph's third line and ends beside its fourth does not split it", () => {
  // Lines 1 and 2 stand above the picture (50–90), 3 and 4 beside it, 5 below.
  const dom = [0, 1, 2, 3, 4].map((i) => domLine(`Line ${i + 1}`, i * 20, i, 0, 320));
  const text = withRecognized(dom, imageLine("In the picture", 60, 0, 0, 20), [picture(50, 90)]);
  assert.equal(runsToPlainText(text), "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n\nIn the picture");
});

test("withRecognized: a picture in the flow of a block, a line above it and a line below, stands between the two", () => {
  const dom = [domLine("Look at this:", 0, 0, 0), domLine("What do you think?", 140, 1, 0)];
  const text = withRecognized(dom, imageLine("In the picture", 60, 0, 0), [picture(30, 130)]);
  assert.equal(runsToPlainText(text), "Look at this:\n\nIn the picture\n\nWhat do you think?");
});

test("withRecognized: the DOM runs keep their numbers, the images' never collide with them", () => {
  const dom = [
    run("Two ", 0, 0, 40, 0, 0),
    run("runs.", 40, 0, 50, 0, 0),
    domLine("Second block.", 200, 1, 1),
  ];
  // The pass numbers its lines and blocks from 0 as well.
  const text = withRecognized(dom, imageLine("Picture", 90, 0, 0), [picture(40, 180)]);
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
  assert.equal(
    runsToPlainText(withRecognized(dom, words, [picture(dy + 40, dy + 180)])),
    "Before.\n\nDeep down\n\nAfter.",
  );
});
