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
