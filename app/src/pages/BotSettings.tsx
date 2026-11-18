import { Clipboard, effect, signal, Text, View } from "nsh";
import { AlertDialog, NavPage, Switch } from "nsh/base";
import { Avatar, FormBody, Icon, Row, Section } from "../components";
import { LEVELS, levelLabel, maskToken } from "../format";
import { exportMessages } from "../archive";
import { api, type Level } from "../host";
import { chatOf, nav, reload, version } from "../store";
import { palette, type Palette } from "../theme";
import { tr } from "../i18n";

export function BotSettings(props: { botId: string }) {
  const p = palette;
  const chat = () => chatOf(props.botId);
  const token = signal<string | null>(null);
  const copied = signal(false);
  void api.token(props.botId).then((t) => token.set(t));
  // End-to-end encryption, three states: off; on with the key on this device; on at the gateway but the key has
  // not reached this device yet (it arrives from the group's other devices, never generated here).
  const key = signal<string | null>(null);
  const keyCopied = signal(false);
  const keyBusy = signal(false);
  effect(() => {
    version(); // a refresh may have brought the key
    void api.encryption.key(props.botId).then((k) => key.set(k)).catch(() => {});
  });
  const encrypted = () => chat()?.bot.encrypted ?? false;
  const waitingForKey = () => encrypted() && key() === null;
  const encryptionOn = () => key() !== null || encrypted();

  const confirm = async (title: string, description: string, label: string) => {
    const { action } = await AlertDialog.show({
      title, description,
      actions: [{ id: "cancel", label: tr("取消"), role: "cancel" }, { id: "ok", label, role: "destructive" }],
    });
    return action === "ok";
  };

  const resetToken = async () => {
    if (!(await confirm(tr("重置 token？"), tr("旧 token 立即失效，用到它的发送方需要换成新的。"), tr("重置")))) return;
    token.set(await api.resetToken(props.botId));
    copied.set(false);
  };
  const failed = (e: unknown) =>
    AlertDialog.show({
      title: tr("无法更改加密设置"),
      description: String((e as Error)?.message ?? e),
      actions: [{ id: "ok", label: tr("好") }],
    });
  const setEncryption = async (on: boolean) => {
    if (keyBusy()) return;
    if (on === encryptionOn()) return;
    if (!on && !(await confirm(tr("关闭端到端加密？"), tr("关闭后这个 Bot 可以再用明文发送，这台设备上的密钥会删除。已收到的消息不受影响。"), tr("关闭加密")))) return;
    keyBusy.set(true);
    try {
      if (on) key.set(await api.encryption.enable(props.botId));
      else {
        await api.encryption.disable(props.botId);
        key.set(null);
      }
      keyCopied.set(false);
    } catch (e) {
      await failed(e);
    } finally {
      keyBusy.set(false);
    }
  };
  const resetKey = async () => {
    if (keyBusy()) return;
    if (!(await confirm(tr("重置密钥？"), tr("旧密钥立即作废，发送方需要换成新密钥，否则新消息无法解密。已收到的消息不受影响。"), tr("重置")))) return;
    keyBusy.set(true);
    try {
      key.set(await api.encryption.resetKey(props.botId));
      keyCopied.set(false);
    } catch (e) {
      await failed(e);
    } finally {
      keyBusy.set(false);
    }
  };
  const copyKey = async () => {
    if (!key()) return;
    await Clipboard.writeText(key()!);
    keyCopied.set(true);
  };
  const pickLevel = async () => {
    const { action } = await AlertDialog.show({
      title: tr("默认提醒级别"),
      presentation: "actionSheet",
      actions: [...LEVELS.map((l) => ({ id: l.id, label: tr(l.label) })), { id: "cancel", label: tr("取消"), role: "cancel" as const }],
    });
    if (!action || action === "cancel") return;
    await api.updateBot(props.botId, { defaultLevel: action as Level });
    await reload();
  };
  const clear = async () => {
    if (!(await confirm(tr("清空消息？"), tr("只删除这台设备上的消息。"), tr("清空")))) return;
    await api.clearChat(props.botId);
    await reload();
  };
  const remove = async () => {
    if (!(await confirm(tr("删除这个 Bot？"), tr("token 立即失效，网关队列里未拉取的消息一并删除。"), tr("删除")))) return;
    await api.deleteBot(props.botId);
    await reload();
    nav.setRoutes([{ name: "home" }]);
  };

  const created = () => {
    const d = new Date(chat()?.bot.createdAt ?? Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const copyToken = async () => {
    if (!token()) return;
    await Clipboard.writeText(token()!);
    copied.set(true);
  };

  return (
    <NavPage headerVisible={false} testID="bot-settings">
      <FormBody
        p={p()}
        onBack={() => nav.pop()}
        action={{ label: tr("编辑"), onPress: () => nav.push({ name: "newBot", botId: props.botId }), testID: "edit-bot" }}
      >
        <View style={{ gap: 20, paddingBottom: 8 }}>
          <View style={{ alignItems: "center", gap: 4 }}>
            <Avatar avatar={chat()?.bot.avatar ?? ""} size={88} />
            <Text style={{ marginTop: 8, fontSize: 24, fontWeight: "700", color: p().text }}>{chat()?.bot.name ?? ""}</Text>
            <Text style={{ fontSize: 15, color: p().hint }}>{tr("机器人 · 创建于 {date}", { date: created() })}</Text>
          </View>

          <Section title="TOKEN" p={p()}>
            <Row
              p={p()}
              first
              mono={!!token()}
              testID="token-row"
              label={token() ? maskToken(token()!) : tr("这台设备上没有保存 token")}
              onPress={token() ? () => void copyToken() : undefined}
              right={token() ? <Icon name={copied() ? "check" : "copy"} color={p().accent} size={19} weight={2} /> : undefined}
            />
            <Row p={p()} label={tr("重置 token")} color={p().accent} onPress={() => void resetToken()} testID="reset-token" />
          </Section>

          <Section
            title={tr("端到端加密")}
            p={p()}
            footer={
              waitingForKey()
                ? tr("等待其他设备同步密钥：这个 Bot 已开启加密，密钥还没到这台设备。在已有密钥的设备上打开 Honk 即可。")
                : key()
                  ? tr("发送方需要 token 和这个密钥：honk send --key，或照 README 里的示例加密。网关、推送中继、苹果和谷歌都看不到通知内容。")
                  : tr("打开后，通知内容在发送方加密，只有你的设备能解开。网关、推送中继、苹果和谷歌都读不到。")
            }
          >
            <ToggleRow p={p()} first label={tr("端到端加密")} checked={encryptionOn()} onChange={(v) => void setEncryption(v)} />
            <If when={key()}>
              <View selectable testID="key-row" style={{ padding: 16, borderTopWidth: 0.5, borderTopColor: p().separator }}>
                <Text testID="e2e-key" style={{ fontFamily: "Menlo", fontSize: 14, lineHeight: 20, color: p().text }}>{key()!}</Text>
              </View>
              <Row
                p={p()}
                label={keyCopied() ? tr("已复制") : tr("复制密钥")}
                color={p().accent}
                testID="copy-key"
                onPress={() => void copyKey()}
                right={<Icon name={keyCopied() ? "check" : "copy"} color={p().accent} size={19} weight={2} />}
              />
              <Row p={p()} label={tr("重置密钥")} color={p().accent} onPress={() => void resetKey()} testID="reset-key" />
            </If>
          </Section>

          <Section title={tr("通知")} p={p()}>
            <Row p={p()} first label={tr("默认提醒级别")} value={levelLabel(chat()?.bot.defaultLevel ?? "active")} onPress={() => void pickLevel()} chevron />
            <ToggleRow p={p()} label={tr("静音")} checked={chat()?.muted ?? false} onChange={(v) => void api.setMuted(props.botId, v).then(reload)} />
          </Section>

          <Section title={tr("消息")} p={p()}>
            <ToggleRow p={p()} first label={tr("置顶会话")} checked={chat()?.pinned ?? false} onChange={(v) => void api.setPinned(props.botId, v).then(reload)} />
            <Row p={p()} label={tr("导出消息")} color={p().accent} onPress={() => void exportMessages(props.botId)} testID="export-chat" />
            <Row p={p()} label={tr("清空消息")} color={p().destructive} onPress={() => void clear()} />
          </Section>

          <Section p={p()} footer={tr("删除后 token 立即失效，网关队列里未拉取的消息一并删除。")}>
            <Row p={p()} first center label={tr("删除 Bot")} color={p().destructive} onPress={() => void remove()} testID="delete-bot" />
          </Section>
        </View>
      </FormBody>
    </NavPage>
  );
}

function ToggleRow(props: { p: Palette; label: string; checked: boolean; first?: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ minHeight: 46, paddingLeft: 16, paddingRight: 16, flexDirection: "row", alignItems: "center", borderTopWidth: props.first ? 0 : 0.5, borderTopColor: props.p.separator }}>
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
