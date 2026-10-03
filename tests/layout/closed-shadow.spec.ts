// SPDX-License-Identifier: GPL-3.0-or-later
// Closed shadow trees as a Chromium content script reaches them: through the
// extension API browser.dom.openOrClosedShadowRoot (Firefox has properties on
// the element instead, which page scripts never see). The spec runs in page
// context, so the API is stood in for by a registry of the roots the page
// attached; what is under test is that the walk uses it, for the root and for
// the slot a light child is assigned to.
import { expect, test } from "@playwright/test";

type Stubbed = Window & { browser?: { dom: { openOrClosedShadowRoot(el: Element): ShadowRoot | null } } };

test("text in a closed shadow tree and text slotted into it are collected in flat-tree order", async ({
  page,
}) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const lines = await page.evaluate(async () => {
    const closed = new WeakMap<Element, ShadowRoot>();
    (window as Stubbed).browser = {
      dom: { openOrClosedShadowRoot: (el) => closed.get(el) ?? el.shadowRoot },
    };

    document.body.innerHTML =
      '<main id="cap" style="font: 16px/1.5 serif"><p>Before.</p><div id="host"></div><p>After.</p></main>';
    const host = document.getElementById("host") as HTMLElement;
    const root = host.attachShadow({ mode: "closed" });
    closed.set(host, root);
    root.innerHTML = '<p>Closed intro <slot name="s"></slot> outro.</p><div><slot></slot></div>';
    host.innerHTML = '<span slot="s">slotted</span>Default slotted text.';

    const cap = (document.getElementById("cap") as HTMLElement).getBoundingClientRect();
    const { runs } = await window.__snapii.collectTextRuns(
      document,
      { x: cap.x + scrollX, y: cap.y + scrollY, width: cap.width, height: cap.height },
      {},
    );
    const byLine = new Map<number, string>();
    for (const r of runs) byLine.set(r.line, (byLine.get(r.line) ?? "") + r.text);
    return [...byLine.values()];
  });
  expect(lines).toEqual(["Before.", "Closed intro slotted outro.", "Default slotted text.", "After."]);
});
