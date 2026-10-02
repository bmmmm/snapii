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

## Text in images (OCR)

With "Recognize text in images (OCR)" on, **Save SVG** also reads the text
inside the images of the selection: `<img>`/`<picture>`, `<canvas>`, SVG
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
`pnpm test` and `pnpm test:glue`). Chrome is expected to select text the same
way (the research behind this project says so); we have not run it ourselves
yet (item 15 of `tests/MANUAL-CHECKLIST.md`).

Other viewers fall short: Inkscape cannot click-select the transparent text
(Tab or Ctrl+A reach it), and macOS Preview and Quick Look show the image
without any text selection. For those, `<desc>`, the metadata and **Copy
text** carry the content.

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
| Text only: header band, three columns of prose (76 text runs) | PNG (default) | 628,932 B (0.60 MiB) | **861,778 B (0.82 MiB)** |
| | JPEG 92 % | 920,991 B (0.88 MiB) | **1,251,192 B (1.19 MiB)** |
| The same with a photo-like 1280×360 px image on top (35 text runs) | PNG | 3,465,633 B (3.31 MiB) | **4,632,607 B (4.42 MiB)** |
| | JPEG 92 % | 906,732 B (0.86 MiB) | **1,220,741 B (1.16 MiB)** |

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

Permissions, and why each one is declared:

| Permission | Used for |
|---|---|
| `activeTab` | Access to the current tab, granted only when you click the button (opening its menu) or press the shortcut: injecting the overlay and capturing the visible tab; the menu also uses it to check whether snapii can run on the page. There are **no host permissions** (no "access your data for all websites"), so snapii cannot touch a tab you did not click. |
| `scripting` | Injecting the content script on demand (the manifest has no `content_scripts`, nothing runs on a page until you start snapii there). |
| `downloads` | Saving the SVG. |
| `clipboardWrite` | Copy text and Copy link, also on pages without a secure origin. |
| `storage` | The settings above, and the one-time flag. |
