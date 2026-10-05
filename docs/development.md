# Developing snapii

pnpm only (a `preinstall` guard rejects npm and yarn); Node 24 or newer.

```sh
pnpm install
pnpm check        # tsc (src and tests) + biome
pnpm test         # unit tests (node --test), then layout tests in Playwright's Firefox and Chromium
pnpm test:glue    # builds, then drives the real extension in Firefox through Marionette
pnpm test:glue:chromium   # builds, then drives the real extension in Chromium
pnpm build        # bundles into dist/ (Firefox) and dist-chromium/ (esbuild, unminified)
pnpm lint:ext     # web-ext lint on dist/
pnpm package      # web-ext build: web-ext-artifacts/snapii-<version>.zip
pnpm package:chromium     # the same for dist-chromium/: snapii-chromium-<version>.zip
pnpm start        # fresh Firefox profile with dist/ loaded (add --start-url <url>)
```

- The layout tests (`pnpm test`) need Playwright's Firefox and Chromium once:
  `pnpm exec playwright install firefox chromium`.
- `pnpm test:glue:chromium` runs that same pinned Chromium headless at device
  scale factor 2 with `dist-chromium/` loaded (`SNAPII_CHROMIUM` names another
  binary; branded Chrome no longer takes `--load-extension`). It binds ports
  8470–8479 (server) and 2970–2979 (DevTools), shifted by
  `SNAPII_GLUE_PORT_OFFSET` as well.
- `pnpm test:glue` and `pnpm start` need Firefox **157 or newer** at
  `/Applications/Firefox.app` (macOS path). The glue tests run headless at
  device-pixel ratio 2 and bind local ports 8460–8469 (server) and
  2960–2969 (Marionette); `SNAPII_GLUE_PORT_OFFSET=<n>` shifts both, and
  `SNAPII_GLUE_OUT=<dir>` keeps profiles, logs and the downloaded files.
- What the automated run cannot check (real keyboard, real display, other
  apps' clipboards, other viewers) is in
  [tests/MANUAL-CHECKLIST.md](../tests/MANUAL-CHECKLIST.md).
- The capture decisions, each resting on facts measured on Firefox 157 that
  live in `src/shared/spike.ts`: D1 `activeTab` only, `captureVisibleTab` is
  the one capture path; D2 the scale asked for per capture; D3 the per-call
  pixel limits that cut a region into tiles; D4 the download from a blob URL
  in the background.

## Chromium

The Chromium build is the same code on another platform adapter
(`src/background/platform.ts`). Its decisions rest on the facts measured on
Chromium 151 and 153 in `SPIKE_CHROMIUM` (`src/shared/spike.ts`).

- **C-D1 Viewport only.** `captureVisibleTab` takes the viewport and nothing
  beyond it. A region that is wholly visible is saved from one capture,
  cropped in the service worker; any other is refused, and the overlay
  disables Save for it with the reason (vector output captures only its
  patches, so there only those must be visible: V-D8). Capturing beyond the viewport would
  need scroll-and-stitch (two captures a second, scroll events in the page,
  repeated fixed elements) or the `debugger` permission (the Firefox
  semantics, at the price of a permission warning and an infobar); neither is
  built.
- **C-D2 Density.** The picture has the screen's density, device scale factor
  times zoom, which is the page's `devicePixelRatio`. The record's `scale` is
  that density without the zoom, as in Firefox.
- **C-D3 Download from a `data:` URL.** A service worker has no object URLs;
  `downloads.download` takes the SVG as a `data:` URL, so there is nothing to
  revoke and no state a worker restart could lose. `download()` resolves
  before a Save-as dialog is answered there, so the save asks for the
  download's state until it is complete or interrupted.
- **C-D4 Offscreen document on demand.** The Tesseract worker and the
  clipboard write for non-secure pages need a document. It is created for a
  request and closed after the last one in flight.
- **C-D5 The shortcut belongs to the browser.** Chromium has no
  `commands.update`; the options page shows the key and opens
  `chrome://extensions/shortcuts`.

The glue tests drive the popup through `Extensions.triggerAction` (DevTools
protocol), which grants `activeTab` like a click. No key of a command can be
pressed from a test: the command is fired as an event there, and the real key
press is a manual item (`tests/MANUAL-CHECKLIST.md`).

## Vector output

The vector output ([docs/details.md](details.md#vector-output-beta)) rests on
these decisions:

- **V-D1 Opt-in, raster unchanged.** `output` defaults to `"raster"`, and a
  raster file stays byte-identical (`tests/unit/golden/simple.svg`). Vector is
  a second renderer (`src/shared/svg/vector.ts`), not a change to the first.
- **V-D2 Scene in the page, pure renderer in the background.** The content
  script reads the DOM into a scene of numbers (`src/content/extract/scene.ts`):
  boxes, pictures, patches and how each text run is painted. The background
  validates it like every message (`src/shared/messages.ts`), captures only
  the patches and renders; same scene, same bytes. The scene holds no page
  string: colours, lengths and gradients are parsed into numbers in the page,
  and a picture is a `data:image/…;base64` URL the content script encoded
  itself. The text layer's strings (text, font names, links) are escaped as in
  raster output.
- **V-D3 The smallest box as pixels.** An element that cannot be drawn as
  shapes becomes a patch over its box, grown by what its shadows and filters
  paint beyond it, and, unless it clips its overflow both ways, over the
  shown absolute and fixed descendants that leave it (a dropdown); its text
  stays in the text layer, invisible, because the pixels show it. The record
  counts the patched elements per reason. On five real pages this kept 71–98 % of the area as shapes before
  pictures, gradients and shadows were drawn (four of five at 85 % or more).
- **V-D4 Text stays text, fonts are not embedded.** Embedding would mean
  reading font files, which a content script cannot do without requests.
  Each run names the page's font with a generic fallback, and `textLength`
  with `lengthAdjust="spacing"` pins its width (measured against the page:
  glyphs keep their shape, the run its extent).
- **V-D5 Pictures from the page's own pixels, cut to what shows.** An `<img>`
  or `<canvas>` is drawn into a canvas the content script makes and read
  back: no request. What the page may not read (another origin) is a patch;
  measured in both browsers, the content script may read exactly what the
  page may. Only the part inside the box, its clips and the selection is
  stored, at the screen's density, with what lies outside rounded corners
  removed (a rounded ancestor's clip is cut about two device pixels outside
  its curve, a corner under about seven not at all; the SVG's own clip hides
  that rest).
- **V-D6 Paint order as CSS 2.1 Appendix E, approximated.** Per stacking
  context: its background, negative z-index, blocks, floats, inline content,
  positioned boxes, positive z-index. Text is drawn above all shapes; a run
  an opaque shape painted later covers is made invisible instead.
- **V-D7 No OCR in vector output.** OCR reads the pixels of the captured
  tiles; a vector capture has only the patches, and reading the embedded
  pictures would mean decoding them once more. Not built for now; the
  settings page and the menu disable the OCR switch for vector output, the
  stored setting stays, and a vector save ignores it.
- **V-D8 Chromium: one capture for all patches.** Two captures a second is
  Chromium's limit (C3), so all patches come from one viewport capture with
  one shrink factor; a patch outside the viewport refuses the save before any
  capture, while shapes and text may lie anywhere.
- **V-D9 Decorations from the viewer's font.** A run's underline, overline
  and line-through are its `<text>`'s `text-decoration`, drawn from the
  run's font (V3 in `SPIKE_VECTOR`: within 36 of 40 000 px of the page in
  Firefox on macOS at a baseline on a whole pixel, a device pixel row off
  in Chromium and in Linux Firefox; between pixels the page snaps the line
  and SVG softens it over two rows). That is where the page
  draws them only while all the text a line reaches shares the declaring
  box's font and baseline: the browser places one line per box from every
  font in it. A box with other text inside, and what SVG has no value for
  (an underline offset or position), is a patch, grown by the line's reach.
  SVG paints a decoration in the declaring element's fill and ignores a
  colour in the value, so a decoration of another colour fills the
  `<text>` and the glyphs take a `<tspan>`.
- **V-D10 Border patterns per browser.** CSS leaves dashes and dots to the
  browser, and the two lay them out differently: Chromium fits the gap
  between dashes of a fixed length, Firefox an odd number of equal
  segments (counted on 21 side lengths at 5 widths in each browser, on
  boxes with four equal sides; `tests/unit/border.test.ts` holds a sample).
  `src/content/extract/border.ts` lays a side out the way the build's
  browser does (`TARGET`, at build time), a `<line>` with a dash array
  along the side, on the border box snapped to device pixels as the
  browsers paint it. A double side is its two lines. Rounded dashed or
  dotted boxes stay patches (their dashes follow the curve), and so does
  what lies inside a collapsed table (its cells share their edges;
  `border-collapse` is inherited, so their contents go with them). Firefox also
  places a side's pattern by its corners and neighbours, which this does
  not model: there it is approximate.

`tests/layout/vector.spec.ts` renders every fixture's scene back in the
browser and compares it with the page (`diffRatio`; a fixture whose
expectations have a `vector` block must stay within its tolerance, 2 % by
default, the others only report it),
checks the text layer, the links, hostile values and that the save message
passes the background's validator.

## Driving Firefox interactively

`pnpm drive` keeps one Firefox (the installed release, headless, DPR 2,
viewport 1280×715) with `dist/` loaded running between commands, for trying
snapii step by step on real websites. Each command opens a fresh Marionette
session, prints one JSON line on stdout and disconnects; `pnpm drive help`
lists them all.

```sh
pnpm drive start                      # builds dist/, launches Firefox (--headed, --dpr, --width/--height)
pnpm drive open https://example.org/
pnpm drive snap --element 'main p'    # or --drag x1 y1 x2 y2; --up N walks to ancestors; --popup
pnpm drive popup                      # the toolbar menu: what it shows + screenshot
pnpm drive save                       # or copy-text / copy-link: toast, file summary, clipboard
pnpm drive screenshot                 # PNG path; also console, eval, click, key, scroll, timing
pnpm drive stop
```

A key recorded under an older build, where the shortcut lived on
`_execute_action` (the toolbar action), stays bound there across updates and
reloads and would only open the popup (measured on Fx157; the default key does
not stay, Firefox rebinds it to the new command). The background therefore
moves such a key to `start-capture` the first time it runs, once per profile
(`src/background/legacy-shortcut.ts`, `tests/glue/shortcut.test.mjs`, last
test: it presses the key as real key events at the browser window).

State (profile, downloads, screenshots, Firefox log) lives in
`/tmp/snapii-drive-<hash of the checkout path>` (`SNAPII_DRIVE_DIR`
overrides), the same path inside and outside a process sandbox; Firefox
itself must run outside it. Marionette uses the first free port in 2990–2999.
