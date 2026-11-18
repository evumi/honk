import type { ListRef } from "nsh";
import { Clipboard, cleanup, computed, Image, List, openUrl, signal, Text, View, effect, safeArea } from "nsh";
import { AlertDialog, NavPage } from "nsh/base";
import { Avatar, Badge, EdgeBlur, glass, Icon, TopBar } from "../components";
import { clock, dayLabel, sameDay } from "../format";
import { api, type Message } from "../host";
import { chatOf, nav, reload, version } from "../store";
import { palette, type Palette } from "../theme";
import { tr } from "../i18n";
import { reuse } from "../stable";
import { MessageBody } from "../MessageBody";
import { Widget } from "../widget/Widget";
import { createDissolve, Dissolve } from "../fx/Dissolve";

interface Row { m: Message; day: boolean }

export function ChatPage(props: { botId: string; messageId?: number }) {
  const p = palette;
  // Newest first, as the host answers: the list is inverted (item 0 at the
  // bottom), so it opens on the newest message and stays there as messages
  // arrive, natively, however late they load.
  const messages = signal<Message[]>([]);
  const chat = () => chatOf(props.botId);
  let loadingOlder = false;
  let reachedStart = false;
  let list: ListRef | undefined;
  // Scrolled up away from the newest messages, and how many arrived since.
  const away = signal(false);
  const fresh = signal(0);
  // A search result opens the chat on a window of messages around it instead of the newest; "back to the newest"
  // (or nothing found) clears it.
  const anchor = signal<number | undefined>(props.messageId);
  let scrolledToAnchor = false;

  // Only the latest load applies: a slow window must not overwrite the newest page after "back to the newest".
  let loadSeq = 0;

  const loadAround = async (id: number, seq: number) => {
    const window = await api.messagesAround(props.botId, id);
    if (seq !== loadSeq) return;
    // Older messages already loaded past the window stay.
    const floor = window.at(-1)?.id;
    const older = floor === undefined ? [] : messages().filter((m) => m.id < floor);
    messages.set(reuse(messages(), [...window, ...older], (m) => String(m.id)));
    // The window's older half may stop short without the start being near: the first scroll up asks for more.
    reachedStart = false;
    const at = messages().findIndex((m) => m.id === id);
    if (at < 0) {
      anchor.set(undefined);
    } else if (!scrolledToAnchor) {
      scrolledToAnchor = true;
      // Once the rows are laid out.
      setTimeout(() => list?.scrollToIndex({ index: at, animated: false, viewPosition: 0.5 }), 60);
    }
    // As below: only when something in the window is unread, so marking read does not loop through the reload.
    if (window.some((m) => !m.read)) await api.markRead(props.botId);
  };

  const load = async () => {
    const seq = ++loadSeq;
    const around = anchor();
    if (around !== undefined) return loadAround(around, seq);
    const latest = await api.messages(props.botId);
    if (seq !== loadSeq) return;
    const newestBefore = messages()[0]?.id;
    if (away() && newestBefore !== undefined) {
      const at = latest.findIndex((m) => m.id === newestBefore);
      if (at > 0) fresh.set(fresh() + at);
    }
    // Older messages already loaded past this page stay.
    const floor = latest.at(-1)?.id;
    const older = floor === undefined ? [] : messages().filter((m) => m.id < floor);
    messages.set(reuse(messages(), [...latest, ...older], (m) => String(m.id)));
    if (older.length === 0) reachedStart = latest.length < 50;
    // Only when something is unread: marking read announces a change, which
    // reloads this page, which would mark read again.
    if (latest.some((m) => !m.read)) await api.markRead(props.botId);
  };
  const loadOlder = async () => {
    const oldest = messages().at(-1);
    if (loadingOlder || reachedStart || !oldest) return;
    loadingOlder = true;
    try {
      const older = await api.messages(props.botId, oldest.id);
      reachedStart = older.length < 50;
      messages.set([...messages(), ...older]);
    } finally {
      loadingOlder = false;
    }
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

  // Positions count from the bottom (item 0's side) in an inverted list.
  const checkPosition = async () => {
    const pos = await list?.measureScrollPosition();
    away.set(!!pos && (pos.index > 0 || pos.offset > 60));
    if (!away()) fresh.set(0);
  };
  const jumpToLatest = () => {
    loadSeq++; // drops a window still loading
    if (anchor() !== undefined) {
      // Leaves the window: the effect above loads the newest page.
      anchor.set(undefined);
      messages.set([]);
      reachedStart = false;
    } else {
      list?.scrollToIndex({ index: 0, animated: true });
    }
    away.set(false);
    fresh.set(0);
  };

  // Rows carry whether they start a day, so a row depends on its own item only
  // (reading the whole array from every row re-ran all of them on any change).
  // Unchanged rows keep their object, so the list leaves them alone.
  let rowCache = new Map<string, Row>();
  const rows = computed<Row[]>(() => {
    const ms = messages();
    const next = new Map<string, Row>();
    const out = ms.map((m, i) => {
      // The older neighbour is the next item.
      const day = i === ms.length - 1 || !sameDay(ms[i + 1].date, m.date);
      const key = String(m.id);
      const old = rowCache.get(key);
      const row = old && old.m === m && old.day === day ? old : { m, day };
      next.set(key, row);
      return row;
    });
    rowCache = next;
    return out;
  });

  const toggleMute = async () => {
    await api.setMuted(props.botId, !chat()?.muted);
    await reload();
  };

  return (
    <NavPage headerVisible={false} testID="chat">
      <View style={{ flex: 1, backgroundColor: p().chatWall }}>
        <List
          each={rows()}
          keyExtractor={(r) => String(r.m.id)}
          estimatedItemSize={150}
          inverted
          ref={(r: ListRef) => (list = r)}
          onScrollEnd={() => void checkPosition()}
          onLoadMore={() => void loadOlder()}
          style={{ flex: 1 }}
          contentStyle={{ paddingTop: safeArea().top + 60, paddingBottom: safeArea().bottom + 70, paddingLeft: 12, paddingRight: 12, gap: 10 } as never}
          empty={
            <View style={{ alignItems: "center", paddingTop: 200 }}>
              <Text style={{ fontSize: 15, color: p().hint }}>{tr("还没有消息。用 token 发一条试试。")}</Text>
            </View>
          }
        >
          {(r) => (
            <View style={{ gap: 10 }}>
              <If when={r().day}>
                <DayChip ms={r().m.date} />
              </If>
              <Bubble message={r().m} p={p()} />
            </View>
          )}
        </List>

        <TopBar
          p={p()}
          tint={p().chatWall}
          title={chat()?.bot.name ?? ""}
          subtitle={chat()?.muted ? tr("机器人 · 已静音") : tr("机器人")}
          onBack={() => nav.pop()}
          right={
            <View testID="open-settings" role="button" accessibilityLabel={tr("Bot 设置")} onPress={() => nav.push({ name: "botSettings", botId: props.botId })}>
              <Avatar avatar={chat()?.bot.avatar ?? ""} size={40} iconScale={0.62} />
            </View>
          }
        />

        <EdgeBlur edge="bottom" height={safeArea().bottom + 80} tint={p().chatWall} />
        {/* Back to the newest message, with how many arrived while scrolled up. */}
        <If when={away() || fresh() > 0 || anchor() !== undefined}>
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

/** A message's image across the top of its bubble, at the image's own proportions (within reason). */
function Picture(props: { src: string }) {
  const ratio = signal(4 / 3);
  return (
    <Image
      src={props.src}
      accessibilityLabel={tr("图片")}
      onLoad={(e) => ratio.set(Math.min(2.5, Math.max(0.6, e.size.width / Math.max(1, e.size.height))))}
      style={{ width: "100%", aspectRatio: ratio(), objectFit: "cover" } as never}
    />
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
      {/* The card is built once per message: keyed by the message, so a recycled
          row shows its new message's card and an unchanged one is left alone. */}
      <Each of={m().html ? [m()] : []} key={(x) => `${x.id}\u0000${x.html}\u0000${x.data}`}>
        {(x) => (
          <View style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 0.5, borderBottomColor: props.p.separator }}>
            <Widget html={x().html} data={x().data} palette={props.p} messageId={x().id} allowQueries={x().allowQueries} />
          </View>
        )}
      </Each>
      <If when={m().image && !m().html}>
        <Picture src={m().image} />
      </If>
      <View style={{ paddingTop: 10, paddingBottom: 8, paddingLeft: 14, paddingRight: 14, gap: 2 }}>
        <If when={m().title && !m().html}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: props.p.text }}>{m().title}</Text>
        </If>
        <MessageBody body={m().body} markdown={m().parseMode === "Markdown"} p={props.p} />
        <Text style={{ alignSelf: "flex-end", fontSize: 12, color: props.p.hint }}>{clock(m().date)}</Text>
      </View>
    </View>
    </Dissolve>
  );
}
