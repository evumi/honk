// The contract with the native hosts (ios/App/NshBridge.swift and
// android/app/src/main/kotlin/dev/evumi/honk/NshBridge.kt).
// Every call goes through `call`, which uses the demo backend when no host
// embeds the app (`nsh run` on a desktop), so the UI can be tried alone.
import { host } from "nsh";
import { demo } from "./demo";

export type Level = "passive" | "active" | "timeSensitive";

/** A bot's public id: a short random string such as `aZ3kQ9xT`, never a sequence number. */
export type BotId = string;

export interface Bot {
  id: BotId;
  name: string;
  /** `preset:<icon>:<#rrggbb>` or an https URL. */
  avatar: string;
  defaultLevel: Level;
  createdAt: number;
}

export interface Message {
  id: number;
  botId: BotId;
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
  /** Where registration with the gateway stands. */
  registration?: "registered" | "registering" | "waitingForPushToken" | "failed";
  registrationError?: string;
  /** `apns`: real pushes; `simulator`: a Debug simulator build without APNs, which polls instead. */
  pushMode?: "apns" | "simulator";
  gatewayURL: string;
  notifications: "authorized" | "denied" | "notDetermined";
  /** The installed build: marketing version and build number (from the release tag and CI run). */
  appVersion?: string;
  appBuild?: string;
}

export interface Gateway {
  url: string;
  defaultURL: string;
  custom: boolean;
}

export interface GatewayTest {
  ok: boolean;
  url?: string;
  version?: string;
  error?: string;
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
  messages: (botId: BotId, before?: number) => call<Message[]>("honk.messages", { botId, before, limit: 50 }),
  markRead: (botId: BotId) => call<boolean>("honk.markRead", { botId }),
  focus: (botId: BotId | null) => call<boolean>("honk.focus", { botId }),
  refresh: () => call<boolean>("honk.refresh"),
  createBot: (name: string, avatar: string, defaultLevel: Level) =>
    call<{ bot: Bot; token: string }>("honk.bot.create", { name, avatar, defaultLevel }),
  updateBot: (botId: BotId, fields: { name?: string; avatar?: string; defaultLevel?: Level }) =>
    call<Bot>("honk.bot.update", { botId, ...fields }),
  token: (botId: BotId) => call<string | null>("honk.bot.token", { botId }),
  resetToken: (botId: BotId) => call<string>("honk.bot.resetToken", { botId }),
  deleteBot: (botId: BotId) => call<boolean>("honk.bot.delete", { botId }),
  setMuted: (botId: BotId, muted: boolean) => call<boolean>("honk.bot.setMuted", { botId, muted }),
  setPinned: (botId: BotId, pinned: boolean) => call<boolean>("honk.bot.setPinned", { botId, pinned }),
  deleteMessage: (messageId: number) => call<boolean>("honk.message.delete", { messageId }),
  clearChat: (botId: BotId) => call<boolean>("honk.chat.clear", { botId }),
  openNotificationSettings: () => call<boolean>("honk.notifications.open"),
  /** Asks for a push token again and registers; resolves with the new status. */
  retryRegistration: () => call<Status>("honk.register.retry"),
  gateway: () => call<Gateway>("honk.gateway.get"),
  testGateway: (url: string) => call<GatewayTest>("honk.gateway.test", { url }),
  /** `null`: back to the build's default gateway. Clears this device's bots and messages. */
  setGateway: (url: string | null) => call<{ url: string; registered: boolean }>("honk.gateway.set", { url }),
};
