import type { ListRef } from "nsh";
import { Clipboard, cleanup, List, openUrl, signal, Text, View, effect, safeArea } from "nsh";
import { AlertDialog, NavPage } from "nsh/base";
import { Avatar, Badge, EdgeBlur, glass, Icon, TopBar } from "../components";
import { clock, dayLabel, sameDay } from "../format";
import { api, type Message } from "../host";
import { chatOf, nav, reload, version } from "../store";
import { palette, type Palette } from "../theme";
import { tr } from "../i18n";
import { Widget } from "../widget/Widget";
import { createDissolve, Dissolve } from "../fx/Dissolve";

export function ChatPage(props: { botId: string }) {
  const p = palette;
  const messages = signal<Message[]>([]); // oldest first
  const chat = () => chatOf(props.botId);
  let loadingOlder = false;
  let reachedStart = false;
  let list: ListRef | undefined;
  // Scrolled up away from the newest messages, and how many arrived since.
  const away = signal(false);
  const fresh = signal(0);
  // Where the viewport starts when scrolled to the newest message.
  let endPos: { index: number; offset: number } | null = null;
  const measureEnd = () =>
    requestAnimationFrame(() => void list?.measureScrollPosition().then((pos) => (endPos = pos)));

  const load = async () => {
    const latest = await api.messages(props.botId);
    const lastBefore = messages().at(-1)?.id;
    const next = [...latest].reverse();
    if (away() && lastBefore !== undefined) {
      const at = next.findIndex((m) => m.id === lastBefore);
      if (at >= 0) fresh.set(fresh() + next.length - 1 - at);
    }
    messages.set(next);
    if (!away()) measureEnd();
    reachedStart = latest.length < 50;
    // Only when something is unread: marking read announces a change, which
    // reloads this page, which would mark read again.
    if (latest.some((m) => !m.read)) await api.markRead(props.botId);
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

  const checkPosition = async () => {
    const pos = await list?.measureScrollPosition();
    away.set(!!pos && !!endPos && (pos.index < endPos.index || (pos.index === endPos.index && pos.offset < endPos.offset - 60)));
    if (!away()) fresh.set(0);
  };
  const jumpToLatest = () => {
    list?.scrollToEnd({ animated: true });
    away.set(false);
    fresh.set(0);
    measureEnd();
  };

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
          ref={(r: ListRef) => (list = r)}
          onScrollEnd={() => void checkPosition()}
          onLoadMoreAtStart={() => void loadOlder()}
          style={{ flex: 1 }}
          contentStyle={{ paddingTop: safeArea().top + 60, paddingBottom: safeArea().bottom + 70, paddingLeft: 12, paddingRight: 12, gap: 10 } as never}
          empty={
            <View style={{ alignItems: "center", paddingTop: 200 }}>
              <Text style={{ fontSize: 15, color: p().hint }}>{tr("还没有消息。用 token 发一条试试。")}</Text>
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

        <TopBar
          p={p()}
          title={chat()?.bot.name ?? ""}
          subtitle={chat()?.muted ? tr("机器人 · 已静音") : tr("机器人")}
          onBack={() => nav.pop()}
          right={
            <View testID="open-settings" role="button" accessibilityLabel={tr("Bot 设置")} onPress={() => nav.push({ name: "botSettings", botId: props.botId })}>
              <Avatar avatar={chat()?.bot.avatar ?? ""} size={40} iconScale={0.62} />
            </View>
          }
        />

        <EdgeBlur edge="bottom" height={safeArea().bottom + 76} />
        {/* Back to the newest message, with how many arrived while scrolled up. */}
        <If when={away() || fresh() > 0}>
          <View
            testID="jump-latest"
            role="button"
            accessibilityLabel={tr("回到最新消息")}
            onPress={jumpToLatest}
            activeStyle={{ opacity: 0.7 }}
            style={{ position: "absolute", right: 12, bottom: safeArea().bottom + 70, width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", ...glass(p()) }}
          >
            <Icon name="down" color={p().text} size={24} weight={2} />
            <If when={fresh() > 0}>
              <View style={{ position: "absolute", top: -9, alignSelf: "center" }}>
                <Badge count={fresh()} p={p()} />
              </View>
            </If>
          </View>
        </If>
        {/* One compact glass pill, as a channel's mute button; settings are behind the avatar. */}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: safeArea().bottom + 10, alignItems: "center", pointerEvents: "box-none" }}>
          <View
            testID="mute"
            role="button"
            onPress={() => void toggleMute()}
            activeStyle={{ opacity: 0.7 }}
            style={{ height: 46, paddingLeft: 20, paddingRight: 22, borderRadius: 23, flexDirection: "row", gap: 8, alignItems: "center", ...glass(p()) }}
          >
            <Icon name={chat()?.muted ? "bell" : "bellOff"} color={p().text} size={20} weight={2} />
            <Text style={{ fontSize: 16, fontWeight: "500", color: p().text }}>{chat()?.muted ? tr("取消静音") : tr("静音通知")}</Text>
          </View>
        </View>
      </View>
    </NavPage>
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
  const dissolving = signal(false);
  const dust = createDissolve();
  const actions = async () => {
    const list = [{ id: "copy", label: tr("复制正文") }];
    if (m().copy) list.push({ id: "copyExtra", label: tr("复制内容") });
    if (m().url) list.push({ id: "open", label: tr("打开链接") });
    const { action } = await AlertDialog.show({
      presentation: "actionSheet",
      actions: [...list, { id: "delete", label: tr("删除"), role: "destructive" as const }, { id: "cancel", label: tr("取消"), role: "cancel" as const }],
    });
    if (action === "copy") await Clipboard.writeText(m().body);
    if (action === "copyExtra") await Clipboard.writeText(m().copy);
    if (action === "open") await openUrl(m().url).catch(() => {});
    if (action === "delete") {
      // Turn to dust first, then delete; the row is recycled afterwards, so reset it.
      dissolving.set(true);
      try {
        // Dust first, then the request: deleting tells the host, which reloads the
        // list at once and would drop the row before it could dissolve. A failed
        // delete brings the row back.
        await dust.play();
        await api.deleteMessage(m().id);
        await reload();
      } finally {
        dissolving.set(false);
        dust.reset();
      }
    }
  };
  return (
    <Dissolve
      active={dissolving()}
      progress={dust.progress}
      style={{ alignSelf: m().html ? "stretch" : "flex-start", maxWidth: m().html ? undefined : "85%" }}
    >
    <View
      testID={`message-${m().id}`}
      onLongPress={() => void actions()}
      onPress={m().url && !m().html ? () => void openUrl(m().url).catch(() => {}) : undefined}
      style={{ backgroundColor: props.p.bubble, borderRadius: 18, overflow: "hidden" }}
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
    </Dissolve>
  );
}
