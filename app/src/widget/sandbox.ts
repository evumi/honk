// Runs a card's scripts (card profile 2) against a small DOM over the card's
// own node tree, with the TelegramWidget API of Telegram's HTML widgets.
//
// A card gets no network, no storage beyond 4 KB in memory, no access to the
// app or other cards, and a budget per task (the scripts at load, one timer,
// one tap): past it the card stops and keeps what it last drew.

import { fromHost, GLOBALS } from "./builtins";
import { Abort, ArrayObj, FnObj, Interp, LIMITS, Native, Obj, PlainObj, Throw, type NativeImpl, type Value } from "./interp";
import { parse, parseStyle, type ElementNode, type TextNode, type WidgetNode } from "./parse";
import { ALLOWED_TAGS, allowedAttr, badCSS, sanitize } from "./sanitize";
import { parseScript, ScriptSyntaxError, type Program } from "./script";

/** Limits, after Telegram's widget limits (core.telegram.org/bots/widgets), scaled for an interpreter on the UI thread. */
export const SANDBOX_LIMITS = {
  /** Wall time of one task; past it the card stops (Telegram: 500 ms). */
  taskMs: 100,
  /** Script time per second; past it timers wait for the next second (Telegram: 300 ms). */
  cpuPerSecondMs: 250,
  /** Allocation per task, in values and 8-character string chunks (Telegram: 8 MB of memory). */
  allocPerTask: 1_000_000,
  nodes: 2000,
  mutationsPerTask: 10_000,
  timers: 64,
  handlersPerEvent: 16,
  storageBytes: 4096,
  linkLength: 256,
  copyLength: 256,
  logLines: 100,
};

export interface SandboxHost {
  /** Opens an https link the card asked for during a tap. */
  openLink(url: string): void;
  copyText(text: string): void;
  /** The DOM changed; draw it again. */
  changed(): void;
  log?(level: string, text: string): void;
  /** The app's language, for navigator.language. */
  language?: string;
  /** The card's localStorage, kept by the caller across mounts. */
  storage?: Map<string, string>;
}

export interface Theme {
  /** `--tg-theme-*` variables and `--tg-color-scheme`. */
  vars: Record<string, string>;
}

type Target = ElementNode | "document" | "window";

const EVENT_TYPES = new Set(["themeChanged", "activated", "deactivated", "chatDataChanged", "publicDataChanged", "contentSafeAreaChanged"]);

/** The script sources of a card, in document order. */
export function scriptsOf(nodes: WidgetNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: WidgetNode[]) => {
    for (const n of ns) {
      if (n.type !== "element") continue;
      if (n.tag === "script") {
        const type = (n.attrs.type ?? "").trim().toLowerCase();
        if (!n.attrs.src && (type === "" || type === "text/javascript" || type === "application/javascript")) {
          out.push(n.children.map((c) => (c.type === "text" ? c.text : "")).join(""));
        }
      } else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export class Sandbox {
  readonly root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  readonly it: Interp = new Interp();
  /** Why the card stopped, once it has. */
  stopped: string | null = null;
  private parents = new WeakMap<WidgetNode, ElementNode>();
  private wrappers = new WeakMap<WidgetNode, Obj>();
  private listeners = new Map<Target, Map<string, FnObj[]>>();
  private onEvents = new Map<string, FnObj[]>();
  private timers = new Map<number, { handle: ReturnType<typeof setTimeout>; fn: FnObj; args: Value[]; every: number | null }>();
  private nextTimer = 1;
  private nodeCount = 0;
  private mutations = 0;
  private dirty = false;
  private logged = 0;
  private windowStart = 0;
  private windowUsed = 0;
  /** Inside a tap's handlers: openLink and copyText work once each. */
  private tap: { link: boolean; copy: boolean } | null = null;
  loading = true;
  private active = true;
  private theme: Theme;
  private themeParams: PlainObj;
  private data: string;
  private storage: Map<string, string>;
  private session = new Map<string, string>();
  private document: DocumentObj;
  private widget: WidgetObj;
  private programs: Program[] = [];

  constructor(nodes: WidgetNode[], data: string, theme: Theme, readonly host: SandboxHost) {
    this.data = data;
    this.theme = theme;
    this.themeParams = this.makeThemeParams();
    this.storage = host.storage ?? new Map();
    for (const n of nodes) this.root.children.push(clone(n));
    this.index(this.root);
    this.nodeCount = countTree(this.root) - 1;
    this.document = new DocumentObj(this);
    this.widget = new WidgetObj(this);
    this.installGlobals();
  }

  // MARK: running

  /** Parses and runs the scripts. Returns false when none could be parsed, so the card stays static. */
  start(): boolean {
    for (const src of scriptsOf(this.root.children)) {
      try {
        this.programs.push(parseScript(src));
      } catch (e) {
        this.log("error", e instanceof ScriptSyntaxError ? `SyntaxError: ${e.message} at ${e.pos}` : String(e));
      }
    }
    if (this.programs.length === 0) return false;
    for (const p of this.programs) this.task(() => this.it.run(p));
    this.loading = false;
    this.task(() => {
      this.fire("document", "DOMContentLoaded", null);
      this.fire("window", "load", null);
    });
    return true;
  }

  dispose(): void {
    this.stop("disposed");
  }

  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = reason;
    this.it.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t.handle);
    this.timers.clear();
    this.listeners.clear();
    this.onEvents.clear();
  }

  /** Runs `fn` as one task within the card's budget. */
  task(fn: () => void): void {
    if (this.stopped) return;
    const start = performance.now();
    if (start - this.windowStart >= 1000) {
      this.windowStart = start;
      this.windowUsed = 0;
    }
    this.it.begin(SANDBOX_LIMITS.taskMs, SANDBOX_LIMITS.allocPerTask);
    this.mutations = 0;
    try {
      fn();
    } catch (e) {
      if (e instanceof Abort) {
        this.log("error", e.message);
        this.stop(e.reason);
      } else if (e instanceof Throw) {
        this.log("error", `Uncaught ${this.describe(e.value)}`);
      } else {
        // A bug or a host stack overflow: stop rather than run on in a bad state.
        this.log("error", `card script crashed: ${e instanceof Error ? e.message : String(e)}`);
        this.stop("crash");
      }
    }
    this.windowUsed += performance.now() - start;
    if (this.dirty) {
      this.dirty = false;
      this.host.changed();
    }
  }

  private describe(v: Value): string {
    if (v instanceof PlainObj && v.isA("Error")) return `${this.it.toStr(v.get("name", this.it))}: ${this.it.toStr(v.get("message", this.it))}`;
    try {
      return this.it.toStr(v);
    } catch {
      return "exception";
    }
  }

  log(level: string, text: string): void {
    if (this.logged >= SANDBOX_LIMITS.logLines) return;
    this.logged++;
    if (this.host.log) this.host.log(level, text);
    else console.log(`[card ${level}] ${text}`);
  }

  // MARK: events

  hasListener(el: ElementNode): boolean {
    return (this.listeners.get(el)?.get("click")?.length ?? 0) > 0;
  }

  /** A tap on `el` (it or an ancestor listens): click handlers run, then the default action unless prevented. Returns whether it was prevented. */
  click(el: ElementNode, trusted = true): boolean {
    let prevented = false;
    if (this.stopped) return false;
    const prev = this.tap;
    if (trusted) this.tap = { link: false, copy: false };
    this.task(() => {
      prevented = this.dispatchClick(el);
    });
    this.tap = prev;
    return prevented;
  }

  /** Runs the click handlers of `el` and its ancestors; returns whether one called preventDefault. */
  dispatchClick(el: ElementNode): boolean {
    let stop = false;
    let prevented = false;
    const ev = new PlainObj();
    const it = this.it;
    ev.props.set("type", "click");
    ev.props.set("target", this.wrap(el));
    ev.props.set("timeStamp", performance.now());
    ev.props.set("isTrusted", this.tap !== null);
    ev.props.set("preventDefault", new Native("preventDefault", () => void (prevented = true)));
    ev.props.set("stopPropagation", new Native("stopPropagation", () => void (stop = true)));
    ev.props.set("stopImmediatePropagation", new Native("stopImmediatePropagation", () => void (stop = true)));
    let node: ElementNode | undefined = el;
    while (node && !stop) {
      const fns = this.listeners.get(node)?.get("click");
      if (fns?.length) {
        const target = this.wrap(node);
        ev.props.set("currentTarget", target);
        for (const f of fns.slice()) {
          it.call(f, target, [ev]);
          if (stop) break;
        }
      }
      node = this.parents.get(node);
    }
    ev.props.set("defaultPrevented", prevented);
    return prevented;
  }

  private fire(target: Target, type: string, ev: Value): void {
    for (const f of this.listeners.get(target)?.get(type)?.slice() ?? []) this.it.call(f, this.wrapTarget(target), ev === null ? [] : [ev]);
  }

  private wrapTarget(t: Target): Value {
    return t === "document" ? this.document : t === "window" ? this.globalObj() : this.wrap(t);
  }

  addListener(target: Target, type: string, f: Value): void {
    if (!(f instanceof FnObj)) return;
    let byType = this.listeners.get(target);
    if (!byType) this.listeners.set(target, (byType = new Map()));
    const fns = byType.get(type) ?? [];
    if (fns.includes(f)) return;
    if (fns.length >= SANDBOX_LIMITS.handlersPerEvent) this.it.throwError("RangeError", "Too many event handlers");
    fns.push(f);
    byType.set(type, fns);
    if (type === "click") this.dirty = true; // the element becomes pressable
  }

  removeListener(target: Target, type: string, f: Value): void {
    const fns = this.listeners.get(target)?.get(type);
    const i = fns ? fns.indexOf(f as FnObj) : -1;
    if (i >= 0) {
      fns!.splice(i, 1);
      if (type === "click") this.dirty = true;
    }
  }

  /** TelegramWidget.onEvent handlers: called with `this` bound to TelegramWidget and no arguments. */
  emit(type: string): void {
    const fns = this.onEvents.get(type);
    if (!fns?.length) return;
    this.task(() => {
      for (const f of fns.slice()) this.it.call(f, this.widget, []);
    });
  }

  onEvent(type: string, f: Value): void {
    if (!EVENT_TYPES.has(type) || !(f instanceof FnObj)) return;
    const fns = this.onEvents.get(type) ?? [];
    if (fns.includes(f)) return;
    if (fns.length >= SANDBOX_LIMITS.handlersPerEvent) this.it.throwError("RangeError", "Too many event handlers");
    fns.push(f);
    this.onEvents.set(type, fns);
  }

  offEvent(type: string, f: Value): void {
    const fns = this.onEvents.get(type);
    const i = fns ? fns.indexOf(f as FnObj) : -1;
    if (i >= 0) fns!.splice(i, 1);
  }

  setTheme(theme: Theme): void {
    if (JSON.stringify(theme.vars) === JSON.stringify(this.theme.vars)) return;
    this.theme = theme;
    this.themeParams = this.makeThemeParams();
    this.emit("themeChanged");
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.emit(active ? "activated" : "deactivated");
  }

  setData(data: string): void {
    if (data === this.data) return;
    this.data = data;
    this.emit("chatDataChanged");
  }

  get isActive(): boolean {
    return this.active;
  }
  get chatData(): string | null {
    return this.data ? this.data : null;
  }
  get colorScheme(): string {
    return this.theme.vars["--tg-color-scheme"] === "dark" ? "dark" : "light";
  }
  get params(): PlainObj {
    return this.themeParams;
  }

  private makeThemeParams(): PlainObj {
    const o = new PlainObj();
    for (const [k, v] of Object.entries(this.theme.vars)) {
      const m = /^--tg-theme-(.+)$/.exec(k);
      if (m) o.props.set(m[1].replace(/-/g, "_"), v);
    }
    o.frozen = true;
    return o;
  }

  // MARK: tap-only actions

  openLink(url: Value, telegram: boolean): void {
    if (typeof url !== "string" || url.length > SANDBOX_LIMITS.linkLength || !url.startsWith("https://")) this.it.throwError("TypeError", "openLink needs an https:// URL of at most 256 characters");
    if (telegram && !/^https:\/\/(t\.me|telegram\.me)\//.test(url)) this.it.throwError("TypeError", "openTelegramLink needs a t.me link");
    if (!this.tap || this.tap.link) {
      this.log("warn", "openLink works once per tap, from its handler");
      return;
    }
    this.tap.link = true;
    this.host.openLink(url);
  }

  copyText(text: Value): void {
    const s = typeof text === "string" ? text : this.it.toStr(text);
    if (s.length < 1 || s.length > SANDBOX_LIMITS.copyLength) this.it.throwError("TypeError", "copyText takes 1 to 256 characters");
    if (!this.tap || this.tap.copy) {
      this.log("warn", "copyText works once per tap, from its handler");
      return;
    }
    this.tap.copy = true;
    this.host.copyText(s);
  }

  // MARK: timers

  setTimer(f: Value, ms: Value, args: Value[], repeat: boolean): number {
    if (!(f instanceof FnObj)) this.it.throwError("TypeError", "Timers take a function");
    if (this.timers.size >= SANDBOX_LIMITS.timers) this.it.throwError("RangeError", "Too many timers");
    const delay = Math.max(repeat ? 16 : 0, Math.min(2 ** 31 - 1, this.it.toNum(ms) || 0));
    const id = this.nextTimer++;
    this.schedule(id, f, args, delay, repeat ? delay : null);
    return id;
  }

  private schedule(id: number, fn: FnObj, args: Value[], delay: number, every: number | null): void {
    // A card off screen or in the background gets a timer at most once a second.
    const wait = this.active ? delay : Math.max(delay, 1000);
    const handle = setTimeout(() => this.fireTimer(id), wait);
    this.timers.set(id, { handle, fn, args, every });
  }

  private fireTimer(id: number): void {
    const t = this.timers.get(id);
    if (!t || this.stopped) return;
    const now = performance.now();
    if (now - this.windowStart < 1000 && this.windowUsed >= SANDBOX_LIMITS.cpuPerSecondMs) {
      // Over this second's budget: try again when the next one starts.
      t.handle = setTimeout(() => this.fireTimer(id), Math.max(1, 1000 - (now - this.windowStart)));
      return;
    }
    if (t.every === null) this.timers.delete(id);
    this.task(() => this.it.call(t.fn, undefined, t.args));
    if (t.every !== null && this.timers.get(id) === t && !this.stopped) this.schedule(id, t.fn, t.args, t.every, t.every);
  }

  clearTimer(id: Value): void {
    if (typeof id !== "number") return;
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t.handle);
      this.timers.delete(id);
    }
  }

  get timerCount(): number {
    return this.timers.size;
  }

  // MARK: the DOM

  /** Records the parents in a detached tree a script made (cloneNode). */
  adopt(el: ElementNode): void {
    this.index(el);
  }

  private index(el: ElementNode): void {
    for (const c of el.children) {
      this.parents.set(c, el);
      if (c.type === "element") this.index(c);
    }
  }

  parentOf(n: WidgetNode): ElementNode | undefined {
    return this.parents.get(n);
  }

  isAttached(n: WidgetNode): boolean {
    let cur: WidgetNode | undefined = n;
    for (let i = 0; cur && i < 4096; i++) {
      if (cur === this.root) return true;
      cur = this.parents.get(cur);
    }
    return false;
  }

  /** Counts a change to the tree, within the per-task limit. */
  mutate(n = 1): void {
    this.mutations += n;
    this.dirty = true;
    if (this.mutations > SANDBOX_LIMITS.mutationsPerTask) throw new Abort("time", "card script changed the page too often");
  }

  detach(n: WidgetNode): void {
    const p = this.parents.get(n);
    if (!p) return;
    const i = p.children.indexOf(n);
    if (i >= 0) p.children.splice(i, 1);
    this.parents.delete(n);
    if (this.isAttached(p)) this.nodeCount -= countTree(n);
    this.mutate();
  }

  /** Inserts `n` into `parent` before `before` (or at the end), moving it from where it was. */
  insert(parent: ElementNode, n: WidgetNode, before: WidgetNode | null = null): void {
    if (n === this.root) this.it.throwError("HierarchyRequestError", "The root cannot be moved");
    // Refuse to put a node inside itself.
    for (let p: ElementNode | undefined = parent; p; p = this.parents.get(p)) {
      if (p === n) this.it.throwError("HierarchyRequestError", "The new child contains the parent");
    }
    if (before && this.parents.get(before) !== parent) this.it.throwError("NotFoundError", "The node before which to insert is not a child of this node");
    this.detach(n);
    if (this.isAttached(parent)) {
      const add = countTree(n);
      if (this.nodeCount + add > SANDBOX_LIMITS.nodes) this.it.throwError("RangeError", "The card has too many nodes");
      this.nodeCount += add;
    }
    const at = before ? parent.children.indexOf(before) : parent.children.length;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, n);
    this.parents.set(n, parent);
    this.mutate();
  }

  replaceChildren(el: ElementNode, nodes: WidgetNode[]): void {
    for (const c of el.children.slice()) this.detach(c);
    for (const n of nodes) this.insert(el, n);
  }

  /** Parses HTML a script wrote, through the whitelist. */
  parseHTML(html: string): WidgetNode[] {
    if (html.length > LIMITS.string) this.it.throwError("RangeError", "HTML too long");
    this.it.charge(html.length >> 4);
    const nodes = sanitize(parse(html));
    this.it.alloc(countTree({ type: "element", tag: "#", attrs: {}, children: nodes }) * 4);
    return nodes;
  }

  createElement(tag: string): ElementNode {
    tag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag) || tag === "style") this.it.throwError("NotSupportedError", `<${tag}> is not allowed in cards`);
    this.it.alloc(8);
    return { type: "element", tag, attrs: {}, children: [] };
  }

  setAttr(el: ElementNode, name: string, value: string): void {
    name = name.toLowerCase();
    if (value.length > 8192) this.it.throwError("RangeError", "Attribute too long");
    if (!allowedAttr(el.tag, name, value)) {
      this.log("warn", `attribute ${name} on <${el.tag}> is not allowed`);
      return;
    }
    if (el.attrs[name] === value) return;
    el.attrs[name] = value;
    this.mutate();
  }

  removeAttr(el: ElementNode, name: string): void {
    name = name.toLowerCase();
    if (!(name in el.attrs)) return;
    delete el.attrs[name];
    this.mutate();
  }

  wrap(n: WidgetNode): Obj {
    let w = this.wrappers.get(n);
    if (!w) {
      w = n.type === "element" ? new ElementObj(this, n) : new TextObj(this, n);
      this.wrappers.set(n, w);
    }
    return w;
  }

  // MARK: globals

  private globalObj(): Obj {
    return this.it.global.vars.get("window")!.v as Obj;
  }

  private installGlobals(): void {
    const g = this.it.global;
    const define = (name: string, v: Value) => g.declare(name, v);
    for (const [k, v] of Object.entries(GLOBALS)) define(k, v);
    const win = new WindowObj(this);
    define("window", win);
    define("globalThis", win);
    define("self", win);
    define("document", this.document);
    define("TelegramWidget", this.widget);
    const f = (name: string, impl: NativeImpl) => define(name, new Native(name, impl));
    f("setTimeout", (_it, _s, a) => this.setTimer(a[0], a[1], a.slice(2), false));
    f("setInterval", (_it, _s, a) => this.setTimer(a[0], a[1], a.slice(2), true));
    f("clearTimeout", (_it, _s, a) => this.clearTimer(a[0]));
    f("clearInterval", (_it, _s, a) => this.clearTimer(a[0]));
    f("requestAnimationFrame", (it, _s, a) => {
      const cb = a[0];
      if (!(cb instanceof FnObj)) it.throwError("TypeError", "requestAnimationFrame takes a function");
      return this.setTimer(new Native("frame", (it2) => it2.call(cb, undefined, [performance.now()])), 16, [], false);
    });
    f("cancelAnimationFrame", (_it, _s, a) => this.clearTimer(a[0]));
    f("queueMicrotask", (_it, _s, a) => this.setTimer(a[0], 0, [], false));
    const console = new PlainObj();
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      console.props.set(level, new Native(level, (it, _s, a) => void this.log(level, a.map((x) => (typeof x === "string" ? x : this.describe(x))).join(" "))));
    }
    console.frozen = true;
    define("console", console);
    define("localStorage", new StorageObj(this, this.storage));
    define("sessionStorage", new StorageObj(this, this.session));
    // No network: these exist so a card gets the error Telegram gives instead of a ReferenceError.
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "RTCPeerConnection", "importScripts", "Worker", "BroadcastChannel"]) {
      f(name, (it) => {
        const e = it.makeError("NetworkDisabledError", `${name} is not available in cards`);
        throw new Throw(e);
      });
    }
    const navigator = new PlainObj();
    navigator.props.set("userAgent", "Honk");
    navigator.props.set("language", this.host.language ?? "en");
    navigator.props.set("onLine", false);
    navigator.props.set("sendBeacon", new Native("sendBeacon", (it) => {
      throw new Throw(it.makeError("NetworkDisabledError", "sendBeacon is not available in cards"));
    }));
    navigator.frozen = true;
    define("navigator", navigator);
    f("alert", () => undefined);
    f("confirm", () => false);
    f("prompt", () => null);
    define("Promise", promiseCtor(this));
  }

  /** Queues a host-side job that runs as a task of its own. */
  later(fn: () => void): void {
    setTimeout(() => this.task(fn), 0);
  }
}

// MARK: helpers

function clone(n: WidgetNode): WidgetNode {
  if (n.type === "text") return { type: "text", text: n.text };
  return { type: "element", tag: n.tag, attrs: { ...n.attrs }, children: n.children.map(clone) };
}

function countTree(n: WidgetNode): number {
  let c = 1;
  if (n.type === "element") for (const k of n.children) c += countTree(k);
  return c;
}

function textOf(n: WidgetNode): string {
  if (n.type === "text") return n.text;
  if (n.tag === "script" || n.tag === "style") return "";
  return n.children.map(textOf).join("");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

export function serialize(nodes: WidgetNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return escapeText(n.text);
      const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escapeText(v).replace(/"/g, "&quot;")}"`).join("");
      if (VOID_TAGS.has(n.tag)) return `<${n.tag}${attrs}>`;
      const inner = n.tag === "script" || n.tag === "style" ? textOf(n) : serialize(n.children);
      return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
    })
    .join("");
}

function kebab(s: string): string {
  if (s.startsWith("--")) return s;
  return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function camel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// MARK: selectors

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op?: string; value?: string }[];
}
type Selector = { parts: Compound[]; combinators: string[] }[];

const selectorCache = new Map<string, Selector>();

export function parseSelector(src: string): Selector | null {
  const cached = selectorCache.get(src);
  if (cached) return cached;
  const groups: Selector = [];
  for (const raw of src.split(",")) {
    const s = raw.trim();
    if (!s) return null;
    const parts: Compound[] = [];
    const combinators: string[] = [];
    const re = /\s*(>)\s*|\s+|([^\s>]+)/g;
    let m: RegExpExecArray | null;
    let pending = "";
    while ((m = re.exec(s))) {
      if (m[2]) {
        const c = parseCompound(m[2]);
        if (!c) return null;
        if (parts.length) combinators.push(pending || " ");
        parts.push(c);
        pending = "";
      } else if (m[1]) pending = ">";
      else if (!pending) pending = " ";
    }
    if (!parts.length) return null;
    groups.push({ parts, combinators });
  }
  if (selectorCache.size > 256) selectorCache.clear();
  selectorCache.set(src, groups);
  return groups;
}

function parseCompound(s: string): Compound | null {
  const c: Compound = { classes: [], attrs: [] };
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?\]/y;
  let i = 0;
  let first = true;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m.index !== i || (m[1] && !first)) return null;
    if (m[1]) c.tag = m[1] === "*" ? undefined : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] ?? m[7] ?? m[8] });
    i = re.lastIndex;
    first = false;
  }
  return c;
}

function matchCompound(el: ElementNode, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id !== undefined && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.attrs.class ?? "").split(/\s+/);
    if (!c.classes.every((x) => cls.includes(x))) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
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
  return true;
}

function matches(sb: Sandbox, el: ElementNode, sel: Selector): boolean {
  return sel.some((g) => {
    const match = (node: ElementNode, k: number): boolean => {
      if (!matchCompound(node, g.parts[k])) return false;
      if (k === 0) return true;
      const comb = g.combinators[k - 1];
      let p = sb.parentOf(node);
      if (comb === ">") return !!p && p.tag !== "#root" && match(p, k - 1);
      while (p && p.tag !== "#root") {
        if (match(p, k - 1)) return true;
        p = sb.parentOf(p);
      }
      return false;
    };
    return match(el, g.parts.length - 1);
  });
}

function query(sb: Sandbox, root: ElementNode, src: string, all: boolean): ElementNode[] {
  const sel = parseSelector(src);
  if (!sel) sb.it.throwError("SyntaxError", `'${src}' is not a valid selector`);
  const out: ElementNode[] = [];
  const walk = (el: ElementNode): boolean => {
    for (const c of el.children) {
      if (c.type !== "element") continue;
      sb.it.charge(1);
      if (matches(sb, c, sel)) {
        out.push(c);
        if (!all) return true;
      }
      if (walk(c)) return true;
    }
    return false;
  };
  walk(root);
  return out;
}

// MARK: host objects

/** An object whose properties come from code: `get`/`set` per key, methods from a table shared by every card. */
abstract class HostObj extends Obj {
  constructor(readonly sb: Sandbox) {
    super();
  }
  set(_key: string, _v: Value, _it: Interp): void {}
  has(key: string): boolean {
    return this.get(key, this.sb.it) !== undefined;
  }
  del(_key: string): boolean {
    return false;
  }
  keys(): string[] {
    return [];
  }
}

function method(table: Map<string, Native>, name: string, impl: NativeImpl): void {
  table.set(name, new Native(name, impl));
}

function self<T>(it: Interp, v: Value, cls: abstract new (...a: never[]) => T, what: string): T {
  if (!(v instanceof cls)) it.throwError("TypeError", `Illegal invocation: not ${what}`);
  return v as T;
}

function nodeArg(it: Interp, sb: Sandbox, v: Value): WidgetNode {
  if (v instanceof ElementObj || v instanceof TextObj) {
    if (v.sb !== sb) it.throwError("TypeError", "The node belongs to another card");
    return v.node;
  }
  if (typeof v === "string") return { type: "text", text: it.str(v) };
  it.throwError("TypeError", "Expected a node");
}

const NODE_METHODS = new Map<string, Native>();
const ELEMENT_METHODS = new Map<string, Native>();

class TextObj extends HostObj {
  className = "Text";
  constructor(sb: Sandbox, readonly node: TextNode) {
    super(sb);
  }
  get(key: string): Value {
    switch (key) {
      case "nodeType": return 3;
      case "nodeName": return "#text";
      case "textContent": case "data": case "nodeValue": case "wholeText": return this.node.text;
      case "parentNode": case "parentElement": {
        const p = this.sb.parentOf(this.node);
        return p ? this.sb.wrap(p) : null;
      }
    }
    return NODE_METHODS.get(key);
  }
  set(key: string, v: Value): void {
    if (key === "textContent" || key === "data" || key === "nodeValue") {
      this.node.text = this.sb.it.str(this.sb.it.toStr(v));
      this.sb.mutate();
    }
  }
}

class ElementObj extends HostObj {
  className = "HTMLElement";
  constructor(sb: Sandbox, readonly node: ElementNode) {
    super(sb);
  }
  isA(brand: string): boolean {
    return brand === "HTMLElement" || brand === "Element" || brand === "Node" || brand === "Object";
  }
  private kids(): ElementNode[] {
    return this.node.children.filter((c): c is ElementNode => c.type === "element");
  }
  private sibling(dir: 1 | -1): Value {
    const p = this.sb.parentOf(this.node);
    if (!p) return null;
    const els = p.children.filter((c) => c.type === "element");
    const n = els[els.indexOf(this.node) + dir];
    return n ? this.sb.wrap(n) : null;
  }
  get(key: string, it: Interp): Value {
    const n = this.node;
    const sb = this.sb;
    switch (key) {
      case "nodeType": return 1;
      case "tagName": case "nodeName": return n === sb.root ? "BODY" : n.tag.toUpperCase();
      case "localName": return n === sb.root ? "body" : n.tag;
      case "id": return n.attrs.id ?? "";
      case "className": return n.attrs.class ?? "";
      case "title": return n.attrs.title ?? "";
      case "href": return n.attrs.href ?? "";
      case "hidden": return "hidden" in n.attrs;
      case "disabled": return "disabled" in n.attrs;
      case "open": return "open" in n.attrs;
      case "textContent": case "innerText": return textOf(n);
      case "innerHTML": return it.str(serialize(n.children));
      case "outerHTML": return it.str(serialize([n]));
      case "style": return new StyleObj(sb, n);
      case "classList": return new ClassListObj(sb, n);
      case "dataset": return new DatasetObj(sb, n);
      case "children": return new ArrayObj(this.kids().map((c) => sb.wrap(c)));
      case "childNodes": return new ArrayObj(n.children.map((c) => sb.wrap(c)));
      case "childElementCount": return this.kids().length;
      case "firstChild": return n.children[0] ? sb.wrap(n.children[0]) : null;
      case "lastChild": return n.children.length ? sb.wrap(n.children[n.children.length - 1]) : null;
      case "firstElementChild": { const k = this.kids(); return k[0] ? sb.wrap(k[0]) : null; }
      case "lastElementChild": { const k = this.kids(); return k.length ? sb.wrap(k[k.length - 1]) : null; }
      case "nextElementSibling": return this.sibling(1);
      case "previousElementSibling": return this.sibling(-1);
      case "parentNode": case "parentElement": {
        const p = sb.parentOf(n);
        return p ? sb.wrap(p) : null;
      }
      case "isConnected": return sb.isAttached(n);
      case "onclick": return undefined;
    }
    return ELEMENT_METHODS.get(key) ?? NODE_METHODS.get(key);
  }
  set(key: string, v: Value, it: Interp): void {
    const n = this.node;
    const sb = this.sb;
    switch (key) {
      case "id": case "className": case "title": case "href":
        sb.setAttr(n, key === "className" ? "class" : key, it.toStr(v));
        return;
      case "hidden": case "disabled": case "open":
        if (it.truthy(v)) sb.setAttr(n, key, "");
        else sb.removeAttr(n, key);
        return;
      case "textContent": case "innerText": {
        const s = it.str(it.toStr(v ?? ""));
        sb.replaceChildren(n, s ? [{ type: "text", text: s }] : []);
        return;
      }
      case "innerHTML":
        sb.replaceChildren(n, sb.parseHTML(it.toStr(v ?? "")));
        return;
      case "onclick":
        it.throwError("TypeError", "Use addEventListener('click', …) in cards");
    }
  }
}

class StyleObj extends HostObj {
  constructor(sb: Sandbox, readonly node: ElementNode) {
    super(sb);
  }
  decls(): Record<string, string> {
    return parseStyle(this.node.attrs.style);
  }
  write(decls: Record<string, string>): void {
    const css = Object.entries(decls).map(([k, v]) => `${k}: ${v}`).join("; ");
    if (css) this.sb.setAttr(this.node, "style", css);
    else this.sb.removeAttr(this.node, "style");
  }
  put(prop: string, value: string): void {
    const d = this.decls();
    const k = kebab(prop).toLowerCase();
    if (value === "") delete d[k];
    else {
      if (badCSS(value) || /[;{}]/.test(value)) {
        this.sb.log("warn", `style ${k} value is not allowed`);
        return;
      }
      delete d[k]; // a set property moves to the end, as in the CSSOM
      d[k] = value;
    }
    this.write(d);
  }
  get(key: string): Value {
    if (key === "cssText") return this.node.attrs.style ?? "";
    if (key === "length") return Object.keys(this.decls()).length;
    const m = STYLE_METHODS.get(key);
    if (m) return m;
    return this.decls()[kebab(key).toLowerCase()] ?? "";
  }
  set(key: string, v: Value, it: Interp): void {
    if (key === "cssText") {
      const s = it.toStr(v ?? "");
      if (badCSS(s)) return;
      if (s.trim()) this.sb.setAttr(this.node, "style", s);
      else this.sb.removeAttr(this.node, "style");
      return;
    }
    this.put(key, v == null ? "" : it.toStr(v));
  }
}
const STYLE_METHODS = new Map<string, Native>();
method(STYLE_METHODS, "setProperty", (it, s, a) => void self(it, s, StyleObj, "a style").put(it.toStr(a[0]), a[1] == null ? "" : it.toStr(a[1])));
method(STYLE_METHODS, "removeProperty", (it, s, a) => {
  const st = self(it, s, StyleObj, "a style");
  const old = st.decls()[it.toStr(a[0]).toLowerCase()] ?? "";
  st.put(it.toStr(a[0]), "");
  return old;
});
method(STYLE_METHODS, "getPropertyValue", (it, s, a) => self(it, s, StyleObj, "a style").decls()[it.toStr(a[0]).toLowerCase()] ?? "");

class ClassListObj extends HostObj {
  constructor(sb: Sandbox, readonly node: ElementNode) {
    super(sb);
  }
  list(): string[] {
    return (this.node.attrs.class ?? "").split(/\s+/).filter(Boolean);
  }
  write(list: string[]): void {
    this.sb.setAttr(this.node, "class", list.join(" "));
  }
  get(key: string): Value {
    if (key === "length") return this.list().length;
    if (key === "value") return this.node.attrs.class ?? "";
    const i = /^\d+$/.test(key) ? Number(key) : -1;
    if (i >= 0) return this.list()[i];
    return CLASS_METHODS.get(key);
  }
}
const CLASS_METHODS = new Map<string, Native>();
method(CLASS_METHODS, "add", (it, s, a) => {
  const cl = self(it, s, ClassListObj, "a classList");
  const list = cl.list();
  for (const x of a) if (!list.includes(it.toStr(x))) list.push(it.toStr(x));
  cl.write(list);
});
method(CLASS_METHODS, "remove", (it, s, a) => {
  const cl = self(it, s, ClassListObj, "a classList");
  const drop = new Set(a.map((x) => it.toStr(x)));
  cl.write(cl.list().filter((x) => !drop.has(x)));
});
method(CLASS_METHODS, "toggle", (it, s, a) => {
  const cl = self(it, s, ClassListObj, "a classList");
  const c = it.toStr(a[0]);
  const list = cl.list();
  const on = a.length > 1 ? it.truthy(a[1]) : !list.includes(c);
  cl.write(on ? (list.includes(c) ? list : [...list, c]) : list.filter((x) => x !== c));
  return on;
});
method(CLASS_METHODS, "contains", (it, s, a) => self(it, s, ClassListObj, "a classList").list().includes(it.toStr(a[0])));
method(CLASS_METHODS, "item", (it, s, a) => self(it, s, ClassListObj, "a classList").list()[it.toNum(a[0])] ?? null);

class DatasetObj extends HostObj {
  constructor(sb: Sandbox, readonly node: ElementNode) {
    super(sb);
  }
  get(key: string): Value {
    return this.node.attrs["data-" + kebab(key)];
  }
  set(key: string, v: Value, it: Interp): void {
    this.sb.setAttr(this.node, "data-" + kebab(key), it.toStr(v));
  }
  has(key: string): boolean {
    return "data-" + kebab(key) in this.node.attrs;
  }
  del(key: string): boolean {
    this.sb.removeAttr(this.node, "data-" + kebab(key));
    return true;
  }
  keys(): string[] {
    return Object.keys(this.node.attrs).filter((k) => k.startsWith("data-")).map((k) => camel(k.slice(5)));
  }
}

// Node methods (elements and text).
method(NODE_METHODS, "remove", (it, s) => {
  const n = s instanceof ElementObj || s instanceof TextObj ? s : it.throwError("TypeError", "Illegal invocation");
  if (n.node === n.sb.root) return;
  n.sb.detach(n.node);
});
method(NODE_METHODS, "cloneNode", (it, s, a) => {
  const n = s instanceof ElementObj || s instanceof TextObj ? s : it.throwError("TypeError", "Illegal invocation");
  if (n.node.type === "text") return n.sb.wrap({ type: "text", text: n.node.text });
  const copy: ElementNode = it.truthy(a[0]) ? (clone(n.node) as ElementNode) : { type: "element", tag: n.node.tag, attrs: { ...n.node.attrs }, children: [] };
  if (copy.tag === "#root") copy.tag = "div";
  it.alloc(countTree(copy) * 4);
  n.sb.adopt(copy);
  return n.sb.wrap(copy);
});
method(NODE_METHODS, "addEventListener", (it, s, a) => {
  const n = self(it, s, ElementObj, "an element");
  n.sb.addListener(n.node, it.toStr(a[0]), a[1]);
});
method(NODE_METHODS, "removeEventListener", (it, s, a) => {
  const n = self(it, s, ElementObj, "an element");
  n.sb.removeListener(n.node, it.toStr(a[0]), a[1]);
});


function el(it: Interp, v: Value): ElementObj {
  return self(it, v, ElementObj, "an element");
}

method(ELEMENT_METHODS, "getAttribute", (it, s, a) => el(it, s).node.attrs[it.toStr(a[0]).toLowerCase()] ?? null);
method(ELEMENT_METHODS, "hasAttribute", (it, s, a) => it.toStr(a[0]).toLowerCase() in el(it, s).node.attrs);
method(ELEMENT_METHODS, "setAttribute", (it, s, a) => {
  const e = el(it, s);
  e.sb.setAttr(e.node, it.toStr(a[0]), it.toStr(a[1]));
});
method(ELEMENT_METHODS, "removeAttribute", (it, s, a) => {
  const e = el(it, s);
  e.sb.removeAttr(e.node, it.toStr(a[0]));
});
method(ELEMENT_METHODS, "toggleAttribute", (it, s, a) => {
  const e = el(it, s);
  const name = it.toStr(a[0]).toLowerCase();
  const on = a.length > 1 ? it.truthy(a[1]) : !(name in e.node.attrs);
  if (on) e.sb.setAttr(e.node, name, e.node.attrs[name] ?? "");
  else e.sb.removeAttr(e.node, name);
  return on;
});
method(ELEMENT_METHODS, "appendChild", (it, s, a) => {
  const e = el(it, s);
  e.sb.insert(e.node, nodeArg(it, e.sb, a[0]));
  return a[0];
});
method(ELEMENT_METHODS, "append", (it, s, a) => {
  const e = el(it, s);
  for (const x of a) e.sb.insert(e.node, nodeArg(it, e.sb, x));
});
method(ELEMENT_METHODS, "prepend", (it, s, a) => {
  const e = el(it, s);
  const first = e.node.children[0] ?? null;
  for (const x of a) e.sb.insert(e.node, nodeArg(it, e.sb, x), first && e.sb.parentOf(first) === e.node ? first : null);
});
method(ELEMENT_METHODS, "insertBefore", (it, s, a) => {
  const e = el(it, s);
  const before = a[1] == null ? null : nodeArg(it, e.sb, a[1]);
  e.sb.insert(e.node, nodeArg(it, e.sb, a[0]), before);
  return a[0];
});
method(ELEMENT_METHODS, "removeChild", (it, s, a) => {
  const e = el(it, s);
  const n = nodeArg(it, e.sb, a[0]);
  if (e.sb.parentOf(n) !== e.node) it.throwError("NotFoundError", "The node to be removed is not a child of this node");
  e.sb.detach(n);
  return a[0];
});
method(ELEMENT_METHODS, "replaceChild", (it, s, a) => {
  const e = el(it, s);
  const next = nodeArg(it, e.sb, a[0]);
  const old = nodeArg(it, e.sb, a[1]);
  if (e.sb.parentOf(old) !== e.node) it.throwError("NotFoundError", "The node to be replaced is not a child of this node");
  e.sb.insert(e.node, next, old);
  e.sb.detach(old);
  return a[1];
});
method(ELEMENT_METHODS, "replaceChildren", (it, s, a) => {
  const e = el(it, s);
  e.sb.replaceChildren(e.node, a.map((x) => nodeArg(it, e.sb, x)));
});
method(ELEMENT_METHODS, "before", (it, s, a) => {
  const e = el(it, s);
  const p = e.sb.parentOf(e.node);
  if (p) for (const x of a) e.sb.insert(p, nodeArg(it, e.sb, x), e.node);
});
method(ELEMENT_METHODS, "after", (it, s, a) => {
  const e = el(it, s);
  const p = e.sb.parentOf(e.node);
  if (!p) return;
  let ref: WidgetNode | null = p.children[p.children.indexOf(e.node) + 1] ?? null;
  for (const x of a) {
    const n = nodeArg(it, e.sb, x);
    if (n === ref) ref = p.children[p.children.indexOf(n) + 1] ?? null;
    e.sb.insert(p, n, ref);
  }
});
method(ELEMENT_METHODS, "querySelector", (it, s, a) => {
  const e = el(it, s);
  const r = query(e.sb, e.node, it.toStr(a[0]), false);
  return r[0] ? e.sb.wrap(r[0]) : null;
});
method(ELEMENT_METHODS, "querySelectorAll", (it, s, a) => {
  const e = el(it, s);
  return new ArrayObj(query(e.sb, e.node, it.toStr(a[0]), true).map((n) => e.sb.wrap(n)));
});
method(ELEMENT_METHODS, "getElementsByTagName", (it, s, a) => {
  const e = el(it, s);
  return new ArrayObj(query(e.sb, e.node, it.toStr(a[0]), true).map((n) => e.sb.wrap(n)));
});
method(ELEMENT_METHODS, "getElementsByClassName", (it, s, a) => {
  const e = el(it, s);
  const sel = it.toStr(a[0]).trim().split(/\s+/).filter(Boolean).map((c) => "." + c).join("");
  return new ArrayObj(sel ? query(e.sb, e.node, sel, true).map((n) => e.sb.wrap(n)) : []);
});
method(ELEMENT_METHODS, "matches", (it, s, a) => {
  const e = el(it, s);
  const sel = parseSelector(it.toStr(a[0]));
  if (!sel) return it.throwError("SyntaxError", "Not a valid selector");
  return e.node !== e.sb.root && matches(e.sb, e.node, sel);
});
method(ELEMENT_METHODS, "closest", (it, s, a) => {
  const e = el(it, s);
  const sel = parseSelector(it.toStr(a[0]));
  if (!sel) return it.throwError("SyntaxError", "Not a valid selector");
  for (let n: ElementNode | undefined = e.node; n && n !== e.sb.root; n = e.sb.parentOf(n)) {
    if (matches(e.sb, n, sel)) return e.sb.wrap(n);
  }
  return null;
});
method(ELEMENT_METHODS, "contains", (it, s, a) => {
  const e = el(it, s);
  if (!(a[0] instanceof ElementObj || a[0] instanceof TextObj)) return false;
  for (let n: WidgetNode | undefined = a[0].node; n; n = e.sb.parentOf(n)) if (n === e.node) return true;
  return false;
});
method(ELEMENT_METHODS, "click", (it, s) => {
  const e = el(it, s);
  // A script's own click() runs the handlers now, but is not a tap: no links.
  e.sb.dispatchClick(e.node);
});
method(ELEMENT_METHODS, "focus", () => undefined);
method(ELEMENT_METHODS, "blur", () => undefined);
method(ELEMENT_METHODS, "getBoundingClientRect", (it) => {
  // Layout is not readable from a card script.
  const r = new PlainObj();
  for (const k of ["x", "y", "top", "left", "right", "bottom", "width", "height"]) r.props.set(k, 0);
  it.alloc(9);
  return r;
});

// MARK: document and window

class DocumentObj extends HostObj {
  className = "Document";
  get(key: string): Value {
    const sb = this.sb;
    switch (key) {
      case "body": case "documentElement": return sb.wrap(sb.root);
      case "readyState": return sb.loading ? "loading" : "complete";
      case "hidden": return !sb.isActive;
      case "visibilityState": return sb.isActive ? "visible" : "hidden";
      case "nodeType": return 9;
    }
    return DOCUMENT_METHODS.get(key);
  }
}
const DOCUMENT_METHODS = new Map<string, Native>();
function doc(it: Interp, v: Value): DocumentObj {
  return self(it, v, DocumentObj, "the document");
}
method(DOCUMENT_METHODS, "getElementById", (it, s, a) => {
  const d = doc(it, s);
  const id = it.toStr(a[0]);
  let found: ElementNode | null = null;
  const walk = (e: ElementNode) => {
    for (const c of e.children) {
      if (found || c.type !== "element") continue;
      it.charge(1);
      if (c.attrs.id === id) found = c;
      else walk(c);
    }
  };
  walk(d.sb.root);
  return found ? d.sb.wrap(found) : null;
});
for (const name of ["querySelector", "querySelectorAll", "getElementsByTagName", "getElementsByClassName"]) {
  method(DOCUMENT_METHODS, name, (it, s, a) => it.call(ELEMENT_METHODS.get(name)!, doc(it, s).sb.wrap(doc(it, s).sb.root), a));
}
method(DOCUMENT_METHODS, "createElement", (it, s, a) => {
  const d = doc(it, s);
  return d.sb.wrap(d.sb.createElement(it.toStr(a[0])));
});
method(DOCUMENT_METHODS, "createTextNode", (it, s, a) => {
  const d = doc(it, s);
  return d.sb.wrap({ type: "text", text: it.str(it.toStr(a[0])) });
});
method(DOCUMENT_METHODS, "addEventListener", (it, s, a) => doc(it, s).sb.addListener("document", it.toStr(a[0]), a[1]));
method(DOCUMENT_METHODS, "removeEventListener", (it, s, a) => doc(it, s).sb.removeListener("document", it.toStr(a[0]), a[1]));

/** `window` and `globalThis`: the card's global variables, plus window's event methods. */
class WindowObj extends HostObj {
  className = "Window";
  get(key: string): Value {
    const b = this.sb.it.global.vars.get(key);
    if (b) return b.v;
    return WINDOW_METHODS.get(key);
  }
  set(key: string, v: Value): void {
    const b = this.sb.it.global.vars.get(key);
    if (b) {
      if (!b.konst) b.v = v;
    } else this.sb.it.global.declare(key, v);
  }
  has(key: string): boolean {
    return this.sb.it.global.vars.has(key);
  }
}
const WINDOW_METHODS = new Map<string, Native>();
method(WINDOW_METHODS, "addEventListener", (it, s, a) => self(it, s, WindowObj, "the window").sb.addListener("window", it.toStr(a[0]), a[1]));
method(WINDOW_METHODS, "removeEventListener", (it, s, a) => self(it, s, WindowObj, "the window").sb.removeListener("window", it.toStr(a[0]), a[1]));
method(WINDOW_METHODS, "open", (it, s, a) => {
  self(it, s, WindowObj, "the window").sb.openLink(a[0], false);
  return null;
});

// MARK: storage

class StorageObj extends HostObj {
  className = "Storage";
  constructor(sb: Sandbox, readonly map: Map<string, string>) {
    super(sb);
  }
  get(key: string): Value {
    if (key === "length") return this.map.size;
    return STORAGE_METHODS.get(key) ?? this.map.get(key);
  }
  size(): number {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
}
const STORAGE_METHODS = new Map<string, Native>();
function store(it: Interp, v: Value): StorageObj {
  return self(it, v, StorageObj, "a Storage");
}
method(STORAGE_METHODS, "getItem", (it, s, a) => store(it, s).map.get(it.toStr(a[0])) ?? null);
method(STORAGE_METHODS, "setItem", (it, s, a) => {
  const st = store(it, s);
  const k = it.toStr(a[0]);
  const v = it.toStr(a[1]);
  const old = st.map.get(k);
  const size = st.size() - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
  if (size > SANDBOX_LIMITS.storageBytes) throw new Throw(it.makeError("QuotaExceededError", "The card's storage is full (4 KB)"));
  st.map.set(k, v);
});
method(STORAGE_METHODS, "removeItem", (it, s, a) => void store(it, s).map.delete(it.toStr(a[0])));
method(STORAGE_METHODS, "clear", (it, s) => store(it, s).map.clear());
method(STORAGE_METHODS, "key", (it, s, a) => [...store(it, s).map.keys()][it.toNum(a[0])] ?? null);

// MARK: TelegramWidget

class WidgetObj extends HostObj {
  className = "TelegramWidget";
  get(key: string, it: Interp): Value {
    const sb = this.sb;
    switch (key) {
      // Telegram's API level (its "widget profile"), not Honk's card profile.
      case "profile": return 1;
      case "platform": return "honk";
      case "colorScheme": return sb.colorScheme;
      case "themeParams": return sb.params;
      case "isActive": return sb.isActive;
      case "isPreview": return false;
      case "isForward": return false;
      case "chatType": return "private";
      case "viewer": return null;
      case "wallet": return null;
      case "publicData": return null;
      case "chatData": return sb.chatData;
      case "contentSafeAreaInset": {
        const o = new PlainObj();
        for (const k of ["top", "right", "bottom", "left"]) o.props.set(k, 0);
        o.frozen = true;
        it.alloc(5);
        return o;
      }
      case "HapticFeedback": return HAPTICS;
    }
    return WIDGET_METHODS.get(key);
  }
}
const WIDGET_METHODS = new Map<string, Native>();
function widget(it: Interp, v: Value): WidgetObj {
  return self(it, v, WidgetObj, "TelegramWidget");
}
method(WIDGET_METHODS, "isProfileAtLeast", (it, _s, a) => it.toNum(a[0]) <= 1);
method(WIDGET_METHODS, "ready", () => undefined);
method(WIDGET_METHODS, "setResizeAnchor", () => undefined);
method(WIDGET_METHODS, "watchPublicData", () => undefined);
method(WIDGET_METHODS, "unwatchPublicData", () => undefined);
method(WIDGET_METHODS, "openLink", (it, s, a) => void widget(it, s).sb.openLink(a[0], false));
method(WIDGET_METHODS, "openTelegramLink", (it, s, a) => void widget(it, s).sb.openLink(a[0], true));
method(WIDGET_METHODS, "copyText", (it, s, a) => void widget(it, s).sb.copyText(a[0]));
method(WIDGET_METHODS, "onEvent", (it, s, a) => widget(it, s).sb.onEvent(it.toStr(a[0]), a[1]));
method(WIDGET_METHODS, "offEvent", (it, s, a) => widget(it, s).sb.offEvent(it.toStr(a[0]), a[1]));
method(WIDGET_METHODS, "request", (it, s) => {
  // Honk has no bot callbacks (yet): every request is refused, as Telegram does without allow_queries.
  const sb = widget(it, s).sb;
  const err = it.makeError("WidgetRequestError", "This card cannot send requests to its bot");
  err.props.set("code", "NOT_ALLOWED");
  return PromiseObj.rejected(sb, err);
});

const HAPTICS = new PlainObj();
for (const name of ["impactOccurred", "notificationOccurred", "selectionChanged"]) HAPTICS.props.set(name, new Native(name, () => undefined));
HAPTICS.frozen = true;

// MARK: promises

/** A small Promise: then/catch/finally, callbacks run as tasks of their own. */
class PromiseObj extends HostObj {
  className = "Promise";
  state: "pending" | "fulfilled" | "rejected" = "pending";
  value: Value = undefined;
  private waiting: (() => void)[] = [];

  static rejected(sb: Sandbox, v: Value): PromiseObj {
    const p = new PromiseObj(sb);
    p.settle("rejected", v);
    return p;
  }

  get(key: string): Value {
    return PROMISE_METHODS.get(key);
  }

  settle(state: "fulfilled" | "rejected", v: Value): void {
    if (this.state !== "pending") return;
    if (state === "fulfilled" && v instanceof PromiseObj) {
      v.whenDone(() => this.settle(v.state as "fulfilled" | "rejected", v.value));
      return;
    }
    this.state = state;
    this.value = v;
    const w = this.waiting;
    this.waiting = [];
    for (const f of w) this.sb.later(f);
  }

  whenDone(f: () => void): void {
    if (this.state === "pending") this.waiting.push(f);
    else this.sb.later(f);
  }

  then(onOk: Value, onErr: Value): PromiseObj {
    const next = new PromiseObj(this.sb);
    const it = this.sb.it;
    this.whenDone(() => {
      const h = this.state === "fulfilled" ? onOk : onErr;
      if (!(h instanceof FnObj)) {
        next.settle(this.state as "fulfilled" | "rejected", this.value);
        return;
      }
      try {
        next.settle("fulfilled", it.call(h, undefined, [this.value]));
      } catch (e) {
        if (e instanceof Throw) next.settle("rejected", e.value);
        else throw e;
      }
    });
    return next;
  }
}
const PROMISE_METHODS = new Map<string, Native>();
function prom(it: Interp, v: Value): PromiseObj {
  return self(it, v, PromiseObj, "a Promise");
}
method(PROMISE_METHODS, "then", (it, s, a) => prom(it, s).then(a[0], a[1]));
method(PROMISE_METHODS, "catch", (it, s, a) => prom(it, s).then(undefined, a[0]));
method(PROMISE_METHODS, "finally", (it, s, a) => {
  const p = prom(it, s);
  const f = a[0];
  const after = new Native("finally", (it2, _t, args) => {
    if (f instanceof FnObj) it2.call(f, undefined, []);
    return args[0];
  });
  const rethrow = new Native("finally", (it2, _t, args) => {
    if (f instanceof FnObj) it2.call(f, undefined, []);
    throw new Throw(args[0]);
  });
  return p.then(after, rethrow);
});

function promiseCtor(sb: Sandbox): Native {
  return new Native("Promise", (it) => it.throwError("TypeError", "Promise needs new"), {
    brand: "Promise",
    make(it, args) {
      const exec = args[0];
      if (!(exec instanceof FnObj)) it.throwError("TypeError", "Promise resolver is not a function");
      const p = new PromiseObj(sb);
      const resolve = new Native("resolve", (_it, _t, a) => void p.settle("fulfilled", a[0]));
      const reject = new Native("reject", (_it, _t, a) => void p.settle("rejected", a[0]));
      try {
        it.call(exec, undefined, [resolve, reject]);
      } catch (e) {
        if (e instanceof Throw) p.settle("rejected", e.value);
        else throw e;
      }
      return p;
    },
  }, {
    resolve: new Native("resolve", (_it, _t, a) => {
      if (a[0] instanceof PromiseObj) return a[0];
      const p = new PromiseObj(sb);
      p.settle("fulfilled", a[0]);
      return p;
    }),
    reject: new Native("reject", (_it, _t, a) => PromiseObj.rejected(sb, a[0])),
  });
}

/** For tests. */
export const _internal = { parseSelector, serialize, fromHost };
