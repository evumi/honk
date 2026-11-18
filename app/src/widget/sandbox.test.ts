import { expect, test } from "nsh/test";
import { parse, type WidgetNode } from "./parse";
import { Sandbox, SANDBOX_LIMITS, type SandboxHost } from "./sandbox";
import { parseScript } from "./script";
import { widgetVars, palette } from "../theme";

interface Opened {
  links: string[];
  copied: string[];
  logs: string[];
  changes: number;
}

function card(html: string, data = "", opened?: Opened): Sandbox {
  const o = opened ?? { links: [], copied: [], logs: [], changes: 0 };
  const host: SandboxHost = {
    openLink: (u) => void o.links.push(u),
    copyText: (t) => void o.copied.push(t),
    changed: () => void o.changes++,
    log: (level, text) => void o.logs.push(`${level}: ${text}`),
  };
  const sb = new Sandbox(parse(html), data, { vars: widgetVars(palette()) }, host);
  sb.start();
  return sb;
}

function text(nodes: WidgetNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : n.tag === "script" ? "" : text(n.children))).join("");
}

function byId(sb: Sandbox, id: string): WidgetNode | undefined {
  const walk = (ns: WidgetNode[]): WidgetNode | undefined => {
    for (const n of ns) {
      if (n.type !== "element") continue;
      if (n.attrs.id === id) return n;
      const r = walk(n.children);
      if (r) return r;
    }
    return undefined;
  };
  return walk(sb.root.children);
}

/** Runs `code` in a card; `out(v)` records a value as JSON. Returns what was recorded. */
function run(code: string, opened?: Opened): string {
  const sb = card(`<p id="out"></p><script>function out(v){document.getElementById('out').textContent = JSON.stringify(v)}\n${code}</script>`, "", opened);
  const out = byId(sb, "out");
  return out ? text([out]) : "";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("parses the supported language and refuses the rest", () => {
  expect(() => parseScript("const {a, b: [c, d = 2], ...r} = o; let f = (x, ...ys) => x ?? ys[0]; for (const [k, v] of m) {} a?.b?.(c)")).not.toThrow();
  for (const bad of ["class A {}", "async function f() {}", "x = /re/", "function* g() {}", "label: for(;;) {}", "await x", "import x from 'y'"]) {
    expect(() => parseScript(bad)).toThrow();
  }
  expect(() => parseScript("(".repeat(200) + "1" + ")".repeat(200))).toThrow();
});

test("runs closures, loops, destructuring and the standard library", () => {
  expect(run(`
    const fns = [];
    for (let i = 0; i < 3; i++) fns.push(() => i);
    const {a, b: [c, d = 4], ...rest} = {a: 1, b: [3], e: 5, f: 6};
    const m = new Map([["x", 1]]); m.set("y", 2);
    const s = new Set([1, 1, 2]);
    let caught = "";
    try { null.x } catch (e) { caught = e.name } finally { caught += "!" }
    let sw = "";
    switch (2) { case 1: sw = "one"; break; case 2: sw = "two"; default: sw += "+" }
    out({
      fns: fns.map(f => f()), a, c, d, rest, caught, sw,
      tpl: \`\${a + c} items\`, opt: rest?.nope?.deeper, nul: null ?? "dflt",
      arr: [3, 1, 2].sort().concat([4]).filter(x => x > 1).map(x => x * 2).reduce((p, x) => p + x, 0),
      json: JSON.parse(JSON.stringify({k: [1, "2", true, null]})),
      map: [...m.keys()].join(), set: s.size, keys: Object.keys({b: 1, a: 2, 1: 0}),
      str: "a-b-c".split("-").reverse().join("+").padStart(7, "."), num: (3.14159).toFixed(2),
      math: Math.max(1, 9, 3), date: typeof Date.now(), proto: (function F() { this.v = 1 }).prototype !== undefined,
    });
  `)).toBe(JSON.stringify({
    fns: [0, 1, 2], a: 1, c: 3, d: 4, rest: { e: 5, f: 6 }, caught: "TypeError!", sw: "two+",
    tpl: "4 items", nul: "dflt", arr: 18, json: { k: [1, "2", true, null] }, map: "x,y", set: 2, keys: ["1", "b", "a"],
    str: "..c+b+a", num: "3.14", math: 9, date: "number", proto: true,
  }));
});

test("constructors, prototypes and instanceof work inside the card", () => {
  expect(run(`
    function P(x) { this.x = x }
    P.prototype.double = function () { return this.x * 2 };
    const p = new P(21);
    out([p.double(), p instanceof P, new Error("e") instanceof Error, [] instanceof Array, [] instanceof Object, p instanceof Array, typeof P]);
  `)).toBe(JSON.stringify([42, true, true, true, true, false, "function"]));
});

test("a card cannot reach the app's objects", () => {
  const probes = [
    "this", "globalThis.nsh", "typeof eval", "typeof Function", "typeof require", "typeof process", "typeof host",
    "({}).constructor", "[].constructor", "''.constructor", "(()=>1).constructor", "[].map.constructor",
    "({}).__proto__", "Object.getPrototypeOf({})", "Math.max.constructor", "JSON.parse.call", "typeof Reflect", "typeof Proxy",
  ];
  const got = run(`out([${probes.map((p) => `(()=>{ try { const v = ${p}; return v === undefined || v === null || v === "undefined" ? String(v) : typeof v === "function" ? "fn:" + v.name : typeof v } catch (e) { return e.name } })()`).join(",")}])`);
  expect(JSON.parse(got)).toEqual([
    "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined",
    "undefined", "undefined", "undefined", "undefined", "undefined",
    "undefined", "null", "undefined", "fn:call", "undefined", "undefined",
  ]);
  // Calling what does exist on functions never yields a host function.
  expect(run(`out(typeof Math.max.call.constructor)`)).toBe(JSON.stringify("undefined"));
  // Built-ins shared by every card cannot be changed by one of them.
  expect(run(`Math.max = () => 1; JSON.stringify = null; [].push.x = 1; out([Math.max(2, 3), typeof JSON.stringify, [].push.x])`)).toBe(JSON.stringify([3, "function", null]));
  expect(run(`out(Math.max(5, 7))`)).toBe("7");
});

test("no network: the web's request APIs throw NetworkDisabledError", () => {
  expect(run(`const r = []; for (const f of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) { try { window[f]("https://example.com") } catch (e) { r.push(e.name) } } out(r)`))
    .toBe(JSON.stringify(Array(4).fill("NetworkDisabledError")));
});

test("an endless loop stops the card, and try/catch cannot keep it alive", () => {
  const o: Opened = { links: [], copied: [], logs: [], changes: 0 };
  const start = performance.now();
  const sb = card(`<p id="p">before</p><script>document.getElementById('p').textContent = 'started'; try { while (true) {} } catch (e) {} document.getElementById('p').textContent = 'after';</script>`, "", o);
  expect(performance.now() - start).toBeLessThan(SANDBOX_LIMITS.taskMs * 4);
  expect(sb.stopped).toBe("time");
  expect(text(sb.root.children)).toBe("started");
  expect(o.logs.some((l) => l.includes("too long"))).toBe(true);
});

test("runaway allocation and recursion are stopped", () => {
  // Each array stays under the size limit; together they pass the allocation budget.
  expect(card(`<script>let a = []; while (true) a = [a, new Array(1000).fill(0)]</script>`).stopped).toBe("memory");
  expect(run(`const a = []; try { while (true) a.push(1) } catch (e) { out([e.name, a.length]) }`)).toBe(JSON.stringify(["RangeError", 16384]));
  expect(run(`let s = "x"; try { while (true) s += s } catch (e) { out([e.name, s.length <= 32768]) }`)).toBe(JSON.stringify(["RangeError", true]));
  expect(run(`function f(n) { return f(n + 1) } try { f(0) } catch (e) { out(e.name) }`)).toBe(JSON.stringify("RangeError"));
  expect(run(`try { "ab".repeat(1e9) } catch (e) { out(e.name) }`)).toBe(JSON.stringify("RangeError"));
});

test("syntax errors leave the card static", () => {
  const o: Opened = { links: [], copied: [], logs: [], changes: 0 };
  const sb = new Sandbox(parse(`<p>static</p><script>class X {}</script>`), "", { vars: {} }, { openLink() {}, copyText() {}, changed() {}, log: (l, t) => void o.logs.push(t) });
  expect(sb.start()).toBe(false);
  expect(o.logs[0]).toContain("class is not supported");
});

test("scripts edit the DOM through the whitelist", () => {
  const sb = card(`<div id="box" class="a"><span>x</span></div><script>
    const box = document.querySelector('#box.a');
    box.classList.add('b');
    box.style.backgroundColor = 'red';
    box.style.background = 'url(https://evil.example/x.png)';
    box.dataset.count = '3';
    box.setAttribute('onclick', 'steal()');
    const b = document.createElement('b');
    b.textContent = 'bold';
    box.appendChild(b);
    box.insertAdjacentHTML;
    document.body.insertBefore(document.createTextNode('top '), document.body.firstChild);
    const extra = document.createElement('div');
    extra.innerHTML = '<p onclick="x()">safe</p><script>alert(1)<\\/script><a href="javascript:alert(1)">a</a><img src="https://evil.example/t.gif">';
    document.body.append(extra);
    document.querySelectorAll('span').forEach(s => s.remove());
  </script>`);
  const box = byId(sb, "box") as WidgetNode & { type: "element" };
  expect(box.attrs).toEqual({ id: "box", class: "a b", style: "background-color: red", "data-count": "3" });
  expect(text(sb.root.children)).toBe("top boldsafea");
  const extra = sb.root.children.find((n) => n.type === "element" && n.tag === "div" && !n.attrs.id) as WidgetNode & { type: "element" };
  expect(extra.children.map((c) => (c.type === "element" ? [c.tag, c.attrs] : c.text))).toEqual([["p", {}], ["a", {}], ["img", {}]]);
});

test("the node limit holds", () => {
  const sb = card(`<div id="d"></div><script>
    const d = document.getElementById('d');
    let n = 0;
    try { for (;;) { d.appendChild(document.createElement('span')); n++ } } catch (e) { d.dataset.n = n; d.dataset.err = e.name }
  </script>`);
  const d = byId(sb, "d") as WidgetNode & { type: "element" };
  expect(d.attrs["data-err"]).toBe("RangeError");
  expect(Number(d.attrs["data-n"])).toBeLessThanOrEqual(SANDBOX_LIMITS.nodes);
});

test("taps run click handlers, and links open only from a tap", () => {
  const o: Opened = { links: [], copied: [], logs: [], changes: 0 };
  const sb = card(`<div id="wrap"><button id="b">0</button></div><script>
    let n = 0;
    const b = document.getElementById('b');
    b.addEventListener('click', (e) => { n++; b.textContent = String(n); TelegramWidget.openLink('https://example.com/' + n); TelegramWidget.openLink('https://example.com/again'); TelegramWidget.copyText('copied ' + n) });
    document.getElementById('wrap').addEventListener('click', (e) => { if (n === 2) e.preventDefault() });
    TelegramWidget.openLink('https://example.com/at-load');
  </script>`, "", o);
  const b = byId(sb, "b") as WidgetNode & { type: "element" };
  expect(sb.hasListener(b)).toBe(true);
  const before = o.changes;
  expect(sb.click(b)).toBe(false);
  expect(text([b])).toBe("1");
  expect(o.changes).toBe(before + 1);
  expect(sb.click(b)).toBe(true);
  expect(o.links).toEqual(["https://example.com/1", "https://example.com/2"]);
  expect(o.copied).toEqual(["copied 1", "copied 2"]);
  expect(run(`try { TelegramWidget.openLink('http://example.com') } catch (e) { out(e.name) }`)).toBe(JSON.stringify("TypeError"));
});

test("TelegramWidget gives theme, data and refuses requests", async () => {
  const o: Opened = { links: [], copied: [], logs: [], changes: 0 };
  const sb = card(`<p id="out"></p><script>
    const w = window.TelegramWidget;
    const p = document.getElementById('out');
    p.textContent = [w.profile, w.isProfileAtLeast(1), w.colorScheme, typeof w.themeParams.bg_color, JSON.parse(w.chatData).n, w.isActive].join(',');
    w.request('hi').then(() => p.dataset.req = 'ok', (e) => p.dataset.req = e.name + ':' + e.code);
    w.onEvent('themeChanged', function () { p.dataset.theme = this.colorScheme });
  </script>`, JSON.stringify({ n: 5 }), o);
  const p = byId(sb, "out") as WidgetNode & { type: "element" };
  expect(text([p])).toBe("1,true,light,string,5,true");
  await sleep(20);
  expect(p.attrs["data-req"]).toBe("WidgetRequestError:NOT_ALLOWED");
  sb.setTheme({ vars: { ...widgetVars(palette()), "--tg-color-scheme": "dark" } });
  expect(p.attrs["data-theme"]).toBe("dark");
});

test("timers run within limits and stop with the card", async () => {
  const sb = card(`<p id="t">0</p><script>
    let n = 0;
    const id = setInterval(() => { n++; document.getElementById('t').textContent = String(n); if (n === 3) clearInterval(id) }, 16);
    let made = 0;
    try { for (let i = 0; i < 100; i++) { setTimeout(() => {}, 100000); made++ } } catch (e) { document.getElementById('t').dataset.made = made }
  </script>`);
  expect(sb.timerCount).toBeLessThanOrEqual(SANDBOX_LIMITS.timers);
  await sleep(200);
  expect(text([byId(sb, "t")!])).toBe("3");
  sb.dispose();
  expect(sb.timerCount).toBe(0);
});

test("localStorage holds 4 KB", () => {
  expect(run(`localStorage.setItem('a', '1'); let err = ''; try { localStorage.setItem('b', 'x'.repeat(5000)) } catch (e) { err = e.name } out([localStorage.getItem('a'), err, localStorage.length])`))
    .toBe(JSON.stringify(["1", "QuotaExceededError", 1]));
});
