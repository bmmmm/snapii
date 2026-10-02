# Agent instructions

Working notes for coding agents. Humans: [CONTRIBUTING.md](CONTRIBUTING.md) is
the readable version with the module map and the contracts — this file is the
short, imperative one.

## Commands

```console
pnpm install --frozen-lockfile   # pnpm only; a preinstall guard blocks npm/yarn
pnpm check                       # tsc (src + tests) + biome — must pass
pnpm test                        # unit (node --test) + layout (Playwright Firefox) — must pass
pnpm test:glue                   # real extension in the installed Firefox via Marionette
pnpm build                       # dist/ (esbuild, unminified for AMO review)
pnpm lint:ext                    # web-ext lint on dist/
pnpm drive help                  # one persistent headless Firefox, one command per call
```

`pnpm test:glue` and `pnpm drive` start a release Firefox (157+,
`SNAPII_FIREFOX` overrides the macOS default path). **Firefox must run outside
a sandbox** — inside one they fail like real bugs (ports, sockets, process
launch). Glue ports 8460–8469 and 2960–2969; a second checkout running at the
same time sets `SNAPII_GLUE_PORT_OFFSET=10`.

## Module map

[CONTRIBUTING.md § Where things live](CONTRIBUTING.md#where-things-live).
Read first: `src/shared/types.ts` (every data contract), then
`src/background/save.ts` (one save end to end) and `src/content/session.ts`
(one capture session in the page).

## Rules

- Keep `// SPDX-License-Identifier: GPL-3.0-or-later` as the first line of
  every source file.
- Do not break the public contracts (CONTRIBUTING.md § Public contracts): SVG
  structure, the `<snapii:capture>` record (`schema: 1`), the permissions, the
  `storage.sync` settings keys, the add-on id `snapii@qmmq.de`, and no network
  requests. Additive is fine; removing, renaming or retyping is not.
- No host permissions and no `content_scripts`. The content script is
  injected on demand under `activeTab` (decision D1, `docs/development.md`); a feature
  that needs more is a design question, not an implementation detail.
- Every value that comes from a page — text, title, URL, font name, `alt`,
  `href` — is hostile. Into the SVG it goes through `xmlText`/`xmlAttr`
  (`src/shared/svg/xml.ts`); link targets through `src/shared/links.ts`
  (http, https and mailto only); messages from the content script through
  `src/shared/messages.ts`; Copy text's HTML through `src/shared/sanitize.ts`;
  the file name through `src/shared/filename.ts`. A new sink inherits the
  rule.
- The renderer and the metadata are pure and deterministic: no clocks, no
  randomness (`capturedAt` comes from the caller). Same input, same bytes —
  the golden file `tests/unit/golden/simple.svg` is compared byte for byte.
- `src/shared/spike.ts` holds measured platform facts. Never change a number
  there without a new measurement of the kind its header describes.
- Comment only what the code cannot say — a constraint, a measurement, a
  platform quirk. The existing comments are the model: they explain *why*.
- Match the surrounding style. No new abstraction layer for a single call site.

## Traps

- **Invisible text is `fill-opacity="0"`, never `fill="none"`.** SVG 2 drops
  `fill="none"` text from hit-testing, so it stops being selectable.
- **`textLength` goes on `<text>`, never on `<tspan>`.** Firefox ignores it on
  `<tspan>` and the hit area drifts from the picture. That is why the layer is
  one `<text>` per run.
- **Overlay styles go through CSSOM with `!important`** (`src/content/overlay/styles.ts`).
  A page CSP blocks `style` attributes and `<style>` elements, not CSSOM.
- **The download's blob URL is revoked only on a terminal state**
  (`src/background/download.ts`); revoking it earlier breaks the download.
- **Only ranges in the page's own HTML document reach the text-fragment
  generator.** In a shadow tree or an SVG/XML document the polyfill's search
  for a block ancestor never ends and freezes the tab (`generatorCanHandle` in
  `src/content/fragment.ts`).
- **The shortcut is not a setting.** It lives in Firefox's commands store
  (`browser.commands.update`), not in `storage.sync`; `maxTotalPixels` and
  `maxTilePixels` are internal and never written by the options page.
- **A key an older build left on `_execute_action`** stays bound across
  updates and `reload-addon` (Firefox stores keys set with
  `commands.update`) and would open the popup;
  `src/background/legacy-shortcut.ts` moves it to `start-capture` once per
  profile. To try the move again, remove `legacyShortcutMoved` from
  `storage.local` or start a fresh profile (`pnpm drive start --force`).
- **The save folder is a path inside Firefox's download folder**, nothing
  else: `downloads.download` refuses absolute paths, `..` and more, and
  rewrites `%`. `src/shared/folder.ts` holds the rules; a glue test pins them
  against the real API, so re-run it when Firefox changes.
- **CI retries Playwright specs twice** (`playwright.config.ts`). A spec that
  passes only on retry is a bug, not noise.
- **Never widen the diff beyond the task.** Adjacent problems go into the PR's
  "Out of scope" section or into a new issue.

## Definition of done

1. `pnpm check` and `pnpm test` pass; `pnpm test:glue` too when
   `src/background/`, `src/content/`, the popup or the options page changed.
2. A test exists that fails without the change. Verify that — break the code
   on purpose, see it go red, restore — and name the fault and the check that
   caught it in the PR.
3. A change to the saved file's bytes updates the golden file, and every
   changed line of it is explained by a claim.
4. The PR description follows `.github/PULL_REQUEST_TEMPLATE.md`: claims as
   bullets with symbols in backticks, real pasted command output, the failing
   test named, contracts confirmed, scope stated.
5. Claims describe observable behaviour, not files touched, and every claim is
   traceable to the diff.
