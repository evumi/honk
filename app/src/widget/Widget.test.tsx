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
