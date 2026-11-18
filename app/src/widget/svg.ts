// Inline <svg> in a card. nsh's Image rasterizes `data:image/svg+xml`, so the
// sanitized subtree is written back out as SVG markup and drawn as an image.
// Only SVG elements and attributes the whitelist (sanitize.ts) keeps are
// written, references stay inside the document, and every value is escaped.

import type { ElementNode, WidgetNode } from "./parse";
import { ALLOWED_TAGS, allowedAttr } from "./sanitize";

const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "defs", "lineargradient", "radialgradient", "stop", "symbol", "use", "title", "desc",
]);

// The parser lowercases names; SVG's are case-sensitive.
const TAG_CASE: Record<string, string> = { lineargradient: "linearGradient", radialgradient: "radialGradient" };
const ATTR_CASE: Record<string, string> = Object.fromEntries(
  [
    "viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "spreadMethod", "pathLength",
    "textLength", "lengthAdjust", "startOffset", "refX", "refY",
  ].map((n) => [n.toLowerCase(), n]),
);

const URL_REF = /url\(\s*['"]?\s*([^\s'")]*)/gi;

/** Whether a value has a url() that is not a same-document reference (`url(#grad)`). */
function foreignUrl(v: string): boolean {
  for (const m of v.matchAll(URL_REF)) if (!m[1].startsWith("#")) return true;
  return false;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whether attribute `name="value"` may be written on SVG element `tag`. */
function svgAttr(tag: string, name: string, value: string): boolean {
  if (!allowedAttr(tag, name, value)) return false;
  if (name === "href" || name === "xlink:href") return tag === "use" && /^#[\w.:-]+$/.test(value.trim());
  return !foreignUrl(value);
}

/**
 * The SVG markup for a sanitized `<svg>` element. `value` maps each attribute
 * value and text run before it is written (`{{key}}`, theme variables).
 */
export function svgMarkup(el: ElementNode, value: (s: string) => string = (s) => s): string {
  let xlink = false;
  const write = (n: WidgetNode, depth: number): string => {
    if (n.type === "text") return escText(value(n.text));
    if (!SVG_TAGS.has(n.tag) || !ALLOWED_TAGS.has(n.tag) || depth > 128) return "";
    const tag = TAG_CASE[n.tag] ?? n.tag;
    let out = "<" + tag;
    if (depth === 0) out += ' xmlns="http://www.w3.org/2000/svg"';
    for (const [k, raw] of Object.entries(n.attrs)) {
      if (k === "xmlns" || k.startsWith("xmlns:")) continue;
      const v = value(raw);
      if (!svgAttr(n.tag, k, v)) continue;
      if (k.startsWith("xlink:")) xlink = true;
      out += ` ${ATTR_CASE[k] ?? k}="${escAttr(v)}"`;
    }
    const inner = n.children.map((c) => write(c, depth + 1)).join("");
    return out + (inner ? `>${inner}</${tag}>` : "/>");
  };
  const body = write(el, 0);
  return xlink ? body.replace(/^<svg /, '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ') : body;
}

/** The markup as a data: URL for an Image. */
export function svgDataUrl(markup: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
}

/** How the image fits its box, from the svg's preserveAspectRatio. */
export function svgFit(el: ElementNode): { objectFit: "fill" | "contain" | "cover"; objectPosition?: string } {
  const par = (el.attrs.preserveaspectratio ?? "").trim().split(/\s+/);
  if (par[0] === "none") return { objectFit: "fill" };
  const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(par[0] ?? "");
  const pos = { Min: ["left", "top"], Mid: ["center", "center"], Max: ["right", "bottom"] } as const;
  const objectPosition = m ? `${pos[m[1] as "Min"][0]} ${pos[m[2] as "Min"][1]}` : undefined;
  return { objectFit: par[1] === "slice" ? "cover" : "contain", ...(objectPosition ? { objectPosition } : {}) };
}

/** The svg's aspect ratio from its viewBox, if it has a usable one. */
export function viewBoxRatio(el: ElementNode): number | undefined {
  const vb = (el.attrs.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : undefined;
}
