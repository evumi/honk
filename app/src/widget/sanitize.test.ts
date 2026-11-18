import { expect, test } from "nsh/test";
import fixtures from "./sanitize.fixtures.json";
import { ALLOWED_TAGS, allowedAttr, badCSS, cleanHTML, serialize } from "./sanitize";
import { parse, type WidgetNode } from "./parse";

type Case = { name: string; html: string; contains?: string[]; absent?: string[] };
const cases = fixtures.cases as Case[];

// The same cases run against the gateway's widget package (fixtures_test.go).
test("shared whitelist fixtures", () => {
  expect(cases.length >= 40).toBe(true);
  for (const c of cases) {
    const out = serialize(cleanHTML(c.html));
    for (const s of c.contains ?? []) if (!out.includes(s)) throw new Error(`${c.name}: ${JSON.stringify(s)} is missing from ${out}`);
    for (const s of c.absent ?? []) if (out.toLowerCase().includes(s.toLowerCase())) throw new Error(`${c.name}: ${JSON.stringify(s)} survived in ${out}`);
  }
});

/** Why a cleaned tree breaks the whitelist (null: it keeps it). */
function violation(nodes: WidgetNode[], inSvg = false): string | null {
  for (const n of nodes) {
    if (n.type === "text") continue;
    if (n.tag === "script") {
      if (inSvg) return "script in svg";
      if (Object.keys(n.attrs).length) return "script with attributes";
      if (n.children.some((c) => c.type !== "text" || /<!--|<\/?script[\s/>]/i.test(c.text))) return "ambiguous script";
      continue;
    }
    if (!ALLOWED_TAGS.has(n.tag)) return `tag ${n.tag}`;
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k.startsWith("on")) return `handler ${k}`;
      if (!allowedAttr(n.tag, k, v)) return `attribute ${k}=${v}`;
    }
    if (n.tag === "style" && n.children.some((c) => c.type !== "text" || badCSS(c.text))) return "style loads a resource";
    const inner = violation(n.children, inSvg || n.tag === "svg");
    if (inner) return inner;
  }
  return null;
}

// A small deterministic generator (mulberry32), so a failure can be replayed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ["div", "span", "p", "a", "img", "button", "style", "script", "svg", "g", "rect", "use", "circle", "iframe", "form", "input", "object", "embed", "video", "link", "meta", "base", "textarea", "select", "details", "summary", "table", "tr", "td", "b", "i", "foreignObject", "image", "title", "html", "body", "head", "math", "template", "noscript", "marquee", "x-y"];
const ATTRS = ["onclick", "onload", "onerror", "ONFOCUS", "href", "xlink:href", "src", "srcset", "style", "class", "id", "type", "fill", "stroke", "action", "formaction", "xml:lang", "xmlns:x", "data-x", "tabindex", "target", "mask", "filter"];
const VALUES = [
  "x()", "javascript:alert(1)", "https://e.test/a", "http://e.test/a", "#a", "{{url}}", "data:image/png;base64,AAAA", "data:text/html,x",
  "url(https://e.test/a)", "url(#g)", "url(data:image/png;base64,AAAA)", "@import 'x'", "expression(1)", "\\75rl(x)", "image-set('a' 1x)",
  "color:red", "background:url('//e.test/a')", "module", "text/javascript", "text/plain", "", "a b", "&quot;onload=x()", "&lt;script&gt;",
];
const TEXTS = ["hi", "{{a}}", "<!--", "-->", "</script", "<script", "<", ">", "&amp;", "&#60;script&#62;", "İ</script>", "a\u0000b", "\\", "'", '"'];

function randomHTML(r: () => number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let out = "";
  const n = 1 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.35) {
      let tag = `<${pick(TAGS)}`;
      for (let k = Math.floor(r() * 4); k > 0; k--) {
        const q = pick(['"', "'", ""]);
        tag += ` ${pick(ATTRS)}` + (r() < 0.9 ? `=${q}${pick(VALUES)}${q}` : "");
      }
      out += tag + (r() < 0.1 ? "/>" : ">");
    } else if (roll < 0.55) out += `</${pick(TAGS)}${pick(["", " ", "\n"])}>`;
    else if (roll < 0.7) out += pick(["<script>", "<style>", "</script>", "</style>", "<svg>", "</svg>"]);
    else out += pick(TEXTS);
  }
  return out;
}

function mutate(r: () => number, src: string): string {
  let s = src;
  for (let k = 1 + Math.floor(r() * 4); k > 0 && s.length > 0; k--) {
    const at = Math.floor(r() * s.length);
    const roll = r();
    if (roll < 0.3) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 3));
    else if (roll < 0.6) s = s.slice(0, at) + TEXTS[Math.floor(r() * TEXTS.length)] + s.slice(at);
    else if (roll < 0.8) s = s.slice(0, at) + "<" + s.slice(at);
    else s = s.slice(0, at) + src.slice(Math.floor(r() * src.length)).slice(0, 8) + s.slice(at);
  }
  return s;
}

test("fuzz: nothing outside the whitelist survives random markup", () => {
  const r = rng(20260101);
  for (let i = 0; i < 2000; i++) {
    const html = randomHTML(r);
    let tree: WidgetNode[];
    try {
      tree = cleanHTML(html);
    } catch (e) {
      throw new Error(`threw on ${JSON.stringify(html)}: ${e}`);
    }
    const v = violation(tree);
    if (v) throw new Error(`${v} survived in ${JSON.stringify(html)} -> ${serialize(tree)}`);
    // Cleaning what was cleaned changes nothing.
    const once = serialize(tree);
    if (serialize(cleanHTML(once)) !== once) throw new Error(`not stable: ${JSON.stringify(html)} -> ${once}`);
  }
});

test("fuzz: mutated cards and fixtures stay inside the whitelist", () => {
  const r = rng(7);
  const seeds = cases.map((c) => c.html);
  for (let i = 0; i < 3000; i++) {
    const html = mutate(r, seeds[i % seeds.length]);
    const tree = cleanHTML(html);
    const v = violation(tree);
    if (v) throw new Error(`${v} survived in ${JSON.stringify(html)} -> ${serialize(tree)}`);
  }
});

test("parse never throws on arbitrary text", () => {
  const r = rng(99);
  for (let i = 0; i < 2000; i++) {
    let s = "";
    for (let k = Math.floor(r() * 30); k > 0; k--) s += String.fromCharCode(Math.floor(r() * 128));
    parse(s);
    cleanHTML(s + "<script>" + s);
  }
  // Deeply nested input is cut, not recursed to the end.
  cleanHTML("<div>".repeat(6000));
});
