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

// A card with a script (profile 2): a CPU chart that switches between 1 h and
// 24 h, a live "for N min" counter and a button that copies the SSH command.
// The phone apps run it in QuickJS (native/card); without a host (`nsh run`
// on a desktop) and in older apps it shows the static part with its data.
const alertCard = `<div style="padding:4px 0">
<div style="display:flex;align-items:center;justify-content:space-between">
<h3 style="margin:0">{{host}}</h3>
<span style="padding:2px 10px;border-radius:999px;background:#d9480f;color:#fff;font-size:13px">CPU {{cpu_now}}%</span>
</div>
<p style="margin:4px 0 10px;color:var(--tg-theme-hint-color)">${L("超过阈值", "Above the threshold for")} <span id="dur">{{minutes}} ${L("分钟", "min")}</span> · ${L("阈值", "threshold")} 85%</p>
<div id="bars" style="display:flex;align-items:flex-end;gap:3px;height:64px"></div>
<p id="range" style="margin:6px 0 0;font-size:12px;color:var(--tg-theme-hint-color)"></p>
<div style="display:flex;gap:8px">
<button id="toggle" style="flex:1">${L("看 24 小时", "Show 24 h")}</button>
<button id="copy" style="flex:1;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)">${L("复制 SSH", "Copy SSH")}</button>
</div>
<script>
var d = JSON.parse(TelegramWidget.chatData || "{}");
var range = "1h";
var labels = { "1h": "${L("过去 1 小时，每 5 分钟", "Last hour, every 5 min")}", "24h": "${L("过去 24 小时，每 2 小时", "Last 24 h, every 2 h")}" };
function draw() {
  var series = range === "1h" ? d.cpu : d.cpu24;
  document.getElementById("bars").replaceChildren(...series.map(function (v) {
    var b = document.createElement("div");
    b.style.cssText = "flex:1;border-radius:2px;height:" + Math.round(v * 0.64) + "px;background:" + (v >= 85 ? "#d9480f" : "var(--tg-theme-hint-color)");
    return b;
  }));
  document.getElementById("range").textContent = labels[range];
  document.getElementById("toggle").textContent = range === "1h" ? "${L("看 24 小时", "Show 24 h")}" : "${L("看 1 小时", "Show 1 h")}";
}
function tick() {
  var m = Math.max(0, Math.floor((Date.now() - d.since) / 60000));
  document.getElementById("dur").textContent = m + " ${L("分钟", "min")}";
}
document.getElementById("toggle").addEventListener("click", function () { range = range === "1h" ? "24h" : "1h"; draw(); });
document.getElementById("copy").addEventListener("click", function () { TelegramWidget.copyText(d.ssh); });
draw();
tick();
setInterval(tick, 1000);
</script>
</div>`;

// A card written as for a Telegram widget: classes and a <style> block, theme
// variables, dark-mode media, and {{status}} in a class that shows or hides
// the failures.
const ciCard = `<style>
:root { --ok: #1a9e6e; --bad: #d9480f }
.ci .head { display: flex; align-items: center; justify-content: space-between }
.ci h3 { margin: 0 }
.pill { padding: 2px 10px; border-radius: 999px; color: #fff; font-size: 13px }
.status-passed .pill { background: var(--ok) }
.status-failed .pill { background: var(--bad) }
.meta { margin: 4px 0 10px; color: var(--tg-theme-hint-color) }
.stats { display: flex; gap: 8px }
.stat { flex: 1; padding: 8px 10px; border-radius: 10px; background: var(--tg-theme-secondary-bg-color) }
.stat b { font-size: 18px }
.stat .label { display: block; font-size: 12px; color: var(--tg-theme-hint-color) }
.failures { display: none; margin-top: 10px; padding: 2px 10px; border-left: 3px solid var(--bad) }
.status-failed .failures { display: block }
.failures code { font-size: 12px }
@media (prefers-color-scheme: dark) { :root { --ok: #34c08a; --bad: #ff6b3d } }
</style>
<div class="ci status-{{status}}">
<div class="head"><h3>{{repo}} #{{run}}</h3><span class="pill">{{status_label}}</span></div>
<p class="meta">{{branch}} · {{duration}}</p>
<div class="stats">
<div class="stat"><b>{{passed}}</b><span class="label">${L("通过", "passed")}</span></div>
<div class="stat"><b>{{failed}}</b><span class="label">${L("失败", "failed")}</span></div>
<div class="stat"><b>{{skipped}}</b><span class="label">${L("跳过", "skipped")}</span></div>
</div>
<div class="failures"><p style="margin:4px 0">${L("失败的测试", "Failing tests")}</p><code>{{failing}}</code></div>
</div>`;

// An analytics report with its visitor trend as inline SVG (fixed colours, so
// it reads in light and dark), as Evumi sends it.
const trendCard = `<div style="padding:4px 0">
<p style="margin:0;font-size:13px;color:var(--tg-theme-hint-color)">{{site}} · ${L("过去 24 小时", "Last 24 hours")}</p>
<div style="display:flex;align-items:baseline;gap:8px;margin:2px 0 8px"><h2 style="margin:0">{{visitors}}</h2><span style="color:#1a9e6e;font-size:13px">▲ {{change}}</span></div>
<svg viewBox="0 0 320 112" width="100%" height="112" preserveAspectRatio="none"><path d="M0 2H320" stroke="#8e8e93" stroke-opacity="0.3"/><path d="M0 90L40 60L80 70L120 20L160 40L200 10L240 50L280 30L320 80" fill="none" stroke="#6366f1" stroke-width="2"/><path d="M0 90L40 60L80 70L120 20L160 40L200 10L240 50L280 30L320 80L320 110L0 110Z" fill="#6366f1" fill-opacity="0.1"/></svg>
<p style="margin:8px 0 0;font-size:13px;color:var(--tg-theme-hint-color)">${L("访客", "Visitors")} · ${L("高峰", "peak")} {{peak}}</p>
</div>`;

const bots: Bot[] = [
  { id: "Bx7kQ2mT", name: L("Berth 部署", "Berth Deploys"), avatar: "preset:box:#1c1c1e", defaultLevel: "active", createdAt: now - 864e5 * 5, encrypted: false },
  { id: "aR4nW9pZ", name: L("服务器告警", "Server Alerts"), avatar: "preset:alert:#c2410c", defaultLevel: "timeSensitive", createdAt: now - 864e5 * 4, encrypted: false },
  { id: "Kc3vH8sL", name: L("CI 构建", "CI Builds"), avatar: "preset:check:#2f6f3e", defaultLevel: "active", createdAt: now - 864e5 * 3, encrypted: false },
  { id: "Ev5tR2nD", name: L("Evumi 报告", "Evumi Reports"), avatar: "preset:chart:#6366f1", defaultLevel: "active", createdAt: now - 864e5 * 2, encrypted: false },
];

let nextId = 100;
const msg = (botId: string, minutesAgo: number, m: Partial<Message>): Message => ({
  id: nextId++, botId, title: "", body: "", html: "", data: "", level: "active", group: "", url: "", copy: "",
  icon: "", open: "", image: "", parseMode: "", silent: false, collapseId: "", allowQueries: false, date: now - minutesAgo * 6e4, read: false, ...m,
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
  // Added after the first cards, so the ids above stay as tests know them.
  // parse_mode=Markdown, an https link in a plain body, and an image.
  msg("Kc3vH8sL", 20, {
    title: L("main #483 构建完成", "main #483 built"), parseMode: "Markdown", url: "https://example.com/builds/483", open: "url",
    body: L(
      "**128 个测试通过**，耗时 *3 分 12 秒*\n\n- 产物：`app-release.apk`\n- 日志：[查看详情](https://example.com/builds/483)\n\n```\nmake test\n```",
      "**128 tests passed** in *3m 12s*\n\n- Artifact: `app-release.apk`\n- Log: [details](https://example.com/builds/483)\n\n```\nmake test\n```",
    ),
  }),
  msg("aR4nW9pZ", 15, {
    title: L("hk-edge-02 已恢复", "hk-edge-02 recovered"), image: "https://picsum.photos/seed/honk/640/360",
    body: L("负载回落到 1.2，详见 https://status.example.com/hk-edge-02。", "Load back to 1.2, see https://status.example.com/hk-edge-02."),
  }),
  msg("Kc3vH8sL", 50, {
    title: L("main #483 失败", "main #483 failed"), body: L("2 个测试失败，点开看是哪些。", "2 tests failed; open to see which."), html: ciCard,
    data: JSON.stringify({
      repo: "evumi/honk", run: 483, branch: "main", duration: L("3 分 41 秒", "3m 41s"), status: "failed", status_label: L("失败", "Failed"),
      passed: 126, failed: 2, skipped: 3, failing: "widget › css cascade, sync › ack after edit",
    }),
  }),
  msg("aR4nW9pZ", 12, {
    title: "hk-edge-02 CPU 96%", body: L("持续超过阈值 85%，点开看负载曲线。", "Above the 85% threshold; open for the load chart."), html: alertCard,
    data: JSON.stringify({
      host: "hk-edge-02", cpu_now: 96, minutes: 17, since: now - 17 * 6e4, ssh: "ssh ops@hk-edge-02.example.com",
      cpu: [41, 44, 52, 58, 63, 71, 79, 86, 91, 94, 92, 96],
      cpu24: [22, 18, 15, 14, 19, 33, 47, 52, 49, 61, 78, 96],
    }),
  }),
  msg("Ev5tR2nD", 140, {
    title: L("evumi.com 日报", "evumi.com daily report"), body: L("过去 24 小时 1,284 位访客，比前一天多 18%。", "1,284 visitors in the last 24 hours, up 18% on the day before."), html: trendCard, read: true,
    data: JSON.stringify({ site: "evumi.com", visitors: "1,284", change: "18%", peak: "14:00" }),
  }),
];
const DEFAULT_GATEWAY = "https://honk.example.com/";
// The device group: this phone and, in the demo, one other.
const groupDevices = [
  { id: "demo-this", name: "iPhone", platform: "ios" as const, seenAt: Date.now(), current: true },
  { id: "demo-other", name: "Pixel 8", platform: "android" as const, seenAt: Date.now() - 5 * 36e5, current: false },
];
let linkCode = "";
const CODE_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let gateway = DEFAULT_GATEWAY;
let registerKey = "";

function normalize(u: string): string | null {
  let t = u.trim();
  if (!t) return null;
  if (!t.includes("://")) t = "https://" + t;
  if (!/^https?:\/\/[^/\s?#]+/i.test(t) || /[?#]/.test(t)) return null;
  return t.endsWith("/") ? t : t + "/";
}

/** How long messages are kept, in days (0: forever); the demo prunes at once, as the hosts do. */
let retentionDays = 0;

const localAvatars = new Map<string, string>();
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

/** The demo's per-bot end-to-end keys (no gateway here; the real ones live in the keychain / keystore). */
const keys = new Map<string, string>();

/** A key shaped like the app's: 32 bytes as 43 unpadded base64url characters. */
function demoKey(): string {
  return randomString(LETTERS + "0123456789-_", 42) + "A";
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
        return { url: gateway, defaultURL: DEFAULT_GATEWAY, custom: gateway !== DEFAULT_GATEWAY, registerKey };
      case "honk.gateway.test": {
        const url = normalize(String(a.url ?? ""));
        if (!url) return { ok: false, error: L("地址无效：需要 http:// 或 https:// 开头的网址", "Not a valid address: it needs http:// or https://") };
        if (url.includes("bad")) return { ok: false, error: L("无法连接到这个地址", "Can't reach this address") };
        return {
          ok: true, url, version: "0.1.0", registerKeyRequired: url.includes("locked"),
          push: url.includes("off") ? { ios: "off", android: "off" } : url.includes("relay") ? { ios: "relay", android: "relay" } : { ios: "direct", android: "direct" },
        };
      }
      case "honk.gateway.set": {
        const target = a.url ? normalize(String(a.url)) ?? gateway : DEFAULT_GATEWAY;
        registerKey = String(a.registerKey ?? "");
        if (target === gateway) return { url: gateway, registered: true };
        gateway = target;
        bots.splice(0, bots.length);
        messages.splice(0, messages.length);
        return { url: gateway, registered: true };
      }
      case "honk.devices.list":
        return groupDevices.map((d) => ({ ...d }));
      case "honk.devices.remove": {
        const i = groupDevices.findIndex((d) => d.id === a.deviceId);
        if (i < 0) return true; // already gone
        if (groupDevices[i].current) {
          // Leaving the group: this phone starts over on its own.
          groupDevices.splice(0, groupDevices.length, { id: "demo-this", name: "iPhone", platform: "ios", seenAt: Date.now(), current: true });
          bots.splice(0, bots.length);
          messages.splice(0, messages.length);
          tokens.clear();
          flags.clear();
        } else {
          groupDevices.splice(i, 1);
        }
        return true;
      }
      case "honk.link.create": {
        const raw = Array.from({ length: 26 }, () => CODE_CHARS[Math.floor(Math.random() * 32)]).join("");
        linkCode = raw;
        return { code: raw.match(/.{1,4}/g)!.join("-"), expiresAt: Date.now() + 10 * 6e4 };
      }
      case "honk.link.claim": {
        const code = String(a.code ?? "").toUpperCase().replace(/[\s-]/g, "");
        if (code.length !== 26 || (linkCode !== "" && code !== linkCode && code !== "000G40R40M30E209185GR38E1W")) {
          throw new Error(L("配对码不对、已过期或已用过", "The pairing code is wrong, expired or already used"));
        }
        linkCode = "";
        if (!groupDevices.some((d) => d.id === "demo-other")) {
          groupDevices.push({ id: "demo-other", name: "Pixel 8", platform: "android", seenAt: Date.now(), current: false });
        }
        return true;
      }
      case "honk.device.delete":
        groupDevices.splice(0, groupDevices.length, { id: "demo-this", name: "iPhone", platform: "ios", seenAt: Date.now(), current: true });
        bots.splice(0, bots.length);
        messages.splice(0, messages.length);
        tokens.clear();
        flags.clear();
        localAvatars.clear();
        return true;
      case "honk.chats":
        return chats();
      case "honk.messages": {
        const own = messages.filter((m) => m.botId === a.botId).sort((x, y) => y.id - x.id);
        const limit = a.limit ?? 50;
        if (a.around != null && own.some((m) => m.id === a.around)) {
          // About half newer, the rest older, as the hosts' window.
          const newer = own.filter((m) => m.id > a.around).slice(-Math.floor(limit / 2));
          return [...newer, ...own.filter((m) => m.id <= a.around).slice(0, limit - newer.length)];
        }
        return own.filter((m) => a.around != null || a.before == null || m.id < a.before).slice(0, limit);
      }
      case "honk.search": {
        const q = String(a.query ?? "").trim().toLowerCase();
        if (!q) return [];
        return messages
          .filter((m) => (a.before == null || m.id < a.before) && `${m.title}\n${m.body}`.toLowerCase().includes(q))
          .sort((x, y) => y.id - x.id)
          .slice(0, 50);
      }
      case "honk.retention.get":
        return retentionDays;
      case "honk.retention.set": {
        retentionDays = Number(a.days) || 0;
        if (retentionDays > 0) {
          const cutoff = Date.now() - retentionDays * 86_400_000;
          for (let i = messages.length - 1; i >= 0; i--) if (messages[i].date < cutoff) messages.splice(i, 1);
        }
        return retentionDays;
      }
      // There is no share sheet or file picker without a host: exporting counts what it would write, importing is cancelled.
      case "honk.export":
        return { count: messages.filter((m) => a.botId == null || m.botId === a.botId).length, shared: false };
      case "honk.import":
        return null;
      case "honk.markRead":
        messages.forEach((m) => m.botId === a.botId && (m.read = true));
        return true;
      case "honk.avatar.save": {
        const ext = ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[a.type] ?? "jpg";
        const avatar = `local:demo${localAvatars.size + 1}.${ext}`;
        localAvatars.set(avatar, `data:${a.type};base64,${a.data}`);
        return avatar;
      }
      case "honk.avatar.image":
        return localAvatars.get(a.avatar) ?? null;
      case "honk.bot.create": {
        const bot: Bot = { id: demoBotId(), name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel, createdAt: Date.now(), encrypted: false };
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
      case "honk.bot.encryption.key":
        return keys.get(a.botId) ?? null;
      case "honk.bot.encryption.enable": {
        // The real hosts refuse when the bot is encrypted at the gateway but its key has not reached this device.
        if (!keys.has(a.botId)) keys.set(a.botId, demoKey());
        const bot = bots.find((b) => b.id === a.botId);
        if (bot) bot.encrypted = true;
        return keys.get(a.botId)!;
      }
      case "honk.bot.encryption.resetKey": {
        const k = demoKey();
        keys.set(a.botId, k);
        return k;
      }
      case "honk.bot.encryption.disable": {
        keys.delete(a.botId);
        const bot = bots.find((b) => b.id === a.botId);
        if (bot) bot.encrypted = false;
        return true;
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
