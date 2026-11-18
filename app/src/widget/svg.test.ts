import { expect, test } from "nsh/test";
import { parse, type ElementNode } from "./parse";
import { cleanTree } from "./sanitize";
import { svgDataUrl, svgFit, svgMarkup, viewBoxRatio } from "./svg";

const chart = `<svg viewBox="0 0 320 112" width="100%" height="112" preserveAspectRatio="none"><path d="M0 2H320" stroke="#8e8e93" stroke-opacity="0.3"/><path d="M0 90L40 60L80 70L120 20L160 40L200 10L240 50L280 30L320 80" fill="none" stroke="#6366f1" stroke-width="2"/><path d="M0 90L40 60L80 70L120 20L160 40L200 10L240 50L280 30L320 80L320 110L0 110Z" fill="#6366f1" fill-opacity="0.1"/></svg>`;

const svgOf = (html: string) => parse(html)[0] as ElementNode;

test("parses an inline svg chart into a tree", () => {
  const el = svgOf(chart);
  expect(el.tag).toBe("svg");
  expect(el.attrs.viewbox).toBe("0 0 320 112");
  expect(el.children.map((c) => (c.type === "element" ? c.tag : "#text"))).toEqual(["path", "path", "path"]);
});

test("writes the svg back out with SVG's casing and a namespace", () => {
  const out = svgMarkup(svgOf(chart));
  expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 112" width="100%" height="112" preserveAspectRatio="none">')).toBe(true);
  expect(out).toContain('<path d="M0 2H320" stroke="#8e8e93" stroke-opacity="0.3"/>');
  expect(out.endsWith("</svg>")).toBe(true);
  const grad = svgMarkup(svgOf(`<svg><defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)" width="1" height="1"/></svg>`));
  expect(grad).toContain('<linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="red"/></linearGradient>');
  expect(grad).toContain('fill="url(#g)"');
});

test("keeps the whitelist: no foreign elements, handlers, outside references or unescaped values", () => {
  const out = svgMarkup(svgOf(
    `<svg onload="x()"><script>evil()</script><style>*{}</style><foreignObject><div>html</div></foreignObject>` +
      `<image href="https://e.example/x.png"/><use href="#a"/><use href="https://e.example/s.svg#a"/><use xlink:href="#b"/>` +
      `<a href="https://e.example">link</a><rect fill="url(https://e.example/p)" stroke="url( #ok )" width="1"/>` +
      `<text x="1" data-x='a"b&lt;c'>1 &lt; 2 &amp; 3</text></svg>`,
  ));
  expect(out).not.toContain("onload");
  expect(out).not.toContain("evil");
  expect(out).not.toContain("<style");
  expect(out).not.toContain("html");
  expect(out).not.toContain("e.example");
  expect(out).not.toContain(">link<");
  expect(out).toContain('<use href="#a"/>');
  expect(out).toContain('<use xlink:href="#b"/>');
  expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  expect(out).toContain('<rect stroke="url( #ok )" width="1"/>');
  expect(out).toContain('data-x="a&quot;b&lt;c"');
  expect(out).toContain(">1 &lt; 2 &amp; 3</text>");
});

test("a script's tree goes through the sanitizer, then the svg writer", () => {
  const tree = cleanTree([
    { type: "element", tag: "svg", attrs: { viewBox: "0 0 10 10", onclick: "x()" }, children: [
      { type: "element", tag: "path", attrs: { d: "M0 0L10 10", style: "fill:url(https://e.example)" }, children: [] },
      { type: "element", tag: "iframe", attrs: {}, children: [] },
    ] },
  ])!;
  expect(svgMarkup(tree[0] as ElementNode)).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>');
});

test("maps values before writing them, and escapes what they return", () => {
  const out = svgMarkup(svgOf(`<svg><path stroke="{{c}}"/><text>{{t}}</text></svg>`), (s) => s.replace("{{c}}", '#fff" onload="x').replace("{{t}}", "<b>"));
  expect(out).toContain('stroke="#fff&quot; onload=&quot;x"');
  expect(out).toContain("<text>&lt;b&gt;</text>");
});

test("fit, ratio and data URL", () => {
  expect(svgFit(svgOf(chart).attrs.preserveaspectratio)).toEqual({ objectFit: "fill" });
  expect(svgFit("")).toEqual({ objectFit: "contain" });
  expect(svgFit("xMinYMax slice")).toEqual({ objectFit: "cover", objectPosition: "left bottom" });
  expect(viewBoxRatio(svgOf(chart).attrs.viewbox)).toBe(320 / 112);
  expect(viewBoxRatio("0 0 0 10")).toBeUndefined();
  expect(viewBoxRatio("")).toBeUndefined();
  expect(svgDataUrl('<svg a="#"/>')).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E");
});
