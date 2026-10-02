<!--
State what your change does, and let the diff prove it.

Fill this in and review is mechanical. Leave it empty and review turns into
archaeology — which is slow, and slow PRs go stale.
-->

Closes #

## What and why

<!-- Two or three sentences. The problem, and why this is the right shape of fix. -->

## Claims

<!--
One bullet per user-visible change. Put files, functions and SVG elements in
`backticks` and reference issues as #N, so a reviewer can check each claim
against the diff. Claim what the change *does*, not what you touched. Examples:

- `Copy link` reports "no text link possible" instead of "no text selected" for picks inside a shadow tree (#12)
- OCR words smaller than 6 px are dropped before they reach `<g id="ocr">`
- The popup's "Capture region" stays disabled while the page probe runs
-->

## Verification

<!--
Real output from your machine, not intentions. "Should work" is not verification.
Touched src/background, src/content, the popup or the options page? Also run
`pnpm test:glue` (Firefox 157 or newer installed; it drives the real
extension). Changed what a capture produces? Show it on a real page with
`pnpm drive` (docs/development.md) and paste the JSON line of `pnpm drive save`.
-->

```console
$ pnpm check
$ pnpm test
```

## Tests

<!--
Name the test and prove it is load-bearing: it must fail without your change.
If you did not add one, say why here — "docs only", "covered by the golden
file". An empty section reads as "untested".
-->

- Added / changed:
- Fails on `main` without this change: <!-- yes / no + how you checked -->

## Public contracts

<!-- Other tools read snapii's files, and users trust its permissions. Tick what still holds. -->

- [ ] Saved SVG structure unchanged: raster `<image>` tiles under an invisible text layer — one `<text>` with `textLength` per run, `fill-opacity="0"`, OCR words in `<g id="ocr">`, linked runs wrapped in `<a href>`
- [ ] Capture record unchanged: the JSON in `<snapii:capture>` keeps `schema: 1` and every field of `captureRecord()` in `src/shared/svg/metadata.ts` (no field removed, renamed or retyped); the Dublin Core fields stay as they are
- [ ] Manifest permissions unchanged: `activeTab`, `scripting`, `downloads`, `clipboardWrite`, `storage` — no `host_permissions`, no `content_scripts` (decision D1, docs/development.md)
- [ ] Settings in `storage.sync` keep their keys, types and meaning (`Settings` in `src/shared/types.ts`); a value stored by an older version still loads
- [ ] Add-on id stays `snapii@qmmq.de`
- [ ] Privacy holds: no network request of any kind, `data_collection_permissions` stays `none`, the saved file reveals nothing new about the user
- [ ] No new dependency shipped in `dist/` — or `NOTICE` and the license texts are updated with it

<!-- If any box stays unticked, describe the break and the migration here: -->

## Saved-file impact

<!--
Only for changes that alter the bytes of a saved SVG (renderer, metadata,
extraction, OCR, capture). Delete this section otherwise.
-->

- Golden file `tests/unit/golden/simple.svg` changed: <!-- no / yes — and why every changed line is intended -->
- Opened a new file in Firefox, selected the text and followed a link: <!-- yes / no -->

## Risk and rollback

- What breaks if this is wrong:
- How to tell from the outside:
- Revert is clean: <!-- yes / no + what else would need undoing -->

## Out of scope

<!-- Adjacent problems you deliberately left alone. Prevents "while you're in there". -->

## Assistance

<!--
LLM-assisted work is welcome. The rule is only that you stand behind it: you
ran it, you read it, you can explain it.
-->

- [ ] I wrote or reviewed every line and can explain why each change is there
- [ ] I ran the commands under Verification myself and pasted their real output

---

<details>
<summary>Reviewer checklist</summary>

1. Claims vs. diff — anything changed that no claim mentions?
2. Does the new test actually fail on `main`?
3. Contracts: SVG structure, capture record, permissions, settings keys, add-on id, privacy.
4. Saved files: is every changed line of the golden file explained by a claim?
5. Scope: does the diff stay inside the files the claims imply?

</details>
