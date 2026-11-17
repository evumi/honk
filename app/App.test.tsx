import { expect, open, test } from "nsh/test";

// The native host as NshBridge answers it, with one bot and one card message.
function host(overrides: Record<string, unknown> = {}) {
  const bot = { id: "aZ3kQ9xT", name: "Berth 部署", avatar: "preset:box:#1c1c1e", defaultLevel: "active", createdAt: 1 };
  const card = {
    id: 7, botId: "aZ3kQ9xT", title: "部署成功", body: "sub2api / sluice 已上线。",
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
      "honk.bot.create": (d: unknown) => ({ bot: { ...bot, id: "bQ7mN2pR", name: (d as { name: string }).name }, token: "bQ7mN2pR:secret-token" }),
      "honk.bot.token": "aZ3kQ9xT:abcdefghijklmnop",
      "honk.bot.delete": true,
      "honk.message.delete": true,
      "honk.avatar.save": (d: unknown) => ((d as { type: string }).type === "image/png" ? "local:a1b2.png" : "local:a1b2.jpg"),
      "honk.avatar.image": null,
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
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.waitFor("text:Berth 部署");
  expect(app.texts()).toContain("部署成功：sub2api / sluice 已上线。");
  expect(app.texts()).toContain("1");
});

test("opens a chat and renders the card with its data", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.press("id:chat-aZ3kQ9xT");
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
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.waitFor("text:Berth 部署");
  await app.host.send("honk.open", { botId: "aZ3kQ9xT" });
  await app.waitFor("text:在 Berth 中查看");
});

test("creates a bot and shows its token", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.press("id:new-bot");
  await app.press("id:icon-box");
  await app.press("id:color-#1c1c1e");
  await app.type("id:bot-name", "CI 构建");
  await app.press("id:create-bot");
  await app.waitFor("text:bQ7mN2pR:secret-token");
  expect(app.texts()).toContain("CI 构建 已创建");
  // Confetti over the page, gone by itself after a few seconds.
  expect(app.count("id:confetti")).toBe(1);
  await app.wait(4000);
  expect(app.count("id:confetti")).toBe(0);
  const create = app.host.calls().find((c) => c.name === "honk.bot.create");
  expect(create?.data).toMatchObject({ name: "CI 构建", avatar: "preset:box:#1c1c1e", defaultLevel: "active" });
});

test("the ship is gone and + picks an image kept on the phone", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.press("id:new-bot");
  expect(app.count("id:icon-ship")).toBe(0);
  // A 1×1 PNG.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  app.onPick((pick) => {
    expect(pick.kind).toBe("images");
    return [{ name: "me.png", type: "image/png", data: png }];
  });
  await app.press("id:icon-upload");
  await app.waitFor("id:custom-avatar");
  const save = app.host.calls().find((c) => c.name === "honk.avatar.save");
  expect((save?.data as { type: string }).type).toBe("image/png");
  expect((save?.data as { data: string }).data.startsWith("iVBORw0KGgo")).toBe(true);
  await app.type("id:bot-name", "我的 Bot");
  await app.press("id:create-bot");
  await app.waitFor("text:bQ7mN2pR:secret-token");
  const create = app.host.calls().find((c) => c.name === "honk.bot.create");
  expect(create?.data).toMatchObject({ name: "我的 Bot", avatar: "local:a1b2.png" });
});

test("choosing an icon after a picked image goes back to the preset", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.press("id:new-bot");
  app.onPick(() => [{ name: "me.jpg", type: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }]);
  await app.press("id:icon-upload");
  await app.waitFor("id:custom-avatar");
  await app.press("id:icon-cloud");
  expect(app.count("id:custom-avatar")).toBe(0);
  await app.type("id:bot-name", "云");
  await app.press("id:create-bot");
  await app.waitFor("text:bQ7mN2pR:secret-token");
  expect(app.host.calls().find((c) => c.name === "honk.bot.create")?.data).toMatchObject({ avatar: "preset:cloud:#0a6ed1" });
});

test("bot settings masks the stored token", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.press("id:chat-aZ3kQ9xT");
  await app.press("id:open-settings");
  await app.waitFor("text:aZ3kQ9xT:abcd••••••••nop");
});

test("a message turns to dust before it is deleted", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.press("id:chat-aZ3kQ9xT");
  app.onDialog(() => "删除");
  await app.longPress("id:message-7");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.message.delete"));
  expect(app.host.calls().find((c) => c.name === "honk.message.delete")?.data).toEqual({ messageId: 7 });
});

test("a message whose delete fails comes back", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host({ "honk.message.delete": () => { throw new Error("offline"); } }) });
  await app.press("id:chat-aZ3kQ9xT");
  app.onDialog(() => "删除");
  await app.longPress("id:message-7");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.message.delete"));
  await app.wait(1200);
  expect(app.count("id:message-7")).toBe(1);
});

test("search filters the chat list", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.waitFor("text:Berth 部署");
  await app.type("id:search", "告警");
  await app.waitFor("text:没有匹配的会话");
  await app.clear("id:search");
  await app.type("id:search", "berth");
  await app.waitFor("text:Berth 部署");
});

test("edit mode deletes a bot after confirming", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
  await app.press("id:edit");
  app.onDialog(() => "删除");
  await app.press("id:delete-aZ3kQ9xT");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.bot.delete"));
  expect(app.host.calls().find((c) => c.name === "honk.bot.delete")?.data).toEqual({ botId: "aZ3kQ9xT" });
});

test("the gateway page tests an address before switching", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN",  host: host() });
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

test("settings shows a failed registration and retries it", async () => {
  let registered = false;
  const status = () => registered
    ? { registered: true, registration: "registered", pushMode: "apns", gatewayURL: "https://gw.test/", notifications: "authorized" }
    : { registered: false, registration: "failed", registrationError: "连不上网关", pushMode: "apns", gatewayURL: "https://gw.test/", notifications: "authorized" };
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", 
    host: host({
      "honk.status": () => status(),
      "honk.register.retry": () => {
        registered = true;
        return status();
      },
    }),
  });
  await app.press("id:tab-settings");
  await app.waitFor("text:注册失败");
  expect(app.texts().some((t) => t.includes("连不上网关"))).toBe(true);
  await app.press("id:retry-registration");
  await app.waitFor("text:已注册");
});

test("an English locale gets the English UI", async () => {
  const app = await open("./App.tsx", { locale: "en-US", host: host() });
  await app.waitFor("text:Berth 部署");
  expect(app.texts()).toContain("Notifications");
  expect(app.texts()).toContain("Edit");
  await app.press("id:tab-settings");
  await app.waitFor("text:Registered");
  expect(app.texts()).toContain("Sync now");
});

test("an open chat does not mark read again on every change", async () => {
  let unread = true;
  let marks = 0;
  const message = () => ({
    id: 7, botId: "aZ3kQ9xT", title: "t", body: "b", html: "", data: "", level: "active", group: "", url: "", copy: "",
    icon: "", collapseId: "", date: Date.now(), read: !unread,
  });
  const app = await open("./App.tsx", {
    locale: "zh-Hans-CN",
    host: host({
      "honk.messages": () => [message()],
      "honk.markRead": () => {
        marks++;
        unread = false;
        return true;
      },
    }),
  });
  await app.press("id:chat-aZ3kQ9xT");
  await app.waitUntil(() => marks === 1);
  // The native side announces the read (and any other change); the page reloads.
  await app.host.send("honk.changed");
  await app.host.send("honk.changed");
  await app.wait(300);
  expect(marks).toBe(1);
});

test("settings shows the installed version at the bottom", async () => {
  const app = await open("./App.tsx", {
    locale: "zh-Hans-CN",
    host: host({ "honk.status": { registered: true, registration: "registered", pushMode: "apns", gatewayURL: "https://gw.test/", notifications: "authorized", appVersion: "0.2.0", appBuild: "17" } }),
  });
  await app.press("id:tab-settings");
  await app.waitFor("text:Honk 0.2.0 (17)");
});

test("settings switches the language and remembers it", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.press("id:tab-settings");
  app.onDialog(() => "English");
  await app.press("id:language-row");
  await app.waitFor("text:Language");
  expect(app.storage()["honk.language"]).toBe("en");
});

test("the created page sends a test notification with the new token", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.press("id:new-bot");
  await app.type("id:bot-name", "CI 构建");
  await app.press("id:create-bot");
  await app.waitFor("id:send-test");
  await app.press("id:send-test");
  await app.waitUntil(() => app.requests().some((r) => r.url.includes("/botbQ7mN2pR:secret-token/sendMessage")));
});


test("swiping a chat left deletes the bot after confirming", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.waitFor("id:chat-aZ3kQ9xT");
  await app.drag("id:chat-aZ3kQ9xT", { x: -160, y: 0 });
  app.onDialog(() => "删除");
  await app.press("id:swipe-delete-aZ3kQ9xT");
  await app.waitUntil(() => app.host.calls().some((c) => c.name === "honk.bot.delete"));
  expect(app.host.calls().find((c) => c.name === "honk.bot.delete")?.data).toEqual({ botId: "aZ3kQ9xT" });
});

test("cancelling the swipe delete keeps the bot", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.waitFor("id:chat-aZ3kQ9xT");
  await app.drag("id:chat-aZ3kQ9xT", { x: -160, y: 0 });
  app.onDialog(() => "取消");
  await app.press("id:swipe-delete-aZ3kQ9xT");
  await app.wait(500);
  expect(app.host.calls().some((c) => c.name === "honk.bot.delete")).toBe(false);
});

test("scrolling up in a chat shows a button back to the newest message", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", height: 500 });
  await app.press("id:chat-Bx7kQ2mT");
  await app.waitFor("id:message-103");
  await app.scroll("id:message-103", -1200);
  await app.waitFor("id:jump-latest");
  await app.press("id:jump-latest");
  await app.waitUntil(() => app.count("id:jump-latest") === 0);
});

test("pulling the chat list refreshes and the spinner stops", async () => {
  const app = await open("./App.tsx", { locale: "zh-Hans-CN", host: host() });
  await app.waitFor("id:chat-aZ3kQ9xT");
  const before = app.host.calls().filter((c) => c.name === "honk.refresh").length;
  await app.drag("id:chat-aZ3kQ9xT", { y: 200 });
  await app.waitUntil(() => app.host.calls().filter((c) => c.name === "honk.refresh").length > before);
  await app.waitUntil(() => app.host.calls().filter((c) => c.name === "honk.chats").length > 1);
});

