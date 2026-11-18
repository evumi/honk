import { expect, test } from "nsh/test";
import { cascade, MAX_RULES, parseDecls, parseSheet, styleText, type Scheme } from "./css";
import { parse, type ElementNode, type WidgetNode } from "./parse";
import { parseSelector } from "./selector";
import type { TreeEnv } from "./selector";

function tree(html: string) {
  const root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: parse(html) };
  const parents = new Map<WidgetNode, ElementNode>();
  const walk = (el: ElementNode) => el.children.forEach((c) => {
    parents.set(c, el);
    if (c.type === "element") walk(c);
  });
  walk(root);
  const env: TreeEnv = { parentOf: (n) => parents.get(n), attr: (el, n) => el.attrs[n] };
  const byId = (id: string): ElementNode => {
    const find = (ns: WidgetNode[]): ElementNode | undefined => {
      for (const n of ns) if (n.type === "element") { if (n.attrs.id === id) return n; const r = find(n.children); if (r) return r; }
      return undefined;
    };
    return find(root.children)!;
  };
  const sheet = parseSheet(styleText(root.children));
  const style = (id: string, scheme: Scheme = "light") => {
    const el = id === ":root" ? root : byId(id);
    return cascade(el, sheet, env, scheme, parseDecls(el.attrs.style ?? ""));
  };
  return { style, sheet };
}

test("selectors: type, class, id, compound, descendant, child, siblings, pseudo-classes", () => {
  const { style } = tree(`<style>
    p { color: gray }
    .card p { margin: 1px }
    .card > p { padding: 2px }
    div.card .x, #b { font-weight: 700 }
    li:first-child { color: red } li:last-child { color: blue } li:nth-child(2) { color: green }
    h3 + p { font-size: 12px } h3 ~ p { letter-spacing: 1px }
    a:hover { color: pink } p::before { content: "x" }
  </style>
  <div class="card"><h3 id="h">t</h3><p id="a" class="x">a</p><section><p id="b">b</p></section></div>
  <ul><li id="l1">1</li><li id="l2">2</li><li id="l3">3</li></ul>`);
  expect(style("a")).toEqual({ color: "gray", margin: "1px", padding: "2px", "font-weight": "700", "font-size": "12px", "letter-spacing": "1px" });
  expect(style("b")).toEqual({ color: "gray", margin: "1px", "font-weight": "700" });
  expect([style("l1").color, style("l2").color, style("l3").color]).toEqual(["red", "green", "blue"]);
  expect(parseSelector("a:hover")).toBeNull();
  expect(parseSelector("div > > p")).toBeNull();
});

test("the cascade: specificity, order, inline style, !important", () => {
  const { style } = tree(`<style>
    #x { color: blue }
    .a.b { color: green; background: white }
    .a { color: red; background: black }
    p { color: gray; padding: 9px !important }
    .a { background: silver }
  </style><p id="x" class="a b" style="color: orange; padding: 1px; background: navy">t</p><p id="y" class="a">u</p>`);
  expect(style("x")).toEqual({ color: "orange", background: "navy", padding: "9px" });
  expect(style("y")).toEqual({ color: "red", background: "silver", padding: "9px" });
});

test("custom properties, :root, html and body, dark mode media", () => {
  const { style } = tree(`<style>
    :root { --accent: #f00 }
    body { color: var(--tg-theme-text-color) }
    html .t { color: var(--accent) }
    @media (prefers-color-scheme: dark) { body .t { color: #fff } }
    html body > p { margin: 3px }
    @media screen and (prefers-color-scheme: light), print { .t { font-size: 20px } }
    @media (max-width: 400px) { .t { display: none } }
    @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
    @import "x.css";
  </style><p id="t" class="t">x</p>`);
  expect(style(":root")).toEqual({ "--accent": "#f00", color: "var(--tg-theme-text-color)" });
  expect(style("t", "light")).toEqual({ color: "var(--accent)", margin: "3px", "font-size": "20px" });
  // Equal specificity (html .t and body .t): the later rule wins.
  expect(style("t", "dark")).toEqual({ color: "#fff", margin: "3px" });
});

test("declarations that would load anything are dropped, and rules are capped", () => {
  expect(parseDecls("color: red; background: url(https://evil/x.png); --u: image-set('https://e' 1x); padding: 1px")).toEqual([
    { prop: "color", value: "red", important: false },
    { prop: "padding", value: "1px", important: false },
  ]);
  const many = Array.from({ length: MAX_RULES + 50 }, (_, i) => `.c${i} { color: red }`).join("\n");
  expect(parseSheet(many).rules.length).toBe(MAX_RULES);
});
