import { signal, Text, View } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { FormBody, Row, Section } from "../components";
import { api, type Gateway, type GatewayTest } from "../host";
import { loadStatus, nav, reload } from "../store";
import { palette } from "../theme";
import { tr } from "../i18n";

type Check = { state: "idle" } | { state: "checking" } | { state: "done"; result: GatewayTest };

/** Where the app sends its requests: the build's default gateway, or one the user runs. */
export function GatewayPage() {
  const p = palette;
  const current = signal<Gateway | null>(null);
  const draft = signal("");
  const check = signal<Check>({ state: "idle" });
  const busy = signal(false);

  void api.gateway().then((g) => {
    current.set(g);
    draft.set(g.url);
  });

  const normalized = () => draft().trim();
  const changed = () => current() != null && normalized() !== "" && normalized() !== current()!.url;

  const test = async () => {
    if (!normalized()) return;
    check.set({ state: "checking" });
    try {
      check.set({ state: "done", result: await api.testGateway(normalized()) });
    } catch (e) {
      check.set({ state: "done", result: { ok: false, error: String((e as Error)?.message ?? e) } });
    }
  };

  const confirmSwitch = async (target: string) => {
    const { action } = await AlertDialog.show({
      title: tr("切换网关？"),
      description: tr("改用 {url}。这台设备会在新网关上重新注册，当前的 Bot 和消息会从这台设备上清除；它们在原网关上仍然保留。", { url: target }),
      actions: [{ id: "cancel", label: tr("取消"), role: "cancel" }, { id: "ok", label: tr("切换"), role: "destructive" }],
    });
    return action === "ok";
  };

  const apply = async (url: string | null) => {
    busy.set(true);
    try {
      await api.setGateway(url);
      await Promise.all([reload(), loadStatus()]);
      nav.setRoutes([{ name: "home" }]);
    } catch (e) {
      await AlertDialog.show({ title: tr("切换失败"), description: String((e as Error)?.message ?? e), actions: [{ id: "ok", label: tr("好") }] });
    } finally {
      busy.set(false);
    }
  };

  const save = async () => {
    if (!changed() || busy()) return;
    // Check first, so a typo never wipes the device.
    await test();
    const c = check();
    if (c.state !== "done" || !c.result.ok) return;
    if (await confirmSwitch(c.result.url ?? normalized())) await apply(normalized());
  };

  const restore = async () => {
    const g = current();
    if (!g || !g.custom || busy()) return;
    if (await confirmSwitch(g.defaultURL)) await apply(null);
  };

  const status = () => {
    const c = check();
    if (c.state === "checking") return { text: tr("正在连接…"), color: p().hint };
    if (c.state === "done" && c.result.ok) return { text: tr("连接正常 · 网关版本 {version}", { version: c.result.version || tr("未知") }), color: p().good };
    if (c.state === "done") return { text: c.result.error ?? tr("无法连接"), color: p().destructive };
    return null;
  };

  return (
    <NavPage headerVisible={false} testID="gateway-page">
      <FormBody
        p={p()}
        title={tr("网关")}
        onBack={() => nav.pop()}
        footer={
          <View
            testID="save-gateway"
            role="button"
            onPress={() => void save()}
            activeStyle={{ opacity: 0.85 }}
            style={{
              height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center",
              backgroundColor: changed() && !busy() ? p().accent : p().pill,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "600", color: changed() && !busy() ? "#ffffff" : p().hint }}>
              {busy() ? tr("切换中…") : tr("保存并切换")}
            </Text>
          </View>
        }
      >
        <View style={{ gap: 22, paddingTop: 16 }}>
          <Section
            title={tr("网关地址")}
            p={p()}
            footer={tr("自己部署了 Honk 网关时，填它的地址，例如 https://honk.example.com/。只填域名时默认使用 https。")}
          >
            <View style={{ height: 48, paddingLeft: 16, paddingRight: 16, justifyContent: "center" }}>
              <Input
                testID="gateway-url"
                value={draft()}
                onChange={({ value }) => {
                  draft.set(value);
                  check.set({ state: "idle" });
                }}
                onSubmit={() => void test()}
                placeholder="https://honk.example.com/"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                style={{ fontSize: 16, color: p().text }}
              />
            </View>
            <Row p={p()} label={tr("测试连接")} color={p().accent} onPress={() => void test()} testID="test-gateway" />
            <If when={status()}>
              {(s) => (
                <View style={{ minHeight: 44, paddingLeft: 16, paddingRight: 16, flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 0.5, borderTopColor: p().separator }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s().color }} />
                  <Text testID="gateway-status" style={{ flex: 1, fontSize: 15, color: s().color }}>{s().text}</Text>
                </View>
              )}
            </If>
          </Section>

          <Section title={tr("当前")} p={p()} footer={tr("切换后这台设备会在新网关上重新注册，本机的 Bot 和消息会被清除。")}>
            <Row p={p()} first label={current()?.url ?? "…"} value={current()?.custom ? tr("自定义") : tr("默认")} />
            <If when={current()?.custom}>
              <Row p={p()} label={tr("恢复默认网关")} color={p().destructive} onPress={() => void restore()} testID="restore-gateway" />
            </If>
          </Section>
        </View>
      </FormBody>
    </NavPage>
  );
}
