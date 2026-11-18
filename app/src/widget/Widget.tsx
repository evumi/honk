import type { JSX } from "nsh";
// Renders a message card with nsh views. Block elements become Views, runs of
// inline content one Text with nested spans. `{{key}}` placeholders come from
// the message's data. Styles come from the card's <style> rules (css.ts)
// and its style attributes. A card with scripts (profile 2) runs them in the
// host's QuickJS sandbox (native/card) and is drawn from the trees it hands
// back, checked against the whitelist; until then, and when the host cannot
// run it, it is the static card. Inline <svg> is written back out as SVG
// markup (svg.ts) and drawn as an image.
import { cleanup, Clipboard, effect, Image, lifecycle, locale, openUrl, signal, Text, untracked, View } from "nsh";
import { cards, on } from "../host";
import type { Palette } from "../theme";
import { widgetVars } from "../theme";
import { countNodes, fill, parseData, type ElementNode, type WidgetNode } from "./parse";
import { cascade, parseDecls, parseSheet, styleText, type Scheme, type Sheet } from "./css";
import { cleanHTML, cleanTree } from "./sanitize";
import { svgDataUrl, svgFit, svgMarkup, viewBoxRatio } from "./svg";
import type { TreeEnv } from "./selector";

const MAX_NODES = 2000;

const BLOCK = new Set([
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "main", "aside", "nav",
  "pre", "blockquote", "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead",
  "tbody", "tfoot", "tr", "td", "th", "details", "summary", "hr", "img", "button", "svg",
]);
const SKIP = new Set(["style", "script", "colgroup", "col", "title"]);

type Style = Record<string, unknown>;

interface Ctx {
  data: Record<string, unknown>;
  /** CSS custom properties in scope: the theme's, then those the card sets on :root and on ancestors. */
  vars: Record<string, string>;
  p: Palette;
  /** The card's <style> rules, and how to match them. */
  sheet: Sheet;
  env: TreeEnv;
  scheme: Scheme;
  /** Styles worked out in this render, by element. */
  computed: Map<ElementNode, Computed>;
  /** A tree from a card's script: already filled, never filled again. */
  raw?: boolean;
  /** What a tap on a pressable element of a scripted card does. */
  press?: (el: ElementNode, href: string | null) => (() => void) | undefined;
}

interface Computed {
  css: ReturnType<typeof mapStyle>;
  /** The context for the element's children: its custom properties added. */
  ctx: Ctx;
}

/** An element's style: its <style> rules and style attribute, cascaded, mapped to nsh styles. */
function computed(el: ElementNode, ctx: Ctx): Computed {
  const hit = ctx.computed.get(el);
  if (hit) return hit;
  const decls = cascade(el, ctx.sheet, ctx.env, ctx.scheme, parseDecls(f(el.attrs.style ?? "", ctx)));
  let inner = ctx;
  for (const [k, v] of Object.entries(decls)) {
    if (!k.startsWith("--")) continue;
    if (inner === ctx) inner = { ...ctx, vars: { ...ctx.vars } };
    inner.vars[k] = resolveVars(v, inner);
  }
  const r = { css: mapStyle(decls, inner), ctx: inner };
  ctx.computed.set(el, r);
  return r;
}

/** `{{key}}` from the data. */
function f(s: string, ctx: Ctx): string {
  return ctx.raw ? s : fill(s, ctx.data);
}

// MARK: CSS values

function resolveVars(v: string, ctx: Ctx): string {
  let out = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => ctx.vars[name] ?? fallback?.trim() ?? "");
  if (out.includes("light-dark(")) {
    out = out.replace(/light-dark\(\s*((?:[^,()]|\([^()]*\))+?)\s*,\s*((?:[^,()]|\([^()]*\))+?)\s*\)/g, (_, light: string, dark: string) => (ctx.scheme === "dark" ? dark : light));
  }
  return out;
}

function length(v: string): number | string | undefined {
  v = v.trim();
  if (v === "auto") return "auto";
  if (v.endsWith("%")) return v;
  const m = /^(-?[\d.]+)(px|pt|em|rem)?$/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2] === "em" || m[2] === "rem" ? n * 15 : n;
}

function sides(v: string): (number | string | undefined)[] {
  const parts = v.split(/\s+/).map(length);
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}

const TEXT_PROPS = new Set(["color", "fontSize", "fontWeight", "fontStyle", "textAlign", "lineHeight", "letterSpacing", "textDecorationLine", "textTransform", "fontFamily"]);

/** Maps a CSS declaration block to nsh style, split into box and text parts. */
function mapStyle(css: Record<string, string>, ctx: Ctx): { box: Style; text: Style; display?: string } {
  const box: Style = {};
  const text: Style = {};
  let display: string | undefined;
  const set = (k: string, v: unknown) => {
    if (v === undefined || v === "") return;
    (TEXT_PROPS.has(k) ? text : box)[k] = v;
  };
  for (const [prop, raw] of Object.entries(css)) {
    const v = resolveVars(raw, ctx);
    switch (prop) {
      case "display":
        display = v;
        if (v === "none") box.display = "none";
        if (v === "flex" || v === "inline-flex") box.flexDirection = "row";
        break;
      case "flex-direction": set("flexDirection", v === "row" || v === "row-reverse" ? v : v === "column-reverse" ? v : "column"); break;
      case "flex-wrap": set("flexWrap", v); break;
      case "flex": {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) set("flex", n);
        break;
      }
      case "flex-grow": set("flexGrow", parseFloat(v)); break;
      case "flex-shrink": set("flexShrink", parseFloat(v)); break;
      case "align-items": set("alignItems", v); break;
      case "align-self": set("alignSelf", v); break;
      case "justify-content": set("justifyContent", v); break;
      case "gap": set("gap", length(v)); break;
      case "row-gap": set("rowGap", length(v)); break;
      case "column-gap": set("columnGap", length(v)); break;
      case "padding":
      case "margin": {
        const [t, r, b, l] = sides(v);
        set(prop + "Top", t); set(prop + "Right", r); set(prop + "Bottom", b); set(prop + "Left", l);
        break;
      }
      case "padding-top": case "padding-right": case "padding-bottom": case "padding-left":
      case "margin-top": case "margin-right": case "margin-bottom": case "margin-left": {
        const [a, side] = prop.split("-");
        set(a + side[0].toUpperCase() + side.slice(1), length(v));
        break;
      }
      case "width": case "height": case "min-width": case "min-height": case "max-width": case "max-height": {
        const k = prop.replace(/-(\w)/, (_, c: string) => c.toUpperCase());
        set(k, length(v));
        break;
      }
      case "background":
      case "background-color":
        if (/gradient\(/.test(v)) set("backgroundImage", v);
        else set("backgroundColor", v);
        break;
      case "background-image": if (/gradient\(/.test(v)) set("backgroundImage", v); break;
      case "border": {
        const w = /(\d+(?:\.\d+)?)px/.exec(v);
        if (w) set("borderWidth", parseFloat(w[1]));
        const style = /\b(solid|dashed|dotted)\b/.exec(v);
        if (style) set("borderStyle", style[1]);
        const color = v.replace(/\d+(?:\.\d+)?px|\b(solid|dashed|dotted|none)\b/g, "").trim();
        if (color) set("borderColor", color);
        if (/\bnone\b/.test(v)) set("borderWidth", 0);
        break;
      }
      case "border-width": set("borderWidth", length(v)); break;
      case "border-color": set("borderColor", v); break;
      case "border-style": set("borderStyle", v); break;
      case "border-radius": set("borderRadius", length(v.split(/\s+/)[0])); break;
      case "border-top": case "border-bottom": case "border-left": case "border-right": {
        const side = prop.slice(7);
        const cap = side[0].toUpperCase() + side.slice(1);
        const w = /(\d+(?:\.\d+)?)px/.exec(v);
        if (w) set(`border${cap}Width`, parseFloat(w[1]));
        const color = v.replace(/\d+(?:\.\d+)?px|\b(solid|dashed|dotted)\b/g, "").trim();
        if (color) set(`border${cap}Color`, color);
        break;
      }
      case "opacity": set("opacity", parseFloat(v)); break;
      case "overflow": set("overflow", v === "visible" ? "visible" : "hidden"); break;
      case "box-shadow": set("boxShadow", v); break;
      case "position": if (v === "relative" || v === "absolute") set("position", v); break;
      case "top": case "left": case "right": case "bottom": set(prop, length(v)); break;
      case "color": set("color", v); break;
      case "font-size": set("fontSize", length(v)); break;
      case "font-weight": set("fontWeight", v === "bold" ? "700" : v === "normal" ? "400" : v); break;
      case "font-style": set("fontStyle", v === "italic" ? "italic" : "normal"); break;
      case "font-family": if (/mono/i.test(v)) set("fontFamily", "Menlo"); break;
      case "text-align": set("textAlign", v); break;
      case "letter-spacing": set("letterSpacing", length(v)); break;
      case "text-transform": set("textTransform", v); break;
      case "text-decoration":
      case "text-decoration-line":
        set("textDecorationLine", /underline/.test(v) ? "underline" : /line-through/.test(v) ? "line-through" : "none");
        break;
      case "line-height":
        // Only absolute heights; a unitless multiplier keeps the default.
        if (/^[\d.]+px$/.test(v.trim())) set("lineHeight", parseFloat(v));
        break;
    }
  }
  return { box, text, display };
}

// MARK: default element styles

function tagStyle(tag: string, p: Palette): { box: Style; text: Style } {
  switch (tag) {
    case "h1": return { box: { marginTop: 8, marginBottom: 6 }, text: { fontSize: 24, fontWeight: "700" } };
    case "h2": return { box: { marginTop: 8, marginBottom: 6 }, text: { fontSize: 21, fontWeight: "700" } };
    case "h3": return { box: { marginTop: 6, marginBottom: 4 }, text: { fontSize: 19, fontWeight: "600" } };
    case "h4": case "h5": case "h6": return { box: { marginTop: 4, marginBottom: 4 }, text: { fontSize: 16, fontWeight: "600" } };
    case "p": return { box: { marginTop: 4, marginBottom: 4 }, text: {} };
    case "hr": return { box: { height: 0.5, backgroundColor: p.separator, marginTop: 12, marginBottom: 12 }, text: {} };
    case "pre": return { box: { backgroundColor: p.pill, borderRadius: 8, padding: 10, marginTop: 4, marginBottom: 4 }, text: { fontFamily: "Menlo", fontSize: 13 } };
    case "blockquote": return { box: { borderLeftWidth: 3, borderLeftColor: p.accent, paddingLeft: 10, marginTop: 4, marginBottom: 4 }, text: {} };
    case "ul": case "ol": return { box: { marginTop: 4, marginBottom: 4, gap: 2 }, text: {} };
    case "li": return { box: { flexDirection: "row", gap: 6 }, text: {} };
    case "table": return { box: { marginTop: 4, marginBottom: 4 }, text: {} };
    case "tr": return { box: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: p.separator }, text: {} };
    case "td": return { box: { flex: 1, paddingTop: 6, paddingBottom: 6, paddingRight: 8 }, text: {} };
    case "th": return { box: { flex: 1, paddingTop: 6, paddingBottom: 6, paddingRight: 8 }, text: { fontWeight: "600" } };
    case "button": return { box: { alignItems: "center", justifyContent: "center", borderRadius: 12, padding: 12, backgroundColor: p.accent, marginTop: 8 }, text: { color: p.accentText, fontWeight: "600", textAlign: "center" } };
    case "summary": return { box: {}, text: { fontWeight: "600" } };
    case "b": case "strong": return { box: {}, text: { fontWeight: "600" } };
    case "em": case "i": return { box: {}, text: { fontStyle: "italic" } };
    case "u": return { box: {}, text: { textDecorationLine: "underline" } };
    case "s": return { box: {}, text: { textDecorationLine: "line-through" } };
    case "small": case "sub": case "sup": return { box: {}, text: { fontSize: 12 } };
    case "code": return { box: {}, text: { fontFamily: "Menlo", fontSize: 13 } };
    case "mark": return { box: {}, text: { backgroundColor: "#fff3a3", color: "#000" } };
    case "a": return { box: {}, text: { color: p.accent } };
    default: return { box: {}, text: {} };
  }
}

// MARK: rendering

function isBlock(el: ElementNode, display?: string): boolean {
  if (display === "block" || display === "flex" || display === "inline-flex" || display === "grid" || display === "inline-block") return true;
  if (display === "inline") return false;
  return BLOCK.has(el.tag);
}

function link(el: ElementNode, ctx: Ctx): string | null {
  const href = f(el.attrs.href ?? el.attrs["data-url"] ?? "", ctx).trim();
  return href.startsWith("https://") ? href : null;
}

function open(url: string) {
  openUrl(url).catch(() => {});
}

function pressHandler(el: ElementNode, ctx: Ctx, href: string | null): (() => void) | undefined {
  if (ctx.press) return ctx.press(el, href);
  return href ? () => open(href) : undefined;
}

function hidden(n: WidgetNode): boolean {
  return n.type === "element" && "hidden" in n.attrs;
}

function renderInline(node: WidgetNode, ctx: Ctx, inherited: Style): JSX.Element | null {
  if (node.type === "text") return node.text ? f(node.text, ctx).replace(/\s+/g, " ") : null;
  // An svg inside a run of text has no box of its own to draw in.
  if (SKIP.has(node.tag) || node.tag === "svg" || hidden(node)) return null;
  if (node.tag === "br") return "\n";
  const own = tagStyle(node.tag, ctx.p);
  const { css, ctx: inner } = computed(node, ctx);
  if (css.display === "none") return null;
  const style = { ...own.text, ...css.text };
  const href = node.tag === "a" ? link(node, ctx) : null;
  return (
    <Text style={style as never} onPress={pressHandler(node, ctx, href)}>
      {node.children.map((c) => renderInline(c, inner, { ...inherited, ...style }))}
    </Text>
  );
}

// Box properties make an inline element a box of its own (a coloured dot, a
// tag with a border): a Text run cannot draw them.
const BOX_KEYS = ["width", "height", "backgroundColor", "backgroundImage", "borderWidth", "borderRadius", "paddingTop", "paddingLeft"];

/** `flex` (the parent is a flex container): every element child is a flex item, laid out as a box, as CSS does. */
function renderChildren(children: WidgetNode[], ctx: Ctx, text: Style, listTag?: string, flex = false): JSX.Element[] {
  const out: JSX.Element[] = [];
  let run: WidgetNode[] = [];
  let index = 0;
  const flush = () => {
    const meaningful = run.some((n) => n.type !== "text" || n.text.trim() !== "");
    if (meaningful) {
      // Trim the whitespace HTML would collapse at the edges of a block.
      const parts = run.map((n) => renderInline(n, ctx, text));
      const first = parts.findIndex((x) => x != null);
      if (typeof parts[first] === "string") parts[first] = (parts[first] as string).replace(/^\s+/, "");
      const last = parts.length - 1 - [...parts].reverse().findIndex((x) => x != null);
      if (typeof parts[last] === "string") parts[last] = (parts[last] as string).replace(/\s+$/, "");
      out.push(<Text style={text as never}>{parts}</Text>);
    }
    run = [];
  };
  for (const c of children) {
    if (c.type === "element" && (SKIP.has(c.tag) || hidden(c))) continue;
    const css = c.type === "element" ? computed(c, ctx).css : null;
    if (css?.display === "none") continue;
    const boxy = css != null && BOX_KEYS.some((k) => k in css.box);
    if (c.type === "element" && (flex || boxy || isBlock(c, css?.display))) {
      flush();
      index += 1;
      out.push(renderBlock(c, ctx, text, listTag, index, flex));
    } else {
      run.push(c);
    }
  }
  flush();
  return out;
}

function renderBlock(el: ElementNode, ctx: Ctx, inherited: Style, listTag?: string, index = 1, inFlex = false): JSX.Element {
  const own = tagStyle(el.tag, ctx.p);
  const { css, ctx: inner } = computed(el, ctx);
  const text = { ...inherited, ...own.text, ...css.text };
  const box: Style = { ...own.box, ...css.box };
  // Inline boxes (inline-flex, inline-block, a styled span) take their content's width.
  const inline = css.display === "inline-flex" || css.display === "inline-block" || (!BLOCK.has(el.tag) && css.display !== "flex" && css.display !== "block");
  if (inline && !inFlex && box.alignSelf === undefined && box.width === undefined) box.alignSelf = "flex-start";
  if (el.tag === "img") {
    const src = el.attrs.src ?? "";
    if (!src.startsWith("data:image/")) return <View />;
    const w = length(el.attrs.width ?? "") ?? 0;
    const h = length(el.attrs.height ?? "") ?? 0;
    return <Image src={src} style={{ width: w || "100%", height: h || 120, borderRadius: 8, ...box } as never} />;
  }
  if (el.tag === "svg") return renderSvg(el, ctx, box, text);
  if (el.tag === "hr") return <View style={box as never} />;
  const href = el.tag === "a" || el.tag === "button" ? link(el, ctx) : null;
  const press = pressHandler(el, ctx, href);
  const isFlex = css.display === "flex" || css.display === "inline-flex";
  if (isFlex && box.alignItems === undefined) box.alignItems = "stretch";
  const children = renderChildren(el.children, inner, text, el.tag === "ul" || el.tag === "ol" ? el.tag : undefined, isFlex);
  if (el.tag === "li") {
    const marker = listTag === "ol" ? `${index}.` : "•";
    return (
      <View style={box as never}>
        <Text style={{ ...text, color: ctx.p.hint } as never}>{marker}</Text>
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );
  }
  return (
    <View style={box as never} onPress={press} activeStyle={press ? { opacity: 0.7 } : undefined}>
      {children}
    </View>
  );
}

/**
 * An inline <svg> as an image of its markup. Its size comes from its CSS, else
 * its width and height attributes (`width="100%"`: the container's width), else
 * its viewBox's aspect ratio; preserveAspectRatio sets how it fills the box.
 */
function renderSvg(el: ElementNode, ctx: Ctx, box: Style, text: Style): JSX.Element {
  const color = typeof text.color === "string" ? text.color : undefined;
  const value = (s: string) => {
    const v = resolveVars(f(s, ctx), ctx);
    return color ? v.replace(/\bcurrentColor\b/gi, color) : v;
  };
  const attr = (k: string) => value(el.attrs[k] ?? "");
  const size = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.endsWith("%")) ? v : undefined);
  const width = size(box.width) ?? size(length(attr("width"))) ?? "100%";
  // A percentage of a card's height, which follows its content, is no height (as in CSS).
  const px = (v: unknown) => (typeof v === "number" ? v : undefined);
  let height = px(box.height) ?? px(length(attr("height")));
  const ratio = viewBoxRatio(attr("viewbox"));
  let aspectRatio: number | undefined;
  if (height === undefined) {
    if (ratio && typeof width === "number") height = width / ratio;
    else if (ratio) aspectRatio = ratio;
    else height = 150;
  }
  const title = el.children.find((c): c is ElementNode => c.type === "element" && c.tag === "title");
  const label = f(el.attrs["aria-label"] ?? (title ? title.children.map((c) => (c.type === "text" ? c.text : "")).join("") : ""), ctx).trim();
  // A fixed width wider than the card shrinks to it rather than overflowing.
  const maxWidth = box.maxWidth ?? (typeof width === "number" ? "100%" : undefined);
  const style = { ...box, width, height, ...(maxWidth !== undefined ? { maxWidth } : {}), ...(aspectRatio ? { aspectRatio } : {}), ...svgFit(attr("preserveaspectratio")) };
  return <Image src={svgDataUrl(svgMarkup(el, value))} style={style as never} accessibilityLabel={label || undefined} />;
}

/** Renders a card, or nothing when the HTML is empty or over the limits. */
// Parsed cards by their HTML: rows are rebuilt as they scroll back in, and
// parsing is the costly part.
const parsed = new Map<string, WidgetNode[]>();
function parseCached(html: string): WidgetNode[] {
  let nodes = parsed.get(html);
  if (!nodes) {
    nodes = cleanHTML(html);
    if (parsed.size >= 200) parsed.delete(parsed.keys().next().value!);
    parsed.set(html, nodes);
  }
  return nodes;
}

/** The card's root (what :root, html and body name) over a static tree, with each node's parent. */
const trees = new WeakMap<WidgetNode[], { root: ElementNode; parents: WeakMap<WidgetNode, ElementNode> }>();
function treeOf(nodes: WidgetNode[]) {
  let t = trees.get(nodes);
  if (!t) {
    const root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: nodes };
    const parents = new WeakMap<WidgetNode, ElementNode>();
    const walk = (el: ElementNode) => {
      for (const c of el.children) {
        parents.set(c, el);
        if (c.type === "element") walk(c);
      }
    };
    walk(root);
    t = { root, parents };
    trees.set(nodes, t);
  }
  return t;
}

/** Draws a card from its root: :root rules give the base text style, the outer box and custom properties. */
function renderCard(root: ElementNode, ctx: Ctx, base: Style): JSX.Element {
  const decls = cascade(root, ctx.sheet, ctx.env, ctx.scheme, []);
  let inner = ctx;
  for (const [k, v] of Object.entries(decls)) {
    // The theme's variables are fixed on the root, as in Telegram.
    if (!k.startsWith("--") || k.startsWith("--tg-")) continue;
    if (inner === ctx) inner = { ...ctx, vars: { ...ctx.vars } };
    inner.vars[k] = resolveVars(v, inner);
  }
  const css = mapStyle(decls, inner);
  return <View style={css.box as never}>{renderChildren(root.children, inner, { ...base, ...css.text })}</View>;
}

function schemeOf(vars: Record<string, string>): Scheme {
  return vars["--tg-color-scheme"] === "dark" ? "dark" : "light";
}

/** A card's context: `{{key}}` filled as it renders (`raw`: a tree that is already filled). */
function staticCtx(nodes: WidgetNode[], data: Record<string, unknown>, palette: Palette, raw = false): { ctx: Ctx; root: ElementNode } {
  const { root, parents } = treeOf(nodes);
  const vars = widgetVars(palette);
  // Matching reads id and class many times per element: fill each once per draw.
  const filled = new Map<ElementNode, Record<string, string>>();
  const env: TreeEnv = {
    parentOf: (n) => parents.get(n),
    attr: (el, name) => {
      const value = el.attrs[name];
      if (value === undefined || raw || !value.includes("{{")) return value;
      let byName = filled.get(el);
      if (!byName) filled.set(el, (byName = {}));
      return (byName[name] ??= fill(value, data));
    },
  };
  const sheet = parseSheet(raw ? styleText(nodes) : styleText(nodes, (s) => fill(s, data)));
  return { ctx: { data, vars, p: palette, sheet, env, scheme: schemeOf(vars), computed: new Map(), raw }, root };
}

export function Widget(props: { html: string; data: string; palette: Palette; messageId?: number; allowQueries?: boolean }): JSX.Element {
  const nodes = parseCached(props.html);
  if (nodes.length === 0 || countNodes(nodes) > MAX_NODES) return <View />;
  const data = parseData(props.data);
  const base: Style = { color: props.palette.text, fontSize: 15, lineHeight: 21 };
  if (scriptsOf(nodes)) return <ScriptedWidget nodes={nodes} data={data} rawData={props.data} base={base} palette={props.palette} messageId={props.messageId ?? 0} allowQueries={props.allowQueries === true} />;
  // Read the palette inside the view, so the card is drawn again when the appearance changes.
  const draw = () => {
    const { ctx, root } = staticCtx(nodes, data, props.palette);
    return renderCard(root, ctx, { ...base, color: props.palette.text });
  };
  return <View>{draw()}</View>;
}

/** Whether the card has a script to run. */
function scriptsOf(nodes: WidgetNode[]): boolean {
  return nodes.some((n) => n.type === "element" && (n.tag === "script" || scriptsOf(n.children)));
}

/** The card's nodes with `{{key}}` filled in text, attributes and <style>, as its script gets them. */
function fillTree(nodes: WidgetNode[], data: Record<string, unknown>): WidgetNode[] {
  return nodes.map((n) => {
    if (n.type === "text") return { type: "text", text: fill(n.text, data) };
    if (n.tag === "script") return n;
    if (n.tag === "style") return { type: "element", tag: "style", attrs: {}, children: [{ type: "text", text: fill(styleText([n]), data) }] };
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.attrs)) attrs[k] = fill(v, data);
    return { type: "element", tag: n.tag, attrs, children: fillTree(n.children, data) };
  });
}

interface CardResult {
  tree: WidgetNode[] | null;
  /** The tree as the card sent it, to skip a redraw when nothing changed. */
  raw: string | null;
  paths: Map<ElementNode, number[]>;
  prevented: boolean;
  open: string | null;
  copy: string | null;
}

/** A host's answer (JSON), with the tree checked against the whitelist. */
function readResult(json: unknown): CardResult {
  let r: Record<string, unknown> = {};
  try {
    const v = typeof json === "string" ? JSON.parse(json) : null;
    if (v && typeof v === "object") r = v;
  } catch {}
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  for (const line of Array.isArray(r.logs) ? r.logs.slice(0, 20) : []) console.log(`[card] ${String(line)}`);
  const paths = new Map<ElementNode, number[]>();
  const raw = r.tree == null ? null : JSON.stringify(r.tree);
  return { tree: r.tree == null ? null : cleanTree(r.tree, paths), raw, paths, prevented: r.prevented === true, open: str(r.open), copy: str(r.copy) };
}

let cardSeq = 0;

/** A card with scripts: the static card until the host's runtime answers, then the trees its script draws. */
function ScriptedWidget(props: { nodes: WidgetNode[]; data: Record<string, unknown>; rawData: string; base: Style; palette: Palette; messageId: number; allowQueries: boolean }): JSX.Element {
  const key = `card-${++cardSeq}`;
  const tree = signal<WidgetNode[] | null>(null);
  let paths = new Map<ElementNode, number[]>();
  let closed = false;
  let lastRaw: string | null = null;

  const apply = (json: unknown): CardResult => {
    const r = readResult(json);
    // A tree equal to the one on screen (a timer wrote the same text again) is not drawn again.
    if (r.tree && !closed && r.raw !== lastRaw) {
      lastRaw = r.raw;
      paths = r.paths;
      tree.set(r.tree);
    }
    return r;
  };

  const initialVars = untracked(() => widgetVars(props.palette));
  const load = {
    tree: fillTree(props.nodes, props.data),
    data: props.rawData,
    theme: initialVars,
    language: untracked(locale),
    active: untracked(lifecycle) === "active",
    messageId: props.messageId,
    allowQueries: props.allowQueries,
  };
  cards.open(key, JSON.stringify(load)).then(apply).catch(() => {});
  const off = on("honk.card.changed", (p) => {
    const e = p as { key?: unknown; result?: unknown };
    if (e && e.key === key) apply(e.result);
  });
  cleanup(() => {
    closed = true;
    off();
    cards.close(key).catch(() => {});
  });
  let lastVars = JSON.stringify(initialVars);
  effect(() => {
    const vars = JSON.stringify(widgetVars(props.palette));
    if (vars !== lastVars) {
      lastVars = vars;
      cards.set(key, JSON.stringify({ theme: JSON.parse(vars) })).then(apply).catch(() => {});
    }
  });
  let lastActive = load.active;
  effect(() => {
    const active = lifecycle() === "active";
    if (active !== lastActive) {
      lastActive = active;
      cards.set(key, JSON.stringify({ active })).then(apply).catch(() => {});
    }
  });

  const press = (el: ElementNode, href: string | null): (() => void) | undefined => {
    if (!el.on) return href ? () => open(href) : undefined;
    return () => {
      const path = paths.get(el);
      if (!path) return;
      cards.click(key, JSON.stringify(path)).then((json) => {
        const r = apply(json);
        if (r.open && r.open.startsWith("https://")) open(r.open);
        if (r.copy) Clipboard.writeText(r.copy).catch(() => {});
        // One link per tap: the script's, else the element's own.
        if (!r.prevented && !r.open && href) open(href);
      }).catch(() => {});
    };
  };

  const draw = () => {
    const t = tree();
    if (!t) {
      const { ctx, root } = staticCtx(props.nodes, props.data, props.palette);
      return renderCard(root, ctx, { ...props.base, color: props.palette.text });
    }
    const { ctx, root } = staticCtx(t, props.data, props.palette, true);
    return renderCard(root, { ...ctx, press }, { ...props.base, color: props.palette.text });
  };
  return <View>{draw()}</View>;
}

// Exposed for tests.
export const _internal = { mapStyle, length };
