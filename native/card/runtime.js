// The page a card script sees, inside the card's own QuickJS runtime
// (honk_card.c): a small DOM over the card's nodes, click events, timers
// driven by the host's ticks, storage, and window.TelegramWidget after
// Telegram's HTML widgets (core.telegram.org/bots/widgets).
//
// It evaluates to its entry points, which honk_card.c takes before any card
// script runs. A card can still change everything here for itself, so
// nothing it returns is trusted: honk_card.c checks links and sizes, and the
// app sanitises the tree it draws.
(() => {
  "use strict";

  const LIMITS = { nodes: 2000, timers: 64, handlers: 16, storage: 4096, logs: 20, mutations: 10000, link: 256 };
  const stringify = JSON.stringify;
  const parseJSON = JSON.parse;
  const globalEval = eval;
  const now = () => Date.now();

  // MARK: state

  let dirty = true; // the tree was not sent yet
  let inTap = false;
  let effects = { open: null, copy: null, logs: [] };
  let mutations = 0;
  let active = true;
  let theme = {};
  let chatData = null;
  let loading = true;
  let scripts = [];

  function log(level, text) {
    if (effects.logs.length < LIMITS.logs) effects.logs.push(`${level}: ${String(text).slice(0, 400)}`);
  }

  function mutate() {
    dirty = true;
    if (++mutations > LIMITS.mutations) throw new RangeError("The card changed its page too often in one task");
  }

  // MARK: nodes

  const PARENT = Symbol("parent");
  let attachedCount = 0;

  class Node {
    constructor() {
      this[PARENT] = null;
    }
    get parentNode() {
      return this[PARENT];
    }
    get parentElement() {
      const p = this[PARENT];
      return p instanceof Element ? p : null;
    }
    get isConnected() {
      for (let n = this; n; n = n[PARENT]) if (n === root) return true;
      return false;
    }
    get nextSibling() {
      const p = this[PARENT];
      return p ? p._children[p._children.indexOf(this) + 1] || null : null;
    }
    get previousSibling() {
      const p = this[PARENT];
      return p ? p._children[p._children.indexOf(this) - 1] || null : null;
    }
    remove() {
      if (this[PARENT] && this !== root) this[PARENT]._remove(this);
    }
  }

  class Text extends Node {
    constructor(text) {
      super();
      this._text = String(text);
    }
    get nodeType() {
      return 3;
    }
    get nodeName() {
      return "#text";
    }
    get textContent() {
      return this._text;
    }
    set textContent(v) {
      const t = v == null ? "" : String(v);
      if (t === this._text) return; // writing the same text again changes nothing
      this._text = t;
      if (this.isConnected) mutate();
    }
    get data() {
      return this._text;
    }
    set data(v) {
      this.textContent = v;
    }
    get nodeValue() {
      return this._text;
    }
    set nodeValue(v) {
      this.textContent = v;
    }
    cloneNode() {
      return new Text(this._text);
    }
  }

  function size(n) {
    let c = 1;
    if (n instanceof Element) for (const k of n._children) c += size(k);
    return c;
  }

  function toNode(v) {
    if (v instanceof Node) return v;
    return new Text(v);
  }

  const kebab = (s) => (s.startsWith("--") ? s : s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function parseStyle(s) {
    const out = new Map();
    let depth = 0, quote = "", start = 0;
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start));
    for (const p of parts) {
      const i = p.indexOf(":");
      if (i < 0) continue;
      let k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (!k || !v) continue;
      if (!k.startsWith("--")) k = k.toLowerCase();
      out.set(k, v);
    }
    return out;
  }

  function styleFor(el) {
    const write = (m) => {
      const css = [...m].map(([k, v]) => `${k}: ${v}`).join("; ");
      if (css) el.setAttribute("style", css);
      else el.removeAttribute("style");
    };
    const decls = () => parseStyle(el.getAttribute("style") || "");
    const api = {
      setProperty(k, v) {
        const m = decls();
        k = kebab(String(k));
        m.delete(k);
        if (v != null && String(v) !== "") m.set(k, String(v));
        write(m);
      },
      removeProperty(k) {
        const m = decls();
        k = kebab(String(k));
        const old = m.get(k) || "";
        m.delete(k);
        write(m);
        return old;
      },
      getPropertyValue: (k) => decls().get(kebab(String(k))) || "",
    };
    return new Proxy(api, {
      get(t, k) {
        if (typeof k !== "string") return undefined;
        if (k in t) return t[k];
        if (k === "cssText") return el.getAttribute("style") || "";
        if (k === "length") return decls().size;
        return decls().get(kebab(k)) || "";
      },
      set(t, k, v) {
        if (typeof k !== "string") return true;
        if (k === "cssText") {
          if (v) el.setAttribute("style", String(v));
          else el.removeAttribute("style");
        } else t.setProperty(k, v);
        return true;
      },
    });
  }

  function classListFor(el) {
    const list = () => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const write = (l) => el.setAttribute("class", l.join(" "));
    return {
      add: (...c) => { const l = list(); for (const x of c.map(String)) if (!l.includes(x)) l.push(x); write(l); },
      remove: (...c) => { const drop = new Set(c.map(String)); write(list().filter((x) => !drop.has(x))); },
      toggle(c, force) {
        c = String(c);
        const l = list();
        const on = force === undefined ? !l.includes(c) : !!force;
        write(on ? (l.includes(c) ? l : [...l, c]) : l.filter((x) => x !== c));
        return on;
      },
      contains: (c) => list().includes(String(c)),
      replace(a, b) {
        const l = list();
        const i = l.indexOf(String(a));
        if (i < 0) return false;
        l[i] = String(b);
        write(l);
        return true;
      },
      item: (i) => list()[i] ?? null,
      get length() { return list().length; },
      get value() { return el.getAttribute("class") || ""; },
      forEach: (f) => list().forEach(f),
      [Symbol.iterator]: () => list()[Symbol.iterator](),
    };
  }

  function datasetFor(el) {
    return new Proxy({}, {
      get: (_, k) => (typeof k === "string" ? el.getAttribute("data-" + kebab(k)) ?? undefined : undefined),
      set: (_, k, v) => (typeof k === "string" && el.setAttribute("data-" + kebab(k), String(v)), true),
      deleteProperty: (_, k) => (typeof k === "string" && el.removeAttribute("data-" + kebab(k)), true),
      has: (_, k) => typeof k === "string" && el.hasAttribute("data-" + kebab(k)),
      ownKeys: () => el.getAttributeNames().filter((k) => k.startsWith("data-")).map((k) => camel(k.slice(5))),
      getOwnPropertyDescriptor: (_, k) => {
        if (typeof k !== "string" || !el.hasAttribute("data-" + kebab(k))) return undefined;
        return { value: el.getAttribute("data-" + kebab(k)), enumerable: true, configurable: true, writable: true };
      },
    });
  }

  class Element extends Node {
    constructor(tag) {
      super();
      this._tag = tag;
      this._attrs = new Map();
      this._children = [];
      this._listeners = new Map();
      this._onclick = null;
    }
    get nodeType() { return 1; }
    get tagName() { return this === root ? "BODY" : this._tag.toUpperCase(); }
    get nodeName() { return this.tagName; }
    get localName() { return this === root ? "body" : this._tag; }

    // Attributes
    getAttribute(k) { return this._attrs.get(String(k).toLowerCase()) ?? null; }
    hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()); }
    getAttributeNames() { return [...this._attrs.keys()]; }
    setAttribute(k, v) {
      k = String(k).toLowerCase();
      v = String(v);
      if (v.length > 8192) throw new RangeError("Attribute too long");
      if (this._attrs.get(k) === v) return;
      this._attrs.set(k, v);
      if (this.isConnected) mutate();
    }
    removeAttribute(k) {
      if (this._attrs.delete(String(k).toLowerCase()) && this.isConnected) mutate();
    }
    toggleAttribute(k, force) {
      const on = force === undefined ? !this.hasAttribute(k) : !!force;
      if (on) { if (!this.hasAttribute(k)) this.setAttribute(k, ""); } else this.removeAttribute(k);
      return on;
    }
    get id() { return this.getAttribute("id") || ""; }
    set id(v) { this.setAttribute("id", v); }
    get className() { return this.getAttribute("class") || ""; }
    set className(v) { this.setAttribute("class", v); }
    get title() { return this.getAttribute("title") || ""; }
    set title(v) { this.setAttribute("title", v); }
    get href() { return this.getAttribute("href") || ""; }
    set href(v) { this.setAttribute("href", v); }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(v) { this.toggleAttribute("hidden", !!v); }
    get disabled() { return this.hasAttribute("disabled"); }
    set disabled(v) { this.toggleAttribute("disabled", !!v); }
    get open() { return this.hasAttribute("open"); }
    set open(v) { this.toggleAttribute("open", !!v); }
    get value() { return this.getAttribute("value") || ""; }
    set value(v) { this.setAttribute("value", v); }
    get style() { return styleFor(this); }
    get classList() { return classListFor(this); }
    get dataset() { return datasetFor(this); }

    // Tree
    get childNodes() { return this._children.slice(); }
    get children() { return this._children.filter((c) => c instanceof Element); }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this._children[0] || null; }
    get lastChild() { return this._children[this._children.length - 1] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
    get nextElementSibling() {
      const p = this[PARENT];
      if (!p) return null;
      const c = p.children;
      return c[c.indexOf(this) + 1] || null;
    }
    get previousElementSibling() {
      const p = this[PARENT];
      if (!p) return null;
      const c = p.children;
      return c[c.indexOf(this) - 1] || null;
    }
    hasChildNodes() { return this._children.length > 0; }
    contains(n) {
      for (let x = n; x; x = x[PARENT]) if (x === this) return true;
      return false;
    }

    _remove(n) {
      const i = this._children.indexOf(n);
      if (i < 0) return;
      this._children.splice(i, 1);
      n[PARENT] = null;
      if (this.isConnected) {
        attachedCount -= size(n);
        mutate();
      }
    }
    _insert(n, before) {
      n = toNode(n);
      if (n === root) throw new Error("HierarchyRequestError: the root cannot be moved");
      for (let p = this; p; p = p[PARENT]) if (p === n) throw new Error("HierarchyRequestError: the new child contains the parent");
      if (before != null && before[PARENT] !== this) throw new Error("NotFoundError: the node before which to insert is not a child of this node");
      if (n[PARENT]) n[PARENT]._remove(n);
      if (this.isConnected) {
        const add = size(n);
        if (attachedCount + add > LIMITS.nodes) throw new RangeError("The card has too many nodes");
        attachedCount += add;
        mutate();
      }
      const at = before == null ? this._children.length : this._children.indexOf(before);
      this._children.splice(at, 0, n);
      n[PARENT] = this;
      return n;
    }
    appendChild(n) { return this._insert(n, null); }
    append(...ns) { for (const n of ns) this._insert(n, null); }
    prepend(...ns) { const first = this._children[0] || null; for (const n of ns) this._insert(n, first); }
    insertBefore(n, before) { return this._insert(n, before ?? null); }
    removeChild(n) {
      if (!n || n[PARENT] !== this) throw new Error("NotFoundError: the node to be removed is not a child of this node");
      this._remove(n);
      return n;
    }
    replaceChild(n, old) {
      if (!old || old[PARENT] !== this) throw new Error("NotFoundError: the node to be replaced is not a child of this node");
      this._insert(n, old);
      this._remove(old);
      return old;
    }
    replaceChildren(...ns) {
      for (const c of this._children.slice()) this._remove(c);
      for (const n of ns) this._insert(n, null);
    }
    replaceWith(...ns) {
      const p = this[PARENT];
      if (!p) return;
      for (const n of ns) p._insert(n, this);
      p._remove(this);
    }
    before(...ns) { const p = this[PARENT]; if (p) for (const n of ns) p._insert(n, this); }
    after(...ns) {
      const p = this[PARENT];
      if (!p) return;
      const next = this.nextSibling;
      for (const n of ns) p._insert(n, next && next[PARENT] === p ? next : null);
    }
    cloneNode(deep) {
      const c = new Element(this === root ? "div" : this._tag);
      for (const [k, v] of this._attrs) c._attrs.set(k, v);
      if (deep) for (const k of this._children) c._insert(k.cloneNode(true), null);
      return c;
    }

    // Text and HTML
    get textContent() {
      if (this._tag === "script" || this._tag === "style") return this._children.map((c) => c.textContent).join("");
      return this._children.map((c) => (c instanceof Element && (c._tag === "script" || c._tag === "style") ? "" : c.textContent)).join("");
    }
    set textContent(v) {
      const s = v == null ? "" : String(v);
      const only = this._children.length === 1 ? this._children[0] : null;
      if (only instanceof Text ? only._text === s : s === "" && this._children.length === 0) return;
      this.replaceChildren(...(s ? [new Text(s)] : []));
    }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    get innerHTML() { return serialize(this._children); }
    set innerHTML(v) {
      const html = v == null ? "" : String(v);
      if (html === serialize(this._children)) return;
      this.replaceChildren(...parseHTML(html));
    }
    get outerHTML() { return serialize([this]); }
    insertAdjacentHTML(pos, html) {
      const nodes = parseHTML(String(html));
      switch (String(pos).toLowerCase()) {
        case "beforebegin": this.before(...nodes); break;
        case "afterbegin": this.prepend(...nodes); break;
        case "beforeend": this.append(...nodes); break;
        case "afterend": this.after(...nodes); break;
        default: throw new SyntaxError("Bad position for insertAdjacentHTML");
      }
    }

    // Queries
    querySelector(s) { return query(this, s, false)[0] || null; }
    querySelectorAll(s) { return query(this, s, true); }
    getElementsByTagName(t) { return query(this, String(t), true); }
    getElementsByClassName(c) {
      const sel = String(c).trim().split(/\s+/).filter(Boolean).map((x) => "." + x).join("");
      return sel ? query(this, sel, true) : [];
    }
    matches(s) { return this !== root && matches(this, selector(s)); }
    closest(s) {
      const sel = selector(s);
      for (let n = this; n && n !== root; n = n[PARENT]) if (matches(n, sel)) return n;
      return null;
    }

    // Events
    addEventListener(type, f) {
      if (typeof f !== "function" && !(f && typeof f.handleEvent === "function")) return;
      type = String(type);
      const fns = this._listeners.get(type) || [];
      if (fns.includes(f)) return;
      if (fns.length >= LIMITS.handlers) throw new RangeError("Too many event handlers");
      fns.push(f);
      this._listeners.set(type, fns);
      if (type === "click") dirty = true;
    }
    removeEventListener(type, f) {
      const fns = this._listeners.get(String(type));
      const i = fns ? fns.indexOf(f) : -1;
      if (i >= 0) {
        fns.splice(i, 1);
        if (type === "click") dirty = true;
      }
    }
    get onclick() { return this._onclick; }
    set onclick(f) {
      this._onclick = typeof f === "function" ? f : null;
      dirty = true;
    }
    dispatchEvent(ev) {
      dispatch(this, ev);
      return !ev.defaultPrevented;
    }
    click() {
      // A script's own click() runs the handlers but is not a tap: no links.
      dispatch(this, new Event("click", { bubbles: true, cancelable: true }));
    }
    focus() {}
    blur() {}
    getBoundingClientRect() {
      // Layout is not readable from a card.
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    _pressable() {
      return (this._listeners.get("click") || []).length > 0 || this._onclick !== null;
    }
  }

  // MARK: events

  class Event {
    constructor(type, init = {}) {
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.timeStamp = now();
      this.isTrusted = false;
      this._stop = false;
      this._stopNow = false;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
  }
  class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  }

  function dispatch(target, ev) {
    ev.target = target;
    for (let n = target; n; n = ev.bubbles ? n[PARENT] : null) {
      ev.currentTarget = n;
      const fns = (n._listeners && n._listeners.get(ev.type)) || [];
      const all = ev.type === "click" && n._onclick ? [...fns, n._onclick] : fns.slice();
      for (const f of all) {
        try {
          if (typeof f === "function") f.call(n, ev);
          else f.handleEvent(ev);
        } catch (e) {
          reportError(e);
        }
        if (ev._stopNow) break;
      }
      if (ev._stop) break;
    }
    ev.currentTarget = null;
  }

  function reportError(e) {
    log("error", `Uncaught ${e && e.name ? e.name : "Error"}: ${e && e.message !== undefined ? e.message : e}`);
  }

  // MARK: HTML

  const VOID = new Set(["br", "hr", "img", "col", "stop", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use"]);
  const RAW = new Set(["style", "script"]);
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", copy: "©" };

  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  /** HTML a script writes, as nodes (the same parser as the app's parse.ts). */
  function parseHTML(html) {
    const top = new Element("#fragment");
    const stack = [top];
    let i = 0;
    const cur = () => stack[stack.length - 1];
    const text = (s) => { if (s) cur()._children.push(Object.assign(new Text(decode(s)), { [PARENT]: cur() })); };
    while (i < html.length) {
      const lt = html.indexOf("<", i);
      if (lt < 0) { text(html.slice(i)); break; }
      text(html.slice(i, lt));
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        i = end < 0 ? html.length : end + 3;
        continue;
      }
      if (html[lt + 1] === "/") {
        const end = html.indexOf(">", lt);
        const tag = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
        const at = stack.map((e) => e._tag).lastIndexOf(tag);
        if (at > 0) stack.length = at;
        i = end < 0 ? html.length : end + 1;
        continue;
      }
      const end = html.indexOf(">", lt);
      if (end < 0 || !/[a-zA-Z!]/.test(html[lt + 1] || "")) { text("<"); i = lt + 1; continue; }
      const inner = html.slice(lt + 1, end);
      i = end + 1;
      if (inner.startsWith("!")) continue;
      const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
      if (!m) continue;
      const tag = m[1].toLowerCase();
      const selfClosing = inner.endsWith("/");
      const el = new Element(tag);
      const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      const attrs = inner.slice(m[1].length, selfClosing ? -1 : undefined);
      let a;
      while ((a = re.exec(attrs))) el._attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      if (tag === "html" || tag === "head" || tag === "body") continue;
      el[PARENT] = cur();
      cur()._children.push(el);
      if (RAW.has(tag)) {
        const close = html.toLowerCase().indexOf(`</${tag}`, i);
        const body = html.slice(i, close < 0 ? html.length : close);
        if (body) el._children.push(Object.assign(new Text(body), { [PARENT]: el }));
        i = close < 0 ? html.length : html.indexOf(">", close) + 1 || html.length;
        continue;
      }
      if (!selfClosing && !VOID.has(tag)) stack.push(el);
    }
    const out = top._children.slice();
    for (const n of out) n[PARENT] = null;
    return out;
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function serialize(nodes) {
    return nodes.map((n) => {
      if (n instanceof Text) return esc(n._text);
      const attrs = [...n._attrs].map(([k, v]) => ` ${k}="${esc(v).replace(/"/g, "&quot;")}"`).join("");
      if (VOID.has(n._tag)) return `<${n._tag}${attrs}>`;
      const inner = RAW.has(n._tag) ? n.textContent : serialize(n._children);
      return `<${n._tag}${attrs}>${inner}</${n._tag}>`;
    }).join("");
  }

  // MARK: selectors

  const selectorCache = new Map();

  function selector(src) {
    src = String(src);
    if (selectorCache.has(src)) return selectorCache.get(src);
    const groups = [];
    for (const raw of splitTop(src)) {
      const s = raw.trim();
      if (!s) throw new SyntaxError(`'${src}' is not a valid selector`);
      const parts = [];
      const combinators = [];
      const re = /\s*([>+~])\s*|\s+|((?:[^\s>+~(\[]|\([^)]*\)|\[(?:[^\]"']|"[^"]*"|'[^']*')*\])+)/g;
      let m;
      let pending = "";
      while ((m = re.exec(s))) {
        if (m[2]) {
          const c = compound(m[2]);
          if (!c) throw new SyntaxError(`'${src}' is not a valid selector`);
          if (parts.length) combinators.push(pending || " ");
          parts.push(c);
          pending = "";
        } else if (m[1]) pending = m[1];
        else if (!pending) pending = " ";
      }
      if (!parts.length || parts.length > 15) throw new SyntaxError(`'${src}' is not a valid selector`);
      groups.push({ parts, combinators });
    }
    if (selectorCache.size > 128) selectorCache.clear();
    selectorCache.set(src, groups);
    return groups;
  }

  function splitTop(s) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
  }

  function compound(s) {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    const re = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?\]|:([\w-]+)(?:\(([^)]*)\))?/y;
    let i = 0;
    let first = true;
    while (i < s.length) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m || (m[1] && !first)) return null;
      if (m[1]) c.tag = m[1] === "*" ? null : m[1].toLowerCase();
      else if (m[2]) c.id = m[2];
      else if (m[3]) c.classes.push(m[3]);
      else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] ?? m[7] ?? m[8] ?? "" });
      else {
        const name = m[9].toLowerCase();
        if (["first-child", "last-child", "only-child"].includes(name) && m[10] === undefined) c.pseudos.push({ kind: name });
        else if (name === "nth-child" && m[10] !== undefined) {
          const nth = parseNth(m[10]);
          if (!nth) return null;
          c.pseudos.push({ kind: name, ...nth });
        } else return null;
      }
      i = re.lastIndex;
      first = false;
    }
    return c;
  }

  function parseNth(arg) {
    const s = arg.replace(/\s+/g, "").toLowerCase();
    if (s === "odd") return { a: 2, b: 1 };
    if (s === "even") return { a: 2, b: 0 };
    if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) };
    const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
    if (!m) return null;
    return { a: m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]), b: m[2] ? Number(m[2]) : 0 };
  }

  function matchCompound(el, c) {
    if (el === root) return false;
    if (c.tag && el._tag !== c.tag) return false;
    if (c.id !== null && el.getAttribute("id") !== c.id) return false;
    if (c.classes.length) {
      const cls = (el.getAttribute("class") || "").split(/\s+/);
      for (const x of c.classes) if (!cls.includes(x)) return false;
    }
    for (const a of c.attrs) {
      const v = el.getAttribute(a.name);
      if (v === null) return false;
      const w = a.value;
      switch (a.op) {
        case undefined: break;
        case "=": if (v !== w) return false; break;
        case "~=": if (!v.split(/\s+/).includes(w)) return false; break;
        case "^=": if (!w || !v.startsWith(w)) return false; break;
        case "$=": if (!w || !v.endsWith(w)) return false; break;
        case "*=": if (!w || !v.includes(w)) return false; break;
        case "|=": if (v !== w && !v.startsWith(w + "-")) return false; break;
      }
    }
    if (c.pseudos.length) {
      const sibs = el[PARENT] ? el[PARENT].children : [el];
      const i = sibs.indexOf(el);
      for (const p of c.pseudos) {
        if (p.kind === "first-child" && i !== 0) return false;
        if (p.kind === "last-child" && i !== sibs.length - 1) return false;
        if (p.kind === "only-child" && sibs.length !== 1) return false;
        if (p.kind === "nth-child") {
          const n = i + 1 - p.b;
          if (p.a === 0 ? n !== 0 : n / p.a < 0 || n % p.a !== 0) return false;
        }
      }
    }
    return true;
  }

  function matches(el, groups) {
    return groups.some((g) => {
      const memo = new Map();
      const match = (node, k) => {
        const key = k + ":" ;
        let m = memo.get(node);
        if (!m) memo.set(node, (m = new Map()));
        if (m.has(key)) return m.get(key);
        let r = matchCompound(node, g.parts[k]);
        if (r && k > 0) {
          const comb = g.combinators[k - 1];
          if (comb === ">") r = !!node[PARENT] && match(node[PARENT], k - 1);
          else if (comb === "+") r = !!node.previousElementSibling && match(node.previousElementSibling, k - 1);
          else if (comb === "~") {
            r = false;
            for (let s = node.previousElementSibling; s && !r; s = s.previousElementSibling) r = match(s, k - 1);
          } else {
            r = false;
            for (let p = node[PARENT]; p && p !== root && !r; p = p[PARENT]) r = match(p, k - 1);
          }
        }
        m.set(key, r);
        return r;
      };
      return match(el, g.parts.length - 1);
    });
  }

  function query(from, src, all) {
    const sel = selector(src);
    const out = [];
    const walk = (el) => {
      for (const c of el._children) {
        if (!(c instanceof Element)) continue;
        if (matches(c, sel)) {
          out.push(c);
          if (!all) return true;
        }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(from);
    return out;
  }

  // MARK: the document

  const root = new Element("#root");
  const docListeners = new Map();
  const winListeners = new Map();

  function listen(map, type, f) {
    if (typeof f !== "function") return;
    const fns = map.get(String(type)) || [];
    if (!fns.includes(f) && fns.length < LIMITS.handlers) fns.push(f);
    map.set(String(type), fns);
  }
  function unlisten(map, type, f) {
    const fns = map.get(String(type));
    const i = fns ? fns.indexOf(f) : -1;
    if (i >= 0) fns.splice(i, 1);
  }
  function fire(map, type, self) {
    for (const f of (map.get(type) || []).slice()) {
      try {
        f.call(self, new Event(type));
      } catch (e) {
        reportError(e);
      }
    }
  }

  const document = {
    get body() { return root; },
    get documentElement() { return root; },
    get readyState() { return loading ? "loading" : "complete"; },
    get hidden() { return !active; },
    get visibilityState() { return active ? "visible" : "hidden"; },
    nodeType: 9,
    getElementById(id) {
      id = String(id);
      const walk = (el) => {
        for (const c of el._children) {
          if (!(c instanceof Element)) continue;
          if (c.getAttribute("id") === id) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(root);
    },
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    getElementsByTagName: (t) => root.getElementsByTagName(t),
    getElementsByClassName: (c) => root.getElementsByClassName(c),
    createElement(tag) {
      tag = String(tag).toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag) || tag === "script") throw new Error(`NotSupportedError: <${tag}> cannot be created in cards`);
      return new Element(tag);
    },
    createTextNode: (t) => new Text(t),
    createEvent: () => new Event(""),
    addEventListener: (type, f) => listen(docListeners, type, f),
    removeEventListener: (type, f) => unlisten(docListeners, type, f),
  };

  // MARK: timers

  const timers = new Map();
  let nextTimer = 1;

  function setTimer(f, ms, args, every) {
    if (typeof f !== "function") throw new TypeError("Timers take a function");
    if (timers.size >= LIMITS.timers) throw new RangeError("Too many timers");
    const delay = Math.max(every ? 16 : 0, Math.min(2 ** 31 - 1, Number(ms) || 0));
    const id = nextTimer++;
    timers.set(id, { f, args, due: now() + delay, every: every ? delay : null });
    return id;
  }
  function clearTimer(id) {
    timers.delete(Number(id));
  }

  function runTimers() {
    const t = now();
    const due = [...timers].filter(([, x]) => x.due <= t).sort((a, b) => a[1].due - b[1].due).slice(0, 32);
    for (const [id, x] of due) {
      if (!timers.has(id)) continue;
      if (x.every === null) timers.delete(id);
      else x.due = t + x.every;
      try {
        x.f(...x.args);
      } catch (e) {
        reportError(e);
      }
    }
  }

  function nextDue() {
    let min = Infinity;
    for (const x of timers.values()) min = Math.min(min, x.due);
    if (min === Infinity) return -1;
    // Off screen or in the background a card's timers fire at most once a second.
    return Math.max(min - now(), active ? 0 : 1000);
  }

  // MARK: storage

  function storage() {
    const map = new Map();
    const used = () => { let n = 0; for (const [k, v] of map) n += k.length + v.length; return n; };
    return {
      getItem: (k) => map.get(String(k)) ?? null,
      setItem(k, v) {
        k = String(k);
        v = String(v);
        const old = map.get(k);
        const next = used() - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
        if (next > LIMITS.storage) {
          const e = new Error("The card's storage is full (4 KB)");
          e.name = "QuotaExceededError";
          throw e;
        }
        map.set(k, v);
      },
      removeItem: (k) => void map.delete(String(k)),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
  }

  // MARK: TelegramWidget

  const widgetEvents = new Map();
  const EVENT_TYPES = new Set(["themeChanged", "activated", "deactivated", "chatDataChanged", "publicDataChanged", "contentSafeAreaChanged"]);
  let themeParams = Object.freeze({});

  function setTheme(vars) {
    theme = vars || {};
    const p = {};
    for (const [k, v] of Object.entries(theme)) {
      const m = /^--tg-theme-(.+)$/.exec(k);
      if (m) p[m[1].replace(/-/g, "_")] = String(v);
    }
    themeParams = Object.freeze(p);
  }

  function emit(type) {
    for (const f of (widgetEvents.get(type) || []).slice()) {
      try {
        f.call(TelegramWidget);
      } catch (e) {
        reportError(e);
      }
    }
  }

  function requestError(code, message) {
    const e = new Error(message);
    e.name = "WidgetRequestError";
    e.code = code;
    return e;
  }

  const noop = () => {};
  const TelegramWidget = Object.freeze({
    // Telegram's API level (its "widget profile").
    profile: 1,
    platform: "honk",
    isProfileAtLeast: (n) => Number(n) <= 1,
    get colorScheme() { return theme["--tg-color-scheme"] === "dark" ? "dark" : "light"; },
    get themeParams() { return themeParams; },
    get isActive() { return active; },
    isPreview: false,
    isForward: false,
    chatType: "private",
    viewer: null,
    wallet: null,
    publicData: null,
    get chatData() { return chatData; },
    contentSafeAreaInset: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
    HapticFeedback: Object.freeze({ impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop }),
    ready: noop,
    setResizeAnchor: noop,
    watchPublicData: noop,
    unwatchPublicData: noop,
    onEvent(type, f) {
      type = String(type);
      if (!EVENT_TYPES.has(type) || typeof f !== "function") return;
      const fns = widgetEvents.get(type) || [];
      if (fns.includes(f)) return;
      if (fns.length >= LIMITS.handlers) throw new RangeError("Too many event handlers");
      fns.push(f);
      widgetEvents.set(type, fns);
    },
    offEvent(type, f) {
      const fns = widgetEvents.get(String(type));
      const i = fns ? fns.indexOf(f) : -1;
      if (i >= 0) fns.splice(i, 1);
    },
    openLink(url) {
      url = String(url);
      if (!url.startsWith("https://") || url.length > LIMITS.link) throw new TypeError("openLink needs an https:// URL of at most 256 characters");
      if (!inTap || effects.open !== null) { log("warn", "openLink works once per tap, from its handler"); return; }
      effects.open = url;
    },
    openTelegramLink(url) {
      url = String(url);
      if (!/^https:\/\/(t\.me|telegram\.me)\//.test(url)) throw new TypeError("openTelegramLink needs a t.me link");
      TelegramWidget.openLink(url);
    },
    copyText(text) {
      text = String(text);
      if (text.length < 1 || text.length > 256) throw new TypeError("copyText takes 1 to 256 characters");
      if (!inTap || effects.copy !== null) { log("warn", "copyText works once per tap, from its handler"); return; }
      effects.copy = text;
    },
    // Honk has no bot callbacks yet: every request is refused, as Telegram does without allow_queries.
    request: () => Promise.reject(requestError("NOT_ALLOWED", "This card cannot send requests to its bot")),
  });

  // MARK: globals

  function networkDisabled(name) {
    return function () {
      const e = new Error(`${name} is not available in cards`);
      e.name = "NetworkDisabledError";
      throw e;
    };
  }

  const g = globalThis;
  const define = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false });
  define("window", g);
  define("self", g);
  define("document", document);
  define("TelegramWidget", TelegramWidget);
  define("Node", Node);
  define("Element", Element);
  define("HTMLElement", Element);
  define("Text", Text);
  define("Event", Event);
  define("CustomEvent", CustomEvent);
  define("setTimeout", (f, ms, ...args) => setTimer(f, ms, args, false));
  define("setInterval", (f, ms, ...args) => setTimer(f, ms, args, true));
  define("clearTimeout", clearTimer);
  define("clearInterval", clearTimer);
  define("requestAnimationFrame", (f) => setTimer(() => f(now()), 16, [], false));
  define("cancelAnimationFrame", clearTimer);
  if (typeof g.queueMicrotask !== "function") define("queueMicrotask", (f) => void Promise.resolve().then(f));
  define("addEventListener", (type, f) => listen(winListeners, type, f));
  define("removeEventListener", (type, f) => unlisten(winListeners, type, f));
  define("open", (url) => { TelegramWidget.openLink(url); return null; });
  define("alert", noop);
  define("confirm", () => false);
  define("prompt", () => null);
  define("print", noop);
  define("localStorage", storage());
  define("sessionStorage", storage());
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "RTCPeerConnection", "importScripts", "Worker", "BroadcastChannel"]) {
    define(name, networkDisabled(name));
  }
  const consoleObj = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleObj[level] = (...a) => log(level, a.map((x) => (typeof x === "string" ? x : (() => { try { return stringify(x); } catch { return String(x); } })())).join(" "));
  }
  define("console", consoleObj);

  // MARK: entry points (called by honk_card.c)

  function build(json, parent) {
    for (const n of json || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "text") parent._children.push(Object.assign(new Text(String(n.text ?? "")), { [PARENT]: parent }));
      else if (n.type === "element" && typeof n.tag === "string") {
        const el = new Element(n.tag.toLowerCase());
        for (const [k, v] of Object.entries(n.attrs || {})) el._attrs.set(k.toLowerCase(), String(v));
        el[PARENT] = parent;
        parent._children.push(el);
        build(n.children, el);
      }
    }
  }

  function out(n) {
    if (n instanceof Text) return { type: "text", text: n._text };
    const o = { type: "element", tag: n._tag, attrs: Object.fromEntries(n._attrs), children: n._children.map(out) };
    if (n._pressable()) o.on = true;
    return o;
  }

  function begin(tap) {
    mutations = 0;
    inTap = tap;
  }

  return {
    load(json) {
      begin(false);
      const a = parseJSON(json);
      setTheme(a.theme);
      active = a.active !== false;
      chatData = typeof a.data === "string" && a.data ? a.data : null;
      define("navigator", Object.freeze({ userAgent: "Honk", language: String(a.language || "en"), onLine: false, sendBeacon: networkDisabled("sendBeacon") }));
      build(a.tree, root);
      attachedCount = size(root) - 1;
      const walk = (el) => {
        for (const c of el._children) {
          if (!(c instanceof Element)) continue;
          if (c._tag === "script") {
            const type = (c.getAttribute("type") || "").trim().toLowerCase();
            if (!c.hasAttribute("src") && (type === "" || type === "text/javascript" || type === "application/javascript")) scripts.push(c.textContent);
          } else walk(c);
        }
      };
      walk(root);
      return scripts.length;
    },
    script(i) {
      begin(false);
      const src = scripts[Number(i)];
      if (src === undefined) return;
      try {
        globalEval(src);
      } catch (e) {
        reportError(e);
      }
    },
    ready() {
      begin(false);
      loading = false;
      fire(docListeners, "DOMContentLoaded", document);
      fire(winListeners, "load", g);
    },
    click(path) {
      begin(true);
      let n = root;
      for (const i of parseJSON(path)) {
        n = n && n._children[i];
      }
      if (!(n instanceof Element)) return false;
      const ev = new Event("click", { bubbles: true, cancelable: true });
      ev.isTrusted = true;
      dispatch(n, ev);
      inTap = false;
      return ev.defaultPrevented;
    },
    tick() {
      begin(false);
      runTimers();
    },
    set(json) {
      begin(false);
      const a = parseJSON(json);
      if (a.theme && stringify(a.theme) !== stringify(theme)) {
        setTheme(a.theme);
        emit("themeChanged");
      }
      if (typeof a.active === "boolean" && a.active !== active) {
        active = a.active;
        emit(active ? "activated" : "deactivated");
      }
      if (typeof a.data === "string" && a.data !== (chatData ?? "")) {
        chatData = a.data || null;
        emit("chatDataChanged");
      }
    },
    tree() {
      if (!dirty) return null;
      dirty = false;
      return stringify(root._children.map(out));
    },
    effects() {
      const e = { next: nextDue(), open: effects.open, copy: effects.copy, logs: effects.logs };
      effects = { open: null, copy: null, logs: [] };
      inTap = false;
      return stringify(e);
    },
  };
})();
