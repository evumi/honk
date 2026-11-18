// Exporting and importing messages: the host does the share sheet and the file
// picker (nsh has neither); these wrap them with the dialogs that report back.
import { AlertDialog } from "nsh/base";
import { api, type BotId, type ImportResult, type Retention } from "./host";
import { tr } from "./i18n";

async function notice(title: string, description?: string) {
  await AlertDialog.show({ title, description, actions: [{ id: "ok", label: tr("好") }] });
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Exports one chat's messages, or every chat's without `botId`, through the system share sheet. */
export async function exportMessages(botId?: BotId) {
  try {
    const r = await api.exportMessages(botId);
    if (r.count === 0) await notice(tr("没有可导出的消息"));
  } catch (e) {
    await notice(tr("导出失败"), reason(e));
  }
}

/** What an import did, in words. */
export function importSummary(r: ImportResult): string {
  const lines = [tr("新增 {n} 条消息。", { n: r.imported })];
  if (r.existing > 0) lines.push(tr("{n} 条已经在这台设备上。", { n: r.existing }));
  if (r.unknownBot > 0) lines.push(tr("{n} 条属于这台设备上没有的 Bot，已跳过。", { n: r.unknownBot }));
  if (r.invalid > 0) lines.push(tr("{n} 行无法读取。", { n: r.invalid }));
  return lines.join("\n");
}

/** Picks a JSON Lines file exported earlier and adds its messages. */
export async function importMessages() {
  try {
    const r = await api.importMessages();
    if (r) await notice(tr("导入完成"), importSummary(r));
  } catch (e) {
    await notice(tr("导入失败"), reason(e));
  }
}

export const RETENTIONS: { days: Retention; label: () => string }[] = [
  { days: 0, label: () => tr("永久") },
  { days: 365, label: () => tr("1 年") },
  { days: 90, label: () => tr("90 天") },
  { days: 30, label: () => tr("30 天") },
];

export function retentionLabel(days: Retention): string {
  return RETENTIONS.find((r) => r.days === days)?.label() ?? tr("永久");
}

/** Whether `next` deletes messages that `current` still keeps. */
export function shortens(current: Retention, next: Retention): boolean {
  return next !== 0 && (current === 0 || next < current);
}

/** Asks how long to keep messages, confirms when that deletes some, and applies it. Resolves with the period now in force. */
export async function chooseRetention(current: Retention): Promise<Retention> {
  const { action } = await AlertDialog.show({
    title: tr("保留期限"),
    presentation: "actionSheet",
    actions: [...RETENTIONS.map((r) => ({ id: String(r.days), label: r.label() })), { id: "cancel", label: tr("取消"), role: "cancel" as const }],
  });
  const next = RETENTIONS.find((r) => String(r.days) === action)?.days;
  if (next === undefined || next === current) return current;
  if (shortens(current, next)) {
    const ok = await AlertDialog.show({
      title: tr("只保留最近 {period}？", { period: retentionLabel(next) }),
      description: tr("这台设备上更早的消息会立即删除，无法恢复。网关上的消息不受影响。"),
      actions: [{ id: "cancel", label: tr("取消"), role: "cancel" }, { id: "delete", label: tr("删除"), role: "destructive" }],
    });
    if (ok.action !== "delete") return current;
  }
  try {
    return await api.setRetention(next);
  } catch (e) {
    await notice(tr("无法更改"), reason(e));
    return current;
  }
}
