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

/** `7351902846:bQx9••••••••JdG`. */
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
