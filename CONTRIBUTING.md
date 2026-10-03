# Contributing

snapii saves a region of a web page as one SVG: a picture with an invisible,
selectable text layer and clickable links on top. It is in **beta**. Bug
reports from real pages are the most valuable contribution right now —
every site that breaks snapii is a case the tests do not cover yet.

What this file asks of contributions: **state what your change does, and make
the diff prove it.** A pull request whose claims are explicit, whose tests
fail without it and whose scope is bounded can be reviewed in minutes.

## Setup

```console
$ pnpm install                            # pnpm only — a preinstall guard blocks npm and yarn
$ pnpm exec playwright install firefox    # once, for the layout tests
$ pnpm check                              # tsc (src and tests) + biome
$ pnpm exec playwright install chromium   # once, for the layout and the Chromium glue tests
$ pnpm test                               # unit tests, then layout tests in Playwright's Firefox and Chromium
$ pnpm test:glue                          # builds, then drives the real extension in Firefox
$ pnpm test:glue:chromium                 # builds, then drives the real extension in Chromium
$ pnpm build                              # bundles into dist/ and dist-chromium/ (esbuild, unminified)
```

Node 24 or newer. TypeScript runs through Node's type stripping and esbuild,
so imports carry their real `.ts` extension and only erasable syntax is
allowed (`tsconfig.json`).

`pnpm test:glue`, `pnpm drive` and `pnpm start` need a release Firefox 157 or
newer. They look for it at the macOS path; elsewhere set `SNAPII_FIREFOX` to
the binary for the glue tests and `pnpm drive`, and run
`pnpm exec web-ext run --source-dir dist` instead of `pnpm start`. Ports, the
other environment variables and the interactive driver are in
[docs/development.md](docs/development.md).

## Where things live

| Path | Responsibility |
|---|---|
| `src/manifest.json` | Permissions, the shortcut command, add-on id |
| `src/background/background.ts` | The background both browsers share: the popup's "Capture region" and the shortcut start a session; routes save and copy messages |
| `src/background/platform.ts` | The one seam between the browsers: what an entry has to provide (capture, OCR, download, clipboard, toolbar notice) |
| `src/background/main.ts` | Firefox's event page: the shared background on the Firefox platform |
| `src/background/chromium/` | Chromium's service worker (`main.ts`): viewport capture, data: URL download, OCR and clipboard through the offscreen document |
| `src/offscreen/` | Chromium's offscreen document: the Tesseract worker and the clipboard write a service worker cannot do |
| `src/background/start.ts` | Whether snapii can run in a tab, injecting the content script |
| `src/background/flag.ts` | The shortcut's "cannot capture this page" notice on the toolbar button, title before badge |
| `src/background/save.ts` | One save end to end: capture, hand the page back, OCR, render, download |
| `src/background/capture.ts` | Region → raster tiles with `captureVisibleTab` |
| `src/background/ocr.ts` | Tesseract in a worker over the image areas of one save |
| `src/background/download.ts` | The SVG download from a blob URL |
| `src/background/clipboard.ts` | Clipboard writes for pages without a secure origin |
| `src/background/settings.ts` | Defaults overlaid with validated values from `storage.sync` |
| `src/background/legacy-shortcut.ts` | Moves a key an older build left on the toolbar action to the capture command, once |
| `src/content/main.ts`, `session.ts` | Injected on demand; one capture session: overlay → selection → extraction → save or copy → toast |
| `src/content/overlay/` | The selection overlay, hover pick, toolbar and toast, styled to survive hostile pages |
| `src/content/extract/` | DOM → text runs (`collect.ts`, `lines.ts`, `baseline.ts`, `visibility.ts`, `flat-tree.ts`), link and image areas, the clean clone for Copy text |
| `src/content/fragment.ts`, `clipboard.ts` | Copy link's text-fragment URL; Copy text and Copy link on the clipboard |
| `src/content/shadow.ts` | Shadow roots and assigned slots as a content script sees them, closed ones included, in either browser |
| `src/shared/svg/` | The renderer (`build.ts`), the metadata block (`metadata.ts`), XML escaping (`xml.ts`) |
| `src/shared/types.ts` | Data contracts between content script, background and renderer, `Settings` |
| `src/shared/messages.ts` | Runtime validation of every message the background receives |
| `src/shared/settings.ts` | `DEFAULT_SETTINGS` |
| `src/shared/*.ts` (rest) | Pure helpers: geometry, tiling, capture strategy, pick heuristic, toolbar placement, links, whitespace and plain text, HTML sanitising for Copy text, text directives, OCR geometry, file name, save-folder rules, shortcut syntax, the version line (`about.ts`) |
| `src/shared/spike.ts` | Platform facts measured on Firefox 157 and on Chromium 151/153 (the headers say how); never edit by hand without a new measurement |
| `src/shared/manifest.ts`, `target.ts` | The manifest each browser gets; which browser a bundle was built for (`TARGET`, set by the build) |
| `src/shared/viewport.ts` | Chromium only: whether a region fits the viewport and where it lies in the captured picture |
| `src/popup/`, `src/options/` | The toolbar menu and the settings page |
| `scripts/build.mjs` | The bundler: `dist/` for Firefox, `dist-chromium/` for Chromium; writes `build-info.json` for the version line |
| `scripts/icons.mjs` | Rasterises the icon into the PNGs Chromium needs; run by hand when `icon.svg` changes |
| `tools/marionette/`, `tools/chromium/` | The drivers of the two glue suites |
| `tools/marionette/`, `tools/drive/` | Marionette client and Firefox driver for the glue tests and `pnpm drive` |

## Filing an issue

Pick the form that matches. Each one asks for the evidence that class of bug
needs, and one question in each splits the report into two different fixes —
that answer is what gets an issue fixed instead of left waiting.

Every bug form asks for the **version line** at the bottom of snapii's menu
or settings page (e.g. `snapii 0.1.0 · 862b4ba · built 2026-10-01 15:45 UTC ·
Firefox 157.0`): it names the exact build and the Firefox version.

- **Text in the SVG is missing, wrong or misplaced** — *does Copy text on the
  same selection get it right?* Copy text reads the page the same way the
  text layer does: if it is wrong too, extraction is at fault
  (`src/content/extract/`); if it is right, the renderer or the viewer is. The
  form also asks which program opened the SVG — only browsers select the
  invisible text — and whether the text was page text or inside an image
  (OCR).
- **The picture in the SVG is wrong** — *does Firefox's own screenshot of the
  same area look right?* If not, the page or Firefox paints it that way; if
  so, snapii's capture is at fault. Zoom, display scaling and the selection's
  size pick the code path; the `<snapii:capture>` JSON from the file carries
  all of it.
- **snapii does not work on a site** — *does it work on example.org?* If not,
  it is the installation or the Firefox setup; if so, it is the site. Plus the
  exact message snapii showed.
- **Copy text or Copy link gives the wrong result** — for links, *does
  Firefox's own Copy Link to Highlight work for the same passage?* If not, the
  page resists text links; if so, snapii's link is at fault. For Copy text,
  where it was pasted: rich editors get the HTML flavour, plain fields the
  plain one.
- **Feature request** — the problem, the proposed surface, acceptance
  criteria and explicit non-goals.
- **Implementation task** — a settled design someone can pick up without
  asking anything.
- **Question** — anything else; it is converted if it turns out to be a bug.

Security problems never go into a public issue — see [SECURITY.md](SECURITY.md).

## Public contracts

Other tools read snapii's files, and users install it because of what it does
*not* do. These surfaces are stable; breaking one silently is worse than any
bug:

1. **The SVG structure** — raster `<image>` tiles under an invisible text
   layer: one `<text>` with `textLength` per run of text, `fill-opacity="0"`
   (not `fill="none"`, which drops the text from hit-testing), OCR words in
   their own `<g id="ocr">`, linked runs wrapped in `<a href>`.
2. **The capture record** — the JSON in `<snapii:capture>`, `schema: 1`, with
   the fields of `captureRecord()` in `src/shared/svg/metadata.ts`, and the
   Dublin Core fields (`dc:title`, `dc:source`, `dc:relation`, `dc:date`,
   `dc:format`, `dc:language`). Removing, renaming or retyping a field is a
   schema change.
3. **The permissions** — `activeTab`, `scripting`, `downloads`,
   `clipboardWrite`, `storage`; no host permissions and no `content_scripts`
   (decision D1 in [docs/development.md](docs/development.md); the measured facts are in `src/shared/spike.ts`).
   The Chromium build adds `offscreen` and nothing else: its service worker
   cannot run the OCR worker or write the clipboard itself.
4. **The settings in `storage.sync`** — the keys of `Settings` in
   `src/shared/types.ts` keep their names, types and meaning; a value stored
   by an older version must still load (`src/background/settings.ts` drops
   what does not fit).
5. **The add-on id** `snapii@qmmq.de` — Firefox ties updates and signing to it.
6. **Privacy** — no network requests of any kind,
   `data_collection_permissions: none`, nothing in the saved file beyond what
   [docs/details.md](docs/details.md#privacy-and-permissions) lists.

## Tests

Every behavioural change needs a test that fails without it.

- **Unit** (`tests/unit/*.test.ts`, `node --test`) — everything pure: geometry,
  tiling, links, sanitising, metadata, the renderer. The renderer is
  deterministic (same input, same bytes) and checked byte for byte against
  `tests/unit/golden/simple.svg`; a change to the output updates that file
  by hand, and every changed line needs a reason in the PR.
- **Layout** (`tests/layout/*.spec.ts`, Playwright's Firefox and Chromium): extraction,
  overlay and round trip against the fixture pages in `tests/fixtures/`. A
  page that broke snapii usually becomes a new, minimal fixture here.
- **Glue** (`tests/glue/*.test.mjs`, `pnpm test:glue`) — the built extension
  in the installed Firefox through Marionette: popup, shortcut, save, copy,
  OCR. Not run in CI (it needs a release Firefox); run it locally whenever you
  touch `src/background/`, `src/content/`, the popup or the options page.
- **Chromium glue** (`tests/glue-chromium/*.test.mjs`, `pnpm test:glue:chromium`):
  `dist-chromium/` in Playwright's Chromium, driven by `tools/chromium/driver.mjs`:
  popup, save, copy, OCR through the offscreen document, the options page, a
  service-worker restart. Local as well; run it for the same paths and for
  `src/offscreen/`.
- **Manual** — what no automation can check (real keyboard, real display,
  other apps' clipboards, other viewers) is in
  [tests/MANUAL-CHECKLIST.md](tests/MANUAL-CHECKLIST.md).

A new check is only trusted once it has gone red: break the code it guards on
purpose, run it, restore — and name the fault and the check that caught it in
the PR.

To try a change on real websites, `pnpm drive` keeps one headless Firefox
with `dist/` loaded and drives it one command at a time
([docs/development.md](docs/development.md#driving-firefox-interactively)).

## Pull requests

The template asks for claims, real command output, a failing test, contract
confirmations, risk and scope. Fill it in and the review is mechanical.

One automated job, **pr intake**, reads the description and posts a checklist
of what is still open to the job summary. It **never fails your build** —
advisory only, a reading aid for the reviewer. Unlike a linter or a checker,
snapii cannot be pointed at its own pull request, so nothing runs the project
on the diff itself; review rests on the claims and the tests. The **tests**
workflow (`pnpm check`, `pnpm test`, build, `web-ext lint`) is the one that
has to pass.

Write claims as one bullet per user-visible change, files, functions and SVG
elements in `backticks`, issues as `#N`. Claim what the change *does*, not
which files you opened. Keep the diff inside the scope the claims imply; an
adjacent problem goes into "Out of scope" and a new issue.

## Using an LLM

Welcome, with no disclosure ritual beyond the two checkboxes in the template.
The rule: **you stand behind it.** You ran it, you read every line, and you
can explain why each change is there. Never paste private pages, tokens or
personal data into an issue or a prompt.

## Licence

Contributions are licensed under GPL-3.0-or-later. Keep the SPDX header as the
first line of every source file:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
```

A new dependency that ships in `dist/` also needs its licence in `NOTICE`
(and its licence text in the package or under `licenses/`).
