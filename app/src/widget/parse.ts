// A small HTML parser for message cards (profile v1). The gateway has already
// removed everything outside the whitelist; this only builds a tree.

export interface ElementNode {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: WidgetNode[];
}

export interface TextNode {
  type: "text";
  text: string;
}

export type WidgetNode = ElementNode | TextNode;

const VOID = new Set(["br", "hr", "img", "col", "stop", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use"]);
const RAW = new Set(["style", "script"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", copy: "©" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parses `html` into a list of top-level nodes. Never throws. */
export function parse(html: string): WidgetNode[] {
  const root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      top().children.push({ type: "text", text: decodeEntities(html.slice(i)) });
      break;
    }
    if (lt > i) top().children.push({ type: "text", text: decodeEntities(html.slice(i, lt)) });

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const tag = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
      // Close up to the matching element; a stray close tag is ignored.
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const end = html.indexOf(">", lt);
    if (end < 0 || !/[a-zA-Z!]/.test(html[lt + 1] ?? "")) {
      top().children.push({ type: "text", text: "<" });
      i = lt + 1;
      continue;
    }
    const inner = html.slice(lt + 1, end);
    if (inner.startsWith("!")) {
      i = end + 1; // doctype
      continue;
    }
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const selfClosing = inner.endsWith("/");
    const el: ElementNode = { type: "element", tag, attrs: parseAttrs(inner.slice(nameMatch[1].length, selfClosing ? -1 : undefined)), children: [] };
    i = end + 1;
    if (tag === "html" || tag === "head" || tag === "body") continue;
    top().children.push(el);
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      el.children.push({ type: "text", text: html.slice(i, close < 0 ? html.length : close) });
      i = close < 0 ? html.length : html.indexOf(">", close) + 1 || html.length;
      continue;
    }
    if (!selfClosing && !VOID.has(tag)) stack.push(el);
  }
  return root.children;
}

/** Replaces `{{ key }}` (dotted paths allowed) with values from `data`. */
export function fill(s: string, data: Record<string, unknown>): string {
  if (!s.includes("{{")) return s;
  return s.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    let v: unknown = data;
    for (const k of path.split(".")) v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** The message's data as an object; `{}` when it is empty or not a JSON object. */
export function parseData(data: string): Record<string, unknown> {
  if (!data) return {};
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** `a: b; c: d` into an object of lowercased property names. */
export function parseStyle(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const decl of s.split(";")) {
    const c = decl.indexOf(":");
    if (c < 0) continue;
    const k = decl.slice(0, c).trim().toLowerCase();
    const v = decl.slice(c + 1).replace(/!important/i, "").trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export function countNodes(nodes: WidgetNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + (node.type === "element" ? countNodes(node.children) : 0);
  return n;
}
