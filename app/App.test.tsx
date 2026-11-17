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
      "honk.bot.delete": true,
      "honk.gateway.get": { url: "https://gw.test/", defaultURL: "https://gw.test/", custom: false },
      "honk.gateway.test": (d: unknown) => {
        const url = (d as { url: string }).url;
        return url.includes("bad") ? { ok: false, error: "无法连接到这个地址" } : { ok: true, url, version: "0.2.0" };
      },
      "honk.gateway.set": (d: unknown) => ({ url: (d as { url: string | null }).url ?? "https://gw.test/", registered: true }),
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
  await app.press("id:icon-ship");
  await app.press("id:color-#1c1c1e");
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

test("search filters the chat list", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.waitFor("text:Berth 部署");
  await app.type("id:search", "告警");
  await app.waitFor("text:没有匹配的会话");
  await app.clear("id:search");
  await app.type("id:search", "berth");
  await app.waitFor("text:Berth 部署");
});

test("edit mode deletes a bot after confirming", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.press("id:edit");
  app.onDialog(() => "删除");
  await app.press("id:delete-1");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.bot.delete"));
  expect(app.host.calls().find((c) => c.name === "honk.bot.delete")?.data).toEqual({ botId: 1 });
});

test("the gateway page tests an address before switching", async () => {
  const app = await open("./App.tsx", { host: host() });
  await app.press("id:tab-settings");
  await app.press("id:gateway-row");
  await app.clear("id:gateway-url");
  await app.type("id:gateway-url", "https://bad.example/");
  await app.press("id:test-gateway");
  await app.waitFor("text:无法连接到这个地址");
  // A failed check never switches.
  await app.press("id:save-gateway");
  expect(app.host.calls().some((c) => c.name === "honk.gateway.set")).toBe(false);

  await app.clear("id:gateway-url");
  await app.type("id:gateway-url", "https://mine.example/");
  app.onDialog(() => "切换");
  await app.press("id:save-gateway");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.gateway.set"));
  expect(app.host.calls().find((c) => c.name === "honk.gateway.set")?.data).toEqual({ url: "https://mine.example/" });
});
