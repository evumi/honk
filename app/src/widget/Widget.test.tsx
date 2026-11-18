import { expect, open, test } from "nsh/test";

// One bot whose only message is a card with a script (profile 2).
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

const counter = `<div>
<p id="n">{{start}}</p>
<button id="inc">+1</button>
<a id="go" href="https://example.com/static">open</a>
<script>
  var n = Number(document.getElementById("n").textContent);
  document.getElementById("inc").addEventListener("click", function () {
    n += 1;
    document.getElementById("n").textContent = "count " + n;
    if (n === 1) TelegramWidget.copyText("copied once");
    if (n === 2) TelegramWidget.openLink("https://example.com/two");
  });
  document.getElementById("go").addEventListener("click", function (e) {
    if (n === 0) e.preventDefault();
  });
</script>
</div>`;

test("a scripted card runs and redraws when a tap changes it", async () => {
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", host: host(counter, { start: 0 }) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:0");
  await app.press("text:+1");
  await app.waitFor("text:count 1");
  expect(app.clipboard()).toBe("copied once");
  await app.press("text:+1");
  await app.waitFor("text:count 2");
  expect(app.openedUrls()).toEqual(["https://example.com/two"]);
  // The link's default action runs unless a handler prevents it.
  await app.press("text:open");
  expect(app.openedUrls()).toEqual(["https://example.com/two", "https://example.com/static"]);
});

test("a card whose script stops keeps what it drew; one that cannot parse stays static", async () => {
  const looping = `<p id="p">{{label}}</p><script>document.getElementById("p").textContent = "drawn"; while (true) {}</script>`;
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", host: host(looping, { label: "static" }) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:drawn");
  expect(app.texts()).toContain("body text");

  const broken = `<p>{{label}}</p><script>class X {}</script>`;
  const app2 = await open("../../App.tsx", { locale: "zh-Hans-CN", host: host(broken, { label: "still static" }) });
  await app2.press("id:chat-aZ3kQ9xT");
  await app2.waitFor("text:still static");
});

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

test("a script that toggles a class restyles the card", async () => {
  const card = `<style>.off { display: none } .on { color: #ff0000 }</style>
<p id="msg" class="off">Details</p><button id="t">Toggle</button>
<script>
  document.getElementById("t").addEventListener("click", function () {
    var m = document.getElementById("msg");
    m.classList.toggle("off");
    m.classList.add("on");
  });
</script>`;
  const app = await open("../../App.tsx", { locale: "zh-Hans-CN", host: host(card, {}) });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitFor("text:Toggle");
  expect(app.texts()).not.toContain("Details");
  await app.press("text:Toggle");
  await app.waitFor("text:Details");
  expect(app.spanStyle("text:Details").color).toBe("#ff0000ff");
});
