// CSS selectors over a card's node tree, shared by the stylesheet cascade
// (css.ts) and the scripts' querySelector (sandbox.ts).
//
// Supported: type, *, #id, .class, [attr], [attr=v] (and ~= ^= $= *= |=),
// :first-child, :last-child, :only-child, :nth-child(odd | even | an+b),
// :root (html and body name the same root), and the descendant, child (>), next-sibling (+) and later-sibling (~)
// combinators, several selectors separated by commas.

import type { ElementNode, WidgetNode } from "./parse";

interface Pseudo {
  kind: "first" | "last" | "only" | "nth" | "root";
  a?: number;
  b?: number;
  /** `html` or `body`: the root, with a type's specificity. */
  type?: boolean;
}

export interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op?: string; value?: string }[];
  pseudos: Pseudo[];
}

export interface Complex {
  parts: Compound[];
  /** Between parts[i] and parts[i + 1]: " ", ">", "+" or "~". */
  combinators: string[];
  /** [ids, classes + attributes + pseudo-classes, types], compared in order. */
  specificity: [number, number, number];
}

export type Selector = Complex[];

/** How to walk the tree: the parent of a node (the card's root has a "#root" tag or none) and an element's attribute as it renders. */
export interface TreeEnv {
  parentOf(n: WidgetNode): ElementNode | undefined;
  attr(el: ElementNode, name: string): string | undefined;
}

const cache = new Map<string, Selector | null>();

/** Parses a selector list; null when any part is not supported. */
export function parseSelector(src: string): Selector | null {
  if (cache.has(src)) return cache.get(src)!;
  const out = parseList(src);
  if (cache.size > 512) cache.clear();
  cache.set(src, out);
  return out;
}

function parseList(src: string): Selector | null {
  const groups: Selector = [];
  for (const raw of splitTop(src, ",")) {
    const s = raw.trim();
    if (!s) return null;
    const parts: Compound[] = [];
    const combinators: string[] = [];
    // Compounds and combinators; parentheses (nth-child) stay inside a compound.
    const re = /\s*([>+~])\s*|\s+|((?:[^\s>+~(]|\([^)]*\))+)/g;
    let m: RegExpExecArray | null;
    let pending = "";
    while ((m = re.exec(s))) {
      if (m[2]) {
        const c = parseCompound(m[2]);
        if (!c) return null;
        if (parts.length) combinators.push(pending || " ");
        else if (pending && pending !== " ") return null;
        parts.push(c);
        pending = "";
      } else if (m[1]) {
        if (pending && pending !== " ") return null;
        pending = m[1];
      } else if (!pending) pending = " ";
    }
    if (!parts.length || (pending && pending !== " ")) return null;
    // `html body`: a card has one root for both.
    for (let k = parts.length - 1; k > 0; k--) {
      const rootOnly = (c: Compound) => !c.tag && c.id === undefined && !c.classes.length && !c.attrs.length && c.pseudos.length > 0 && c.pseudos.every((p) => p.kind === "root");
      if (rootOnly(parts[k - 1]) && parts[k].pseudos.some((p) => p.kind === "root") && combinators[k - 1] !== "+" && combinators[k - 1] !== "~") {
        parts[k].pseudos.push(...parts[k - 1].pseudos);
        parts.splice(k - 1, 1);
        combinators.splice(k - 1, 1);
      }
    }
    const spec: [number, number, number] = [0, 0, 0];
    for (const p of parts) {
      if (p.id !== undefined) spec[0]++;
      spec[1] += p.classes.length + p.attrs.length + p.pseudos.filter((x) => !x.type).length;
      spec[2] += p.pseudos.filter((x) => x.type).length;
      if (p.tag) spec[2]++;
    }
    groups.push({ parts, combinators, specificity: spec });
  }
  return groups;
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseNth(arg: string): { a: number; b: number } | null {
  const s = arg.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (!m) return null;
  const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  return { a, b: m[2] ? Number(m[2]) : 0 };
}

function parseCompound(s: string): Compound | null {
  const c: Compound = { classes: [], attrs: [], pseudos: [] };
  const re = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?\]|:([\w-]+)(?:\(([^)]*)\))?/y;
  let i = 0;
  let first = true;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || (m[1] && !first)) return null;
    if (m[1] && /^(html|body)$/i.test(m[1])) c.pseudos.push({ kind: "root", type: true });
    else if (m[1]) c.tag = m[1] === "*" ? undefined : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] ?? m[7] ?? m[8] });
    else {
      const name = m[9].toLowerCase();
      if (name === "first-child" && m[10] === undefined) c.pseudos.push({ kind: "first" });
      else if (name === "last-child" && m[10] === undefined) c.pseudos.push({ kind: "last" });
      else if (name === "only-child" && m[10] === undefined) c.pseudos.push({ kind: "only" });
      else if (name === "root" && m[10] === undefined) c.pseudos.push({ kind: "root" });
      else if (name === "nth-child" && m[10] !== undefined) {
        const nth = parseNth(m[10]);
        if (!nth) return null;
        c.pseudos.push({ kind: "nth", ...nth });
      } else return null; // :hover, ::before and the rest never match a card
    }
    i = re.lastIndex;
    first = false;
  }
  return c;
}

function isRoot(n: ElementNode | undefined): boolean {
  return !n || n.tag === "#root";
}

function siblings(env: TreeEnv, el: ElementNode): ElementNode[] | null {
  const p = env.parentOf(el);
  return p ? p.children.filter((c): c is ElementNode => c.type === "element") : null;
}

function matchCompound(el: ElementNode, c: Compound, env: TreeEnv): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id !== undefined && env.attr(el, "id") !== c.id) return false;
  if (c.classes.length) {
    const cls = (env.attr(el, "class") ?? "").split(/\s+/);
    for (const x of c.classes) if (!cls.includes(x)) return false;
  }
  for (const a of c.attrs) {
    const v = env.attr(el, a.name);
    if (v === undefined) return false;
    if (!a.op) continue;
    const want = a.value ?? "";
    switch (a.op) {
      case "=": if (v !== want) return false; break;
      case "~=": if (!v.split(/\s+/).includes(want)) return false; break;
      case "^=": if (!want || !v.startsWith(want)) return false; break;
      case "$=": if (!want || !v.endsWith(want)) return false; break;
      case "*=": if (!want || !v.includes(want)) return false; break;
      case "|=": if (v !== want && !v.startsWith(want + "-")) return false; break;
    }
  }
  for (const p of c.pseudos) {
    if (p.kind === "root") {
      if (el.tag !== "#root") return false;
      continue;
    }
    const sibs = siblings(env, el);
    if (!sibs) return false;
    const i = sibs.indexOf(el);
    if (p.kind === "first" && i !== 0) return false;
    if (p.kind === "last" && i !== sibs.length - 1) return false;
    if (p.kind === "only" && sibs.length !== 1) return false;
    if (p.kind === "nth") {
      const n = i + 1 - p.b!;
      if (p.a === 0 ? n !== 0 : n / p.a! < 0 || n % p.a! !== 0) return false;
    }
  }
  return true;
}

/** Whether `el` matches the complex selector `g`. The card's root never matches a type or class, only `:root`. */
export function matchComplex(el: ElementNode, g: Complex, env: TreeEnv): boolean {
  const match = (node: ElementNode, k: number): boolean => {
    if (!matchCompound(node, g.parts[k], env)) return false;
    if (k === 0) return true;
    const comb = g.combinators[k - 1];
    if (comb === "+" || comb === "~") {
      const sibs = siblings(env, node);
      if (!sibs) return false;
      const i = sibs.indexOf(node);
      if (comb === "+") return i > 0 && match(sibs[i - 1], k - 1);
      for (let j = i - 1; j >= 0; j--) if (match(sibs[j], k - 1)) return true;
      return false;
    }
    let p = env.parentOf(node);
    // A selector part names the root only through :root.
    const reaches = (n: ElementNode) => !isRoot(n) || g.parts[k - 1].pseudos.some((x) => x.kind === "root");
    if (comb === ">") return !!p && reaches(p) && match(p, k - 1);
    while (p) {
      if (reaches(p) && match(p, k - 1)) return true;
      p = env.parentOf(p);
    }
    return false;
  };
  if (el.tag === "#root" && !g.parts[g.parts.length - 1].pseudos.some((x) => x.kind === "root")) return false;
  return match(el, g.parts.length - 1);
}

export function matches(el: ElementNode, sel: Selector, env: TreeEnv): boolean {
  return sel.some((g) => matchComplex(el, g, env));
}
