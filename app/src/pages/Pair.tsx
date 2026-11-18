import { Clipboard, signal, Text, View } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { FormBody, Row, Section } from "../components";
import { api } from "../host";
import { loadDevices, loadStatus, nav, reload } from "../store";
import { palette } from "../theme";
import { tr } from "../i18n";

/** Whether `text` has the 26 characters of a pairing code once dashes and spaces are gone. */
export function looksLikeCode(text: string): boolean {
  return text.replace(/[\s-]/g, "").length === 26;
}

/** Joins this phone to another phone's group with the code that phone shows. */
export function PairPage() {
  const p = palette;
  const draft = signal("");
  const busy = signal(false);
  const error = signal("");
  const ready = () => looksLikeCode(draft()) && !busy();

  const paste = async () => {
    try {
      const t = await Clipboard.readText();
      if (t) draft.set(t.trim());
    } catch {
      // No permission to read the clipboard: the code can be typed.
    }
  };

  const join = async () => {
    if (!ready()) return;
    busy.set(true);
    error.set("");
    try {
      await api.claimLink(draft().trim());
      await Promise.all([reload(), loadStatus(), loadDevices()]);
      nav.setRoutes([{ name: "home" }]);
      await AlertDialog.show({
        title: tr("已加入设备组"),
        description: tr("这台手机现在和你的其他设备共用同一批 Bot。你在新手机上原有的 Bot 也并入了设备组。"),
        actions: [{ id: "ok", label: tr("好") }],
      });
    } catch (e) {
      error.set(String((e as Error)?.message ?? e));
    } finally {
      busy.set(false);
    }
  };

  return (
    <NavPage headerVisible={false} testID="pair-page">
      <FormBody
        p={p()}
        title={tr("输入配对码")}
        onBack={() => nav.pop()}
        footer={
          <View
            testID="join-group"
            role="button"
            onPress={() => void join()}
            activeStyle={{ opacity: 0.85 }}
            style={{ height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: ready() ? p().accent : p().pill }}
          >
            <Text style={{ fontSize: 17, fontWeight: "600", color: ready() ? "#ffffff" : p().hint }}>{busy() ? tr("正在加入…") : tr("加入")}</Text>
          </View>
        }
      >
        <View style={{ gap: 22, paddingTop: 16 }}>
          <Section
            title={tr("配对码")}
            p={p()}
            footer={tr("在已有设备上打开「设置 → 设备 → 添加设备」，会显示 26 位配对码。大小写和短横线都不影响。")}
          >
            <View style={{ minHeight: 48, paddingLeft: 16, paddingRight: 16, justifyContent: "center" }}>
              <Input
                testID="pairing-input"
                value={draft()}
                onChange={({ value }) => {
                  draft.set(value);
                  error.set("");
                }}
                onSubmit={() => void join()}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="go"
                style={{ fontSize: 16, fontFamily: "Menlo", color: p().text }}
              />
            </View>
            <Row p={p()} label={tr("粘贴")} color={p().accent} onPress={() => void paste()} testID="paste-code" />
            <If when={error() !== ""}>
              <View style={{ minHeight: 44, paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16, borderTopWidth: 0.5, borderTopColor: p().separator }}>
                <Text testID="pair-error" style={{ fontSize: 15, color: p().destructive }}>{error()}</Text>
              </View>
            </If>
          </Section>
        </View>
      </FormBody>
    </NavPage>
  );
}
