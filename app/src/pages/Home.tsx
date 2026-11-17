import type { JSX } from "nsh";
import { Canvas, List, Path2D, safeArea, signal, Text, View } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { Avatar, Badge, Glyph, Row, Section } from "../components";
import { listTime } from "../format";
import { createDissolve, Dissolve } from "../fx/Dissolve";
import { api, type Chat } from "../host";
import { chats, loadStatus, nav, reload, status } from "../store";
import { palette, type Palette } from "../theme";
import { lang, tr } from "../i18n";

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
  const editing = signal(false);
  const shown = () => chats().filter((c) => matches(c, query().trim()));
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
        each={shown()}
        keyExtractor={(c) => String(c.bot.id)}
        style={{ flex: 1 }}
        contentStyle={{ paddingBottom: safeArea().bottom + 100 } as never}
        refreshing={false}
        onRefresh={() => void api.refresh().then(reload)}
        empty={
          <If when={query().trim()} else={<Empty p={p()} />}>
            <Text style={{ textAlign: "center", paddingTop: 60, fontSize: 15, color: p().hint }}>{tr("没有匹配的会话")}</Text>
          </If>
        }
      >
        {(chat) => <ChatRow chat={chat()} p={p()} editing={editing()} />}
      </List>
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
    </View>
  );
}

function ChatRow(props: { chat: Chat; p: Palette; editing: boolean }) {
  const c = () => props.chat;
  const dissolving = signal(false);
  const dust = createDissolve();
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
    if (action !== "delete") return;
    dissolving.set(true);
    try {
      // The request runs while the dust plays; a failure brings the row back.
      await Promise.all([dust.play(), api.deleteBot(c().bot.id)]);
      await reload();
    } finally {
      dissolving.set(false);
      dust.reset();
    }
  };
  return (
    <Dissolve active={dissolving()} progress={dust.progress}>
    <View
      testID={`chat-${c().bot.id}`}
      role="button"
      onPress={() => (props.editing ? void actions() : nav.push({ name: "chat", botId: c().bot.id }))}
      onLongPress={() => void actions()}
      activeStyle={{ backgroundColor: props.p.pill }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, height: 80 }}
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
              style={{ height: 32, paddingLeft: 14, paddingRight: 14, borderRadius: 16, backgroundColor: props.p.destructive, justifyContent: "center" }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#ffffff" }}>{tr("删除")}</Text>
            </View>
          </If>
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
  const host = () => {
    const u = status()?.gatewayURL ?? "";
    return u.replace(/^https?:\/\//, "").replace(/\/$/, "") || "…";
  };
  return (
    <View style={{ flex: 1, gap: 22 }}>
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
        <Row p={p()} first label={tr("系统通知")} value={permission()} onPress={() => void api.openNotificationSettings()} />
        <Row p={p()} label={tr("设备注册")} value={registration()} color={status()?.registration === "failed" ? p().destructive : undefined} testID="registration" />
        <If when={status()?.registration !== "registered"}>
          <Row p={p()} label={retrying() ? tr("正在重试…") : tr("重试注册")} color={p().accent} onPress={() => void retry()} testID="retry-registration" />
        </If>
      </Section>
      <Section title={tr("网关")} p={p()}>
        <Row p={p()} first label={host()} value={tr("更改")} onPress={() => nav.push({ name: "gateway" })} testID="gateway-row" />
        <Row p={p()} label={tr("立即同步")} color={p().accent} onPress={() => void api.refresh().then(reload)} />
      </Section>
      <View style={{ flex: 1 }} />
      <If when={status()?.appVersion}>
        <Text
          testID="app-version"
          style={{ textAlign: "center", fontSize: 13, color: p().hint, paddingBottom: safeArea().bottom + 96 }}
        >
          {`Honk ${status()?.appVersion}${status()?.appBuild ? ` (${status()?.appBuild})` : ""}`}
        </Text>
      </If>
    </View>
  );
}

function TabBar(props: { tab: Tab; onSelect: (t: Tab) => void; p: Palette }) {
  const unread = () => chats().reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
  const color = (t: Tab) => (props.tab === t ? props.p.accent : props.p.text);
  return (
    <View
      style={{
        position: "absolute", left: 24, right: 24, bottom: safeArea().bottom + 8, height: 64,
        borderRadius: 32, backgroundColor: props.p.glass, flexDirection: "row",
        boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
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
