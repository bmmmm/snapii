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
Chromium 151 and 153 in `SPIKE_CHROMIUM` (`src/shared/spike.ts`);
[chromium-port.md](chromium-port.md) has the research behind them, with
sources (it numbers its own measurements C1 to C20; the C numbers in the code
are the ones in `spike.ts`).

- **C-D1 Viewport only.** `captureVisibleTab` takes the viewport and nothing
  beyond it. A region that is wholly visible is saved from one capture,
  cropped in the service worker; any other is refused, and the overlay
  disables Save for it with the reason. Capturing beyond the viewport would
  need scroll-and-stitch (two captures a second, scroll events in the page,
  repeated fixed elements) or the `debugger` permission (the Firefox
  semantics, at the price of a permission warning and an infobar); neither is
  built.
- **C-D2 Density.** The picture has the screen's density, device scale factor
  times zoom, which is the page's `devicePixelRatio`. The record's `scale` is
  that density without the zoom, as in Firefox.
- **C-D3 Download from a `data:` URL.** A service worker has no object URLs;
  `downloads.download` takes the SVG as a `data:` URL, so there is nothing to
  revoke and no state a worker restart could lose.
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
