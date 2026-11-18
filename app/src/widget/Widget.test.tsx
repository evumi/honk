import { expect, open, test } from "nsh/test";

// One bot whose only message is a card.
function host(html: string, data: Record<string, unknown>) {
  const bot = { id: "aZ3kQ9xT", name: "Ops", avatar: "preset:alert:#c2410c", defaultLevel: "active", createdAt: 1 };
  const card = {
    id: 9, botId: bot.id, title: "", body: "body text", html, data: JSON.stringify(data),
    level: "active", group: "", url: "", copy: "", icon: "", collapseId: "", date: Date.now(), read: true,
  };
  return {
    handlers: {
      "honk.status": { registered: true, gatewayURL: "https://gw.test/", notifications: "authorized" },
      "honk.chats": [{ bot, muted: false, pinned: false, unread: 0, last: card }],
      "honk.messages": [card],
      "honk.markRead": true,
      "honk.focus": true,
      "honk.refresh": true,
    },
  };
}

const styled = `<style>
  :root { --accent: #ff0000 }
  .card .title { color: var(--accent); font-weight: 700 }
  p.note { color: #00ff00 }
  #special { color: #0000ff }
  .hidden, .{{hide}} { display: none }
  .badge { color: {{tone}} }
  @media (prefers-color-scheme: dark) { .card .title { color: #ffffff } }
</style>
<div class="card">
  <p class="title">Title</p>
  <p class="note" id="special">Special</p>
  <p class="note">Note</p>
  <p class="hidden">Gone</p>
  <p class="{{state}}">State {{state}}</p>
  <p><span class="badge">Badge</span> <span class="hidden">inline gone</span></p>
</div>`;

test("<style> rules apply by type, class and id, with {{key}} in classes and the sheet", async () => {
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", colorScheme: "light", host: host(styled, { state: "off", hide: "off", tone: "#123456" }) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:Title");
  expect(app.spanStyle("text:Title").color).toBe("#ff0000ff");
  expect(app.spanStyle("text:Title").fontWeight).toBe(700);
  expect(app.spanStyle("text:Special").color).toBe("#0000ffff");
  expect(app.spanStyle("text:Note").color).toBe("#00ff00ff");
  expect(app.spanStyle("text:Badge").color).toBe("#123456ff");
  const texts = app.texts().join("|");
  expect(texts).not.toContain("Gone");
  expect(texts).not.toContain("State off");
  expect(texts).not.toContain("inline gone");
});

test("@media (prefers-color-scheme: dark) follows the app's appearance, also when it changes", async () => {
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", colorScheme: "light", host: host(styled, { state: "on", hide: "x", tone: "red" }) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:Title");
  expect(app.spanStyle("text:Title").color).toBe("#ff0000ff");
  await app.setColorScheme("dark");
  expect(app.spanStyle("text:Title").color).toBe("#ffffffff");
  expect(app.texts()).toContain("State on");
});

// A card with a script: the host (native/card in the apps) runs it and answers with trees.
const scripted = `<p id="n">{{start}}</p><button id="b">+1</button><a href="https://example.com/static">open</a><script>/* runs in the host */</script>`;

function scriptedHost(clicks: string[]) {
  const tree = (text: string, on = true) => [
    { type: "element", tag: "p", attrs: { id: "n" }, children: [{ type: "text", text }] },
    { type: "element", tag: "button", attrs: { id: "b", onclick: "steal()" }, children: [{ type: "text", text: "+1" }], on },
    { type: "element", tag: "a", attrs: { href: "https://example.com/static" }, children: [{ type: "text", text: "open" }], on },
    { type: "element", tag: "iframe", attrs: { src: "https://evil.example" }, children: [{ type: "text", text: "evil frame" }] },
    { type: "element", tag: "img", attrs: { src: "https://evil.example/t.png" }, children: [] },
  ];
  const h = host(scripted, { start: 0 });
  return {
    handlers: {
      ...h.handlers,
      "honk.card.open": (d: unknown) => {
        const load = JSON.parse((d as { load: string }).load);
        // The host gets the card filled with its data, scripts included.
        if (load.tree[0].children[0].text !== "0" || load.tree[3].tag !== "script") throw new Error("bad load");
        return JSON.stringify({ tree: tree("count 0"), prevented: false, stopped: null, logs: [] });
      },
      "honk.card.click": (d: unknown) => {
        const path = (d as { path: string }).path;
        clicks.push(path);
        if (path === "[1]") return JSON.stringify({ tree: tree("count 1"), prevented: false, open: "https://example.com/one", copy: "copied", stopped: null, logs: [] });
        // The link's handler prevents its default the first time only.
        return JSON.stringify({ tree: null, prevented: clicks.filter((c) => c === "[2]").length === 1, stopped: null, logs: [] });
      },
      "honk.card.set": JSON.stringify({ tree: null, prevented: false, stopped: null, logs: [] }),
      "honk.card.close": true,
    },
  };
}

test("a scripted card draws what the host's runtime returns, through the whitelist", async () => {
  const clicks: string[] = [];
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", host: scriptedHost(clicks) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:count 0");
  const texts = app.texts().join("|");
  expect(texts).not.toContain("evil frame");
  await app.press("text:+1");
  await app.waitFor("text:count 1");
  expect(clicks).toEqual(["[1]"]);
  expect(app.openedUrls()).toEqual(["https://example.com/one"]);
  expect(app.clipboard()).toBe("copied");
  // A handler that prevents the default keeps the link closed; the next tap opens it.
  await app.press("text:open");
  expect(app.openedUrls()).toEqual(["https://example.com/one"]);
  await app.press("text:open");
  expect(app.openedUrls()).toEqual(["https://example.com/one", "https://example.com/static"]);
  // Timer changes come as an event.
  await app.host.send("honk.card.changed", { key: "card-1", result: JSON.stringify({ tree: [{ type: "text", text: "from a timer" }], prevented: false, stopped: null, logs: [] }) });
  await app.waitFor("text:from a timer");
});

test("without a host that runs scripts, a scripted card stays static", async () => {
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", host: host(scripted, { start: 7 }) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:7");
  await app.press("text:open");
  expect(app.openedUrls()).toEqual(["https://example.com/static"]);
});
