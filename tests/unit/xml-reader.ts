// SPDX-License-Identifier: GPL-3.0-or-later
// A minimal XML reader for the renderer tests: well-formedness + namespaces,
// no dependency, written independently of src/shared/svg/xml.ts.
import assert from "node:assert/strict";

export interface XEl {
  name: string;
  attrs: Map<string, string>;
  children: (XEl | string)[];
}

const NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}="[^"<]*")*)\\s*(/?)>`, "y");
const END_TAG = new RegExp(`</(${NAME})\\s*>`, "y");
const ATTR = new RegExp(`(${NAME})="([^"<]*)"`, "g");
const ENTITY = "amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+";

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function decode(raw: string): string {
  assert.ok(!new RegExp(`&(?!(?:${ENTITY});)`).test(raw), `bare ampersand in: ${raw.slice(0, 80)}`);
  assert.ok(!raw.includes("]]>"), "]]> in character data");
  return raw.replace(new RegExp(`&(${ENTITY});`, "g"), (_m, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(
          e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10),
        );
    }
  });
}

export function parseXml(src: string): XEl {
  assert.ok(src.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), "XML declaration first");
  for (const ch of src) {
    assert.ok(
      isXmlChar(ch.codePointAt(0) ?? -1),
      `invalid XML character U+${(ch.codePointAt(0) ?? 0).toString(16)}`,
    );
  }
  const doc: XEl = { name: "#document", attrs: new Map(), children: [] };
  const stack: XEl[] = [doc];
  let pos = src.indexOf("?>") + 2;
  while (pos < src.length) {
    const top = stack.at(-1);
    assert.ok(top, "element stack");
    if (src[pos] !== "<") {
      const next = src.indexOf("<", pos);
      const end = next === -1 ? src.length : next;
      top.children.push(decode(src.slice(pos, end)));
      pos = end;
      continue;
    }
    END_TAG.lastIndex = pos;
    const close = END_TAG.exec(src);
    if (close) {
      assert.equal(top.name, close[1], `closing tag </${close[1]}> does not match <${top.name}>`);
      stack.pop();
      pos = END_TAG.lastIndex;
      continue;
    }
    START_TAG.lastIndex = pos;
    const open = START_TAG.exec(src);
    assert.ok(open, `malformed tag at ${pos}: ${src.slice(pos, pos + 80)}`);
    const el: XEl = { name: open[1] ?? "", attrs: new Map(), children: [] };
    for (const a of (open[2] ?? "").matchAll(ATTR)) {
      assert.ok(!el.attrs.has(a[1] ?? ""), `duplicate attribute ${a[1]} on <${el.name}>`);
      el.attrs.set(a[1] ?? "", decode(a[2] ?? ""));
    }
    top.children.push(el);
    if (open[3] !== "/") stack.push(el);
    pos = START_TAG.lastIndex;
  }
  assert.equal(stack.length, 1, "unclosed element");
  const roots = elements(doc);
  assert.equal(roots.length, 1, "exactly one root element");
  assert.ok(
    doc.children.every((c) => typeof c !== "string" || c.trim() === ""),
    "only whitespace outside the root",
  );
  const root = roots[0];
  assert.ok(root);
  checkNamespaces(root, new Map());
  return root;
}

function checkNamespaces(el: XEl, scope: Map<string, string>): void {
  const inner = new Map(scope);
  for (const [k, v] of el.attrs) {
    if (k === "xmlns") inner.set("", v);
    else if (k.startsWith("xmlns:")) inner.set(k.slice(6), v);
  }
  const prefix = el.name.includes(":") ? (el.name.split(":")[0] ?? "") : "";
  assert.ok(inner.has(prefix), `undeclared namespace prefix on <${el.name}>`);
  for (const k of el.attrs.keys()) {
    const p = k.includes(":") ? (k.split(":")[0] ?? "") : "";
    if (p !== "" && p !== "xml" && p !== "xmlns")
      assert.ok(inner.has(p), `undeclared namespace prefix on @${k}`);
  }
  for (const c of elements(el)) checkNamespaces(c, inner);
}

export const elements = (el: XEl): XEl[] => el.children.filter((c): c is XEl => typeof c !== "string");
export const descendants = (el: XEl): XEl[] => elements(el).flatMap((c) => [c, ...descendants(c)]);
export const textOf = (el: XEl): string =>
  el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
export const named = (el: XEl, name: string): XEl[] => descendants(el).filter((e) => e.name === name);

export function byId(root: XEl, id: string): XEl {
  const hit = descendants(root).find((e) => e.attrs.get("id") === id);
  assert.ok(hit, `element #${id}`);
  return hit;
}

export function attr(el: XEl, name: string): string {
  const v = el.attrs.get(name);
  assert.ok(v !== undefined, `<${el.name}> has @${name}`);
  return v;
}

/** A line separator: a <text> with nothing but a position and one space. */
export const isSeparator = (el: XEl): boolean =>
  el.name === "text" && [...el.attrs.keys()].join() === "x,y" && textOf(el) === " ";
