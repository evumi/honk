import type { JSX } from "nsh";
import { Canvas, computed, createAnimatedValue, effect, List, Path2D, safeArea, Scroll, signal, Text, View } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { Avatar, Badge, EdgeBlur, Glyph, glass, Row, Section, UI_ICONS } from "../components";
import { lastSeen, listTime } from "../format";
import { createDissolve, Dissolve } from "../fx/Dissolve";
import { api, type Chat, type Message, type Retention } from "../host";
import { chooseRetention, exportMessages, importMessages, retentionLabel } from "../archive";
import { chats, devices, loadDevices, loadStatus, nav, reload, status } from "../store";
import { palette, type Palette } from "../theme";
import { lang, langChoice, setLangChoice, tr, type LangChoice } from "../i18n";

type Tab = "chats" | "settings";

// Tab bar and header icons, 24-unit grid (the design's).
const BUBBLE = "M12 3.5c-5 0-9 3.4-9 7.6 0 2.3 1.2 4.4 3.1 5.8L5.5 20.5l4.1-2.1c.8.2 1.6.3 2.4.3 5 0 9-3.4 9-7.6S17 3.5 12 3.5z";
const GEAR =
  "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";
const PLUS = "M12 5v14 M5 12h14";
const SEARCH = "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4";

/** A 24-grid icon, stroked or filled. */
function Icon(props: { path: string; color: string; size: number; fill?: boolean; width?: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, size) => {
        const s = size.width / 24;
        cx.save();
        cx.scale(s, s);
        const path = new Path2D(props.path);
        if (props.fill) {
          cx.fillStyle = props.color;
          cx.fill(path);
        } else {
          cx.strokeStyle = props.color;
          cx.lineWidth = props.width ?? 1.8;
          cx.lineCap = "round";
          cx.lineJoin = "round";
          cx.stroke(path);
        }
        cx.restore();
      }}
    />
  );
}

export function Home() {
  const tab = signal<Tab>("chats");
  const p = palette;
  return (
    <NavPage headerVisible={false} testID="home">
      <View style={{ flex: 1, backgroundColor: tab() === "chats" ? p().bg : p().groupedBg }}>
        <If when={tab() === "chats"} else={<SettingsTab p={p()} />}>
          <ChatsTab p={p()} />
        </If>
        <EdgeBlur edge="bottom" height={safeArea().bottom + 92} tint={p().bg} />
        <TabBar tab={tab()} onSelect={(t) => tab.set(t)} p={p()} />
      </View>
    </NavPage>
  );
}

function Header(props: { title: string; p: Palette; right?: JSX.Element; left?: JSX.Element }) {
  return (
    <View
      style={{
        paddingTop: safeArea().top + 8, paddingLeft: 16, paddingRight: 16, paddingBottom: 8,
        flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      }}
    >
      <View style={{ width: 96, alignItems: "flex-start" }}>{props.left}</View>
      <Text style={{ fontSize: 17, fontWeight: "600", color: props.p.text }}>{props.title}</Text>
      <View style={{ width: 96, alignItems: "flex-end" }}>{props.right}</View>
    </View>
  );
}

function matches(c: Chat, q: string): boolean {
  if (!q) return true;
  const hay = `${c.bot.name} ${c.last?.title ?? ""} ${c.last?.body ?? ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function ChatsTab(props: { p: Palette }) {
  const p = () => props.p;
  const query = signal("");
  // The pull-to-refresh spinner is the app's to stop: it shows while this is true.
  const refreshing = signal(false);
  const refresh = async () => {
    if (refreshing()) return;
    refreshing.set(true);
    try {
      await api.refresh();
      await reload();
    } finally {
      refreshing.set(false);
    }
  };
  const editing = signal(false);
  const shown = () => chats().filter((c) => matches(c, query().trim()));

  // Messages matching the search, 50 a page, under the matching chats.
  const found = signal<Message[]>([]);
  let searchSeq = 0;
  let moreToFind = false;
  let findingMore = false;
  effect(() => {
    const q = query().trim();
    const seq = ++searchSeq;
    moreToFind = false;
    if (!q) {
      found.set([]);
      return;
    }
    void api.search(q).then(
      (ms) => {
        if (seq !== searchSeq) return;
        moreToFind = ms.length >= 50;
        found.set(ms);
      },
      () => seq === searchSeq && found.set([]),
    );
  });
  const findMore = async () => {
    const last = found().at(-1);
    if (!moreToFind || findingMore || !last) return;
    findingMore = true;
    const seq = searchSeq;
    try {
      const ms = await api.search(query().trim(), last.id);
      if (seq !== searchSeq) return;
      moreToFind = ms.length >= 50;
      found.set([...found(), ...ms]);
    } catch {
      moreToFind = false;
    } finally {
      findingMore = false;
    }
  };

  // The list's rows: matching chats, then a 「消息」 group of matching messages. Unchanged rows keep their object.
  let itemCache = new Map<string, Item>();
  const items = computed<Item[]>(() => {
    const next = new Map<string, Item>();
    const keep = (key: string, chat?: Chat, msg?: Message, bot?: Chat["bot"]): Item => {
      const old = itemCache.get(key);
      const item = old && old.chat === chat && old.msg === msg && old.bot === bot ? old : { key, chat, msg, bot };
      next.set(key, item);
      return item;
    };
    const out: Item[] = shown().map((c) => keep(`c${c.bot.id}`, c));
    if (query().trim()) {
      const hits = found().flatMap((m) => {
        const bot = chats().find((c) => c.bot.id === m.botId)?.bot;
        return bot ? [keep(`m${m.id}`, undefined, m, bot)] : [];
      });
      if (hits.length > 0) out.push(keep("header"), ...hits);
    }
    itemCache = next;
    return out;
  });
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={tr("通知")}
        p={p()}
        left={
          <If when={chats().length > 0}>
            <View
              testID="edit"
              role="button"
              onPress={() => editing.set(!editing())}
              activeStyle={{ opacity: 0.7 }}
              style={{ height: 44, paddingLeft: 18, paddingRight: 18, borderRadius: 22, backgroundColor: p().pill, justifyContent: "center" }}
            >
              <Text style={{ fontSize: 17, color: editing() ? p().accent : p().text, fontWeight: editing() ? "600" : "400" }}>
                {editing() ? tr("完成") : tr("编辑")}
              </Text>
            </View>
          </If>
        }
        right={
          <View
            testID="new-bot"
            role="button"
            accessibilityLabel={tr("新建 Bot")}
            onPress={() => nav.push({ name: "newBot" })}
            activeStyle={{ opacity: 0.7 }}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: p().accent, alignItems: "center", justifyContent: "center" }}
          >
            <Icon path={PLUS} color="#ffffff" size={22} width={2.2} />
          </View>
        }
      />
      <If when={chats().length > 0}>
        <View style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 8 }}>
          <View style={{ height: 36, borderRadius: 10, backgroundColor: p().pill, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingRight: 10 }}>
            <Icon path={SEARCH} color={p().hint} size={16} width={2} />
            <Input
              testID="search"
              value={query()}
              onChange={({ value }) => query.set(value)}
              placeholder={tr("搜索")}
              returnKeyType="search"
              style={{ flex: 1, fontSize: 16, color: p().text }}
            />
          </View>
        </View>
      </If>
      <List
        each={items()}
        keyExtractor={(i) => i.key}
        onLoadMore={() => void findMore()}
        estimatedItemSize={80}
        style={{ flex: 1 }}
        contentStyle={{ paddingBottom: safeArea().bottom + 100 } as never}
        refreshing={refreshing()}
        onRefresh={() => void refresh()}
        empty={
          <If when={query().trim()} else={<Empty p={p()} />}>
            <Text style={{ textAlign: "center", paddingTop: 60, fontSize: 15, color: p().hint }}>{tr("没有匹配的结果")}</Text>
          </If>
        }
      >
        {(item) => (
          <If
            when={item().chat}
            else={
              <If when={item().msg} else={<GroupLabel text={tr("消息")} p={p()} />}>
                {(m) => <MessageHit message={m()} bot={item().bot!} p={p()} />}
              </If>
            }
          >
            {(chat) => <ChatRow chat={chat()} p={p()} editing={editing()} />}
          </If>
        )}
      </List>
    </View>
  );
}

/** A row of the chat list: a chat, a matching message, or the 「消息」 label between them. */
interface Item {
  key: string;
  chat?: Chat;
  msg?: Message;
  bot?: Chat["bot"];
}

function GroupLabel(props: { text: string; p: Palette }) {
  return (
    <View style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 6, backgroundColor: props.p.bg }}>
      <Text testID="messages-group" style={{ fontSize: 13, fontWeight: "600", color: props.p.hint }}>{props.text}</Text>
    </View>
  );
}

/** A message that matches the search; opens its chat on that message. */
function MessageHit(props: { message: Message; bot: Chat["bot"]; p: Palette }) {
  const m = () => props.message;
  return (
    <View
      testID={`hit-${m().id}`}
      role="button"
      onPress={() => nav.push({ name: "chat", botId: m().botId, messageId: m().id })}
      activeStyle={{ backgroundColor: props.p.pill }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, minHeight: 64, backgroundColor: props.p.bg }}
    >
      <Avatar avatar={props.bot.avatar} size={40} iconScale={0.55} />
      <View style={{ flex: 1, paddingTop: 8, paddingBottom: 8, paddingRight: 16, gap: 2, borderBottomWidth: 0.5, borderBottomColor: props.p.separator }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: props.p.text, numberOfLines: 1 }}>{props.bot.name}</Text>
          <Text style={{ fontSize: 13, color: props.p.hint }}>{listTime(m().date)}</Text>
        </View>
        <Text style={{ fontSize: 15, lineHeight: 20, color: props.p.hint, numberOfLines: 2 }}>
          {m().title && m().body ? `${m().title}${lang() === "zh" ? "：" : ": "}${m().body}` : m().title || m().body}
        </Text>
      </View>
    </View>
  );
}

function Empty(props: { p: Palette }) {
  return (
    <View style={{ alignItems: "center", paddingTop: 96, paddingLeft: 40, paddingRight: 40 }}>
      <Glyph icon="bell" color={props.p.accent} size={72} />
      <Text style={{ marginTop: 20, fontSize: 20, fontWeight: "600", color: props.p.text }}>{tr("还没有 Bot")}</Text>
      <Text style={{ marginTop: 8, fontSize: 15, lineHeight: 21, color: props.p.hint, textAlign: "center" }}>
        {tr("每个 Bot 是一个独立的通知渠道。创建后用它的 token 调用发送接口，通知就会出现在这里。")}
      </Text>
      <View
        testID="create-first-bot"
        role="button"
        onPress={() => nav.push({ name: "newBot" })}
        activeStyle={{ opacity: 0.85 }}
        style={{ marginTop: 24, height: 50, paddingLeft: 28, paddingRight: 28, borderRadius: 25, backgroundColor: props.p.accent, justifyContent: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>{tr("创建第一个 Bot")}</Text>
      </View>
      <View
        testID="pair-existing"
        role="button"
        onPress={() => nav.push({ name: "pair" })}
        activeStyle={{ opacity: 0.6 }}
        style={{ marginTop: 14, height: 44, paddingLeft: 16, paddingRight: 16, justifyContent: "center" }}
      >
        <Text style={{ color: props.p.accent, fontSize: 16 }}>{tr("已有设备？输入配对码")}</Text>
      </View>
    </View>
  );
}

/** The row swiped open to show its delete button (one at a time). */
const swipedRow = signal<string | null>(null);
/** How far a row slides to show its delete button, in points. */
const ACTION_W = 88;

function ChatRow(props: { chat: Chat; p: Palette; editing: boolean }) {
  const c = () => props.chat;
  const dissolving = signal(false);
  const dust = createDissolve();
  // Swipe left to reveal Delete: the drag drives `drag` natively; the row only
  // moves left, and settles open or shut when the finger lifts.
  const drag = createAnimatedValue(0);
  const shift = drag.interpolate({ inputRange: [-ACTION_W * 3, 0, 1], outputRange: [-ACTION_W * 3, 0, 0], extrapolate: "clamp" });
  const open = signal(false);
  const settle = (to: boolean) => {
    open.set(to);
    if (to) swipedRow.set(c().bot.id);
    else if (swipedRow() === c().bot.id) swipedRow.set(null);
    void drag.spring(to ? -ACTION_W : 0, { damping: 22, stiffness: 260 });
  };
  effect(() => {
    if (open() && swipedRow() !== c().bot.id) settle(false);
  });
  effect(() => {
    if (props.editing && open()) settle(false);
  });
  const preview = () => {
    const m = c().last;
    if (!m) return tr("还没有消息");
    return m.title && m.body ? `${m.title}${lang() === "zh" ? "：" : ": "}${m.body}` : m.title || m.body;
  };
  const actions = async () => {
    const { action } = await AlertDialog.show({
      title: c().bot.name,
      presentation: "actionSheet",
      actions: [
        { id: "pin", label: c().pinned ? tr("取消置顶") : tr("置顶") },
        { id: "mute", label: c().muted ? tr("取消静音") : tr("静音") },
        { id: "read", label: tr("标为已读") },
        { id: "cancel", label: tr("取消"), role: "cancel" },
      ],
    });
    if (action === "pin") await api.setPinned(c().bot.id, !c().pinned);
    if (action === "mute") await api.setMuted(c().bot.id, !c().muted);
    if (action === "read") await api.markRead(c().bot.id);
    if (action && action !== "cancel") await reload();
  };
  const remove = async () => {
    const { action } = await AlertDialog.show({
      title: tr("删除「{name}」？", { name: c().bot.name }),
      description: tr("token 立即失效，网关队列里未拉取的消息一并删除。"),
      actions: [{ id: "cancel", label: tr("取消"), role: "cancel" }, { id: "delete", label: tr("删除"), role: "destructive" }],
    });
    if (action !== "delete") {
      settle(false);
      return;
    }
    dissolving.set(true);
    try {
      // Dust first, then the request: deleting tells the host, which reloads the
      // list at once and would drop the row before it could dissolve. A failed
      // delete brings the row back.
      await dust.play();
      await api.deleteBot(c().bot.id);
      await reload();
    } finally {
      dissolving.set(false);
      dust.reset();
      open.set(false);
      void drag.timing(0, { duration: 0 });
    }
  };
  return (
    <Dissolve active={dissolving()} progress={dust.progress}>
    <View style={{ height: 80, backgroundColor: props.p.destructive }}>
    {/* The delete button under the row, shown as the row slides left. */}
    <View
      testID={`swipe-delete-${c().bot.id}`}
      role="button"
      accessibilityLabel={tr("删除")}
      onPress={() => void remove()}
      activeStyle={{ opacity: 0.7 }}
      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: ACTION_W, alignItems: "center", justifyContent: "center", gap: 4 }}
    >
      <Icon path={UI_ICONS.trash} color="#ffffff" size={22} width={2} />
      <Text style={{ fontSize: 13, fontWeight: "600", color: "#ffffff" }}>{tr("删除")}</Text>
    </View>
    <View
      testID={`chat-${c().bot.id}`}
      role="button"
      pan={props.editing ? undefined : { x: drag }}
      panActivation={{ activeOffsetX: 12, failOffsetY: 10 }}
      onPanEnd={(e) => settle(!e.cancelled && ((e.value?.x ?? e.translation.x) < -ACTION_W / 2 || e.velocity.x < -600))}
      onPress={() => (open() ? settle(false) : props.editing ? void actions() : nav.push({ name: "chat", botId: c().bot.id }))}
      onLongPress={() => void actions()}
      activeStyle={{ backgroundColor: props.p.pill }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, height: 80, backgroundColor: props.p.bg, translate: [shift, 0] }}
    >
      <Avatar avatar={c().bot.avatar} size={56} />
      <View
        style={{
          flex: 1, height: 80, justifyContent: "center", gap: 2, paddingRight: 16,
          borderBottomWidth: 0.5, borderBottomColor: props.p.separator,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: props.p.text, numberOfLines: 1 }}>{c().bot.name}</Text>
          <If when={!props.editing}>
            <Text style={{ fontSize: 14, color: props.p.hint }}>{listTime(c().last?.date ?? c().bot.createdAt)}</Text>
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, color: props.p.hint, numberOfLines: 2 }}>{preview()}</Text>
          <If
            when={props.editing}
            else={
              <If when={c().unread > 0} else={<If when={c().pinned}><Text style={{ fontSize: 13, color: props.p.hint }}>{tr("置顶")}</Text></If>}>
                <Badge count={c().unread} muted={c().muted} p={props.p} />
              </If>
            }
          >
            <View
              testID={`delete-${c().bot.id}`}
              role="button"
              onPress={() => void remove()}
              accessibilityLabel={tr("删除")}
              activeStyle={{ opacity: 0.6 }}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: props.p.destructiveSoft, alignItems: "center", justifyContent: "center" }}
            >
              <Icon path={UI_ICONS.trash} color={props.p.destructive} size={19} width={2} />
            </View>
          </If>
        </View>
      </View>
    </View>
    </View>
    </Dissolve>
  );
}

function SettingsTab(props: { p: Palette }) {
  const p = () => props.p;
  void loadStatus();
  const retrying = signal(false);
  const permission = () => {
    const n = status()?.notifications;
    return n === "authorized" ? tr("已开启") : n === "denied" ? tr("已关闭") : tr("未设置");
  };
  const registration = () => {
    switch (status()?.registration) {
      case "registered": return tr("已注册");
      case "registering": return tr("注册中…");
      case "waitingForPushToken": return tr("等待推送授权");
      case "failed": return tr("注册失败");
      case "notRegistered": return tr("未注册");
      default: return status()?.registered ? tr("已注册") : tr("未注册");
    }
  };
  const retry = async () => {
    retrying.set(true);
    try {
      await api.retryRegistration();
    } finally {
      retrying.set(false);
      await loadStatus();
      await reload();
    }
  };
  const deleting = signal(false);
  void loadDevices();
  const others = () => devices().filter((d) => !d.current);
  const failed = (e: unknown, description: string) =>
    AlertDialog.show({
      title: tr("删除失败"),
      description: tr(description, { error: String((e as Error)?.message ?? e) }),
      actions: [{ id: "ok", label: tr("好") }],
    });
  /** Deletes or leaves after a confirmation; the phone keeps its data when the gateway does not confirm. */
  const confirmed = async (title: string, description: string, label: string, run: () => Promise<unknown>) => {
    if (deleting()) return;
    const { action } = await AlertDialog.show({
      title, description,
      actions: [{ id: "cancel", label: tr("取消"), role: "cancel" }, { id: "delete", label, role: "destructive" }],
    });
    if (action !== "delete") return;
    deleting.set(true);
    try {
      await run();
      await Promise.all([reload(), loadStatus(), loadDevices()]);
    } catch (e) {
      await failed(e, "{error}。这台设备的数据没有改动，请稍后重试。");
    } finally {
      deleting.set(false);
    }
  };
  const deleteData = () =>
    confirmed(
      tr("删除全部数据？"),
      others().length > 0
        ? tr("将删除：设备组里所有设备在网关上的注册（包括其他 {n} 台设备）；所有 Bot，它们的 token 立即失效；网关上排队的消息；本机的消息和头像。无法恢复。", { n: others().length })
        : tr("将删除：这台设备在网关上的注册；所有 Bot，它们的 token 立即失效；网关上排队的消息；本机的消息和头像。无法恢复。"),
      tr("删除"),
      () => api.deleteDevice(),
    );
  const leaveGroup = () => {
    const me = devices().find((d) => d.current);
    if (!me) return Promise.resolve();
    return confirmed(
      tr("从设备组移除这台设备？"),
      tr("这台设备会从设备组里退出，并清空本机的消息、头像和 token。其他设备和 Bot 不受影响，Bot 仍会推送给它们。之后可以用配对码重新加入。"),
      tr("移除"),
      () => api.removeDevice(me.id),
    );
  };
  const removeOther = (id: string, name: string) =>
    confirmed(
      tr("移除 {name}？", { name }),
      tr("这台设备不再收到通知，也不再能使用这些 Bot。Bot 和其他设备不受影响。"),
      tr("移除"),
      () => api.removeDevice(id),
    );
  const deviceName = (d: { name: string; platform: string }) => d.name || (d.platform === "ios" ? "iPhone" : "Android");
  const retention = signal<Retention>(0);
  void api.retention().then((d) => retention.set(d), () => {});
  const host = () => {
    const u = status()?.gatewayURL ?? "";
    return u.replace(/^https?:\/\//, "").replace(/\/$/, "") || "…";
  };
  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ gap: 22, paddingBottom: safeArea().bottom + 96 }}>
      <Header title={tr("设置")} p={p()} />
      <Section
        title={tr("推送")}
        p={p()}
        footer={
          status()?.registration === "failed"
            ? tr("注册失败：{error}。检查网关地址和网络后重试。", { error: status()?.registrationError ?? tr("未知错误") })
            : status()?.pushMode === "simulator"
              ? tr("模拟器调试：没有 APNs 推送，App 在前台时每 10 秒同步一次。")
              : tr("通知被关闭时，消息仍会在打开 App 时同步过来。")
        }
      >
        <Row p={p()} first label={tr("系统通知")} value={permission()} onPress={() => void api.openNotificationSettings()} chevron />
        <Row p={p()} label={tr("设备注册")} value={registration()} color={status()?.registration === "failed" ? p().destructive : undefined} testID="registration" />
        <If when={status()?.registration !== "registered"}>
          <Row p={p()} label={retrying() ? tr("正在重试…") : tr("重试注册")} color={p().accent} onPress={() => void retry()} testID="retry-registration" />
        </If>
      </Section>
      <Section title={tr("网关")} p={p()}>
        <Row p={p()} first label={host()} value={tr("更改")} onPress={() => nav.push({ name: "gateway" })} testID="gateway-row" chevron />
        <Row p={p()} label={tr("立即同步")} color={p().accent} onPress={() => void api.refresh().then(reload)} />
      </Section>
      <Section title={tr("消息")} p={p()} footer={tr("超过保留期限的消息会从这台设备上删除，不影响网关。导出的 JSON Lines 文件可以在这里导入回来；属于这台设备上没有的 Bot 的消息会被跳过。")}>
        <Row
          p={p()}
          first
          label={tr("保留期限")}
          value={retentionLabel(retention())}
          onPress={() => void chooseRetention(retention()).then((d) => retention.set(d))}
          testID="retention-row"
          chevron
        />
        <Row p={p()} label={tr("导出全部消息")} color={p().accent} onPress={() => void exportMessages()} testID="export-all" />
        <Row p={p()} label={tr("导入消息")} color={p().accent} onPress={() => void importMessages()} testID="import" />
      </Section>
      <Section title={tr("通用")} p={p()}>
        <Row p={p()} first label={tr("语言")} value={languageLabel(langChoice())} onPress={() => void pickLanguage()} testID="language-row" chevron />
      </Section>
      <Section
        title={tr("设备")}
        p={p()}
        footer={tr("设备组里的手机共用同一批 Bot，每条通知都会推送到所有设备。换新手机时，在新手机上输入旧手机的配对码即可，Bot 的 token 不变。")}
      >
        <Each of={devices()} key={(d) => d.id}>
          {(d, i) => (
            <Row
              p={p()}
              first={i() === 0}
              testID={`device-${d().id}`}
              label={deviceName(d())}
              value={d().current ? tr("这台设备") : `${d().platform === "ios" ? "iOS" : "Android"} · ${lastSeen(d().seenAt)}`}
              onPress={d().current ? undefined : () => void removeOther(d().id, deviceName(d()))}
              right={d().current ? undefined : <Icon path={UI_ICONS.trash} color={p().destructive} size={19} width={2} />}
            />
          )}
        </Each>
        <Row p={p()} first={devices().length === 0} label={tr("添加设备")} color={p().accent} onPress={() => nav.push({ name: "addDevice" })} testID="add-device" />
        <Row p={p()} label={tr("已有设备？输入配对码")} color={p().accent} onPress={() => nav.push({ name: "pair" })} testID="enter-code" />
      </Section>
      <Section
        title={tr("数据")}
        p={p()}
        footer={
          others().length > 0
            ? tr("「从设备组移除这台设备」只让这台手机退出，Bot 留给其他设备。「删除全部数据」会删除设备组在网关上的一切，并清空本机。")
            : tr("删除这台设备在网关上的注册、所有 Bot 和排队的消息，并清空本机数据。之后创建 Bot 或重新打开 App 时，这台设备会重新注册。")
        }
      >
        <If when={others().length > 0}>
          <Row
            p={p()}
            first
            label={deleting() ? tr("正在删除…") : tr("从设备组移除这台设备")}
            color={p().destructive}
            onPress={() => void leaveGroup()}
            testID="leave-group"
          />
        </If>
        <Row
          p={p()}
          first={others().length === 0}
          label={deleting() ? tr("正在删除…") : tr("删除全部数据")}
          color={p().destructive}
          onPress={() => void deleteData()}
          testID="delete-device-data"
        />
      </Section>
      <If when={status()?.appVersion}>
        <Text
          testID="app-version"
          style={{ textAlign: "center", fontSize: 13, color: p().hint, paddingTop: 8 }}
        >
          {`Honk ${status()?.appVersion}${status()?.appBuild ? ` (${status()?.appBuild})` : ""}`}
        </Text>
      </If>
    </Scroll>
  );
}

const LANGUAGES: { id: LangChoice; label: () => string }[] = [
  { id: "system", label: () => tr("跟随系统") },
  { id: "zh", label: () => "简体中文" },
  { id: "en", label: () => "English" },
];

function languageLabel(c: LangChoice): string {
  return LANGUAGES.find((l) => l.id === c)?.label() ?? "";
}

async function pickLanguage() {
  const { action } = await AlertDialog.show({
    title: tr("语言"),
    presentation: "actionSheet",
    actions: [...LANGUAGES.map((l) => ({ id: l.id, label: l.label() })), { id: "cancel", label: tr("取消"), role: "cancel" as const }],
  });
  if (action === "system" || action === "zh" || action === "en") await setLangChoice(action);
}

function TabBar(props: { tab: Tab; onSelect: (t: Tab) => void; p: Palette }) {
  const unread = () => chats().reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
  const color = (t: Tab) => (props.tab === t ? props.p.accent : props.p.text);
  return (
    <View
      style={{
        position: "absolute", left: 24, right: 24, bottom: safeArea().bottom + 8, height: 64,
        borderRadius: 32, flexDirection: "row",
        ...glass(props.p), boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
      }}
    >
      <View testID="tab-chats" role="tab" onPress={() => props.onSelect("chats")} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
        <View>
          <Icon path={BUBBLE} color={color("chats")} size={28} fill />
          <If when={unread() > 0}>
            <View style={{ position: "absolute", top: -6, left: 18 }}>
              <Badge count={unread()} p={{ ...props.p, accent: "#e5484d" }} />
            </View>
          </If>
        </View>
        <Text style={{ fontSize: 11, fontWeight: "600", color: color("chats") }}>{tr("通知")}</Text>
      </View>
      <View testID="tab-settings" role="tab" onPress={() => props.onSelect("settings")} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
        <Icon path={GEAR} color={color("settings")} size={28} />
        <Text style={{ fontSize: 11, fontWeight: "600", color: color("settings") }}>{tr("设置")}</Text>
      </View>
    </View>
  );
}
