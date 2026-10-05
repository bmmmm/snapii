# snapii — details

The short version is in the [README](../README.md).

## What is in the file

- **Raster.** The selected region as one PNG or JPEG `<image>` (embedded as a
  data URL), sized in CSS pixels, captured at the screen's device-pixel
  ratio times the page zoom. Very large regions are captured in several
  bands and the resolution is lowered to stay under 100 megapixels in total.
- **Text layer.** Invisible text (`fill-opacity="0"`, so it still takes part
  in selection and hit-testing), one `<text>` element per run of text, with
  the page's font, size, weight and style, and `textLength` set to the width
  measured in the page, so a viewer with different font metrics does not move
  the hit area. Lines are separated so that copied text does not run
  together.
- **Links.** Text and image links are wrapped in `<a href>` (http, https and
  mailto only; `javascript:`, same-page anchors and form buttons are not
  links). Images with `alt` text, and links without text of their own (icon
  and logo links), get a transparent rectangle (clickable if it is a link)
  that carries the `alt` text as a tooltip.
- **Metadata.** `<title>` and `<desc>`, Dublin Core in RDF (`dc:title`,
  `dc:source`, `dc:relation`, `dc:date`, `dc:format`, `dc:language`) and the
  complete capture record as JSON in `<snapii:capture>` (URL, time,
  viewport, scroll, device-pixel ratio, zoom, scale, selection, tile sizes,
  number of text runs, skipped frames).
  `dc:source` is the text-fragment URL of the selection's first paragraph
  (it opens the page, scrolls there and highlights it; fixed headers and
  sticky bars are skipped as anchors) or the plain URL when there is none;
  `dc:relation` is always the plain URL.

## Vector output (beta)

With **Output: Shapes and text (beta)** in the settings page, Save SVG writes
the region as SVG shapes, embedded pictures and visible text instead of one
picture. Raster stays the default and its files are unchanged.

- **Shapes.** Background colours and solid borders as rectangles and paths
  (rounded corners where the border has one colour; sides of their own
  colours only on square corners), dashed, dotted and double borders of
  square boxes as lines laid out as the browser lays them out, solid
  outlines (drawn square), linear
  gradients as `<linearGradient>` (one per box, at the box's own size and
  place), outer box shadows as blurred shapes, stacked as CSS paints them
  (CSS 2.1 Appendix E, approximated); overflow clips as `<clipPath>`.
- **Pictures.** `<img>` and `<canvas>` as embedded `<image>`s (pixels, not
  shapes) of the part that shows: cut to the box, `object-fit`, the clips and
  the selection, rounded corners left transparent, at the screen's density.
  They are read from the page's own elements: nothing is downloaded.
- **Text.** Every run is visible text in the page's colour, font family (with
  `sans-serif` appended when the page names no generic family), size, weight
  and style; `textLength` pins its width as in raster output. Underlines,
  overlines and line-throughs are drawn by the viewer from the run's font
  (SVG `text-decoration`), in their colour, style and thickness, where all
  the text a line reaches is in the font and on the baseline of the box
  that declares it. A run that a pixel patch shows, or that an opaque shape painted
  later covers, stays invisible but selectable. Links are as in raster
  output.
- **Patches.** What cannot be drawn so is a picture of the page, cut from a
  screenshot as in raster output. The record counts the patched elements
  per reason:
  - `transform`: transforms (`transform`, `rotate`, `scale`, `translate`);
  - `effect`: filters, `backdrop-filter`, blend modes, masks, an element's
    own `clip-path` or `clip`;
  - `box-shadow`: inset shadows, shadows on an inline box across lines, and
    shadows whose colour this cannot read;
  - `gradient`: radial, conic and repeating gradients, and linear ones with
    several layers, colour hints, colours given in another colour space than
    `rgb()` (`oklch()`, `lab()`, `color()`), a size or position of their own,
    fixed or local, blended, clipped to the text, across an inline box's
    lines, painted beyond their `background-origin` box other than under
    opaque borders, or on a frame's root or body;
  - `background-image`: images in `url()` (clipped to the text too);
  - `border`: groove, ridge, inset and outset borders, dashed, dotted and
    double ones with rounded corners or inside a collapsed table,
    border images, outlines other than solid, and rounded corners whose
    sides differ in colour;
  - `text-effect`: text shadows, text strokes and a background colour clipped
    to the text; decorations SVG cannot draw: an underline moved by
    `text-underline-offset` or `text-underline-position`, a thickness in %, a
    colour this cannot read, one inside another of a different colour,
    style or thickness, one over text of another font, size or baseline
    (a link with a `<code>` or `<sup>`: the browser places one line for the
    whole box), and the boxes below such a decoration;
  - `color`: a colour this cannot read;
  - `pseudo`: a `::before` or `::after` with content (text, counters,
    images) or a box of its own, a styled `::first-letter` or `::first-line`;
  - `marker`: list markers;
  - `icon-font`, `vertical` (vertical text), `form` (form controls), `media`
    (video, audio, embed, object), `frame` (frames that cannot be read:
    cross-origin or sandboxed), `svg` (inline SVG), `math` (MathML);
  - `image` and `canvas`: images from another origin, still loading or
    broken; canvases that read back empty (WebGL) or hold another origin's
    pixels; either positioned in a form this does not read (`calc()`);
  - `budget`: pictures over the limits below; also the whole selection on a
    page too large, too deep or too slow to read (over 60,000 elements,
    150,000 drawing operations, 24 nested transparent groups or 5 seconds),
    and patches merged into bands of the region when more than 2,000 remain
    after overlapping ones are merged (over 4,000 go to bands at once).

  A background image or gradient (any kind) on `html`, or on `body` when
  `html` has no background of its own, paints the whole page and makes the
  **whole selection one patch**; so does any of the reasons above on `html`
  or `body` itself.
- **Record.** The JSON adds `output: "vector"` and `scene`: the number of
  drawing operations, of patches, their area and the patched elements per
  reason. It has no `ocr`. `tiles` are the patches (a large one split into
  tiles as in raster output), not the whole region.

Limits:

- **Not drawn**, and outside patches not in the file at all, among others:
  the colour of visited links (the browser hides it from extensions, so
  they come out in the link colour), a decoration of `::first-line`, the
  `…` of `text-overflow: ellipsis`, scrollbars and column rules.
- A decoration takes the viewer's own way of skipping descenders
  (`text-decoration-skip-ink` is not carried over), and breaks between the
  glyphs where the viewer spaces them out to the run's width (a narrower
  fallback font). The page snaps a line to whole device pixels and the
  viewer does not: where a baseline falls between two, the line comes out
  softer, spread over two pixel rows (always about a row off in Chromium,
  and in Firefox on Linux).
  Chromium also draws a thickness of 0 unlike the page.
- The viewer needs the page's fonts. Web fonts are not embedded, so a viewer
  without them shows a fallback font; each run keeps its place and width.
- Text is drawn above the shapes; text under a half-transparent box or
  shadow is not dimmed as on the page.
- Dashed and dotted borders follow each browser's own layout, as far as it
  was measured. Chromium's dashes come close to the page (under 1 % of the
  border pixels off in a review over some 180 boxes), its dots within a
  pixel (a fifth of their pixels differ, mostly by a 1 px shift or
  antialiasing); its round dots of 3 px are spaced evenly where Chromium
  keeps them two widths apart. Firefox's
  layout is fitted to boxes with four equal sides: on a single side, a
  small box or sides of unequal neighbours its dashes and dots can sit
  elsewhere and differ in number (about a fifth of the border pixels off
  in the same review). Sides overlap at the corners: of different colours
  instead of meeting diagonally, of a see-through colour darker there.
- No OCR in vector output: OCR reads the captured pixels, and a vector
  capture has only the patches.
- In Chromium a selection whose patches reach beyond the visible part of the
  page is refused with a toast ("Parts of this selection that are saved as
  pixels are outside the visible area…"); shapes and text may lie anywhere.
- Pictures beyond about 16.8 million pixels or 32 Mi characters of data URL
  (about 24 MiB of encoded image) together, or longer than 65,535 device px,
  become patches.

How close it comes: rendered back in the same browser at device-pixel ratio
1 (`tests/layout/vector.spec.ts` in Playwright's Firefox and Chromium on
Linux, CI run of 2026-10-05), the vector SVGs of the 17 test pages
(`tests/fixtures/vector-*.html`) differ from the page in under 0.3 % of the
pixels on 15 of them in Firefox and 16 in Chromium; the others are a page of
inline boxes (1.7 %, Firefox) and the page with half-transparent groups,
whose text lies above the group instead of in it (3.7 % in Firefox, 3.5 % in
Chromium). Two of these pages are wholly patches by design. On five real
pages in Firefox (a Wikipedia article, an MDN page, a GitHub page, a blog
post and a shop page) 71–98 % of the area came out as shapes, measured
before pictures, gradients and shadows were drawn instead of patched.

File size, measured as in [File size](#file-size) below
(`tests/glue/sizes.test.mjs`, its second test; full viewport, DPR 2, Firefox
157): the text page is 24,453 B as vector against 862,060 B as a
PNG picture; the page with the photo is 4,266,390 B (the photo as PNG) or
678,451 B (JPEG 92 %) against 4,632,889 B and 1,221,023 B as raster. The
photo itself is stored at the screen's density either way; the text and the
flat areas are what gets smaller.

## Text in images (OCR)

With "Recognize text in images (OCR)" on, **Save SVG** in raster output also
reads the text inside the images of the selection: `<img>`/`<picture>`, `<canvas>`, SVG
`<image>` and boxes with a CSS `background-image` (visible part only, images
smaller than 24×12 CSS px skipped). It runs Tesseract (tesseract.js 7.0.0,
German and English models) in the extension's background page; engine and
models ship in the add-on (8.3 MB of the unpacked add-on), nothing is downloaded.

- The words go into the same invisible text layer, in a group of their own
  (`<g id="ocr">`), one `<text>` per word with its measured width.
- **DOM text wins:** a recognised word that lies on text the page has as
  text (a caption over a photo) is dropped, so it is not in the file twice.
  Words Tesseract is less than 60 % sure of are dropped as well.
- **Noise is dropped:** a "word" without any letter or digit (`—`, `=`, `®`,
  `@`, read from lines, ticks and textures) never goes in, nor does a single
  character alone on its line (a stroke read as `A` or `N`). A single
  character among other words stays (`a`, `5 km`). On 12 images of
  Wikipedia's "Infographic" article this removed 15 of 110 words; two of them
  (`2`, `6`) were probably real axis labels.
- At most 24 image areas per save are recognised; the rest are skipped.
- The metadata JSON records the pass: `ocr: {engine, langs, areas,
  recognized, truncated, words, ms, status}`. `areas` is the number of image
  areas the pass set out to read (at most 24), `recognized` how many of them
  Tesseract finished, `truncated` whether the selection had more than 24.
  `status` is `ok`, `disabled`, `no-areas`, `timeout` or `failed`. The whole
  pass has 20 seconds; after that the file is saved without OCR text (status
  `timeout`, `recognized` says how far it got).
- **The page stays usable meanwhile:** as soon as the background has the
  last tile, the overlay closes, the page takes clicks again (your text
  selection is back) and a toast says "Saving… (recognizing text)"; "Saved
  …" or an error follows when the file is written. A new capture can be
  started right away. On the glue-test page the page was given back 61–78 ms
  after Enter (Firefox 157, four runs), while the whole save took about
  0.75 s.
- Cost: on the glue-test page (Firefox 157, macOS, seven runs) the OCR pass
  took 0.6–1.0 s for three images and 0.4–0.6 s for one, engine start
  included (it is started per save and stopped afterwards). Larger regions
  take longer.
- Photos are harder than graphics: on a Wikipedia photo of a road sign it
  read "Auf 1200" of "Auf 1200 m"; small, slanted or non-German/English text
  is often missed.
- **Copy text** and **Copy link** stay DOM-only.

## Viewers

The SVG is meant to be opened in a **browser**. In Firefox, opened directly,
the text can be selected and copied and the links work (checked by
`pnpm test` and `pnpm test:glue`). In Chromium the text is selectable and the
links work too (the round-trip specs of `pnpm test` run there), with one
difference: a selection copied from the file has a space between two pieces
of text that follow each other without one on the page, for example between a
link and the full stop after it. Chromium puts a line break between any two
`<text>` elements when it turns a selection into a string.

Other viewers fall short: Inkscape cannot click-select the transparent text
(Tab or Ctrl+A reach it), and macOS Preview and Quick Look show the image
without any text selection. For those, `<desc>`, the metadata and **Copy
text** carry the content. In a vector file the text is drawn, not
transparent; how these viewers handle it has not been checked yet.

## Limits

- HTML pages in the selected tab only, one region per capture.
- **Cross-origin iframes:** their pixels are in the image, their text is not
  in the text layer (sandboxed frames likewise). Same-origin iframes are read.
  The metadata counts the skipped frames.
- **Vertical writing modes** are skipped (counted in the metadata).
- **Shadow DOM:** text inside open shadow roots is extracted (tested).
  Closed roots are read through Firefox's content-script accessor, but no
  automated test covers them.
- **Top layer:** a `<dialog>` opened with `showModal()` or a popover is
  painted above the overlay by the browser, whatever the overlay's z-index;
  such content is not selectable through the overlay. (Follows from how the
  top layer works; not tested.)
- Text covered by another element is still included unless "Skip text covered
  by other elements" is on. Text hidden with `display`, `visibility`,
  `opacity`, clipping or `font-size: 0` is left out. Text with
  `user-select: none` is included on purpose.
- The vertical position of the invisible text is estimated from the font's
  metrics; for lines set in a fallback font (e.g. Hebrew, Arabic or CJK
  text under a Latin font stack) it can be off by a small amount. The
  horizontal extent is exact.
- The page is not frozen: animations, lazy-loaded images and layout changes
  between the pick and the capture show up as they are.
- A region too large for the browser's capture limits is refused with a toast
  ("This area is too large to capture").

## File size

The picture dominates the file size, and the SVG stores it base64-encoded
(a third larger than the PNG or JPEG itself).

Measured with `tests/glue/sizes.test.mjs` (Firefox 157, headless, macOS,
`layout.css.devPixelsPerPx = 2`; viewport 1280×715 CSS px). The test builds
two pages in the page itself and drags over the whole viewport, from the
top-left pixel to the last pixel (1279, 714), so the selection is
**1279×714 CSS px = 2558×1428 device px** (3.65 megapixels), then clicks
Save SVG; JPEG is switched on in the options page, quality at its default of
92 %.

| Page | Format | Image payload | SVG file |
|---|---|---|---|
| Text only: header band, three columns of prose (76 text runs) | PNG (default) | 628,932 B (0.60 MiB) | **862,060 B (0.82 MiB)** |
| | JPEG 92 % | 920,991 B (0.88 MiB) | **1,251,474 B (1.19 MiB)** |
| The same with a photo-like 1280×360 px image on top (35 text runs) | PNG | 3,465,633 B (3.31 MiB) | **4,632,889 B (4.42 MiB)** |
| | JPEG 92 % | 906,732 B (0.86 MiB) | **1,221,023 B (1.16 MiB)** |

What this says: for text on flat backgrounds PNG is the smaller file (JPEG at
92 % was 45 % larger here); JPEG pays off when the region contains photos
(about a quarter of the PNG size here). The photo is synthetic (seeded
gradients plus noise), so its absolute numbers are indicative only. The byte
counts repeat from run to run on the same machine; they will differ with other
fonts, pages and Firefox versions. The test only asserts sanity bounds: both
files under 20 MB, and JPEG smaller than PNG on the photo page.

## Privacy and permissions

snapii makes no network requests and sends nothing anywhere: the page is read
and captured in your browser, the SVG is written to your disk. The manifest
declares `data_collection_permissions: none`.

Settings live in the browser's extension storage (`storage.sync`); if you use
Firefox Sync, Firefox itself may sync them between your devices (the save folder
too, which may not suit another operating system). A single flag, "an old
shortcut binding has been looked at", is kept in `storage.local` on the device.

What a saved file contains matters when you share it: besides the pixels and
the text of the region it holds the **full page URL including the query
string and fragment** (`<desc>`, `dc:source`, `dc:relation`, the JSON
record), the page title, the capture time and the screen/viewport figures.
The text-fragment URL in `dc:source` also contains text from the start of
the selection. Remove these before publishing a file from a page whose
address carries a token.

A file saved with vector output holds more of the page than its pixels:

- the colours of the region's boxes, and their gradients and shadows;
- the boxes, gradients and shadows that reach into the selection, at their
  full size (beyond the selection's edge, hidden by the SVG's frame), also
  where something else covers them on the page;
- the pictures of the region's images and canvases, cut to the part inside
  their box, their clips and the selection, but not to what covers them: a
  picture under another element, or sharp under a blurring overlay, is in the
  file as it is, where a raster capture holds only what the page shows.

Permissions, and why each one is declared:

| Permission | Used for |
|---|---|
| `activeTab` | Access to the current tab, granted only when you click the button (opening its menu) or press the shortcut: injecting the overlay and capturing the visible tab; the menu also uses it to check whether snapii can run on the page. There are **no host permissions** (no "access your data for all websites"), so snapii cannot touch a tab you did not click. |
| `scripting` | Injecting the content script on demand (the manifest has no `content_scripts`, nothing runs on a page until you start snapii there). |
| `downloads` | Saving the SVG. |
| `clipboardWrite` | Copy text and Copy link, also on pages without a secure origin. |
| `storage` | The settings above, and the one-time flag. |
