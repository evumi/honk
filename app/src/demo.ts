// An in-memory stand-in for the native host, used when the app runs without
// one (`nsh run App.tsx` on a desktop). Same names and shapes as NshBridge.
import type { Bot, Chat, Message } from "./host";

const now = Date.now();
const card = `<div style="padding:4px 0">
<span style="display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;border:1px solid var(--tg-theme-section-separator-color)"><span style="width:8px;height:8px;border-radius:4px;background:{{dot}}"></span><span>{{status}}</span></span>
<h3 style="margin:12px 0 2px">{{service}}</h3>
<p style="margin:0;color:var(--tg-theme-hint-color)">部署 · {{env}}</p>
<hr>
<p><span style="color:var(--tg-theme-hint-color)">部署 ID</span>  <code>{{deploy_id}}</code></p>
<a href="{{url}}" style="display:block;padding:12px;border-radius:12px;background:#111;color:#fff;text-align:center">在 Berth 中查看</a>
</div>`;

const bots: Bot[] = [
  { id: 1, name: "Berth 部署", avatar: "preset:ship:#1c1c1e", defaultLevel: "active", createdAt: now - 864e5 * 5 },
  { id: 2, name: "服务器告警", avatar: "preset:alert:#c2410c", defaultLevel: "timeSensitive", createdAt: now - 864e5 * 4 },
  { id: 3, name: "CI 构建", avatar: "preset:check:#2f6f3e", defaultLevel: "active", createdAt: now - 864e5 * 3 },
];

let nextId = 100;
const msg = (botId: number, minutesAgo: number, m: Partial<Message>): Message => ({
  id: nextId++, botId, title: "", body: "", html: "", data: "", level: "active", group: "", url: "", copy: "",
  icon: "", collapseId: "", date: now - minutesAgo * 6e4, read: false, ...m,
});

const messages: Message[] = [
  msg(3, 60 * 30, { title: "main #482 通过", body: "3 分 12 秒 · 128 个测试全部通过", read: true }),
  msg(1, 95, {
    title: "部署失败", body: "fluxship / queue 未通过健康检查，已自动回滚。", html: card, read: true,
    data: JSON.stringify({ status: "部署失败", dot: "#d9480f", service: "fluxship / queue", env: "production", deploy_id: "dep_r8kq2", url: "https://example.com" }),
  }),
  msg(2, 75, { title: "hk-edge-02 CPU 92%", body: "持续 5 分钟超过阈值 85%，负载 7.8。" }),
  msg(1, 38, {
    title: "部署成功", body: "部署成功：sub2api / sluice (production) 已上线。", html: card,
    data: JSON.stringify({ status: "已上线", dot: "#1a9e6e", service: "sub2api / sluice", env: "production", deploy_id: "dep_w3tn2cnlrvwtspmjmpol", url: "https://example.com" }),
  }),
  msg(1, 25, { title: "每日部署汇总", body: "今天共 6 次部署，5 次成功，1 次回滚。" }),
];
const flags = new Map<number, { muted: boolean; pinned: boolean }>();
const tokens = new Map<number, string>([[1, "1:bQx9fK2mT4vLr8Wz1pYs6NcHa3Ue0JdG"]]);

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
        return { registered: true, gatewayURL: "http://127.0.0.1:8080/", notifications: "authorized" };
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
        const bot: Bot = { id: bots.length + 1, name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel, createdAt: Date.now() };
        bots.push(bot);
        const token = `${bot.id}:demo${Math.random().toString(36).slice(2, 14)}`;
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
        const t = `${a.botId}:demo${Math.random().toString(36).slice(2, 14)}`;
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
