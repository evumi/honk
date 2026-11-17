import { createNavStack } from "nsh/base";
import { signal } from "nsh";
import { api, on, type BotId, type Chat, type Status } from "./host";
import { reuse } from "./stable";

export type Route =
  | { name: "home" }
  | { name: "chat"; botId: BotId }
  | { name: "newBot"; botId?: BotId }
  | { name: "botCreated"; botId: BotId; token: string; botName: string; avatar: string }
  | { name: "botSettings"; botId: BotId }
  | { name: "gateway" };

export const nav = createNavStack<Route>([{ name: "home" }]);

export const chats = signal<Chat[]>([]);
export const status = signal<Status | null>(null);
/** Bumped whenever the host says the store changed; pages reload on it. */
export const version = signal(0);

export async function reload() {
  try {
    chats.set(reuse(chats(), await api.chats(), (c) => c.bot.id));
  } catch (e) {
    console.error("chats", e);
  }
  version.update((v) => v + 1);
}

export async function loadStatus() {
  try {
    status.set(await api.status());
  } catch (e) {
    console.error("status", e);
  }
}

export function chatOf(botId: BotId): Chat | undefined {
  return chats().find((c) => c.bot.id === botId);
}

let started = false;

/** Loads the first data and follows host events. */
export function start() {
  if (started) return;
  started = true;
  on("honk.changed", () => void reload());
  on("honk.open", (payload) => {
    const raw = (payload as { botId?: unknown } | null)?.botId;
    const botId = raw == null ? "" : String(raw);
    if (!botId) return;
    const top = nav.routes()[nav.routes().length - 1];
    if (top?.name === "chat" && top.botId === botId) return;
    nav.setRoutes([{ name: "home" }, { name: "chat", botId }]);
  });
  void reload();
  void loadStatus();
}
