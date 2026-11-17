import { Clipboard, signal, Text, View } from "nsh";
import { AlertDialog, NavPage, Switch } from "nsh/base";
import { Avatar, Row, Section } from "../components";
import { LEVELS, levelLabel, maskToken } from "../format";
import { api, type Level } from "../host";
import { chatOf, nav, reload } from "../store";
import { palette, type Palette } from "../theme";

export function BotSettings(props: { botId: number }) {
  const p = palette;
  const chat = () => chatOf(props.botId);
  const token = signal<string | null>(null);
  const copied = signal(false);
  void api.token(props.botId).then((t) => token.set(t));

  const confirm = async (title: string, description: string, label: string) => {
    const { action } = await AlertDialog.show({
      title, description,
      actions: [{ id: "cancel", label: "取消", role: "cancel" }, { id: "ok", label, role: "destructive" }],
    });
    return action === "ok";
  };

  const resetToken = async () => {
    if (!(await confirm("重置 token？", "旧 token 立即失效，用到它的发送方需要换成新的。", "重置"))) return;
    token.set(await api.resetToken(props.botId));
    copied.set(false);
  };
  const pickLevel = async () => {
    const { action } = await AlertDialog.show({
      title: "默认提醒级别",
      presentation: "actionSheet",
      actions: [...LEVELS.map((l) => ({ id: l.id, label: l.label })), { id: "cancel", label: "取消", role: "cancel" as const }],
    });
    if (!action || action === "cancel") return;
    await api.updateBot(props.botId, { defaultLevel: action as Level });
    await reload();
  };
  const clear = async () => {
    if (!(await confirm("清空消息？", "只删除这台设备上的消息。", "清空"))) return;
    await api.clearChat(props.botId);
    await reload();
  };
  const remove = async () => {
    if (!(await confirm("删除这个 Bot？", "token 立即失效，网关队列里未拉取的消息一并删除。", "删除"))) return;
    await api.deleteBot(props.botId);
    await reload();
    nav.setRoutes([{ name: "home" }]);
  };

  return (
    <NavPage title="Bot 设置" testID="bot-settings">
      <View style={{ flex: 1, backgroundColor: p().groupedBg, gap: 20 }}>
        <View style={{ alignItems: "center", gap: 4, paddingTop: 12 }}>
          <Avatar avatar={chat()?.bot.avatar ?? ""} size={88} />
          <Text style={{ marginTop: 8, fontSize: 24, fontWeight: "700", color: p().text }}>{chat()?.bot.name ?? ""}</Text>
          <Text style={{ fontSize: 15, color: p().hint }}>{`机器人 · ID ${props.botId}`}</Text>
        </View>

        <Section title="TOKEN" p={p()}>
          <Row
            p={p()}
            first
            testID="token-row"
            label={token() ? maskToken(token()!) : "这台设备上没有保存 token"}
            onPress={token() ? () => void Clipboard.writeText(token()!).then(() => copied.set(true)) : undefined}
            right={token() ? <Text style={{ fontSize: 15, color: p().accent }}>{copied() ? "已复制" : "复制"}</Text> : undefined}
          />
          <Row p={p()} label="重置 token" color={p().accent} onPress={() => void resetToken()} testID="reset-token" />
        </Section>

        <Section title="通知" p={p()}>
          <Row p={p()} first label="默认提醒级别" value={levelLabel(chat()?.bot.defaultLevel ?? "active")} onPress={() => void pickLevel()} />
          <ToggleRow p={p()} label="静音" checked={chat()?.muted ?? false} onChange={(v) => void api.setMuted(props.botId, v).then(reload)} />
          <ToggleRow p={p()} label="置顶会话" checked={chat()?.pinned ?? false} onChange={(v) => void api.setPinned(props.botId, v).then(reload)} />
        </Section>

        <Section p={p()} footer="删除后 token 立即失效。">
          <Row p={p()} first label="清空消息" color={p().destructive} onPress={() => void clear()} />
          <Row p={p()} label="删除 Bot" color={p().destructive} onPress={() => void remove()} testID="delete-bot" />
        </Section>
      </View>
    </NavPage>
  );
}

function ToggleRow(props: { p: Palette; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ minHeight: 46, paddingLeft: 16, paddingRight: 16, flexDirection: "row", alignItems: "center", borderTopWidth: 0.5, borderTopColor: props.p.separator }}>
      <Text style={{ flex: 1, fontSize: 16, color: props.p.text }}>{props.label}</Text>
      <Switch
        checked={props.checked}
        onChange={({ checked }) => props.onChange(checked)}
        accessibilityLabel={props.label}
        trackStyle={{ width: 51, height: 31, borderRadius: 16, backgroundColor: props.checked ? props.p.good : "#e3e3e8", padding: 2 }}
        thumbStyle={{ width: 27, height: 27, borderRadius: 14, backgroundColor: "#ffffff", marginLeft: props.checked ? 20 : 0 }}
      />
    </View>
  );
}
