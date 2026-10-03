# Chromium port: platform facts

Research notes for the question "can snapii also be built for Chromium (Chrome, Edge, other
Chromium browsers), and how much compatibility glue does that need". This file holds the
platform facts only. It is not a port plan and contains no effort estimate.

Written 2026-10-03.

## How to read this

Every claim carries one of these status tags:

- **[source]** verified in a primary source (Chromium source, Chrome/MDN/CDP/W3C documentation,
  the library's own repository). The URL follows the claim.
- **[measured]** measured on 2026-10-03 with a throw-away extension in a real Chromium, in the
  style of the S1 to S12 facts in `src/shared/spike.ts`. These facts are numbered C1 to C20.
- **[conflict]** primary sources disagree with each other or with the measurement.
- **[not found]** searched for, no primary source found.
- **[to measure]** needs a measurement in a real Chromium that was not possible here (mostly:
  needs a headed browser, a real display, a branded Chrome build or Edge). What to measure is
  spelled out.

### Versions

- Chrome stable is **154** (154.0.8037.97 on Linux, .98 on Windows, served since 2026-10-02).
  Chrome 155 is in early stable since 2026-09-23 and becomes stable on 2026-10-06.
  Sources: <https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions/all/releases>,
  <https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=155>
- "Chromium main" below means the `main` branch as read on 2026-10-03 (about M156).
  Source links use `https://chromium.googlesource.com/chromium/src/+/refs/heads/main/<path>`.

### Measurement setup (C facts)

Chromium **151.0.7922.173** (the distribution build at `/bin/chromium`, not Google Chrome), Linux,
new headless mode, window 1000x800 (page viewport 1000x713 CSS px), once with
`--force-device-scale-factor=1` and once with `2`. Driven by playwright-core 1.63 over CDP
(`launchPersistentContext`, `--load-extension`), API calls made from the extension's service
worker. The test page was a calibration grid of 100x100 CSS px cells whose colour encodes column
and row, 1000x6000 CSS px, plus one `position: fixed` square. Two throw-away extensions: one with
`<all_urls>` (to study the API semantics), one with **only** snapii's permission list
(`activeTab, scripting, downloads, clipboardWrite, storage`) whose action was triggered through
CDP `Extensions.triggerAction` (to study the `activeTab` grant).

Limits of this setup, valid for every C fact: headless, Linux only, emulated device scale
factor, Chromium 151 (three milestones behind stable), no real keyboard, no real Save-as
dialog, no toolbar to look at. Nothing was measured in Google Chrome or Edge.

---

## 1. Capture

### 1.1 What `tabs.captureVisibleTab` accepts

- Documented options are `format` (default `"jpeg"`, Firefox defaults to PNG) and `quality`
  only. **[source]** <https://developer.chrome.com/docs/extensions/reference/api/extensionTypes>
- Chromium also accepts `rect` and `scale` since **Chrome 140**. They are in the schema with
  `"nodoc": true`, so they do not appear in the documentation, and browser-compat-data lists
  them as unsupported in Chrome. **[conflict]** (documentation and BCD say no, source and
  measurement say yes)
  - Schema: <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/extension_types.json>
    (`ImageDetails.rect`, `ImageDetails.scale`)
  - Changes: <https://chromium-review.googlesource.com/c/chromium/src/+/6709761> (`rect`, first in
    140.0.7297.0) and <https://chromium-review.googlesource.com/c/chromium/src/+/6734895> (`scale`,
    first in 140.0.7303.0). Milestones from `https://chromiumdash.appspot.com/fetch_commit`.
  - Proposal: <https://github.com/w3c/webextensions/issues/850> (open, labels
    `implemented: firefox`, `supportive: chrome`, `supportive: safari`). The proposal text says
    "capture only a selected portion of the visible tab".
  - BCD: <https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/extensionTypes.json>
- **The Chromium `rect` is not Firefox's `rect`.** The schema description is copied from Firefox
  ("in CSS pixels, relative to the page"), but the implementation only crops the visible
  surface: `CopyFromSurface(source_rect, ...)` where `source_rect = ScaleToEnclosingRect(rect, scale)`
  and `scale` defaults to the view's device scale factor. Nothing is rendered that is not
  already on screen, and nothing is resampled. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/web_contents_capture_client.cc>

Measured behaviour:

- **C1 [measured]** No options: a JPEG of the viewport in physical pixels. 1000x713 at device
  scale factor 1, 2000x1426 at 2. At page zoom 1.5 the image size does not change, the page is
  just drawn larger (a 100 CSS px cell is 150 px, or 300 px at device scale factor 2). So one CSS
  px is `device scale factor * zoom` image px, which is the page's own `devicePixelRatio`
  (measured 1.5 and 3).
- **C2 [measured]** `rect` is honoured, but its members must be integers. A fractional value
  throws synchronously: `Error at property 'rect': Error at property 'x': Invalid type: expected integer, found number.`
  Firefox takes fractional rects and snaps them (S5).
- **C3 [measured]** `rect` is relative to the **viewport**, not the document. With the page
  scrolled to y=1000, `rect {x:0, y:0}` returned the cells of document row 10. Firefox: relative
  to the document (S1).
- **C4 [measured]** A rect that lies completely outside the viewport rejects with
  `Failed to capture tab: image readback failed`. A rect that crosses the viewport edge is
  silently clipped to the viewport (300x1000 starting at y=500 returned 300x213). Firefox
  captures such rects in full (S2).
- **C5 [measured]** `scale` never magnifies or shrinks. The captured source is
  `rect * scale` in device-independent px and the image is that source times the device scale
  factor. `scale` without `rect` is ignored. Results for `rect {100, 200, 300x200}`:

  | device scale factor | zoom | `scale` | image | top-left cell (col,row) | px per 100 CSS px | correct region? |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1 | 1 | default | 300x200 | 1,2 | 100 | yes |
  | 1 | 1 | 2 | 600x313 (clipped) | 2,4 | 100 | no, region at 200,400, twice as large |
  | 1 | 1 | 0.5 | 150x100 | 0,1 | 100 | no |
  | 1 | 1.5 | default | 300x200 | 0,1 | 150 | no |
  | 1 | 1.5 | 1.5 | 450x300 | 1,2 | 150 | yes |
  | 2 | 1 | default | 1200x626 (clipped) | 2,4 | 200 | no |
  | 2 | 1 | 1 | 600x400 | 1,2 | 200 | yes |
  | 2 | 1.5 | default | 1200x626 (clipped) | 1,2 | 300 | no (size wrong) |
  | 2 | 1.5 | 1.5 | 900x600 | 1,2 | 300 | yes |
  | 2 | 1.5 | 3 | 1400x226 (clipped) | 2,4 | 300 | no |

  The rule that fits every row: to capture a CSS px rect of the viewport, pass
  **`scale = tabs.getZoom()`**. The default (`scale` = device scale factor) is only right when
  the device scale factor happens to equal the zoom, so on any HiDPI display at zoom 1 the
  default captures the wrong region. Passing the page's `devicePixelRatio` is wrong too. The
  image always comes out at native resolution (`rect * zoom * device scale factor`). There is no
  way to ask for another resolution; resampling would have to happen afterwards
  (`OffscreenCanvas` exists in the service worker, see C10).
- **[to measure]** C1 to C5 on a real HiDPI display (not `--force-device-scale-factor`) and on
  Chrome 154/155 stable, Windows and macOS. The options are undocumented, so their behaviour is
  not a contract; the device-scale double-scaling at default `scale` looks like a bug that could
  be fixed in either direction. The Chromium bug is <https://issues.chromium.org/issues/423658618>
  (needs a sign-in, content not read).

### 1.2 Permission

- `activeTab` alone is enough. The check is `CanCaptureVisiblePage(..., CaptureRequirement::kActiveTabOrAllUrls)`.
  **[source]** <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/tabs/tabs_api.cc>,
  <https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab>
- **C7 [measured]** With snapii's exact permission list and no invocation, capture rejects with
  `Either the '<all_urls>' or 'activeTab' permission is required.` After the action was
  triggered, `captureVisibleTab` (with `rect` and `scale`) and `scripting.executeScript` both
  work. See 7 for how long the grant lasts.
- `tabs.captureTab` does not exist in Chromium (BCD, and `undefined` in C10). snapii does not use
  it (S3). **[source]** <https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/tabs.json>

### 1.3 Rate limit

- `tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` is 2 (Chrome 92+). The quota is a
  `TimedLimit` of 2 per second per extension, the error text is
  `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.`, and the quota is
  skipped when the call carries a user gesture (`ShouldSkipQuotaLimiting()` returns
  `user_gesture()`). **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/tabs.json>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/tabs/tabs_api.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/quota_service.cc>
- **C6 [measured]** Six sequential calls from the service worker: two succeed, four reject with
  exactly that text. Four parallel calls: two succeed, two reject. The same inside an
  `action.onClicked` handler (triggered through CDP): the gesture exemption did not apply there.
  Firefox has no such limit.
- **[to measure]** Whether a call made from the popup page directly inside a real click handler
  is exempt (the source says a call with a user gesture is). A capture loop that runs from the
  service worker after a message from the content script should be assumed limited to 2 per
  second.

### 1.4 Routes to a region larger than the viewport

| Route | Permission | User-visible cost | Off-viewport without scrolling | Chosen scale | Status |
| --- | --- | --- | --- | --- | --- |
| `captureVisibleTab` + scroll and stitch | `activeTab` (already there) | page scrolls visibly; 2 captures per second | no | no (native only) | C1 to C8 |
| `chrome.debugger` + `Page.captureScreenshot` | `debugger` (new) | install warnings, global infobar, resize events in the page | yes | yes | C9 |
| `chrome.tabCapture` | `tabCapture` (new) | install warning; a video stream of the tab | no | no | source |
| `chrome.desktopCapture` | `desktopCapture` (new) | install warning; picker dialog on every use | no | no | source |

**`chrome.debugger` + CDP `Page.captureScreenshot`**

- Parameters: `format`, `quality`, `clip` (`x`, `y`, `width`, `height` in device-independent px,
  `scale`), `fromSurface`, `captureBeyondViewport`, `optimizeForSpeed`; the last three are
  marked experimental. **[source]**
  <https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/public/devtools_protocol/domains/Page.pdl>
- The `Page` domain is on the extension allow list. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- Permission warnings for `debugger`: "Access the page debugger backend" and "Read and change
  all your data on all websites". snapii today shows only "Manage your downloads" and "Modify
  data you copy and paste" in Chrome (see 8). **[source]**
  <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- Attaching shows an infobar in every window, `"<extension name>" started debugging this browser`,
  with a Cancel button. It is skipped only with the `--silent-debugger-extension-api` switch or
  for policy-installed extensions. The label "does not disappear until the user dismisses it,
  even if the debugger is detached"; the code closes it 5 seconds after the last client
  detached. Cancel detaches (`onDetach` reason `canceled_by_user`). **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.h>
  (`kAutoCloseDelay = 5 s`),
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/app/generated_resources.grd>
  (`IDS_DEV_TOOLS_INFOBAR_LABEL`)
- No host permission is needed to attach; `debugger` alone covers every scriptable page. An
  attached session keeps the service worker alive (Chrome 118+). **[source]** same file,
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- A feature `DebuggerAPIRestrictedToDevMode` exists and is disabled by default. If it were
  enabled, the API would only work with developer mode on. It is a signal, not a current
  restriction. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/extension_features.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/_api_features.json>
  (`"debugger"`, comment on `developer_mode_only`)
- **C9 [measured]** (extension with `debugger`, device scale factor 2)
  - `attach` took 2 ms.
  - `clip` below the viewport with `captureBeyondViewport: true` is captured without scrolling:
    `scrollY` stays 0, the page sees no scroll event. Without `captureBeyondViewport` the same
    clip returns a blank white image of the requested size, no error.
  - `clip` is relative to the document, in device-independent px, which is CSS px times zoom
    (at zoom 1.5 the clip `{100, 3000}` started at CSS `{66.7, 2000}`).
  - `clip.scale` really magnifies: image px = `clip size * clip.scale * device scale factor`
    (300x200 at scale 2 gave 1200x800 with 400 px per 100 CSS px cell).
  - Sizes: 2000x12000 in 0.6 s, 4000x24000 (96 MP) in 2.4 to 2.8 s, 6000x32760 (196 MP) in
    5.4 s, all complete. 6000x36000 returned an image of that size whose end was blank, with no
    error. So the failure mode beyond the limit is a silently incomplete image, and the limit
    sits between 32760 and 36000 px on one side.
  - Side effect: every capture fires two `resize` events in the page, and `innerWidth` x
    `innerHeight` read inside the handler is `1x1` and then the real size again. This is the
    workaround in the implementation that sets the emulated view size to 1x1 first
    (<https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc>,
    `tmp_params.view_size = gfx::Size(1, 1)`). A page that reacts to resize (responsive
    scripts, virtualised lists, lazy loading) can change under the capture.
  - In one run `innerHeight` was 657 instead of 713 after the second attach, in another run it
    was unchanged. Not explained.
- **[to measure]** Headed: how the infobar changes the viewport height when it appears (the
  page region the user selected moves on screen), whether the 1x1 resize is visible to the
  user, the exact size limit and whether it depends on the GPU, memory use at 100+ MP.

**`chrome.tabCapture`**: needs the `tabCapture` permission (warning "Read and change all your
data on all websites"), must follow an invocation like `activeTab`, and delivers a media stream
of "the visible area of the currently active tab". It cannot see anything outside the viewport.
**[source]** <https://developer.chrome.com/docs/extensions/reference/api/tabCapture>,
<https://developer.chrome.com/docs/extensions/reference/permissions-list>

**`chrome.desktopCapture`**: `chooseDesktopMedia` "shows desktop media picker UI"; the user must
pick a source each time; warning "Capture content of your screen". It captures what is on
screen, so viewport only. **[source]**
<https://developer.chrome.com/docs/extensions/reference/api/desktopCapture>.
`getDisplayMedia` was not examined beyond that; it is the web-platform form of the same picker.

**Anything else**: no other extension API that renders page content outside the viewport was
found. `pageCapture` saves MHTML, not pixels. **[not found]**

### 1.5 Scroll and stitch

- **C8 [measured]** `position: fixed` content is painted at its viewport position in every
  capture, so it repeats in every stitched tile (Firefox paints it once, S8). Sticky content
  was not measured; by definition it also stays in the viewport while its container is on
  screen.
- **C8 [measured]** The page sees every programmatic scroll: one `scroll` event per `scrollTo`.
- **C8 [measured]** Timing: `scripting.executeScript(scrollTo)` followed at once by
  `captureVisibleTab` returned the frame from **before** the scroll in 1 of 3 attempts, in both
  runs. A capture needs to wait until the scrolled frame has been presented.
- **[to measure]** Which wait is sufficient (one or two `requestAnimationFrame` in the page, or
  a fixed delay), on a slow page and with smooth scrolling (`scroll-behavior: smooth`); what
  scroll-linked content does (lazy images, scroll-driven animations, sticky headers that hide
  on scroll down); whether the scroll position can always be restored; the visible flicker.
- Arithmetic from C1 and C6: a region of height H needs `ceil(H / viewport height)` captures at
  no more than 2 per second.

---

## 2. Background context

### 2.1 Service worker is required

- In Manifest V3 `background.scripts`, `background.page` and `background.persistent` are
  limited to manifest version 2; only `background.service_worker` is available. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/_manifest_features.json>
- One manifest may carry both keys. Chrome before 121 refused to load an MV3 extension with
  `background.scripts`; from **Chrome 121** the key is ignored (with an install warning, because
  unavailable keys are filtered out before parsing). Firefox does not support
  `background.service_worker`; before Firefox 121 its presence kept the event page from
  starting, from **Firefox 121** the event page starts regardless. Safari uses `scripts` unless
  `preferred_environment` says otherwise. **[source]**
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/manifest.cc>
- **C11 [measured]** A manifest with `background: { scripts, service_worker }`,
  `browser_specific_settings`, snapii's CSP string, `options_ui.open_in_tab: false` and SVG
  icons loads unpacked in Chromium 151 and its service worker starts.
- `web-ext lint` on such a manifest reports the warning `BACKGROUND_SERVICE_WORKER_IGNORED`
  ("ignored by Firefox"), no error. **[measured]** (web-ext 10.x from this repo's
  `node_modules`, run on the throw-away extension)

### 2.2 What is missing in the service worker

**C10 [measured]** in the extension service worker of Chromium 151, with the spec reason:

| API | In the service worker | Source |
| --- | --- | --- |
| `URL.createObjectURL` | `undefined` | `[Exposed=(Window,DedicatedWorker,SharedWorker)]`, <https://w3c.github.io/FileAPI/#creating-revoking> |
| `navigator.clipboard` | `undefined` (`ClipboardItem` not probed, same exposure in the spec) | `[SecureContext, Exposed=Window]`, <https://w3c.github.io/clipboard-apis/#clipboard-interface> |
| `Worker` constructor | `undefined` | `[Exposed=(Window,DedicatedWorker,SharedWorker)]`, <https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface> |
| `devicePixelRatio` | `undefined` | a `Window` attribute |
| `document`, DOM | `undefined` | no DOM in workers |
| `createImageBitmap` | present, works on a PNG blob | `WindowOrWorkerGlobalScope` |
| `OffscreenCanvas` (2d, `drawImage`, `getImageData`) | present, works | `[Exposed=(Window,Worker)]`, <https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface> |
| `fetch()` of a `data:` URL | works | used by the probe to decode every capture |

- Clipboard in extension service workers is being built: `navigator.clipboard` is exposed to
  extension service workers behind the feature `ClipboardOnExtensionServiceWorker`, landed
  2026-09-18 (first in 156.0.8067.0), **disabled by default**. The change description says reads
  are rejected in workers and `ClipboardItem.supports()` "refuses text/html and image/svg+xml
  there". So even when it ships it does not cover snapii's `text/html` flavour. **[source]**
  <https://chromium-review.googlesource.com/c/chromium/src/+/8348086>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/clipboard/navigator_clipboard.idl>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/common/features.cc>

### 2.3 Lifetime

- Chrome terminates the service worker "after 30 seconds of inactivity. Receiving an event or
  calling an extension API resets this timer", "when a single request, such as an event or API
  call, takes longer than 5 minutes to process", and "when a `fetch()` response takes more than
  30 seconds to arrive". Global variables are lost. Exceptions that extend the lifetime: an
  attached `chrome.debugger` session (118+), long-lived message ports (114+), WebSockets
  (116+), native messaging (105+), prompts such as `permissions.request()` (120+). **[source]**
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- The documentation says nothing about downloads or an open Save-as dialog. **[not found]**
- Consequences to check, all **[to measure]** (headed Chrome, a stopwatch, the service worker
  row on `chrome://extensions` or `chrome://serviceworker-internals`):
  - Start a save with "Ask where to save" and leave the dialog open for 60 seconds. Is the
    worker still alive, does `downloads.onChanged` still arrive (it should wake the worker), and
    is module state such as the `pending` map in `src/background/download.ts` still there?
    (Firefox: S9, the event page stays alive.)
  - Start a save whose OCR pass runs close to `OCR_BUDGET_MS` (20 s) after a capture loop of
    several seconds. Does the worker survive while it only awaits a reply from an offscreen
    document? The pending `runtime.onMessage` event from the content script should count as a
    request in flight (5 minute limit), but that was not measured.
  - Does the `activeTab` grant survive a worker restart? The grant is stored per tab in the
    browser process (`ActiveTabPermissionGranter`, see 7), so it should; Firefox: S10.

### 2.4 `chrome.offscreen`

- Needs the `offscreen` permission (no install warning), Chrome 109+, MV3 only. Reasons:
  `TESTING`, `AUDIO_PLAYBACK`, `IFRAME_SCRIPTING`, `DOM_SCRAPING`, `BLOBS`, `DOM_PARSER`,
  `USER_MEDIA`, `DISPLAY_MEDIA`, `WEB_RTC`, `CLIPBOARD`, `LOCAL_STORAGE`, `WORKERS`,
  `BATTERY_STATUS`, `MATCH_MEDIA`, `GEOLOCATION`. One document per extension (one more for a
  split-mode incognito profile). Only `AUDIO_PLAYBACK` has a lifetime limit ("All other reasons
  don't set lifetime limits"). Only `chrome.runtime` is available inside. The document cannot be
  focused. `hasDocument()` is Chrome 150+. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/api/offscreen>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/_api_features.json>
  (contexts containing `offscreen_extension`)
- **C12 [measured]**
  - `Object.keys(chrome)` in the document: `loadTimes, csi, runtime`. `runtime` has `connect`,
    `sendMessage`, `onMessage`, `onConnect`, `getURL`, `id` and the external variants. No
    `getManifest`, no `downloads`, no `tabs`.
  - A second `createDocument` rejects with `Only a single offscreen document may be created.`
  - `document.hasFocus()` is `false`, `devicePixelRatio` is defined, `Worker` and
    `navigator.clipboard` exist.
  - A `Worker` from an extension URL starts, and `WebAssembly.instantiate` works inside it
    under the CSP `script-src 'self' 'wasm-unsafe-eval'`.
  - `URL.createObjectURL` works there, and `downloads.download({ url: <that blob URL> })`
    called from the service worker completes (5 MB SVG). The browser resolves the blob URL
    itself (`ChromeBlobStorageContext::URLLoaderFactoryForUrl`,
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/download/download_manager_impl.cc>).
- **[to measure]** What happens to a running download when the offscreen document that made
  the blob URL is closed, or the URL is revoked, before the terminal `onChanged` state (the
  Firefox rule is in AGENTS.md "Traps").

---

## 3. `downloads.download`

- Source URLs. **C13 [measured]**, all from the service worker, `saveAs: false`, each ended with
  `onChanged` state `complete` and the right byte count:
  - `data:image/svg+xml;base64,...` of 41 bytes, 5 MB and 31.5 MB (a URL of 42 million
    characters). No offscreen document is needed for the download.
  - a `blob:` URL created in an offscreen document (5 MB).
  - A `blob:` URL cannot be created in the service worker at all (C10).
- Size limits: none documented. **[not found]** `url::kMaxURLChars` is 2 MB for URLs "passed
  between processes" (<https://chromium.googlesource.com/chromium/src/+/refs/heads/main/url/url_constants.h>),
  yet the 42 MB `data:` URL downloaded. **[to measure]** the same on Chrome stable on Windows
  and macOS, headed, with the real download UI (shelf/bubble, history page, Safe Browsing
  check), before relying on `data:` for large files.
- `filename`: "A file path relative to the Downloads directory to contain the downloaded file,
  possibly containing subdirectories. Absolute paths, empty paths, and paths containing
  back-references ".." will cause an error." **[source]**
  <https://developer.chrome.com/docs/extensions/reference/api/downloads#type-DownloadOptions>
- The implementation first replaces every `%` with `_` ("Strip "%" character as it affects
  environment variables"), then requires `net::IsSafePortableRelativePath`, else the call
  rejects with `Invalid filename`. A path component is refused when it is empty, absolute, `.`
  or `..`, starts with `.`, ends with a space or `.`, contains one of `" * / : < > ? \ |`, a
  control or format character (`Cc`, `Cf`), starts or ends with whitespace or `~`, is a
  Windows reserved name (`CON`, `NUL`, ...) or ends in a shell-integrated extension. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/downloads/downloads_api.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/filename_util_icu.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/filename_util.h>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/i18n/file_util_icu.cc>
- **C13 [measured]** `Invalid filename` for `/abs.svg`, `../up.svg`, `a/../b.svg`,
  `.hidden/x.svg`, `a./x.svg`, `a:b/x.svg`, `~/x.svg`, `CON/x.svg`. Accepted: `a%b/x.svg`,
  `a<no-break space>b/x.svg`, `a b/ok name.svg`.
- Compared with the Firefox rules in `src/shared/folder.ts`: the same shape (relative only, no
  `..`, no leading or trailing dot, the Windows-reserved characters, `%` becomes `_`).
  Differences: Chrome also refuses Windows reserved device names on every platform and a
  component that starts or ends with `~`; Chrome accepts a no-break space inside a name, Firefox
  refused it. `checkFolder` is stricter than Chrome everywhere except reserved device names.
- **[to measure]** The final path on disk: that missing subfolders are created and that `a%b`
  is saved as `a_b`. Playwright's download interception renamed every file to a GUID, so the
  path was not observable here.
- `saveAs`: "Use a file-chooser to allow the user to select a filename regardless of whether
  `filename` is set or already exists." **[source]** Chrome docs above. With `saveAs: false` the
  user's setting "Ask where to save each file before downloading" still applies: the target
  determiner prompts for `TARGET_DISPOSITION_PROMPT` (that is `saveAs: true`) and otherwise
  follows the `PromptForDownload` preference. Neither applies when the download directory is
  managed by policy. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/download/download_target_determiner.cc>
  (`NeedsConfirmation`)
- `download()` resolves with the id when the download item has been created
  (`DownloadsDownloadFunction::OnStarted`), which is before the file name is determined.
  **[source]** downloads_api.cc. **[to measure]** (headed): cancelling the Save-as dialog. In
  Firefox `download()` rejects and no `onChanged` arrives (`src/background/download.ts`). In
  Chrome the expected sequence is: resolved id first, then `onChanged` with `state: interrupted`
  and `error: USER_CANCELED`. Record the exact events.
- States: `in_progress`, `interrupted`, `complete`; `onChanged` delivers deltas
  (`{ id, state: { previous, current } }`). Promises since Chrome 96. **[source]** Chrome docs
  above. **C13 [measured]** `state.current === "complete"` arrived for every download.
- Install warning for `downloads`: "Manage your downloads". **[source]**
  <https://developer.chrome.com/docs/extensions/reference/permissions-list>

---

## 4. Commands

- `commands.update` and `commands.reset` do not exist in Chrome. The API has `getAll` and
  `onCommand` only. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/commands.json>,
  <https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/commands.json>
  (`update`, `reset`: Chrome `false`, Firefox 60). **C10 [measured]** both `undefined`.
- Users change shortcuts at `chrome://extensions/shortcuts`. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/api/commands>
- An extension may open that page: `tabs.create` only refuses `javascript:`, crash URLs,
  `devtools:` and `chrome-untrusted:`. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/extension_tab_util.cc>
  (`PrepareURLForNavigation`). **C15 [measured]** `tabs.create({ url: "chrome://extensions/shortcuts" })`
  resolved with that `pendingUrl`. **[to measure]** the same in Edge (`edge://extensions/shortcuts`).
- A command shortcut grants `activeTab`: the keybinding registry calls
  `ActiveTabPermissionGranter::GrantIfRequested` before it dispatches `onCommand` (not for media
  keys, not for global commands). The documentation lists "Executing a keyboard shortcut from
  the commands API" among the gestures. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/extension_keybinding_registry.cc>,
  <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>.
  **[to measure]** with a real key press.
- `_execute_action` does not dispatch `onCommand`; with a popup it opens the popup. **[source]**
  Chrome commands docs.
- Limits: "may specify at most four suggested keyboard shortcuts"; shortcuts "must include
  either `Ctrl` or `Alt`"; `Ctrl+Alt` is not permitted; media keys take no modifier; on macOS
  `Ctrl` becomes `Command` and `MacCtrl` is the Control key. `Alt+Shift+S` is valid. **[source]**
  Chrome commands docs,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/command.cc>
- A suggested key that is already taken by another extension, or that is a Chrome accelerator,
  is not assigned; the command stays without a shortcut and no error is raised. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/commands/command_service.cc>
  (`AddKeybindingPref` "Already taken", `CanAutoAssign`). The documentation does not describe
  this. Suggested keys are applied at install time; whether a changed suggestion is applied on
  update was not checked. **[to measure]**
- **C15 [measured]** `commands.getAll()` returned
  `[{ name: "_execute_action", description: "", shortcut: "" }, { name: "start-capture", description: "Capture a region", shortcut: "Alt+Shift+S" }]`.
  Same shape as Firefox (`name`, `description`, `shortcut`).
- Consequences in this repo, as facts: the shortcut recorder on the options page
  (`commands.update` / `commands.reset` in `src/options/options.ts`) and
  `src/background/legacy-shortcut.ts` have no Chromium equivalent. The Firefox-specific
  validation in `src/shared/shortcut.ts` (F13 to F19, the modifier rules of
  `ShortcutUtils.validate`) describes an API that is not there.

---

## 5. Namespace and promises

- "From Chrome 148, all Chrome Extension APIs are available under the `browser` namespace";
  "it points to the same API objects as `chrome`, so `chrome.tabs === browser.tabs`"; available
  in content scripts, service workers and offscreen documents; before Chrome 152 it was disabled
  for the whole extension if the manifest declared a `devtools_page` (snapii has none).
  `webextension-polyfill` "becomes a no-op on Chrome 148 and later". Advice for new extensions:
  `"minimum_chrome_version": "148"` and use `browser` unconditionally; for older browsers
  `if (!globalThis.browser) { globalThis.browser = chrome; }`. **[source]**
  <https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace>,
  <https://developer.chrome.com/docs/extensions/whats-new> (entry of 2026-05-08)
- **C10, C12, C18 [measured]** `typeof browser === "object"` in the service worker, an extension
  page, an offscreen document and a content script; `browser.tabs === chrome.tabs`.
- Promises: every API snapii uses returns a promise in MV3 when no callback is passed:
  `tabs.*` since Chrome 88 (`tabs.sendMessage` 99), `downloads.*` 96, `action.*` 96,
  `scripting.executeScript` from its introduction, `storage`, `commands.getAll`, `runtime.*`.
  **[source]** the per-API reference pages under
  <https://developer.chrome.com/docs/extensions/reference/api>. All calls in the probe used
  promises. **[measured]**
- `runtime.onMessage` listeners: "From Chrome 148, you can return a promise from a message
  listener to respond asynchronously. This update is rolling out gradually". Before that:
  `sendResponse` plus a literal `return true`. An `async` listener always returns a promise, so
  it answers every message (with `null` when it returns nothing); a rejection must be an `Error`
  for the sender to see its message. **[source]**
  <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>.
  **C14 [measured]** a listener that returns a promise answered `runtime.sendMessage` in 151.
  **[to measure]** that the gradual rollout is complete in Chrome 154 stable.
- Serialisation differs: "In Chrome, the message passing APIs use JSON serialization", other
  browsers use structured clone. `undefined`, `NaN`, `Map`, `Blob`, typed arrays do not survive.
  An opt-in to structured clone was announced on 2026-04-22 (version not read). **[source]**
  messaging docs and what's-new page above. **[to measure]** that every `ToBackground` /
  `ToContent` message in `src/shared/types.ts` round-trips through JSON (tiles are data URL
  strings, which do).
- `runtime.getBrowserInfo` is absent (BCD: Firefox 51, Chrome `false`; `undefined` in C10).
  `src/shared/about.ts` already wraps it in `try`, but `browser.runtime.getBrowserInfo()` on
  `undefined` throws a `TypeError` inside that `try`, so the line just omits the browser version.
  **[source]** <https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/runtime.json>
- `action.setTitle({ tabId, title: null })` (used by `src/background/flag.ts` to restore the
  default) throws in Chrome: `Error at parameter 'details': Missing required property 'title'.`
  `action.setBadgeText({ tabId, text: null })` is accepted. **C16 [measured]**. Schema:
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/action.json>.
  **[to measure]** what restores the manifest title for one tab (empty string?).
- Is `webextension-polyfill` still needed for this API surface: no, with a minimum of Chrome
  148. **[source]** browser-namespace page.

---

## 6. Manifest

- Icons: "WebP and SVG files are not supported" (`icons`); for the action "SVG isn't supported.
  Unpacked extensions must use PNG images." Always provide 128x128 (install, Web Store), 48x48
  (management page), 16x16. BCD: `icons.svg_icons` Chrome `false`, Firefox 92. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/manifest/icons>,
  <https://developer.chrome.com/docs/extensions/reference/api/action>,
  <https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/icons.json>
- **C11 [measured]** A manifest whose `icons` and `action.default_icon` point at an SVG still
  loads unpacked in Chromium 151 and the extension is enabled. Whether anything is drawn in the
  toolbar was not visible headless. **[to measure]** headed; and whether the Web Store upload
  accepts it. Treat PNG as required.
- `browser_specific_settings` is explicitly ignored without a warning
  (`kIgnoredUnrecognizedKeys`). **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/manifest_constants.h>
- Unknown keys in Chrome: an install warning ("Unrecognized manifest key"), not an error; "we
  will ignore keys that are not features; we do this for forward compatibility". Keys that exist
  but are not available for the manifest version (such as `background.scripts` in MV3) are a
  warning too and are filtered out. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/manifest.cc>
- Unknown things in Firefox: `web-ext lint` gave warnings, not errors, for
  `background.service_worker` (`BACKGROUND_SERVICE_WORKER_IGNORED`) and for the permission
  `offscreen` (`MANIFEST_PERMISSIONS: Invalid permissions "offscreen"`). **[measured]**
- `options_ui.open_in_tab`: supported (Chrome 40). `false` embeds the page in
  `chrome://extensions`. **[source]**
  <https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/options_ui.json>
- `minimum_chrome_version`: the manifest key that corresponds to `strict_min_version`.
  **[source]** <https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version>
- CSP: the default for `extension_pages` is `script-src 'self'; object-src 'self';`, and the
  most permissive value allowed is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`.
  snapii's string `script-src 'self' 'wasm-unsafe-eval'; upgrade-insecure-requests` was
  accepted (C11) and WASM compiled under it in a worker (C12). **[source]**
  <https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/manifest_handlers/csp_info.cc>
- One shared manifest or one per browser: a single file is loadable by both (C11, Firefox 121+
  and Chrome 121+). It stops being clean as soon as Chromium needs something Firefox does not
  know: PNG icons instead of the SVG, `minimum_chrome_version`, and any Chromium-only permission
  such as `offscreen` or `debugger`, which shows up as a lint warning in Firefox and would
  change the permission list that AGENTS.md calls a public contract. MDN documents the
  both-keys manifest as the cross-browser pattern; no primary source states that a generated
  per-browser manifest is "the norm". **[not found]** for the norm claim.

---

## 7. Injection and `activeTab`

- `scripting.executeScript` needs `scripting` plus host permission or `activeTab`. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- **C7 [measured]** with snapii's permission list only:
  - Before any invocation: `executeScript` rejects with
    `Cannot access contents of the page. Extension manifest must request permission to access the respective host.`;
    `tabs.get` returns a tab without `url` and `title`; `tabs.getZoom` works.
  - After the action was triggered: `executeScript` (function and file) works, `tabs.get` shows
    `url` and `title`.
  - The grant is per tab. It survives switching to another tab and back, and injection into the
    granted tab works while it is in the background. It survives a same-origin navigation and a
    reload. It ends with a cross-origin navigation.
  - While another tab without a grant is active, `captureVisibleTab` rejects. Firefox: a grant
    on another tab can let the wrong tab be captured (comment in `src/background/capture.ts`);
    in Chromium the same holds if that other tab has its own grant.
- When the grant ends, from the source: on a committed main-frame navigation that is not
  same-document and not same-origin, on every non-same-document navigation of a `chrome://`
  page, and when the tab is destroyed. Same-origin navigations keep it. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/permissions/active_tab_permission_granter.cc>,
  <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>.
  Firefox for comparison: S10 (survives suspension and tab switch, a navigation drops it).
- Result and error shape, **C17 [measured]**: each entry is `{ documentId, frameId, result }`.
  `false` stays `false`; `undefined` and `NaN` become `null`; a `Map` and a DOM node become
  `{}`; a returned promise is awaited; a thrown error or a rejected promise gives
  `result: null` with **no** `error` property and no rejection. Documentation: results are
  JSON-serialised, promises are awaited (Chrome 90+), Chrome "does not support the `error`
  property yet". **[source]** Chrome scripting docs,
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript>
  - Effect on `src/background/start.ts`: the probe returns a boolean, which survives. The
    Firefox special case "resolves with `[null]` on about:addons" does not occur in the same
    form: Chromium rejects on pages it will not script.
- With several frames, Chrome runs nothing if any targeted frame is not accessible (Firefox and
  Safari return partial results). snapii injects into the top frame only. **[source]** MDN page
  above (crbug 1325114).
- Pages where injection is refused, **C17 [measured]** (extension with `<all_urls>`):
  - `chrome://version/`, `chrome://extensions/`: `Cannot access a chrome:// URL`
  - another extension's page: `Cannot access a chrome-extension:// URL of different extension`
  - top-level `about:blank`, `data:` URL: `Cannot access contents of url "..."` (the URL is
    shown because the probe had the `tabs` permission; without it the text is the generic
    "Cannot access contents of the page ...")
  - From the source, not measured: the Chrome Web Store (`The extensions gallery cannot be scripted.`),
    the New Tab Page (`The New Tab Page cannot be scripted.`), `file:` URLs unless the user
    enabled "Allow access to file URLs" (also required for `captureVisibleTab` on file URLs).
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/manifest_constants.h>,
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/permissions/permissions_data.cc>
  - A PDF tab: with `<all_urls>` the injection **succeeded** and the probe returned `"html"`
    (headless). `hasHtmlRoot()` in `start.ts` would therefore pass on the PDF viewer's wrapper
    page.
- `captureVisibleTab` on `chrome://`, `data:` and other extensions' pages is allowed with an
  `activeTab` grant only ("These sensitive sites can only be captured with the activeTab
  permission"). With `<all_urls>` alone it rejected with
  `The 'activeTab' permission is not in effect because this extension has not been in invoked.`
  **[source]** Chrome tabs docs; **C17 [measured]**. So on a `chrome://` page under `activeTab`
  the screenshot would work while the content script cannot be injected.
- **[to measure]** under `activeTab` only, headed: the PDF viewer, the Web Store, the New Tab
  Page, a `file:` page with and without the toggle, `view-source:`. Record the exact message
  for each, as `cannotRun()` shows it to the user.

---

## 8. Clipboard

- Rules in the Blink source for `navigator.clipboard.write` in a window: the document must be
  focused (else `NotAllowedError: Document is not focused.`), the context must be secure
  (`[SecureContext]`); permission is then granted at once if the running script context is an
  extension context with `clipboardWrite` or a privileged extension page, otherwise it needs
  transient user activation. For `document.execCommand("copy")`: allowed with user activation
  and focus, or when the same extension check passes (no focus requirement on that path).
  **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/clipboard/clipboard_promise.cc>,
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/renderer/chrome_content_settings_agent_delegate.cc>
  (`AllowWriteToClipboard`),
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/editing/commands/clipboard_commands.cc>
  (`CanWriteClipboard`)
- What `clipboardWrite` changes in Chrome: it shows the install warning "Modify data you copy
  and paste" and it is what lets a content script or an offscreen document write without a user
  gesture. Ordinary extension pages (popup, options) can always write. **[source]**
  <https://developer.chrome.com/docs/extensions/reference/permissions-list>, files above
- **C18 [measured]** Content script, isolated world, extension has `clipboardWrite`, injected
  from the service worker (no user gesture):
  - Secure page (`http://127.0.0.1`), document focused:
    `navigator.clipboard.write([ClipboardItem{text/plain, text/html}])` resolved.
  - Non-secure page (`http://insecure.test`): `navigator.clipboard` is `undefined`, as in
    Firefox (S12). `document.execCommand("copy")` with a capture-phase `copy` listener that
    calls `clipboardData.setData` for `text/plain` and `text/html` returned `true`, and both
    flavours were read back from the clipboard by another page.
- **C12 [measured]** Offscreen document: `navigator.clipboard.write` rejects with
  `NotAllowedError: Failed to execute 'write' on 'Clipboard': Document is not focused.`
  `document.execCommand("copy")` with the same `copy` listener returned `true`, and both
  flavours were read back. Chrome's own sample says the same: "the `navigator.clipboard` API
  requires that the window is focused, but offscreen documents cannot be focused. As such, we
  have to fall back to `document.execCommand()`." **[source]**
  <https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write>
- Service worker: no clipboard API (C10); flag-gated work in progress without `text/html`
  (2.2).
- So the background fallback of `src/background/clipboard.ts` (S12) has two possible Chromium
  counterparts, both measured to write `text/html` + `text/plain`: `execCommand("copy")` in the
  content script itself, where the page's own `copy` listeners take part in the event, or
  `execCommand("copy")` in an offscreen document, which needs the `offscreen` permission.
- **[to measure]** headed, real OS clipboard, paste into another application: both flavours
  arrive; the content-script path on a page that registers its own `copy` listener on `window`
  in the capture phase and calls `preventDefault()`; the content-script path when focus is in
  the snapii toolbar's shadow tree; `navigator.clipboard.write` when the page's
  `Permissions-Policy` disables `clipboard-write` (the source rejects before the extension
  check).

---

## 9. Content-side web platform (isolated world)

All **C18 [measured]** in a content script injected with `scripting.executeScript({ files })`,
on a page without a CSP:

- Constructable stylesheets: `new CSSStyleSheet()`, `replaceSync`, and
  `shadowRoot.adoptedStyleSheets = [sheet]` on a **closed** shadow root apply (computed colour
  checked). `document.adoptedStyleSheets = [sheet]` applies too. No Chromium bug or restriction
  for content scripts was found. **[not found]** for known bugs.
  `adoptedStyleSheets`: Chrome 73.
  **[to measure]** the same on a page with a strict `style-src` CSP, including the CSSOM
  `style.setProperty(..., "important")` path of `src/content/overlay/styles.ts` (the AGENTS.md
  trap states the Firefox behaviour).
- `Element.checkVisibility({ visibilityProperty: true })`: returned `true`, and `false` for
  `visibility: hidden`. Option support: `checkVisibility` Chrome 105, `visibilityProperty`,
  `opacityProperty`, `contentVisibilityAuto` Chrome 121. **[source]**
  <https://github.com/mdn/browser-compat-data/blob/main/api/Element.json>
- Closed shadow roots. `src/content/extract/flat-tree.ts` and `src/content/overlay/pick.ts` use
  two Gecko-only accessors with a fallback to the open-only properties:
  - `element.openOrClosedShadowRoot`: `undefined` in Chromium. The equivalent is
    `chrome.dom.openOrClosedShadowRoot(element)` (Chrome 88+, available to content scripts); it
    returned the closed root. **[source]**
    <https://developer.chrome.com/docs/extensions/reference/api/dom>,
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/_api_features.json>
    (`"dom"`: contexts `privileged_extension`, `content_script`)
  - `node.openOrClosedAssignedSlot`: no Chromium equivalent. `node.assignedSlot` is `null` when
    the slot is in a closed tree. `slot.assignedNodes()` on a slot reached through
    `chrome.dom.openOrClosedShadowRoot(host)` does list the node, so the flat-tree parent can
    be derived.
  - Without a shim the existing fallback silently treats closed shadow trees as absent.
- Text fragments: `fragment-generation-utils.js` is "a module of util functions for generating
  URLs with a text fragment"; the polyfill "is used in Chromium for iOS as well as the Link to
  Text Fragment Browser Extension", which is a Chrome extension. **[source]**
  <https://github.com/GoogleChromeLabs/text-fragments-polyfill>.
  **[to measure]** (the Chromium counterpart of S11): bundle `src/content/fragment.ts` as is,
  inject it in Chromium, generate a fragment for a selection, open the resulting URL and check
  the highlight; repeat the freeze case from AGENTS.md (a range in a shadow tree or an SVG
  document) to confirm `generatorCanHandle` still guards it.

---

## 10. tesseract.js 7

- Where the engine can run. tesseract.js in a browser always spawns a Web Worker
  (`new Worker(workerPath)` or, with `workerBlobURL`, a blob worker that calls
  `importScripts(workerPath)`). The `Worker` constructor does not exist in a service worker
  (C10). So in Chromium the engine runs in a document: an extension page (popup and options are
  short-lived) or an offscreen document with reason `WORKERS`. **[source]**
  <https://github.com/naptha/tesseract.js/blob/master/src/worker/browser/spawnWorker.js>,
  <https://github.com/naptha/tesseract.js/blob/master/docs/api.md> (`workerBlobURL`, default
  `true`)
- CSP: the core is WebAssembly, so `'wasm-unsafe-eval'` is needed, which snapii's manifest
  already has and which is the most Chrome allows (see 6). **C12 [measured]** a worker loaded
  from an extension URL compiled WASM in an offscreen document under snapii's CSP string.
- Blob workers: `workerBlobURL: false` stays necessary. In an MV3 Chrome extension the blob
  worker's `importScripts` of the extension's own `worker.min.js` is refused by the CSP
  ("Refused to load the script 'chrome-extension://.../worker.min.js' because it violates the
  following Content Security Policy directive: "script-src 'self' 'wasm-unsafe-eval' ..."), and
  the reporter fixed it with `workerBlobURL: false`. **[source]**
  <https://github.com/naptha/tesseract.js/issues/961>. (In C12 a trivial blob worker without
  `importScripts` did start in the offscreen document; that does not contradict the issue.)
- First-party guidance: `docs/local-installation.md` documents `workerPath`, `langPath`,
  `corePath` for fully local files and recommends pointing `corePath` at a directory with all
  four core builds; setting it to one `.js` file "is strongly discouraged" but supported. The
  README lists an MV3 Chrome extension among the projects. There is no dedicated extension
  guide. **[source]**
  <https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md>,
  <https://github.com/naptha/tesseract.js/blob/master/README.md>
- Compared with `src/background/ocr.ts`: the options (`workerPath`, single-file `corePath`,
  `langPath`, `workerBlobURL: false`, `cacheMethod: "none"`, `gzip: true`) carry over
  unchanged; `runtime.getURL` exists in an offscreen document (C12). What does not carry over
  is the place: `createWorker`, the `globalThis.Worker` wrapper, `OffscreenCanvas` cropping and
  `createImageBitmap` all run in the background page today, and in Chromium the part that
  constructs the `Worker` cannot run in the background. The comment "moz-extension pages may not
  start blob: workers (Firefox bug 1294996)" has the Chromium counterpart above.
- **[to measure]** Run the real engine in an offscreen document in Chromium: `createWorker`
  with the options of `workerOptions()`, recognise the glue fixture, compare the words and the
  time against Firefox (0.4 to 0.5 s per area there). Also: the size of a `runtime.sendMessage`
  from the service worker to the offscreen document that carries the tiles as data URLs (the
  message size limit was not verified here), and whether the service worker stays alive for the
  whole pass (2.3).

---

## 11. Testing and tooling

- Loading an unpacked extension by command line: from **Chrome 137** branded Chrome no longer
  honours `--load-extension` ("`--load-extension` will continue to function as before in non
  Chrome brands, such as Chromium and Chrome For Testing"), and from Chrome 139 the same for
  `--disable-extensions-except` and `--extensions-on-chrome-urls`. Named alternatives: Chrome
  for Testing, Chromium, the "Load unpacked" button, WebDriver BiDi `webExtension.install` or
  CDP with `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`. **[source]**
  <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ>,
  <https://developer.chrome.com/docs/extensions/whats-new> (entry of 2025-06-30),
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/extension_features.cc>
  (`kDisableDisableExtensionsExceptCommandLineSwitch`, enabled for Google Chrome branding only)
- CDP `Extensions` domain (experimental): `loadUnpacked` ("Installs an unpacked extension from
  the filesystem similar to --load-extension CLI flags"), `triggerAction` ("Runs an extension
  default action", parameters `id`, `targetId`), `getExtensions`, `uninstall`, and storage
  accessors. **[source]**
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/public/devtools_protocol/domains/Extensions.pdl>
- Playwright: extensions need the Chromium bundled with Playwright ("Google Chrome and Microsoft
  Edge removed the command-line flags needed to side-load extensions"), a persistent context,
  `--disable-extensions-except` and `--load-extension`; `channel: "chromium"` gives headless
  with extensions; the service worker is `context.serviceWorkers()[0]` or
  `context.waitForEvent("serviceworker")`, the extension id is in its URL; after a worker
  restart in-flight `evaluate()` calls can throw. **[source]**
  <https://playwright.dev/docs/chrome-extensions>
- **C19 [measured]** playwright-core 1.63 with `executablePath: "/bin/chromium"` (151, new
  headless) and those two arguments loaded the extension; `serviceWorker.evaluate()` called
  extension APIs; an extension page opened as a tab by its `chrome-extension://` URL.
- **C19 [measured]** Triggering the action: `Extensions.triggerAction` sent on the **browser**
  CDP session (`context.browser().newBrowserCDPSession()`), with the `targetId` of the target of
  type `tab` (from `Target.getTargets` with `filter: [{ type: "tab" }]`), fired
  `action.onClicked` and granted `activeTab`. With a page-type target id it fails with
  `Action can only be triggered on a tab target.` The browser had been started with
  `--enable-unsafe-extension-debugging`; whether the flag is required was not isolated.
  **[to measure]** what `triggerAction` does when the action has a `default_popup`, as snapii's
  does (opens the popup and grants `activeTab`?), and whether the popup can then be driven.
- Triggering a command programmatically: no CDP method or extension API for it was found.
  **[not found]** The glue test that presses the key "as real key events at the browser window"
  (Marionette) has no counterpart identified here. CDP `Input.dispatchKeyEvent` targets page
  content; whether it reaches extension accelerators was not measured. **[to measure]**
- `web-ext run --target chromium` exists, with `--chromium-binary`, `--chromium-profile`,
  `--chromium-pref`. **[source]**
  <https://extensionworkshop.com/documentation/develop/web-ext-command-reference/>.
  **[to measure]** that it still loads the extension in branded Chrome 137+ (it should be
  pointed at Chromium or Chrome for Testing).
- `web-ext lint` validates for Firefox only. On a Chromium-flavoured manifest it warns about
  `background.service_worker` and about permissions Firefox does not know (see 6). There is no
  Chromium linter in web-ext. **[source]** same page; **C20 [measured]**
- The existing glue suite and `pnpm drive` speak Marionette, which is Firefox only. The layout
  tests run in Playwright's Firefox and do not load the extension.

---

## 12. Distribution

- Chrome Web Store policies that apply: "Request access to the narrowest permissions necessary
  to implement your Product's features or services"; "An extension must have a single purpose
  that is narrow and easy to understand"; "Developers must not obfuscate code or conceal
  functionality of their extension ... Minification is allowed"; for MV3 "the full functionality
  of an extension must be easily discernible from its submitted code", no remotely hosted code.
  Bundled WASM and bundled, unminified code are within these rules; WebAssembly is not
  mentioned. **[source]** <https://developer.chrome.com/docs/webstore/program-policies/policies>
- Review: "For most extensions, review is completed within a few days, but it can take up to a
  few weeks"; broad host permissions and "dangerous permission requests" lead to closer
  examination, as do new developers and new extensions; "The more code an extension contains,
  the more work it takes to verify". **[source]**
  <https://developer.chrome.com/docs/webstore/review-process>
- `debugger` (only if question 1 leads there): no policy text specific to it was found.
  **[not found]** What is certain is the install warning pair in 1.4, the general
  narrowest-permission rule, and that the dashboard's "Permissions justification" section has
  "a field for you to state the justification for each" declared permission
  (<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>). snapii's current list
  gives two warnings in Chrome ("Manage your downloads", "Modify data you copy and paste") and
  none of the "all websites" kind.
- "Always provide a 128x128 icon; it's used during installation and by the Chrome Web Store"
  (see 6).
- Edge: "The Extension APIs and manifest keys supported by Chrome are code-compatible with
  Microsoft Edge." To port: check the API list, remove `update_url`, do not use "Chrome" in name
  or description, sideload and test, then publish through Partner Center, which is a separate
  account, listing and certification. Every API snapii uses (`action`, `commands`, `downloads`,
  `offscreen`, `scripting`, `storage`, `tabs`, `dom`, `runtime`, and `debugger`) is on Edge's
  supported list. **[source]**
  <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension>,
  <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support>
- **[to measure]** in Edge: C1 to C7 (the undocumented `rect`/`scale` options in particular),
  the `browser` namespace and promise-returning listeners on current Edge stable, the shortcuts
  page URL, the Save-as behaviour.

---

## Summary table

Gap kinds: **none**, **rename** (same thing under another name or key), **shim** (a small
adapter keeps the design), **redesign** (the feature has to work differently), **impossible**
(under the current permission contract: `activeTab, scripting, downloads, clipboardWrite, storage`,
no host permissions, no network).

| Firefox dependency (where) | Chromium equivalent | Gap |
| --- | --- | --- |
| `captureVisibleTab` `rect` relative to the document, captured outside the viewport without scrolling (S1, S2, D1; `capture.ts`) | `rect` crops the viewport only (140+, undocumented), integers, `scale` must equal the zoom (C2 to C5) | impossible as a single capture; redesign as scroll and stitch, or `debugger` permission (C9) |
| `scale` chosen per capture, output = rect x scale x zoom (S5, S6, D2; `captureScale`) | native resolution only, `rect x zoom x device scale factor` (C1, C5) | shim (resample with `OffscreenCanvas`) for smaller; impossible for larger without `debugger` |
| Per-call pixel limits 32766 px / 472 MP (S7, D3; `planTiles`) | not applicable to viewport captures; `Page.captureScreenshot` blanks silently above about 32760 px on a side (C9) | redesign (tile plan follows the viewport) |
| `position: fixed` painted once (S8) | painted in every viewport capture (C8) | redesign |
| No capture rate limit | 2 calls per second, error on the third (C6) | shim (pacing) |
| Background `devicePixelRatio` (`captureRegion`) | not defined in a service worker (C10); page `devicePixelRatio` = device scale factor x zoom | shim |
| `tabs.getZoom`, `tabs.get`, `tabs.sendMessage` | same, promises | none |
| `tabs.captureTab` (S3, unused) | absent | none |
| Event page `background.scripts` (`main.ts`) | `background.service_worker`; both keys allowed since Chrome 121 / Firefox 121 (C11) | rename |
| Event page stays alive during Save-as (S9), module state kept | service worker stops after 30 s idle, state lost; behaviour during Save-as unknown | shim, to measure |
| `URL.createObjectURL` in the background (D4; `download.ts`) | absent in the service worker; `data:` URL download works (C13), or blob URL from an offscreen document (C12) | shim |
| `downloads.download` file name rules (`folder.ts`, `filename.ts`) | nearly identical; also refuses Windows device names and `~` at the ends (C13) | none |
| `download()` rejects on Save-as cancel, no `onChanged` | resolves early; cancel expected as `interrupted` | shim, to measure |
| `downloads.onChanged` terminal states | same states | none |
| `navigator.clipboard.write` in the background as fallback (S12; `background/clipboard.ts`) | no clipboard in the service worker; `execCommand("copy")` in the content script or in an offscreen document (C12, C18) | shim (the offscreen variant adds the `offscreen` permission) |
| `navigator.clipboard.write` in the content script on secure pages (S12) | same, without a user gesture given `clipboardWrite` (C18) | none |
| tesseract.js `Worker` started from the background (`ocr.ts`) | no `Worker` in the service worker; offscreen document with reason `WORKERS` (C12) | redesign (new context, message hop); adds the `offscreen` permission |
| `OffscreenCanvas`, `createImageBitmap`, `fetch(data:)` in the background | available in the service worker (C10) | none |
| `commands.update` / `commands.reset` (options page recorder, `legacy-shortcut.ts`, `shortcut.ts` rules) | absent; user edits at `chrome://extensions/shortcuts`, which `tabs.create` can open (C15) | impossible; redesign of the options UI |
| `commands.getAll`, `onCommand`, shortcut grants `activeTab` | same; at most 4 suggested keys; a taken key stays unassigned | none |
| `browser.*` namespace with promises | native since Chrome 148 (C10) | none with `minimum_chrome_version` 148, otherwise shim |
| `runtime.onMessage` listener returns a promise (`main.ts`, `content/main.ts`) | since Chrome 148, rollout gradual (C14) | none, or shim (`sendResponse` + `return true`) |
| Structured clone in messaging | JSON serialisation | none if messages are JSON-safe, to measure |
| `runtime.getBrowserInfo` (`about.ts`) | absent; the existing `try` swallows it | none (cosmetic: "Firefox" label) |
| `action.setTitle({ title: null })` (`flag.ts`) | throws, `title` is required (C16) | shim |
| `scripting.executeScript` probe, `[null]` on privileged pages (`start.ts`) | rejects on restricted pages; a throw in the page gives `result: null` (C17); PDF viewer may pass the probe | shim (messages, PDF case) |
| `activeTab` grant lifetime (S10) | per tab, survives tab switch and same-origin navigation, ends on cross-origin navigation (C7) | none |
| SVG icons (`icons`, `action.default_icon`) | not supported, PNG required | rename (assets) |
| `browser_specific_settings.gecko` | ignored without warning | none |
| `strict_min_version` | `minimum_chrome_version` | rename |
| CSP `'wasm-unsafe-eval'` | same, and it is the maximum allowed | none |
| `element.openOrClosedShadowRoot` (`flat-tree.ts`, `pick.ts`) | `chrome.dom.openOrClosedShadowRoot(element)` (C18) | shim |
| `node.openOrClosedAssignedSlot` (`flat-tree.ts`) | none; derive from `slot.assignedNodes()` of the closed root (C18) | shim |
| `adoptedStyleSheets`, CSSOM `!important` (`styles.ts`) | same (C18); strict-CSP page to measure | none |
| `Element.checkVisibility({ visibilityProperty })` (`fragment.ts`) | Chrome 121+ (C18) | none |
| text-fragments-polyfill generator in the content script (S11) | expected to work, not measured | none, to measure |
| `storage.sync` / `storage.local` / `storage.onChanged` | same API (quotas not compared here) | none |
| `runtime.getURL`, `getManifest`, `getPlatformInfo`, `openOptionsPage` | same | none |
| Glue tests and `pnpm drive` over Marionette | Playwright or raw CDP, `Extensions.triggerAction` (C19); no way found to press a command key | redesign (tooling) |
| `web-ext lint` | Firefox only; warns on Chromium-only keys and permissions (C20) | none for Firefox, no equivalent for Chromium |
