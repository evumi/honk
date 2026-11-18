import { Clipboard, signal, Text, View } from "nsh";
import { NavPage } from "nsh/base";
import { Avatar, FormBody, Icon } from "../components";
import { curlExample } from "../format";
import { Confetti } from "../fx/Confetti";
import { nav, status } from "../store";
import { palette } from "../theme";
import { tr } from "../i18n";

type Sending = "idle" | "sending" | "sent" | "failed";

/** Sends one notification through the gateway's bot API with the new token. */
async function sendTest(gateway: string, token: string, botName: string): Promise<void> {
  const base = gateway.endsWith("/") ? gateway : gateway + "/";
  const res = await fetch(`${base}bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: tr("测试通知"), body: tr("{name} 已就绪，以后的通知都会出现在这里。", { name: botName }) }),
  });
  const reply = (await res.json().catch(() => null)) as { ok?: boolean } | null;
  if (!res.ok || !reply?.ok) throw new Error(`sendMessage ${res.status}`);
}

export function BotCreated(props: { botId: string; token: string; botName: string; avatar: string }) {
  const p = palette;
  const copied = signal<"" | "token" | "curl">("");
  const sending = signal<Sending>("idle");
  const gateway = () => status()?.gatewayURL ?? "https://honk.example.com/";
  const example = () => curlExample(gateway(), props.token);
  const copy = async (what: "token" | "curl") => {
    await Clipboard.writeText(what === "token" ? props.token : example());
    copied.set(what);
  };
  const test = async () => {
    if (sending() === "sending") return;
    sending.set("sending");
    try {
      await sendTest(gateway(), props.token, props.botName);
      sending.set("sent");
    } catch {
      sending.set("failed");
    }
  };
  const testLabel = () =>
    ({ idle: tr("发送一条测试通知"), sending: tr("发送中…"), sent: tr("已发送，看看通知"), failed: tr("发送失败，点按重试") })[sending()];

  const caption = (t: string) => <Text style={{ marginLeft: 32, marginTop: 20, marginBottom: 6, fontSize: 13, color: p().hint }}>{t}</Text>;
  const copyRow = (what: "token" | "curl", label: string) => (
    <View
      testID={`copy-${what}`}
      role="button"
      onPress={() => void copy(what)}
      activeStyle={{ backgroundColor: p().pill }}
      style={{
        height: 44, paddingLeft: 16, flexDirection: "row", alignItems: "center", gap: 6,
        borderTopWidth: 0.5, borderTopColor: p().separator, backgroundColor: p().card,
      }}
    >
      <Icon name={copied() === what ? "check" : "copy"} color={p().accent} size={17} weight={2} />
      <Text style={{ fontSize: 16, color: p().accent }}>{copied() === what ? tr("已复制") : label}</Text>
    </View>
  );

  return (
    <NavPage headerVisible={false} popOnSwipe={false} testID="bot-created">
      <FormBody
        p={p()}
        footer={
          <View style={{ gap: 10 }}>
            <View
              testID="send-test"
              role="button"
              onPress={() => void test()}
              activeStyle={{ opacity: 0.7 }}
              style={{ height: 52, borderRadius: 14, backgroundColor: p().card, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }}
            >
              <If when={sending() === "sent"}>
                <Icon name="check" color={p().good} size={18} weight={2.4} />
              </If>
              <Text style={{ fontSize: 17, fontWeight: "600", color: sending() === "failed" ? p().destructive : sending() === "sent" ? p().good : p().accent }}>
                {testLabel()}
              </Text>
            </View>
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
        }
      >
        <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingRight: 16, marginTop: -8 }}>
          <View testID="done" role="button" onPress={() => nav.setRoutes([{ name: "home" }])} activeStyle={{ opacity: 0.6 }} style={{ height: 44, paddingLeft: 8, justifyContent: "center" }}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: p().accent }}>{tr("完成")}</Text>
          </View>
        </View>

        <View style={{ alignItems: "center", gap: 8, paddingTop: 4, paddingLeft: 32, paddingRight: 32 }}>
          <View style={{ width: 88, height: 88 }}>
            <Avatar avatar={props.avatar} size={88} />
            <View
              style={{
                position: "absolute", right: -2, bottom: -2, width: 30, height: 30, borderRadius: 15,
                backgroundColor: p().good, borderWidth: 3, borderColor: p().groupedBg, alignItems: "center", justifyContent: "center",
              }}
            >
              <Icon name="check" color="#ffffff" size={15} weight={3} />
            </View>
          </View>
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
        <Text testID="e2e-hint" style={{ marginLeft: 32, marginRight: 32, marginTop: 8, fontSize: 13, lineHeight: 18, color: p().hint }}>
          {tr("要端到端加密？在 Bot 设置里打开，然后用 honk send --key 密钥 发送。")}
        </Text>
      </FormBody>
      <Confetti />
    </NavPage>
  );
}
