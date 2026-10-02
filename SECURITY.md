# Security policy

## Reporting

Do not open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/bmmmm/snapii/security/advisories/new)
for this repository.

Useful in a report: a page (or a minimal HTML file) that reproduces it, what
happens, the impact you see, and the version line from the bottom of snapii's
menu or settings page. Expect a first response within a week. snapii is a
small volunteer project in beta — there is no bounty, and no SLA beyond a
genuine effort to fix real issues quickly and credit you. Only the latest
release gets fixes.

## What is in scope

snapii reads arbitrary, possibly hostile web pages and writes what it reads
into a file that people open in a browser, into the clipboard, and into a
link. Anything that turns page content into more than inert text and pixels
is in scope:

- **Active content in a saved SVG.** Page text, titles, URLs, font names,
  `alt` text and link targets all end up in the file. A page that gets a
  `<script>`, an event-handler attribute, a `javascript:` or `data:` link, an
  external resource load or broken-out markup into the SVG is a vulnerability
  — the file is opened in a browser, often from the local disk.
- **Active content on the clipboard.** Copy text's HTML flavour is pasted into
  rich editors; anything in it that runs, loads, styles or tracks is in scope.
- **A page escalating through the extension.** The content script lives inside
  the page; a page that forges or tampers with messages to the background
  page (`src/shared/messages.ts`) to capture something you did not select,
  read another tab, write a file under a name or path it chose, or reach the
  extension's own pages.
- **More in the file than you selected.** Text the capture does not show
  (hidden elements, form field values, password fields, cross-origin frame
  content, other tabs) ending up in the SVG, the clipboard or the link.
- **Anything leaving the browser.** snapii promises no network requests at all
  and declares `data_collection_permissions: none`. A request of any kind —
  from the extension, the OCR engine or the saved file when opened — breaks
  that promise.
- **Permission creep.** snapii runs with `activeTab`, `scripting`, `downloads`,
  `clipboardWrite` and `storage`, and no host permissions. A way to act on a
  tab you did not click snapii in is in scope.
- **The download file name.** It is built from the page title
  (`src/shared/filename.ts`); a title that escapes the download directory or
  produces a dangerous file type is in scope.

## What is not

- **The page URL in the saved file.** A saved SVG contains the full page URL
  with its query string, the page title, the capture time and a text-fragment
  link — by design and documented in the README's "Privacy" section and
  [docs/details.md](docs/details.md#privacy-and-permissions). Check a file
  before sharing it.
- **A page blocking snapii.** A page can, for example, pre-register snapii's
  custom-element names so the overlay does not appear. That is denial of
  service against yourself on that page, a known limitation, not a
  vulnerability.
- **Pages Firefox protects.** snapii cannot run on `about:` pages, the PDF
  viewer or addons.mozilla.org; that is Firefox's rule.
- **Vulnerabilities in Firefox, tesseract.js or text-fragments-polyfill
  themselves** — report those upstream. How snapii *uses* them is in scope.
- **Viewers.** How a third-party program renders or scripts SVG files in
  general.
