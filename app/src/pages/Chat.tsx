import { Clipboard, cleanup, List, openUrl, signal, Text, View, effect, safeArea } from "nsh";
import { AlertDialog, NavPage } from "nsh/base";
import { Avatar } from "../components";
import { clock, dayLabel, sameDay } from "../format";
import { api, type Message } from "../host";
import { chatOf, nav, reload, version } from "../store";
import { palette, type Palette } from "../theme";
import { Widget } from "../widget/Widget";

export function ChatPage(props: { botId: number }) {
  const p = palette;
  const messages = signal<Message[]>([]); // oldest first
  const chat = () => chatOf(props.botId);
  let loadingOlder = false;
  let reachedStart = false;

  const load = async () => {
    const latest = await api.messages(props.botId);
    messages.set([...latest].reverse());
    reachedStart = latest.length < 50;
    await api.markRead(props.botId);
  };
  const loadOlder = async () => {
    if (loadingOlder || reachedStart || messages().length === 0) return;
    loadingOlder = true;
    const older = await api.messages(props.botId, messages()[0].id);
    reachedStart = older.length < 50;
    messages.set([...older.reverse(), ...messages()]);
    loadingOlder = false;
  };

  // Reload when the host reports a change (a push arrived, an edit landed).
  effect(() => {
    version();
    void load();
  });
  void api.focus(props.botId);
  cleanup(() => {
    void api.focus(null);
    void reload();
  });

  const toggleMute = async () => {
    await api.setMuted(props.botId, !chat()?.muted);
    await reload();
  };

  return (
    <NavPage headerVisible={false} testID="chat">
      <View style={{ flex: 1, backgroundColor: p().chatWall }}>
        <List
          each={messages()}
          keyExtractor={(m) => String(m.id)}
          initialScrollAtEnd
          onLoadMoreAtStart={() => void loadOlder()}
          style={{ flex: 1 }}
          contentStyle={{ paddingTop: safeArea().top + 60, paddingBottom: safeArea().bottom + 76, paddingLeft: 12, paddingRight: 12, gap: 10 } as never}
          empty={
            <View style={{ alignItems: "center", paddingTop: 200 }}>
              <Text style={{ fontSize: 15, color: p().hint }}>还没有消息。用 token 发一条试试。</Text>
            </View>
          }
        >
          {(m, i) => (
            <View style={{ gap: 10 }}>
              <If when={i() === 0 || !sameDay(messages()[i() - 1]?.date ?? 0, m().date)}>
                <DayChip ms={m().date} />
              </If>
              <Bubble message={m()} p={p()} />
            </View>
          )}
        </List>

        <TopBar botId={props.botId} p={p()} />

        <View
          style={{
            position: "absolute", left: 12, right: 12, bottom: safeArea().bottom + 8,
            flexDirection: "row", gap: 10,
          }}
        >
          <View
            testID="mute"
            role="button"
            onPress={() => void toggleMute()}
            activeStyle={{ opacity: 0.7 }}
            style={{ flex: 1, height: 52, borderRadius: 26, backgroundColor: p().glass, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 16, color: p().text }}>{chat()?.muted ? "取消静音" : "静音通知"}</Text>
          </View>
          <View
            testID="open-settings"
            role="button"
            onPress={() => nav.push({ name: "botSettings", botId: props.botId })}
            activeStyle={{ opacity: 0.7 }}
            style={{ flex: 1, height: 52, borderRadius: 26, backgroundColor: p().glass, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 16, color: p().text }}>Token 与设置</Text>
          </View>
        </View>
      </View>
    </NavPage>
  );
}

function TopBar(props: { botId: number; p: Palette }) {
  const chat = () => chatOf(props.botId);
  return (
    <View
      style={{
        position: "absolute", left: 12, right: 12, top: safeArea().top + 4,
        flexDirection: "row", alignItems: "center", gap: 10,
      }}
    >
      <View
        role="button"
        accessibilityLabel="返回"
        onPress={() => nav.pop()}
        activeStyle={{ opacity: 0.7 }}
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: props.p.glass, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ fontSize: 22, color: props.p.text }}>‹</Text>
      </View>
      <View style={{ flex: 1, height: 44, borderRadius: 22, backgroundColor: props.p.glass, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: props.p.text, numberOfLines: 1 }}>{chat()?.bot.name ?? ""}</Text>
        <Text style={{ fontSize: 12, color: props.p.hint }}>{chat()?.muted ? "机器人 · 已静音" : "机器人"}</Text>
      </View>
      <View
        role="button"
        accessibilityLabel="Bot 设置"
        onPress={() => nav.push({ name: "botSettings", botId: props.botId })}
      >
        <Avatar avatar={chat()?.bot.avatar ?? ""} size={44} />
      </View>
    </View>
  );
}

function DayChip(props: { ms: number }) {
  return (
    <View style={{ alignSelf: "center", paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, borderRadius: 12, backgroundColor: "rgba(40,70,40,0.28)" }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: "#ffffff" }}>{dayLabel(props.ms)}</Text>
    </View>
  );
}

function Bubble(props: { message: Message; p: Palette }) {
  const m = () => props.message;
  const actions = async () => {
    const list = [{ id: "copy", label: "复制正文" }];
    if (m().copy) list.push({ id: "copyExtra", label: "复制内容" });
    if (m().url) list.push({ id: "open", label: "打开链接" });
    const { action } = await AlertDialog.show({
      presentation: "actionSheet",
      actions: [...list, { id: "delete", label: "删除", role: "destructive" as const }, { id: "cancel", label: "取消", role: "cancel" as const }],
    });
    if (action === "copy") await Clipboard.writeText(m().body);
    if (action === "copyExtra") await Clipboard.writeText(m().copy);
    if (action === "open") await openUrl(m().url).catch(() => {});
    if (action === "delete") {
      await api.deleteMessage(m().id);
      await reload();
    }
  };
  return (
    <View
      testID={`message-${m().id}`}
      onLongPress={() => void actions()}
      onPress={m().url && !m().html ? () => void openUrl(m().url).catch(() => {}) : undefined}
      style={{
        alignSelf: m().html ? "stretch" : "flex-start", maxWidth: m().html ? undefined : "85%",
        backgroundColor: props.p.bubble, borderRadius: 18, overflow: "hidden",
      }}
    >
      <If when={m().html}>
        <View style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 0.5, borderBottomColor: props.p.separator }}>
          <Widget html={m().html} data={m().data} palette={props.p} />
        </View>
      </If>
      <View style={{ paddingTop: 10, paddingBottom: 8, paddingLeft: 14, paddingRight: 14, gap: 2 }}>
        <If when={m().title && !m().html}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: props.p.text }}>{m().title}</Text>
        </If>
        <Text style={{ fontSize: 16, lineHeight: 22, color: props.p.text }}>{m().body}</Text>
        <Text style={{ alignSelf: "flex-end", fontSize: 12, color: props.p.hint }}>{clock(m().date)}</Text>
      </View>
    </View>
  );
}
