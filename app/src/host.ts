// The contract with the native hosts (ios/App/NshBridge.swift and
// android/app/src/main/kotlin/dev/evumi/honk/NshBridge.kt). host.contract.json
// holds sample arguments and results for every call and event; host.contract.test.ts
// checks this file and demo.ts against it, HonkKit's and :core's tests check
// the native side. Change them together.
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

/** Test hook (host.contract.test.ts): sees every host call before it is made, host or not. */
export const spy: { call?: (name: string, args: unknown) => void } = {};

export function call<T>(name: string, args?: unknown): Promise<T> {
  spy.call?.(name, args ?? null);
  if (!host.available()) return demo<T>(name, args);
  return host.call<T>(name, args ?? null);
}

/**
 * Card scripts (profile 2), run by the host in a QuickJS runtime per card
 * (native/card). Strings are JSON: `load` is honk_card_open's argument, and
 * every call answers with a result {tree, prevented, open?, copy?, stopped,
 * logs}. A card's later changes (timers, promises) come as the event
 * honk.card.changed {key, result}. Without a host there are none: the demo
 * rejects, and the card stays static.
 */
export const cards = {
  open: (key: string, load: string) => {
    spy.call?.("honk.card.open", { key, load });
    return host.available() ? host.call<string>("honk.card.open", { key, load }) : Promise.reject(new Error("no host"));
  },
  click: (key: string, path: string) => {
    spy.call?.("honk.card.click", { key, path });
    return host.available() ? host.call<string>("honk.card.click", { key, path }) : Promise.reject(new Error("no host"));
  },
  set: (key: string, state: string) => {
    spy.call?.("honk.card.set", { key, state });
    return host.available() ? host.call<string>("honk.card.set", { key, state }) : Promise.reject(new Error("no host"));
  },
  close: (key: string) => {
    spy.call?.("honk.card.close", { key });
    return host.available() ? host.call<boolean>("honk.card.close", { key }) : Promise.resolve(true);
  },
};

/**
 * Listens to a host event; a no-op without a host. Events: `honk.changed`,
 * `honk.open { botId }`, `honk.incoming { botId, messageId }` (a message
 * arrived while the app is open; the app shows its own banner),
 * `honk.card.changed { key, result }` (see `cards`).
 */
export function on(event: string, listener: (payload: unknown) => void): () => void {
  if (!host.available()) return () => {};
  return host.on(event, listener);
}

/** Tells the host the app shows its own banner for `honk.incoming` (until then it shows the system's). */
export function listenIncoming(): Promise<boolean> {
  spy.call?.("honk.incoming.listen", null);
  if (!host.available()) return Promise.resolve(false);
  return host.call<boolean>("honk.incoming.listen", null).catch(() => false);
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
  /**
   * Keeps a picked image (base64 JPEG or PNG) on this phone and resolves with
   * the avatar that names it, `local:<file>`. The gateway stores only that
   * name; the image itself never leaves the phone.
   */
  saveAvatar: (data: string, type: string) => call<string>("honk.avatar.save", { data, type }),
  /** A `local:` avatar's image as a `data:` URL; `null` when the file is not on this phone. */
  avatarImage: (avatar: string) => call<string | null>("honk.avatar.image", { avatar }),
};
