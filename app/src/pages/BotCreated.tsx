import { Clipboard, signal, Text, View, safeArea } from "nsh";
import { NavPage } from "nsh/base";
import { Avatar } from "../components";
import { curlExample } from "../format";
import { Confetti } from "../fx/Confetti";
import { nav, status } from "../store";
import { palette } from "../theme";
import { tr } from "../i18n";

export function BotCreated(props: { botId: number; token: string; botName: string; avatar: string }) {
  const p = palette;
  const copied = signal<"" | "token" | "curl">("");
  const example = () => curlExample(status()?.gatewayURL ?? "https://honk.example.com/", props.token);
  const copy = async (what: "token" | "curl") => {
    await Clipboard.writeText(what === "token" ? props.token : example());
    copied.set(what);
  };

  const caption = (t: string) => <Text style={{ marginLeft: 32, marginTop: 20, marginBottom: 6, fontSize: 13, color: p().hint }}>{t}</Text>;
  const copyRow = (what: "token" | "curl", label: string) => (
    <View
      testID={`copy-${what}`}
      role="button"
      onPress={() => void copy(what)}
      activeStyle={{ backgroundColor: p().pill }}
      style={{ height: 44, paddingLeft: 16, justifyContent: "center", borderTopWidth: 0.5, borderTopColor: p().separator, backgroundColor: p().card }}
    >
      <Text style={{ fontSize: 16, color: p().accent }}>{copied() === what ? tr("已复制") : label}</Text>
    </View>
  );

  return (
    <NavPage title="" headerBackVisible={false} popOnSwipe={false} testID="bot-created">
      <View style={{ flex: 1, backgroundColor: p().groupedBg }}>
        <View style={{ alignItems: "center", gap: 8, paddingTop: 16, paddingLeft: 32, paddingRight: 32 }}>
          <Avatar avatar={props.avatar} size={88} />
          <Text style={{ marginTop: 8, fontSize: 24, fontWeight: "700", color: p().text, textAlign: "center" }}>{tr("{name} 已创建", { name: props.botName })}</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: p().hint, textAlign: "center" }}>
            {tr("用下面的 token 发送通知。token 相当于密码，泄露后可以在设置里重置。")}
          </Text>
        </View>

        {caption("TOKEN")}
        <View style={{ marginLeft: 16, marginRight: 16, borderRadius: 12, overflow: "hidden" }}>
          <View selectable style={{ padding: 16, backgroundColor: p().card }}>
            <Text testID="token" style={{ fontFamily: "Menlo", fontSize: 15, lineHeight: 21, color: p().text }}>{props.token}</Text>
          </View>
          {copyRow("token", tr("复制 token"))}
        </View>

        {caption(tr("发送示例"))}
        <View style={{ marginLeft: 16, marginRight: 16, borderRadius: 12, overflow: "hidden" }}>
          <View style={{ padding: 16, backgroundColor: "#1c1c1e" }}>
            <Text style={{ fontFamily: "Menlo", fontSize: 12.5, lineHeight: 19, color: "#e5e5ea" }}>{example()}</Text>
          </View>
          {copyRow("curl", tr("复制示例"))}
        </View>

        <View style={{ flex: 1 }} />
        <View style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: safeArea().bottom + 16 }}>
          <View
            testID="enter-chat"
            role="button"
            onPress={() => nav.setRoutes([{ name: "home" }, { name: "chat", botId: props.botId }])}
            activeStyle={{ opacity: 0.85 }}
            style={{ height: 52, borderRadius: 14, backgroundColor: p().accent, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 17, fontWeight: "600", color: "#ffffff" }}>{tr("进入会话")}</Text>
          </View>
        </View>
        <Confetti />
      </View>
    </NavPage>
  );
}
