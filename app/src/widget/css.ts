// Stylesheets in cards: the rules of a card's <style> blocks, matched to its
// elements with the cascade (specificity, then order; inline style beats the
// sheet unless a sheet declaration is !important). `@media
// (prefers-color-scheme: dark | light)` follows the app's appearance; other
// media queries and at-rules (@keyframes, @font-face, @supports…) are skipped.

import { badCSS } from "./sanitize";
import { matchComplex, parseSelector, type Complex, type TreeEnv } from "./selector";
import type { ElementNode, WidgetNode } from "./parse";

/** Style rules a card may have (Telegram: 400). Later ones are ignored. */
export const MAX_RULES = 400;

export type Scheme = "light" | "dark";

export interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

interface Rule {
  sel: Complex;
  decls: Decl[];
  order: number;
  /** The color schemes the rule applies in (from @media); all when absent. */
  schemes?: Set<Scheme>;
}

export interface Sheet {
  rules: Rule[];
  /** Rules by the key of their last compound: `#id`, `.class`, a tag or `*`. */
  index: Map<string, Rule[]>;
}

const EMPTY: Sheet = { rules: [], index: new Map() };

/** Splits `s` at `sep` outside parentheses and quotes. */
function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** A declaration block (`a: b; c: d !important`). Declarations that would load anything are dropped. */
export function parseDecls(text: string): Decl[] {
  const out: Decl[] = [];
  for (const part of splitOutside(text, ";")) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    let prop = part.slice(0, c).trim();
    let value = part.slice(c + 1).trim();
    if (!prop || !value) continue;
    if (!prop.startsWith("--")) prop = prop.toLowerCase();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    if (badCSS(value)) continue;
    out.push({ prop, value, important });
  }
  return out;
}

/** The schemes a media query list allows, or null when it never matches a card. */
function mediaSchemes(cond: string): Set<Scheme> | null {
  const out = new Set<Scheme>();
  for (const q of splitOutside(cond.toLowerCase(), ",")) {
    let s = q.trim();
    if (!s) continue;
    if (/^not\b/.test(s)) continue;
    s = s.replace(/^only\s+/, "");
    let ok = true;
    const schemes = new Set<Scheme>(["light", "dark"]);
    for (const tok of s.split(/\s+and\s+/)) {
      const t = tok.trim();
      if (t === "screen" || t === "all" || t === "") continue;
      const m = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/.exec(t);
      if (m) {
        for (const x of [...schemes]) if (x !== m[1]) schemes.delete(x);
        continue;
      }
      ok = false; // widths, print, reduced motion…: not for a card
    }
    if (ok) for (const x of schemes) out.add(x);
  }
  return out.size ? out : null;
}

function keyOf(sel: Complex): string {
  const last = sel.parts[sel.parts.length - 1];
  if (last.id !== undefined) return "#" + last.id;
  if (last.classes.length) return "." + last.classes[0];
  if (last.pseudos.some((p) => p.kind === "root")) return ":root";
  return last.tag ?? "*";
}

const sheets = new Map<string, Sheet>();

/** Parses stylesheet text (cached by text). */
export function parseSheet(css: string): Sheet {
  if (!css.trim()) return EMPTY;
  const cached = sheets.get(css);
  if (cached) return cached;
  const rules: Rule[] = [];
  let count = 0;
  const text = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, " ");

  /** The index just past the block that opens at `open` (a `{`). */
  const blockEnd = (open: number): number => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return text.length;
  };

  const parseBlock = (from: number, to: number, schemes: Set<Scheme> | undefined) => {
    let i = from;
    while (i < to && count < MAX_RULES) {
      while (i < to && /\s/.test(text[i])) i++;
      if (i >= to) break;
      if (text[i] === "}") {
        i++;
        continue;
      }
      const open = text.indexOf("{", i);
      if (text[i] === "@") {
        const semi = text.indexOf(";", i);
        if (open < 0 || open >= to || (semi >= 0 && semi < open)) {
          i = semi < 0 || semi >= to ? to : semi + 1; // @import, @charset: nothing to load
          continue;
        }
        const end = Math.min(blockEnd(open), to);
        const head = text.slice(i, open).trim();
        const m = /^@media\s+(.*)$/is.exec(head);
        if (m) {
          const allowed = mediaSchemes(m[1]);
          if (allowed) {
            const inner = schemes ? new Set([...allowed].filter((x) => schemes.has(x))) : allowed;
            if (inner.size) parseBlock(open + 1, end - 1, inner);
          }
        }
        i = end;
        continue;
      }
      if (open < 0 || open >= to) break;
      const end = Math.min(blockEnd(open), to);
      const selText = text.slice(i, open).trim();
      const body = text.slice(open + 1, end - 1);
      i = end;
      count++;
      if (body.includes("{")) continue; // nesting is not supported
      const sel = parseSelector(selText);
      if (!sel) continue;
      const decls = parseDecls(body);
      if (!decls.length) continue;
      for (const g of sel) rules.push({ sel: g, decls, order: rules.length, schemes });
    }
  };
  parseBlock(0, text.length, undefined);

  const index = new Map<string, Rule[]>();
  for (const r of rules) {
    const k = keyOf(r.sel);
    const list = index.get(k);
    if (list) list.push(r);
    else index.set(k, [r]);
  }
  const sheet = { rules, index };
  if (sheets.size >= 64) sheets.delete(sheets.keys().next().value!);
  sheets.set(css, sheet);
  return sheet;
}

/** The text of every <style> block in the tree, in document order, each passed through `fill` ({{key}}). */
export function styleText(nodes: WidgetNode[], fill: (s: string) => string = (s) => s): string {
  let out = "";
  const walk = (ns: WidgetNode[]) => {
    for (const n of ns) {
      if (n.type !== "element") continue;
      if (n.tag === "style") out += fill(n.children.map((c) => (c.type === "text" ? c.text : "")).join("")) + "\n";
      else if (n.tag !== "script") walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function compare(a: Rule, b: Rule): number {
  const x = a.sel.specificity;
  const y = b.sel.specificity;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.order - b.order;
}

/** The declarations that apply to `el`, cascaded, with `inline` (its style attribute) on top. */
export function cascade(el: ElementNode, sheet: Sheet, env: TreeEnv, scheme: Scheme, inline: Decl[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (sheet.rules.length) {
    const candidates: Rule[] = [];
    const add = (k: string) => {
      const list = sheet.index.get(k);
      if (list) for (const r of list) candidates.push(r);
    };
    if (el.tag === "#root") add(":root");
    else {
      add(el.tag);
      add("*");
      const id = env.attr(el, "id");
      if (id) add("#" + id);
      const cls = env.attr(el, "class");
      if (cls) for (const c of new Set(cls.split(/\s+/))) if (c) add("." + c);
    }
    const matched = candidates.filter((r) => (!r.schemes || r.schemes.has(scheme)) && matchComplex(el, r.sel, env));
    matched.sort(compare);
    for (const r of matched) for (const d of r.decls) if (!d.important) out[d.prop] = d.value;
    for (const d of inline) out[d.prop] = d.value;
    for (const r of matched) for (const d of r.decls) if (d.important) out[d.prop] = d.value;
    return out;
  }
  for (const d of inline) out[d.prop] = d.value;
  return out;
}
