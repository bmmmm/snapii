# Manual checklist (Firefox)

Items 1–15. Each is marked

- `auto (tests/glue/<file>: <test>)` — `pnpm test:glue` drives the installed
  Firefox headless at DPR 2 through Marionette and checks it; the human only
  repeats it when the automated run cannot stand in for real hardware,
- `human` — only a person at a real display can check it; exact steps below,
- `obsolete (D1)` — dropped by decision D1 (`docs/development.md`): snapii uses
  `activeTab` only and has no host permission, so there is nothing to grant
  or revoke.

Record each run in the pull request or the release notes: date, Firefox
version and OS, file name and SHA-256 of the package, one row per item with
pass / fail and what you saw.

## Setup for the human items

```sh
# terminal 1: fixture server (serves tests/ at port 8438)
python3 -m http.server 8438 --bind 127.0.0.1 --directory tests
# terminal 2: build and start a fresh Firefox profile with snapii installed
pnpm build && pnpm start --start-url http://127.0.0.1:8438/fixtures/inline-links.html
```

`pnpm test:glue` needs no setup (each test file starts its own server and
Firefox on one port pair within 8460–8469 and 2960–2969;
`SNAPII_GLUE_PORT_OFFSET=20` shifts both, for a second checkout running at
the same time; 10 would collide with the Chromium suite's 8470–8479 and
2970–2979). It must run outside a process sandbox.

## Items

| # | Item | Status |
|---|---|---|
| 1 | Toolbar button → popup → Capture region, and the shortcut (Ctrl+Alt+S; macOS Control+Option+S), open the overlay; Escape leaves no `snapii-overlay` node | auto (tests/glue/overlay.test.mjs: item 1; the popup itself: tests/glue/popup.test.mjs) + human 1h |
| 2 | Hover highlights; ArrowUp/ArrowDown walk the ancestors | auto (tests/glue/overlay.test.mjs: item 2) |
| 3 | Element save → file in the download folder; opened in Firefox, select-all + copy gives the paragraph; links open | auto (tests/glue/save.test.mjs: item 3) + human 3h |
| 4 | Drag across paragraphs → the SVG text has both | auto (tests/glue/save.test.mjs: item 4) |
| 5 | Below-the-fold selection behaves per D1 (captured, not clipped) | auto (tests/glue/offscreen.test.mjs: item 5a, item 5b) + human 5h |
| 6 | Permission granted path | obsolete (D1) |
| 7 | Zoom 150 % / 80 % | auto (tests/glue/offscreen.test.mjs: item 7 ×2) |
| 8 | Copy text into a rich and a plain editor | auto for what lands on Firefox's clipboard, on a secure and a non-secure origin (tests/glue/copy.test.mjs: item 8 ×2) + human 8h (pasting into other apps) |
| 9 | Copy link → new tab highlights the passage | auto (tests/glue/copy.test.mjs: item 9) + human 9h |
| 10 | `about:addons` and AMO → the popup says why (button disabled), the shortcut puts a badge; no console error | auto for `about:addons` and `view-source:` with the shortcut (tests/glue/overlay.test.mjs: item 10 ×2), `about:addons` and an SVG document with the popup (tests/glue/popup.test.mjs: popup on …) + human 10h (AMO, PDF viewer) |
| 11 | Strict-CSP page → overlay styled | auto with a local page served with `Content-Security-Policy: style-src 'none'; script-src 'none'` as an HTTP header (tests/glue/overlay.test.mjs: item 11) + human 11h (github.com) |
| 12 | Metadata visible in the source | auto (tests/glue/save.test.mjs: item 12, item 12 / M3 pass) |
| 13 | Overlay never in the raster | auto (tests/glue/save.test.mjs: item 13) |
| 14 | Revoke host permission in `about:addons` → hint | obsolete (D1) |
| 15 | Informative: open the SVG in Chrome and Inkscape | human 15h |
| 16 | Vector output: Output "Shapes and text" in the settings page → the save has shapes, visible text, pictures and patches; the record says `output: "vector"`; OCR is off | auto (tests/glue/options.test.mjs: output Vector …, vector output with pictures …; tests/glue-chromium/save.test.mjs: vector output …; tests/layout/vector.spec.ts) + human 16h |

### Chromium

`pnpm test:glue:chromium` covers, in Playwright's headless Chromium at device
scale factor 2: popup → overlay → save (file name, sub-folder, picture pixels,
text layer, record), zoom 150 %, the refusal of a selection beyond the
viewport and the save after scrolling, JPEG, closed shadow trees, Copy text on
a secure and a non-secure origin and Copy link (read back from the
clipboard), OCR through the offscreen document, the popup on a browser page,
the read-only shortcut section, the folder rules against the real download
API, a save across a service-worker restart, the toolbar notice, a
cancelled Save-as dialog (headless Chromium has no file dialog, so every
"Ask where to save" download ends as a cancelled one), and vector output
(shapes and visible text, pictures and patches, a selection beyond the
viewport without patches that saves, and one with a patch there that is
refused).

Human steps there (load `dist-chromium/` via `chrome://extensions` → Developer
mode → Load unpacked):

- **C1h: real shortcut.** Press Alt+Shift+S on a web page: the overlay opens
  without the popup (the key press itself grants `activeTab`; the tests can
  only fire the command as an event). On `chrome://extensions` the toolbar
  button shows "×" and the reason for three seconds.
- **C2h: Save-as dialog.** With "Ask where to save" on, save: the browser's
  dialog opens and no toast shows yet; leave it open for a minute, then save:
  the toast names the file and the file is complete. Cancel it on a second
  try: the toast says the SVG was not saved.
- **C3h: real display.** On a HiDPI screen and at 100 % and 125 % zoom, save
  an element: text layer and picture line up in the opened file.
- **C4h: toolbar icon.** The snapii icon shows in the toolbar and in
  `chrome://extensions` (PNG icons; the SVG one is Firefox's).
- **C5h: PDF viewer and the Web Store.** The popup says why the page cannot
  be captured, the button is disabled.
- **C6h: another Chromium browser.** Repeat C1h and one save in Edge or
  Brave.

### What the automated run cannot stand in for

The glue run uses Firefox's own trigger paths (`triggerAction`, which opens
the popup, and the `start-capture` `<key>` command), synthesized
pointer/keyboard input (in the popup: pointer actions in the browser window,
keys through the popup's TextInputProcessor),
`layout.css.devPixelsPerPx = 2` instead of a Retina screen, a temp download
directory, and a headless in-process clipboard. Hence these human steps:

**1h — real shortcut.** On the inline-links page press Ctrl+Alt+S on the
keyboard (macOS: Control+Option+S): the overlay appears with the hint
"Click an element or drag an area · ↑ ↓ parent/child · Esc cancels". Press
Escape. Open the Browser Toolbox' inspector (or run
`document.querySelectorAll("snapii-overlay").length` in the page console):
0 nodes. Click the toolbar button: the popup opens with **Capture region**
focused and the shortcut next to it; press Enter: overlay, popup gone. Open
the popup again and click **Capture region**: the overlay is gone. Toggle
"Recognize text in images" in the popup, open **All settings…**: the options
page shows the same state. Then record a shortcut with real keys in the
options page (macOS: Option+Shift+Y, which types "¥"): the field shows it,
the popup shows it next to **Capture region**, and pressing it opens the
overlay.

**3h — real download folder and real clipboard.** Click into the first
paragraph, click **Save SVG**. A toast "Saved snapii inline-links <date>.svg"
appears; the file is in `~/Downloads` (or the configured folder). Open it in
Firefox (drag into a tab), press Cmd+A, Cmd+C, paste into TextEdit (plain
text mode): the four lines of the page, "Read the docs or external." first.
Click "the docs" in the opened SVG: the browser goes to `/docs/a.html` (404
from the fixture server is fine).

**5h — real display.** On `http://127.0.0.1:8438/fixtures/long-article.html`
drag from the top of the visible text and scroll with the wheel while
holding the button until the selection reaches well below the original
viewport; release, Save SVG. Open the file: the image shows the whole
selected area sharply (Retina: 2 device px per CSS px), the text below the
original fold is selectable.

**8h — pasting into other apps (real system clipboard).** On
`http://127.0.0.1:8438/fixtures/copy.html` drag across the whole content,
click **Copy text**: toast "Copied text", the overlay stays. Paste into
TextEdit in rich-text mode (or a web rich editor such as a mail compose
window): heading, bold/italic, the list and the "real link" link arrive;
"script link" is plain text; no "HIDDENDISPLAY"/"HIDDENVIS". Paste into
TextEdit in plain-text mode (or Terminal): the six lines with empty lines
between them. Repeat once on a non-secure origin (e.g. any `http://` site
that is not localhost) to see the background fallback reach the system
clipboard.

**9h — real click and display.** On
`http://127.0.0.1:8438/glue/fixtures/article.html` scroll to the last
paragraph ("Piezoelectric quartz …"), click it, click **Copy element link**: toast
"Copied link", the overlay closes. Paste the URL into a new tab's address
bar and press Enter: the page opens scrolled to that paragraph, which is
highlighted. Optional:
paste it into Chrome — the same paragraph is highlighted.

**10h — AMO and PDF viewer (need network / a PDF).** Open
`https://addons.mozilla.org/`, click the snapii button: the popup's
**Capture region** is disabled and below it "snapii cannot capture this page:
…". Press Ctrl+Alt+S (macOS: Control+Option+S) instead: the button shows "×" for 3 s and its tooltip
says the same. Same for a PDF opened in Firefox's viewer. Browser console
(Cmd+Shift+J): no error from snapii.

**11h — real strict-CSP site.** Open `https://github.com/` (strict CSP),
click the snapii button and **Capture region**, hover the page: the blue highlight with dimmed
surroundings appears, the toolbar has a blue "Save SVG" button. Save works.

**15h — other viewers (informative).** Open a saved SVG in Chrome: image and
selectable text, links clickable. Open it in Inkscape: the image shows; text
may not be selectable (documented limitation). Record what you see.

**16h — vector output on real pages and in other viewers.** Switch Output to
"Shapes and text (beta)" in the settings page and save a region of a
Wikipedia article, a GitHub page and a page with photos and gradients. Open
each file in Firefox next to the page: boxes, colours, gradients, shadows and
pictures where the page has them, the text visible and selectable, links
clickable, zooming in keeps edges sharp (patches excepted). Open the files in
Inkscape and macOS Preview: the shapes show and can be selected and moved in
Inkscape; note fonts the viewer replaces. Record the record's `scene` counts
and what differs from the page.
