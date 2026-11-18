// The card whitelist on the device. The gateway cleans what a bot sends
// (gateway/internal/widget); a card's script can still write any HTML,
// attributes and styles in its own runtime, so every tree a card hands back is
// checked against the same rules before it is drawn. Keep the two in step.

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

/** Most nodes a card may draw (Telegram: 2000), and how deep they may nest. */
export const MAX_TREE_NODES = 2000;
const MAX_DEPTH = 128;

/**
 * A tree a card's script handed back (JSON), as nodes the renderer may draw:
 * only whitelisted elements and attributes, no scripts. `on` marks elements
 * with click handlers. Null when it is not a tree or is over the limits.
 */
export function cleanTree(json: unknown): WidgetNode[] | null {
  let count = 0;
  const walk = (list: unknown, depth: number): WidgetNode[] | null => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return null;
    const out: WidgetNode[] = [];
    for (const n of list) {
      if (++count > MAX_TREE_NODES) return null;
      if (!n || typeof n !== "object") continue;
      const o = n as Record<string, unknown>;
      if (o.type === "text") {
        if (typeof o.text === "string") out.push({ type: "text", text: o.text.slice(0, 32 * 1024) });
        continue;
      }
      if (o.type !== "element" || typeof o.tag !== "string") continue;
      const tag = o.tag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) continue;
      const children = walk(o.children ?? [], depth + 1);
      if (children === null) return null;
      if (tag === "style") {
        const css = children.map((c) => (c.type === "text" ? c.text : "")).join("");
        if (!badCSS(css)) out.push({ type: "element", tag, attrs: {}, children: [{ type: "text", text: css }] });
        continue;
      }
      const attrs: Record<string, string> = {};
      if (o.attrs && typeof o.attrs === "object") {
        for (const [k, v] of Object.entries(o.attrs as Record<string, unknown>)) {
          if (typeof v === "string" && v.length <= 8192 && allowedAttr(tag, k, v)) attrs[k.toLowerCase()] = v;
        }
      }
      const el: ElementNode = { type: "element", tag, attrs, children };
      if (o.on === true) el.on = true;
      out.push(el);
    }
    return out;
  };
  return walk(json, 0);
}
