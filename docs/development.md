# Developing snapii

pnpm only (a `preinstall` guard rejects npm and yarn); Node 24 or newer.

```sh
pnpm install
pnpm check        # tsc (src and tests) + biome
pnpm test         # unit tests (node --test), then layout tests in Playwright's Firefox
pnpm test:glue    # builds, then drives the real extension in Firefox through Marionette
pnpm build        # bundles into dist/ (esbuild, unminified)
pnpm lint:ext     # web-ext lint on dist/
pnpm package      # web-ext build: web-ext-artifacts/snapii-<version>.zip
pnpm start        # fresh Firefox profile with dist/ loaded (add --start-url <url>)
```

- The layout tests (`pnpm test`) need Playwright's Firefox once:
  `pnpm exec playwright install firefox`.
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
