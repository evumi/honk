// The card whitelist on the device. The gateway cleans what a bot sends
// (gateway/internal/widget); a card's script can still write any HTML,
// attributes and styles in its own runtime, so every tree a card hands back is
// checked against the same rules before it is drawn. Keep the two in step.

import { parse, type ElementNode, type WidgetNode } from "./parse";

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
const PLACEHOLDER = /^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$/;
/** SVG elements: their attributes are CSS values too (fill, stroke, mask, filter, marker-*). */
const SVG_TAGS = new Set("svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop symbol use title desc".split(" "));
/** A script tag inside script text as the HTML tokenizer sees one, or a comment opener. */
const AMBIGUOUS_SCRIPT = /<!--|<\/?script[\s/>]/i;

/** An SVG attribute value that could load something: a url() that is not a same-document reference, or a CSS escape. */
function badSVGValue(v: string): boolean {
  if (v.includes("\\")) return true;
  for (const m of v.matchAll(CSS_URL)) if (!m[1].startsWith("#")) return true;
  return false;
}

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
      if (tag === "a") return v.startsWith("https://") || v.startsWith("#") || PLACEHOLDER.test(v);
      return tag === "use" && v.startsWith("#");
    case "style": return !badCSS(value);
  }
  return !(SVG_TAGS.has(tag) && badSVGValue(value));
}

/** Most nodes a card may draw (Telegram: 2000), and how deep they may nest. */
export const MAX_TREE_NODES = 2000;
const MAX_DEPTH = 128;

/**
 * A tree a card's script handed back (JSON), as nodes the renderer may draw:
 * only whitelisted elements and attributes, no scripts. `on` marks elements
 * with click handlers. Null when it is not a tree or is over the limits.
 * `paths` gets each element's path in the card's tree (for honk.card.click).
 */
export function cleanTree(json: unknown, paths?: Map<ElementNode, number[]>): WidgetNode[] | null {
  let count = 0;
  const walk = (list: unknown, depth: number, at: number[]): WidgetNode[] | null => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return null;
    const out: WidgetNode[] = [];
    for (let index = 0; index < list.length; index++) {
      const n: unknown = list[index];
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
      const children = walk(o.children ?? [], depth + 1, [...at, index]);
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
      // The card's own path to it: dropped nodes do not shift the indexes it resolves.
      paths?.set(el, [...at, index]);
      out.push(el);
    }
    return out;
  };
  return walk(json, 0, []);
}

/** An inline classic script: no src, no type but JavaScript, text that reads the same to every parser. Not in SVG. */
function keepScript(el: ElementNode, inSvg: boolean): boolean {
  if (inSvg) return false;
  if ("src" in el.attrs) return false;
  const type = el.attrs.type;
  if (type !== undefined && !["", "text/javascript", "application/javascript"].includes(type.trim().toLowerCase())) return false;
  return el.children.every((c) => c.type === "text" && !AMBIGUOUS_SCRIPT.test(c.text));
}

/**
 * A parsed card (from `parse`) cleaned by the same rules as the gateway's
 * widget package: elements outside the whitelist go with their subtree,
 * attributes are filtered, scripts stay only when inline and unambiguous.
 * Cards that arrive end-to-end encrypted were never seen by the gateway, so
 * this runs on every card before it is drawn.
 */
export function cleanNodes(nodes: WidgetNode[], inSvg = false, depth = 0): WidgetNode[] {
  const out: WidgetNode[] = [];
  if (depth > MAX_DEPTH) return out;
  for (const n of nodes) {
    if (n.type === "text") {
      out.push(n);
      continue;
    }
    const tag = n.tag;
    if (tag === "script") {
      if (keepScript(n, inSvg)) out.push({ type: "element", tag, attrs: {}, children: n.children });
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (tag === "style") {
      const css = n.children.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (!badCSS(css)) out.push({ type: "element", tag, attrs: {}, children: [{ type: "text", text: css }] });
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.attrs)) if (allowedAttr(tag, k, v)) attrs[k] = v;
    const el: ElementNode = { type: "element", tag, attrs, children: cleanNodes(n.children, inSvg || tag === "svg", depth + 1) };
    if (n.on === true) el.on = true;
    out.push(el);
  }
  return out;
}

/** Parses and cleans a card's HTML. */
export function cleanHTML(html: string): WidgetNode[] {
  return cleanNodes(parse(html));
}

/** A cleaned card as HTML text (what the tests compare; text and attribute values are escaped). */
export function serialize(nodes: WidgetNode[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
  return nodes
    .map((n) => {
      if (n.type === "text") return esc(n.text);
      const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${attr(v)}"`).join("");
      const inner = n.tag === "script" || n.tag === "style" ? n.children.map((c) => (c.type === "text" ? c.text : "")).join("") : serialize(n.children);
      return `<${n.tag}${a}>${inner}</${n.tag}>`;
    })
    .join("");
}
