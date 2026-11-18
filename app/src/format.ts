import { lang, tr } from "./i18n";

const WEEKDAYS = {
  zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** The chat list's time: 16:17 today, 周四 within a week, 11/09 before that. */
export function listTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= today.getTime() - 6 * 864e5) return WEEKDAYS[lang()][d.getDay()];
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A day chip: 今天, 昨天, or 11月9日. */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return tr("今天");
  if (ms >= today.getTime() - 864e5) return tr("昨天");
  return lang() === "zh" ? `${d.getMonth() + 1}月${d.getDate()}日` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** How long ago a device was last seen: 刚刚, 5 小时前, 3 天前 (the gateway writes it at most hourly). */
export function lastSeen(ms: number, now = Date.now()): string {
  if (ms <= 0) return tr("从未");
  const minutes = Math.floor((now - ms) / 6e4);
  if (minutes < 60) return tr("刚刚");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr("{n} 小时前", { n: hours });
  return tr("{n} 天前", { n: Math.floor(hours / 24) });
}

/** `aZ3kQ9xT:bQx9••••••••JdG`. */
export function maskToken(t: string): string {
  const i = t.indexOf(":");
  if (i < 0 || t.length - i < 10) return t;
  return `${t.slice(0, i + 5)}••••••••${t.slice(-3)}`;
}

export const LEVELS = [
  { id: "passive", label: "静默" },
  { id: "active", label: "普通" },
  { id: "timeSensitive", label: "时效性" },
] as const;

export function levelLabel(l: string): string {
  return tr(LEVELS.find((x) => x.id === l)?.label ?? "普通");
}

/** The curl example for a bot. */
export function curlExample(gateway: string, token: string): string {
  const base = gateway.endsWith("/") ? gateway : gateway + "/";
  return `curl ${base}bot${token}/sendMessage \\\n  -d title="${tr("部署成功")}" \\\n  -d body="${tr("evumi / sluice 已上线")}"`;
}

/** A count as a badge shows it: past 99 it reads "99+". */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/**
 * A device joined the group: a successfully fetched list holds an id a successfully fetched baseline
 * lacks. A failed fetch (null) never counts, so an unknown baseline cannot make this phone look new.
 */
export function deviceJoined(baseline: { id: string }[] | null, list: { id: string }[] | null): boolean {
  if (!baseline || !list) return false;
  const known = new Set(baseline.map((d) => d.id));
  return list.some((d) => !known.has(d.id));
}
