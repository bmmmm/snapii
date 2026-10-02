// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { fragmentToCleanHtml, type SNode } from "../../src/shared/sanitize.ts";

const CTX = { baseURL: "https://p/dir/page", pageURL: "https://p/dir/page" };
const t = (text: string): SNode => ({ kind: "text", text });
const el = (tag: string, attrs: Record<string, string>, ...children: SNode[]): SNode => ({
  kind: "element",
  tag,
  attrs,
  children,
});
const clean = (...nodes: SNode[]) => fragmentToCleanHtml(nodes, CTX);

test("sanitize: on*, style, class and id are gone from kept elements", () => {
  assert.equal(
    clean(el("p", { onclick: "alert(1)", style: "color:red", class: "x", id: "y" }, t("Hi"))),
    "<p>Hi</p>",
  );
});

test("sanitize: script, style and the other dropped elements go with their content", () => {
  assert.equal(
    clean(
      el(
        "div",
        {},
        t("a"),
        el("script", {}, t("alert(1)")),
        el("style", {}, t("p{}")),
        el("noscript", {}, t("enable JS")),
        el("svg", {}, el("text", {}, t("svg text"))),
        el("button", {}, t("Click")),
        el("textarea", {}, t("draft")),
        t("b"),
      ),
    ),
    "<div>ab</div>",
  );
});

// Each case has text inside, so it reads red if the element were only
// unwrapped. "template" has no case: in the DOM its content lives in
// .content, not in its children, so toSNodes never gives it any and
// dropping or unwrapping it serializes the same (an equivalent mutant).
test("sanitize: math and iframe go with their content", () => {
  assert.equal(
    clean(
      t("a"),
      el("math", {}, el("mi", {}, t("x")), el("mo", {}, t("+")), el("mn", {}, t("1"))),
      el("iframe", { src: "https://p/frame" }, t("fallback text")),
      t("b"),
    ),
    "ab",
  );
});

test("sanitize: comments are dropped", () => {
  assert.equal(clean(t("a"), { kind: "comment" }, t("b")), "ab");
});

test("sanitize: a keeps only its resolved href", () => {
  assert.equal(
    clean(el("a", { href: "../x?a=1&b=2", target: "_blank", rel: "noopener", class: "c" }, t("link"))),
    '<a href="https://p/x?a=1&amp;b=2">link</a>',
  );
});

test("sanitize: links leading nowhere are unwrapped", () => {
  assert.equal(clean(el("a", { href: "javascript:alert(1)" }, t("js"))), "js");
  assert.equal(clean(el("a", { href: "#sec" }, t("anchor"))), "anchor");
  assert.equal(clean(el("a", { name: "top" }, t("named"))), "named");
  assert.equal(clean(el("a", { href: "data:text/html,<script>x</script>" }, t("data"))), "data");
});

test("sanitize: lang and dir survive on kept elements, spans only with them", () => {
  assert.equal(
    clean(
      el("p", { lang: "de", dir: "ltr", class: "c" }, t("Hallo "), el("span", { lang: "fr" }, t("salut"))),
      el("span", { class: "x" }, t(" plain")),
      el("span", { dir: "rtl", style: "x" }, t("שלום")),
    ),
    '<p lang="de" dir="ltr">Hallo <span lang="fr">salut</span></p> plain<span dir="rtl">שלום</span>',
  );
});

test("sanitize: abbr keeps its title", () => {
  assert.equal(
    clean(el("abbr", { title: "HyperText Markup Language", class: "c" }, t("HTML"))),
    '<abbr title="HyperText Markup Language">HTML</abbr>',
  );
});

test("sanitize: unknown and unlisted elements are unwrapped, content kept", () => {
  assert.equal(
    clean(
      el("section", {}, el("custom-el", {}, el("font", { color: "red" }, t("x"))), el("img", { src: "y" })),
    ),
    "x",
  );
});

test("sanitize: structure elements are kept, br stays void", () => {
  assert.equal(
    clean(
      el("h2", {}, t("T")),
      el("ul", {}, el("li", {}, el("em", {}, t("a")), el("br", {}), t("b"))),
      el("table", {}, el("tr", {}, el("td", {}, t("1")), el("td", {}))),
    ),
    "<h2>T</h2><ul><li><em>a</em><br>b</li></ul><table><tr><td>1</td><td></td></tr></table>",
  );
});

test("sanitize: elements left empty by hidden text are unwrapped, whitespace kept", () => {
  assert.equal(clean(el("p", {}), el("p", {}, t("x")), t("a"), el("b", {}, t(" ")), t("c")), "<p>x</p>a c");
});

test("sanitize: text and attribute values are escaped", () => {
  assert.equal(
    clean(
      el("p", { lang: `x" onmouseover="alert(1)` }, t("<img src=x onerror=alert(1)> & co")),
      el("abbr", { title: `'"<>&` }, t("q")),
    ),
    '<p lang="x&quot; onmouseover=&quot;alert(1)">&lt;img src=x onerror=alert(1)&gt; &amp; co</p>' +
      '<abbr title="&#39;&quot;&lt;&gt;&amp;">q</abbr>',
  );
});

test("sanitize: tag names compare case-insensitively", () => {
  assert.equal(clean(el("SCRIPT", {}, t("x")), el("P", {}, t("y"))), "<p>y</p>");
});
