// The card whitelist on the device. The gateway cleans what a bot sends
// (gateway/internal/widget); a script can still write HTML, attributes and
// styles at run time, so the sandbox checks those against the same rules.
// Keep the two in step.

import type { ElementNode, WidgetNode } from "./parse";

export const ALLOWED_TAGS = new Set(`
  div span p br hr h1 h2 h3 h4 h5 h6 section article header footer main aside nav
  pre code blockquote figure figcaption strong b em i u s small sub sup mark abbr time
  ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col details summary
  img a button style
  svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop symbol use title desc`.trim().split(/\s+/));

const DROPPED_ATTRS = new Set(["srcset", "formaction", "action", "contenteditable", "draggable", "tabindex", "autofocus", "accesskey"]);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const CSS_IMPORT = /@import|expression\s*\(|\\/i;
const CSS_LOADERS = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|cross-fade|image|element|src)\s*\(/i;
const CSS_URL = /url\s*\(\s*['"]?\s*([^'")\s]*)/gi;

/** CSS that would load something other than an inline data: image. */
export function badCSS(css: string): boolean {
  if (CSS_IMPORT.test(css) || CSS_LOADERS.test(css)) return true;
  for (const m of css.matchAll(CSS_URL)) if (!m[1].toLowerCase().startsWith("data:image/")) return true;
  return false;
}

/** Whether attribute `name="value"` may stay on a `tag` element. */
export function allowedAttr(tag: string, name: string, value: string): boolean {
  name = name.toLowerCase();
  if (name.startsWith("on") || DROPPED_ATTRS.has(name) || (name.includes(":") && !name.startsWith("xlink:"))) return false;
  if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name)) return false;
  const v = value.trim();
  switch (name) {
    case "src": return tag === "img" && DATA_IMAGE.test(v);
    case "href":
    case "xlink:href":
      if (tag === "a") return v.startsWith("https://") || v.startsWith("#");
      return tag === "use" && v.startsWith("#");
    case "style": return !badCSS(value);
  }
  return true;
}

/** Cleans nodes parsed from HTML a script wrote (innerHTML): unknown elements and scripts go with their subtrees. */
export function sanitize(nodes: WidgetNode[]): WidgetNode[] {
  const out: WidgetNode[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      out.push(n);
      continue;
    }
    if (!ALLOWED_TAGS.has(n.tag)) continue;
    if (n.tag === "style") {
      const css = n.children.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!badCSS(css)) out.push({ type: "element", tag: "style", attrs: {}, children: [{ type: "text", text: css }] });
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.attrs)) if (allowedAttr(n.tag, k, v)) attrs[k] = v;
    const el: ElementNode = { type: "element", tag: n.tag, attrs, children: sanitize(n.children) };
    out.push(el);
  }
  return out;
}
