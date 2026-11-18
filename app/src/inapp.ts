// In-app notifications: while the app is open, the host sends
// `honk.incoming` instead of showing the system banner, and the app shows
// its own (InAppBanner). A new message replaces the one shown; from the same
// bot it counts up ("3 条新消息"), from another a layer peeks out below.
import { signal } from "nsh";
import { api, type BotId } from "./host";
import { chatOf, nav, reload } from "./store";

export interface Banner {
  /** Changes with every message shown, so the banner can animate it in. */
  key: number;
  botId: BotId;
  name: string;
  avatar: string;
  title: string;
  body: string;
  count: number;
  timeSensitive: boolean;
  /** Another bot's banner was showing: a layer peeks out below. */
  stacked: boolean;
}

export const banner = signal<Banner | null>(null);
let key = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The messages the banner shown counts. */
const counted = new Set<number>();

/** How long a banner stays, in ms. */
export const SHOW_MS = 4000;
export const SHOW_TIME_SENSITIVE_MS = 8000;

/** A message arrived while the app is open. */
export async function incoming(botId: BotId, messageId: number): Promise<void> {
  // A message already counted (re-presented, or updated in place) changes nothing.
  if (counted.has(messageId)) return;
  // The host announced the change too, which reloads the chats; only wait for
  // a reload when this message isn't in them yet.
  let chat = chatOf(botId);
  if (chat?.last?.id !== messageId) {
    await reload();
    chat = chatOf(botId);
  }
  // Muted bots only update the list; the open chat shows the message itself.
  if (!chat || chat.muted) return;
  const top = nav.routes()[nav.routes().length - 1];
  if (top?.name === "chat" && top.botId === botId) return;
  let m = chat.last?.id === messageId ? chat.last : undefined;
  if (!m) m = (await api.messages(botId).catch(() => [])).find((x) => x.id === messageId);
  if (!m) return;
  const prev = banner();
  if (!prev || prev.botId !== botId) counted.clear();
  counted.add(messageId);
  const timeSensitive = m.level === "timeSensitive";
  banner.set({
    key: ++key,
    botId,
    name: chat.bot.name,
    avatar: m.icon || chat.bot.avatar,
    title: m.title,
    body: m.body,
    count: prev && prev.botId === botId ? prev.count + 1 : 1,
    timeSensitive,
    stacked: !!prev && prev.botId !== botId,
  });
  clearTimeout(timer);
  timer = setTimeout(() => dismissBanner(), timeSensitive ? SHOW_TIME_SENSITIVE_MS : SHOW_MS);
}

/** Hides the banner (timeout, swipe up, or opened). */
export function dismissBanner(): void {
  clearTimeout(timer);
  counted.clear();
  banner.set(null);
}

/** Opens the banner's chat. */
export function openBanner(): void {
  const b = banner();
  dismissBanner();
  if (b) nav.setRoutes([{ name: "home" }, { name: "chat", botId: b.botId }]);
}
