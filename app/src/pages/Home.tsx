import type { JSX } from "nsh";
import { List, signal, Text, View, safeArea } from "nsh";
import { AlertDialog, NavPage } from "nsh/base";
import { Avatar, Badge, Row, Section } from "../components";
import { listTime } from "../format";
import { api, type Chat } from "../host";
import { chats, loadStatus, nav, reload, status } from "../store";
import { palette, type Palette } from "../theme";

type Tab = "chats" | "settings";

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
      <View style={{ width: 88, alignItems: "flex-start" }}>{props.left}</View>
      <Text style={{ fontSize: 17, fontWeight: "600", color: props.p.text }}>{props.title}</Text>
      <View style={{ width: 88, alignItems: "flex-end" }}>{props.right}</View>
    </View>
  );
}

function ChatsTab(props: { p: Palette }) {
  const p = () => props.p;
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="通知"
        p={p()}
        right={
          <View
            testID="new-bot"
            role="button"
            accessibilityLabel="新建 Bot"
            onPress={() => nav.push({ name: "newBot" })}
            activeStyle={{ opacity: 0.7 }}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: p().accent, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: "#ffffff", fontSize: 26, lineHeight: 28, fontWeight: "400" }}>+</Text>
          </View>
        }
      />
      <List
        each={chats()}
        keyExtractor={(c) => String(c.bot.id)}
        style={{ flex: 1 }}
        contentStyle={{ paddingBottom: 120 } as never}
        refreshing={false}
        onRefresh={() => void api.refresh().then(reload)}
        empty={<Empty p={p()} />}
      >
        {(chat) => <ChatRow chat={chat()} p={p()} />}
      </List>
    </View>
  );
}

function Empty(props: { p: Palette }) {
  return (
    <View style={{ alignItems: "center", paddingTop: 120, paddingLeft: 40, paddingRight: 40, gap: 16 }}>
      <Text style={{ fontSize: 17, fontWeight: "600", color: props.p.text }}>还没有 Bot</Text>
      <Text style={{ fontSize: 15, lineHeight: 21, color: props.p.hint, textAlign: "center" }}>
        每个 Bot 是一个独立的通知渠道。创建后用它的 token 发送通知。
      </Text>
      <View
        role="button"
        onPress={() => nav.push({ name: "newBot" })}
        activeStyle={{ opacity: 0.8 }}
        style={{ height: 48, paddingLeft: 24, paddingRight: 24, borderRadius: 14, backgroundColor: props.p.accent, justifyContent: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>创建第一个 Bot</Text>
      </View>
    </View>
  );
}

function ChatRow(props: { chat: Chat; p: Palette }) {
  const c = () => props.chat;
  const preview = () => {
    const m = c().last;
    if (!m) return "还没有消息";
    return m.title && m.body ? `${m.title}：${m.body}` : m.title || m.body;
  };
  const actions = async () => {
    const { action } = await AlertDialog.show({
      title: c().bot.name,
      presentation: "actionSheet",
      actions: [
        { id: "pin", label: c().pinned ? "取消置顶" : "置顶" },
        { id: "mute", label: c().muted ? "取消静音" : "静音" },
        { id: "read", label: "标为已读" },
        { id: "cancel", label: "取消", role: "cancel" },
      ],
    });
    if (action === "pin") await api.setPinned(c().bot.id, !c().pinned);
    if (action === "mute") await api.setMuted(c().bot.id, !c().muted);
    if (action === "read") await api.markRead(c().bot.id);
    if (action && action !== "cancel") await reload();
  };
  return (
    <View
      testID={`chat-${c().bot.id}`}
      role="button"
      onPress={() => nav.push({ name: "chat", botId: c().bot.id })}
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
          <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: props.p.text, numberOfLines: 1 }}>
            {c().pinned ? `${c().bot.name} · 置顶` : c().bot.name}
          </Text>
          <Text style={{ fontSize: 14, color: props.p.hint }}>{listTime(c().last?.date ?? c().bot.createdAt)}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, color: props.p.hint, numberOfLines: 2 }}>{preview()}</Text>
          <If when={c().unread > 0}>
            <Badge count={c().unread} muted={c().muted} p={props.p} />
          </If>
        </View>
      </View>
    </View>
  );
}

function SettingsTab(props: { p: Palette }) {
  const p = () => props.p;
  void loadStatus();
  const permission = () => {
    const n = status()?.notifications;
    return n === "authorized" ? "已开启" : n === "denied" ? "已关闭" : "未设置";
  };
  return (
    <View style={{ flex: 1, gap: 20 }}>
      <Header title="设置" p={p()} />
      <Section title="推送" p={p()} footer="通知被关闭时，消息仍会在打开 App 时同步过来。">
        <Row p={p()} first label="系统通知" value={permission()} onPress={() => void api.openNotificationSettings()} />
        <Row p={p()} label="设备注册" value={status()?.registered ? "已注册" : "未注册"} />
      </Section>
      <Section title="网关" p={p()}>
        <Row p={p()} first label={status()?.gatewayURL ?? "…"} />
        <Row p={p()} label="立即同步" color={p().accent} onPress={() => void api.refresh().then(reload)} />
      </Section>
    </View>
  );
}

function TabBar(props: { tab: Tab; onSelect: (t: Tab) => void; p: Palette }) {
  const unread = () => chats().reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
  const item = (t: Tab, label: string) => (
    <View
      testID={`tab-${t}`}
      role="tab"
      onPress={() => props.onSelect(t)}
      style={{ flex: 1, height: 64, alignItems: "center", justifyContent: "center", gap: 2 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 15, fontWeight: props.tab === t ? "600" : "500", color: props.tab === t ? props.p.accent : props.p.text }}>
          {label}
        </Text>
        <If when={t === "chats" && unread() > 0}>
          <Badge count={unread()} p={props.p} />
        </If>
      </View>
    </View>
  );
  return (
    <View
      style={{
        position: "absolute", left: 24, right: 24, bottom: safeArea().bottom + 8, height: 64,
        borderRadius: 32, backgroundColor: props.p.glass, flexDirection: "row",
        boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
      }}
    >
      {item("chats", "通知")}
      {item("settings", "设置")}
    </View>
  );
}
