<p align="center"><img src="src/icons/icon.svg" width="96" height="96" alt="snapii logo"></p>

<h1 align="center">snapii</h1>

<p align="center"><b>Screenshots in which the text stays text.</b><br>
A Firefox extension (Chromium: experimental) that saves a region of a web page
as one SVG file — selectable, copyable, searchable text and clickable links on
top of the picture.</p>

Classic screenshots freeze text into pixels. snapii reads text, font, position
and links straight from the page and lays them invisibly over the image; only
text that exists solely as pixels inside images needs OCR, and that runs
locally if you switch it on.

Status: **beta** (0.2.0) — see [Install](#install).

## Features

- **Pick or drag** — hover an element and click, walk up/down with ↑/↓, or drag
  any rectangle (in Firefox also beyond the visible part of the page). Every
  button has a key — Q, W, E, R and F, the letters on the buttons — so after
  the shortcut the mouse can stay where it is.
- **Save SVG** — picture + invisible text layer + links + metadata (source URL,
  time) in one file.
- **Copy text** — the selection as clean text and simple HTML, without hidden
  text or scripts.
- **Copy element link** — a link that opens the page, jumps to the start of
  the selection and highlights it (`#:~:text=`).
- **Copy page link** — the page's own address, without a text-fragment link.
- **Without trackers** — both links leave out tracking parameters (`utm_*`,
  `fbclid`, `gclid` and similar); can be switched off.
- **Text in images (OCR)** — optional: words inside pictures, banners and
  canvases become selectable too, recognised offline (German + English).
  Real page text always wins.
- **Your shortcut** — Ctrl+Alt+S by default (Control+Option+S on macOS) starts
  a capture at once, changeable right in snapii's settings. Chromium does not
  load an extension with that default, so there it is Alt+Shift+S, changed in
  the browser's shortcut settings.
- **A small menu on the button** — start a capture, switch OCR, the
  text-fragment link, tracker removal and the save-as dialog on or off, and
  pick the save folder, right there.
- **Shapes and text (beta)** — optional output that writes backgrounds,
  borders, linear gradients and outer shadows as SVG shapes with visible text
  instead of one picture, and embeds images as their pixels: much smaller for
  text, each box its own SVG element; what cannot be drawn so stays pixels
  ([details](docs/details.md#vector-output-beta)).
- **PNG or JPEG**, optional save-as dialog, a folder of your choice inside
  Downloads, all in the settings.
- **Local only** — no network, no tracking, only the permissions it needs.

## Install

snapii is in **beta** and not on addons.mozilla.org yet. Until the first
signed release, load it from source:

```sh
git clone https://github.com/bmmmm/snapii.git
cd snapii
pnpm install      # pnpm only; Node 24+
pnpm build        # writes the extension to dist/
```

Then in Firefox open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on…** and pick `dist/manifest.json`. Pin the snapii button to the
toolbar via the puzzle-piece menu.

A temporary add-on is removed when Firefox restarts. To keep it, use Firefox
Developer Edition or Nightly with `xpinstall.signatures.required` set to
`false` in `about:config`, run `pnpm package` and install
`web-ext-artifacts/snapii-<version>.zip` via `about:addons` → gear → **Install
Add-on From File…**. Signed builds will be attached to the GitHub releases.

To update: `git pull && pnpm build`, then **Reload** in `about:debugging`.

### Chromium (experimental)

`pnpm build` also writes a build for Chromium-based browsers to
`dist-chromium/`. Open `chrome://extensions`, switch on **Developer mode**,
click **Load unpacked** and pick the `dist-chromium` folder. Needs Chromium 151
or newer. It is not in the Chrome Web Store.

What differs from Firefox:

- **Save SVG takes what is visible.** Chromium lets an extension capture the
  viewport only, so a selection that reaches beyond it cannot be saved: the
  overlay says so, and scrolling the selection fully into view makes Save
  available again. Copy text and both links work for any selection. With
  Shapes and text output only the parts saved as pixels must be visible.
- **The shortcut is changed in the browser**, at `chrome://extensions/shortcuts`
  (the settings page shows the current one and links there).

## Use

1. Click the snapii button, then **Capture region** (it has the focus, so
   Enter works too), or just press the shortcut. The page dims. On a page
   snapii cannot run on (Firefox's own pages, addons.mozilla.org, the PDF
   viewer) the menu says why.
2. Hover and click an element, or drag a rectangle. Escape cancels.
3. Choose **Save SVG**, **Copy text**, **Copy element link** or **Copy page
   link** — or press the letter shown on the button: **Q** saves, **W** copies
   the text, **E** and **R** copy the element or page link, **F** cancels. The
   letters work on a hovered element too, before you click it.

Open the saved `.svg` in a browser to select text and follow links. Needs
Firefox 157 or newer.

## Settings

The most used ones (three switches and the save folder) are in the button's
menu; all of them under **All settings…** there (or `about:addons` → snapii →
Preferences): output (a picture with selectable text, or shapes and text),
image format and JPEG quality, save-as dialog, save folder, skip covered text,
text-fragment links, tracker removal from copied links, OCR for text in images
(off by default), and the keyboard shortcut.

The **save folder** is a folder name inside Firefox's Downloads folder, such as
`snapii` or `Pages/snapii`, created when needed; empty means the Downloads
folder itself. Firefox does not let add-ons save anywhere else, so a full path
is refused, and so is a name Firefox would refuse or change (a leading or
trailing dot, `% : * ? " < > |`); the save-as dialog is the way to pick another
place.

## Privacy

snapii makes no network requests; the file is written to your disk and nothing
is sent anywhere. A saved file contains the page URL (including its query
string) and the capture time — check that before sharing files from pages
with tokens in the address.

## More

- [docs/details.md](docs/details.md) — what is in the file, OCR, viewers,
  limits, file sizes, permissions
- [docs/development.md](docs/development.md) — build, tests, driving Firefox

GPL-3.0-or-later ([LICENSE](LICENSE), third-party code in [NOTICE](NOTICE)).

## Development

```sh
pnpm install
pnpm check && pnpm test   # types, lint, unit and layout tests
pnpm test:glue            # end-to-end in the real Firefox (headless)
pnpm test:glue:chromium   # end-to-end in Playwright's Chromium
pnpm build && pnpm start  # try it in a fresh Firefox profile
```
