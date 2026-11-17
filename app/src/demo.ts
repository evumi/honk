// An in-memory stand-in for the native host, used when the app runs without
// one (`nsh run App.tsx` on a desktop). Same names and shapes as NshBridge.
import type { Bot, Chat, Message } from "./host";
import { appInfo } from "nsh";
import { lang } from "./i18n";

const now = Date.now();
// The demo speaks the app's language, so screenshots read naturally.
const en = lang() === "en";
const L = (zh: string, english: string) => (en ? english : zh);

const card = `<div style="padding:4px 0">
<span style="display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;border:1px solid var(--tg-theme-section-separator-color)"><span style="width:8px;height:8px;border-radius:4px;background:{{dot}}"></span><span>{{status}}</span></span>
<h3 style="margin:12px 0 2px">{{service}}</h3>
<p style="margin:0;color:var(--tg-theme-hint-color)">${L("部署", "Deploy")} · {{env}}</p>
<hr>
<p><span style="color:var(--tg-theme-hint-color)">${L("部署 ID", "Deploy ID")}</span>  <code>{{deploy_id}}</code></p>
<a href="{{url}}" style="display:block;padding:12px;border-radius:12px;background:var(--tg-theme-text-color);color:var(--tg-theme-bg-color);text-align:center">${L("在 Berth 中查看", "View in Berth")}</a>
</div>`;

const bots: Bot[] = [
  { id: "Bx7kQ2mT", name: L("Berth 部署", "Berth Deploys"), avatar: "preset:ship:#1c1c1e", defaultLevel: "active", createdAt: now - 864e5 * 5 },
  { id: "aR4nW9pZ", name: L("服务器告警", "Server Alerts"), avatar: "preset:alert:#c2410c", defaultLevel: "timeSensitive", createdAt: now - 864e5 * 4 },
  { id: "Kc3vH8sL", name: L("CI 构建", "CI Builds"), avatar: "preset:check:#2f6f3e", defaultLevel: "active", createdAt: now - 864e5 * 3 },
];

let nextId = 100;
const msg = (botId: string, minutesAgo: number, m: Partial<Message>): Message => ({
  id: nextId++, botId, title: "", body: "", html: "", data: "", level: "active", group: "", url: "", copy: "",
  icon: "", collapseId: "", date: now - minutesAgo * 6e4, read: false, ...m,
});

const messages: Message[] = [
  msg("Kc3vH8sL", 60 * 30, { title: L("main #482 通过", "main #482 passed"), body: L("3 分 12 秒 · 128 个测试全部通过", "3m 12s · all 128 tests passed"), read: true }),
  msg("Bx7kQ2mT", 95, {
    title: L("部署失败", "Deploy failed"), body: L("fluxship / queue 未通过健康检查，已自动回滚。", "fluxship / queue failed its health check and was rolled back."), html: card, read: true,
    data: JSON.stringify({ status: L("部署失败", "Failed"), dot: "#d9480f", service: "fluxship / queue", env: "production", deploy_id: "dep_r8kq2", url: "https://example.com" }),
  }),
  msg("aR4nW9pZ", 75, { title: "hk-edge-02 CPU 92%", body: L("持续 5 分钟超过阈值 85%，负载 7.8。", "Above the 85% threshold for 5 minutes, load 7.8.") }),
  msg("Bx7kQ2mT", 38, {
    title: L("部署成功", "Deployed"), body: L("部署成功：evumi / sluice (production) 已上线。", "evumi / sluice is live in production."), html: card,
    data: JSON.stringify({ status: L("已上线", "Live"), dot: "#1a9e6e", service: "evumi / sluice", env: "production", deploy_id: "dep_w3tn2cnlrvwtspmjmpol", url: "https://example.com" }),
  }),
  msg("Bx7kQ2mT", 25, { title: L("每日部署汇总", "Daily deploy summary"), body: L("今天共 6 次部署，5 次成功，1 次回滚。", "6 deploys today: 5 succeeded, 1 rolled back.") }),
];
const DEFAULT_GATEWAY = "https://honk.example.com/";
let gateway = DEFAULT_GATEWAY;

function normalize(u: string): string | null {
  let t = u.trim();
  if (!t) return null;
  if (!t.includes("://")) t = "https://" + t;
  if (!/^https?:\/\/[^/\s?#]+/i.test(t) || /[?#]/.test(t)) return null;
  return t.endsWith("/") ? t : t + "/";
}

const flags = new Map<string, { muted: boolean; pinned: boolean }>();
const tokens = new Map<string, string>([["Bx7kQ2mT", "Bx7kQ2mT:bQx9fK2mT4vLr8Wz1pYs6NcHa3Ue0JdG"]]);

function randomString(abc: string, n: number): string {
  let t = "";
  for (let i = 0; i < n; i++) t += abc[Math.floor(Math.random() * abc.length)];
  return t;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A bot id shaped like the gateway's: 8 base62 characters starting with a letter. */
function demoBotId(): string {
  return randomString(LETTERS, 1) + randomString(LETTERS + "0123456789", 7);
}

/** A token shaped like the gateway's: `<bot id>:` and 32 URL-safe characters. */
function demoToken(botId: string): string {
  return `${botId}:${randomString(LETTERS + "0123456789-_", 32)}`;
}

function chats(): Chat[] {
  return bots
    .map((bot) => {
      const own = messages.filter((m) => m.botId === bot.id);
      const f = flags.get(bot.id) ?? { muted: false, pinned: false };
      return { bot, ...f, unread: own.filter((m) => !m.read).length, last: own[own.length - 1] ?? null };
    })
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (b.last?.date ?? b.bot.createdAt) - (a.last?.date ?? a.bot.createdAt)));
}

export async function demo<T>(name: string, args: unknown): Promise<T> {
  const a = (args ?? {}) as Record<string, any>;
  const out = ((): unknown => {
    switch (name) {
      case "honk.status":
        return { registered: true, registration: "registered", pushMode: "apns", gatewayURL: gateway, notifications: "authorized", appVersion: appInfo().version, appBuild: String(appInfo().build ?? "") };
      case "honk.register.retry":
        return { registered: true, registration: "registered", pushMode: "apns", gatewayURL: gateway, notifications: "authorized" };
      case "honk.gateway.get":
        return { url: gateway, defaultURL: DEFAULT_GATEWAY, custom: gateway !== DEFAULT_GATEWAY };
      case "honk.gateway.test": {
        const url = normalize(String(a.url ?? ""));
        if (!url) return { ok: false, error: L("地址无效：需要 http:// 或 https:// 开头的网址", "Not a valid address: it needs http:// or https://") };
        if (url.includes("bad")) return { ok: false, error: L("无法连接到这个地址", "Can't reach this address") };
        return { ok: true, url, version: "0.1.0" };
      }
      case "honk.gateway.set": {
        gateway = a.url ? normalize(String(a.url)) ?? gateway : DEFAULT_GATEWAY;
        bots.splice(0, bots.length);
        messages.splice(0, messages.length);
        return { url: gateway, registered: true };
      }
      case "honk.chats":
        return chats();
      case "honk.messages":
        return messages
          .filter((m) => m.botId === a.botId && (a.before == null || m.id < a.before))
          .sort((x, y) => y.id - x.id)
          .slice(0, a.limit ?? 50);
      case "honk.markRead":
        messages.forEach((m) => m.botId === a.botId && (m.read = true));
        return true;
      case "honk.bot.create": {
        const bot: Bot = { id: demoBotId(), name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel, createdAt: Date.now() };
        bots.push(bot);
        const token = demoToken(bot.id);
        tokens.set(bot.id, token);
        return { bot, token };
      }
      case "honk.bot.update": {
        const bot = bots.find((b) => b.id === a.botId)!;
        Object.assign(bot, { name: a.name ?? bot.name, avatar: a.avatar ?? bot.avatar, defaultLevel: a.defaultLevel ?? bot.defaultLevel });
        return bot;
      }
      case "honk.bot.token":
        return tokens.get(a.botId) ?? null;
      case "honk.bot.resetToken": {
        const t = demoToken(a.botId);
        tokens.set(a.botId, t);
        return t;
      }
      case "honk.bot.delete":
        bots.splice(bots.findIndex((b) => b.id === a.botId), 1);
        return true;
      case "honk.bot.setMuted":
      case "honk.bot.setPinned": {
        const f = flags.get(a.botId) ?? { muted: false, pinned: false };
        if ("muted" in a) f.muted = a.muted;
        if ("pinned" in a) f.pinned = a.pinned;
        flags.set(a.botId, f);
        return true;
      }
      case "honk.message.delete":
        messages.splice(messages.findIndex((m) => m.id === a.messageId), 1);
        return true;
      case "honk.chat.clear":
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].botId === a.botId) messages.splice(i, 1);
        return true;
      default:
        return true;
    }
  })();
  return out as T;
}
