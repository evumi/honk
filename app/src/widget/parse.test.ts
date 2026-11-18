import { expect, test } from "nsh/test";
import { countNodes, fill, parse, parseData, parseStyle, type ElementNode } from "./parse";
import { _internal } from "./Widget";
import { palette } from "../theme";

test("parses nested elements, attributes and entities", () => {
  const nodes = parse(`<div class="a" style='color:red'>x &amp; y<br><b>bold</b><img src="data:image/png;base64,AA"></div>`);
  expect(nodes.length).toBe(1);
  const div = nodes[0] as ElementNode;
  expect(div.tag).toBe("div");
  expect(div.attrs).toEqual({ class: "a", style: "color:red" });
  expect(div.children.map((c) => (c.type === "text" ? c.text : c.tag))).toEqual(["x & y", "br", "b", "img"]);
});

test("survives broken markup", () => {
  expect(parse("<div><p>unclosed").length).toBe(1);
  expect(parse("a < b").map((n) => (n.type === "text" ? n.text : "")).join("")).toBe("a < b");
  expect(parse("</span>text")).toEqual([{ type: "text", text: "text" }]);
  expect(parse("<!-- c --><style>p{}</style>")[0]).toMatchObject({ tag: "style" });
});

test("fills placeholders from data", () => {
  const data = parseData(`{"status":"已上线","deploy":{"id":"dep_1"}}`);
  expect(fill("{{status}} / {{ deploy.id }} / {{missing}}", data)).toBe("已上线 / dep_1 / ");
  expect(parseData("not json")).toEqual({});
  expect(parseData("[1]")).toEqual({});
});

test("parses inline styles", () => {
  expect(parseStyle("color: red; padding:4px 8px ;bad")).toEqual({ color: "red", padding: "4px 8px" });
});

test("maps CSS to nsh styles", () => {
  const ctx = {
    data: {}, vars: { "--tg-theme-hint-color": "#6d6d72" }, p: palette(), sheet: { rules: [], index: new Map() },
    env: { parentOf: () => undefined, attr: (e: ElementNode, n: string) => e.attrs[n] }, scheme: "light" as const, computed: new Map(),
  };
  const { box, text } = _internal.mapStyle(
    parseStyle("display:flex;padding:4px 12px;border:1px solid #ddd;border-radius:999px;color:var(--tg-theme-hint-color);font-weight:bold"),
    ctx,
  );
  expect(box).toMatchObject({ flexDirection: "row", paddingTop: 4, paddingRight: 12, paddingBottom: 4, paddingLeft: 12, borderWidth: 1, borderStyle: "solid", borderColor: "#ddd", borderRadius: 999 });
  expect(text).toEqual({ color: "#6d6d72", fontWeight: "700" });
});

test("fills placeholders inside style attributes", () => {
  const nodes = parse(`<span style="background:{{dot}}">x</span>`);
  const el = nodes[0] as ElementNode;
  expect(parseStyle(fill(el.attrs.style, { dot: "#1a9e6e" }))).toEqual({ background: "#1a9e6e" });
});

test("counts nodes for the limit", () => {
  expect(countNodes(parse("<div><p>a</p><p>b</p></div>"))).toBe(5);
});
