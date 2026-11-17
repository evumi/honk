import { expect, open, test } from "nsh/test";

// The native host as NshBridge answers it, with one bot and one card message.
function host(overrides: Record<string, unknown> = {}) {
  const bot = { id: 1, name: "Berth 部署", avatar: "preset:ship:#1c1c1e", defaultLevel: "active", createdAt: 1 };
  const card = {
    id: 7, botId: 1, title: "部署成功", body: "sub2api / sluice 已上线。",
    html: `<div><span>{{status}}</span><h3>{{service}}</h3><p>部署 ID <code>{{id}}</code></p><a href="https://example.com">在 Berth 中查看</a></div>`,
    data: JSON.stringify({ status: "已上线", service: "sub2api / sluice", id: "dep_w3tn" }),
    level: "active", group: "", url: "", copy: "", icon: "", collapseId: "dep", date: Date.now(), read: false,
  };
  return {
    handlers: {
      "honk.status": { registered: true, gatewayURL: "https://gw.test/", notifications: "authorized" },
      "honk.chats": [{ bot, muted: false, pinned: false, unread: 1, last: card }],
      "honk.messages": [card],
      "honk.markRead": true,
      "honk.focus": true,
      "honk.refresh": true,
      "honk.bot.create": (d: unknown) => ({ bot: { ...bot, id: 2, name: (d as { name: string }).name }, token: "2:secret-token" }),
      "honk.bot.token": "1:abcdefghijklmnop",
      ...overrides,
    },
  };
}

test("lists bots with their last message and unread count", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.waitFor("text:Berth 部署");
  expect(app.texts()).toContain("部署成功：sub2api / sluice 已上线。");
  expect(app.texts()).toContain("1");
});

test("opens a chat and renders the card with its data", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.press("id:chat-1");
  await app.waitFor("text:已上线");
  const texts = app.texts();
  expect(texts).toContain("sub2api / sluice");
  expect(texts).toContain("在 Berth 中查看");
  expect(texts.some((t) => t.includes("dep_w3tn"))).toBe(true);
  expect(texts).toContain("sub2api / sluice 已上线。");
  const calls = app.host.calls().map((c) => c.name);
  expect(calls).toContain("honk.markRead");
  expect(calls).toContain("honk.focus");
});

test("a host event opens the chat", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.waitFor("text:Berth 部署");
  await app.host.send("honk.open", { botId: 1 });
  await app.waitFor("text:在 Berth 中查看");
});

test("creates a bot and shows its token", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.press("id:new-bot");
  await app.type("id:bot-name", "CI 构建");
  await app.press("id:create-bot");
  await app.waitFor("text:2:secret-token");
  expect(app.texts()).toContain("CI 构建 已创建");
  const create = app.host.calls().find((c) => c.name === "honk.bot.create");
  expect(create?.data).toMatchObject({ name: "CI 构建", avatar: "preset:ship:#1c1c1e", defaultLevel: "active" });
});

test("bot settings masks the stored token", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.press("id:chat-1");
  await app.press("id:open-settings");
  await app.waitFor("text:1:abcd••••••••nop");
});
