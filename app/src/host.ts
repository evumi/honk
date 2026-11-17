// The contract with the native host (ios/App/NshBridge.swift; Android later).
// Every call goes through `call`, which uses the demo backend when no host
// embeds the app (`nsh run` on a desktop), so the UI can be tried alone.
import { host } from "nsh";
import { demo } from "./demo";

export type Level = "passive" | "active" | "timeSensitive";

export interface Bot {
  id: number;
  name: string;
  /** `preset:<icon>:<#rrggbb>` or an https URL. */
  avatar: string;
  defaultLevel: Level;
  createdAt: number;
}

export interface Message {
  id: number;
  botId: number;
  title: string;
  body: string;
  html: string;
  data: string;
  level: string;
  group: string;
  url: string;
  copy: string;
  icon: string;
  collapseId: string;
  /** Unix milliseconds. */
  date: number;
  read: boolean;
}

export interface Chat {
  bot: Bot;
  muted: boolean;
  pinned: boolean;
  unread: number;
  last: Message | null;
}

export interface Status {
  registered: boolean;
  gatewayURL: string;
  notifications: "authorized" | "denied" | "notDetermined";
}

export function call<T>(name: string, args?: unknown): Promise<T> {
  if (!host.available()) return demo<T>(name, args);
  return host.call<T>(name, args ?? null);
}

/** Listens to a host event; a no-op without a host. */
export function on(event: string, listener: (payload: unknown) => void): () => void {
  if (!host.available()) return () => {};
  return host.on(event, listener);
}

export const api = {
  status: () => call<Status>("honk.status"),
  chats: () => call<Chat[]>("honk.chats"),
  messages: (botId: number, before?: number) => call<Message[]>("honk.messages", { botId, before, limit: 50 }),
  markRead: (botId: number) => call<boolean>("honk.markRead", { botId }),
  focus: (botId: number | null) => call<boolean>("honk.focus", { botId }),
  refresh: () => call<boolean>("honk.refresh"),
  createBot: (name: string, avatar: string, defaultLevel: Level) =>
    call<{ bot: Bot; token: string }>("honk.bot.create", { name, avatar, defaultLevel }),
  updateBot: (botId: number, fields: { name?: string; avatar?: string; defaultLevel?: Level }) =>
    call<Bot>("honk.bot.update", { botId, ...fields }),
  token: (botId: number) => call<string | null>("honk.bot.token", { botId }),
  resetToken: (botId: number) => call<string>("honk.bot.resetToken", { botId }),
  deleteBot: (botId: number) => call<boolean>("honk.bot.delete", { botId }),
  setMuted: (botId: number, muted: boolean) => call<boolean>("honk.bot.setMuted", { botId, muted }),
  setPinned: (botId: number, pinned: boolean) => call<boolean>("honk.bot.setPinned", { botId, pinned }),
  deleteMessage: (messageId: number) => call<boolean>("honk.message.delete", { messageId }),
  clearChat: (botId: number) => call<boolean>("honk.chat.clear", { botId }),
  openNotificationSettings: () => call<boolean>("honk.notifications.open"),
};
