import { Clipboard, signal, Text, View } from "nsh";
import { NavPage } from "nsh/base";
import { FormBody, Icon, Section } from "../components";
import { deviceJoined } from "../format";
import { api } from "../host";
import { loadDevices, nav } from "../store";
import { palette } from "../theme";
import { tr } from "../i18n";

/** `m:ss` for a countdown in seconds. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Shows a pairing code for another phone. The code is only text (nsh has no
 * QR code API): the other phone types or pastes it. It lives 10 minutes and
 * works once; the page counts down and offers a new one afterwards, and goes
 * back by itself when a device joins the group.
 */
export function AddDevicePage() {
  const p = palette;
  const code = signal("");
  const error = signal("");
  const left = signal(0);
  const copied = signal(false);
  let expiresAt = 0;
  let timer: number | undefined;
  // The device list when the code was made; null when it could not be fetched.
  let known: { id: string }[] | null = null;
  // Bumped by every make(): a stale one must not start a timer.
  let makeSeq = 0;
  let generating = false;

  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const onTop = () => {
    const top = nav.routes()[nav.routes().length - 1];
    return top?.name === "addDevice";
  };
  let polls = 0;
  const tick = () => {
    if (!onTop()) return stop(); // the page was left
    left.set(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    if (left() === 0) return stop();
    // A device joined: back to the list, which shows it.
    if (++polls % 3 === 0) {
      void api.devices().then(async (list) => {
        if (deviceJoined(known, list) && onTop()) {
          await loadDevices();
          nav.pop();
        }
      }).catch(() => {});
    }
  };

  const make = async () => {
    if (generating) return;
    generating = true;
    const seq = ++makeSeq;
    stop();
    error.set("");
    code.set("");
    copied.set(false);
    try {
      const link = await api.createLink();
      const baseline = await api.devices().catch(() => null);
      if (seq !== makeSeq) return;
      known = baseline;
      stop();
      code.set(link.code);
      expiresAt = link.expiresAt;
      polls = 0;
      tick();
      timer = setInterval(tick, 1000);
    } catch (e) {
      if (seq === makeSeq) error.set(String((e as Error)?.message ?? e));
    } finally {
      generating = false;
    }
  };
  void make();

  const expired = () => code() !== "" && left() === 0;
  const copy = async () => {
    if (!code() || expired()) return;
    await Clipboard.writeText(code());
    copied.set(true);
  };

  const button = (label: string, onPress: () => void, testID: string) => (
    <View
      testID={testID}
      role="button"
      onPress={onPress}
      activeStyle={{ opacity: 0.85 }}
      style={{ height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: p().accent }}
    >
      <Text style={{ fontSize: 17, fontWeight: "600", color: "#ffffff" }}>{label}</Text>
    </View>
  );

  return (
    <NavPage headerVisible={false} testID="add-device-page">
      <FormBody
        p={p()}
        title={tr("添加设备")}
        onBack={() => nav.pop()}
        footer={
          <If when={error() !== "" || expired()} else={button(copied() ? tr("已复制") : tr("复制配对码"), () => void copy(), "copy-code")}>
            {button(tr("重新生成"), () => void make(), "regenerate-code")}
          </If>
        }
      >
        <View style={{ gap: 22, paddingTop: 16 }}>
          <Section
            p={p()}
            footer={tr("在新手机上打开 Honk，到「设置 → 设备 → 已有设备？输入配对码」，输入这串配对码。新手机加入后会和这台手机共用所有 Bot，每条通知都会推送到两台手机。")}
          >
            <View style={{ alignItems: "center", paddingTop: 22, paddingBottom: 22, paddingLeft: 12, paddingRight: 12, gap: 14 }}>
              <If when={error() === ""} else={<Text testID="link-error" style={{ fontSize: 15, color: p().destructive, textAlign: "center" }}>{error()}</Text>}>
                <If when={code() !== ""} else={<Text style={{ fontSize: 15, color: p().hint }}>{tr("正在生成…")}</Text>}>
                  <Icon name="key" color={expired() ? p().hint : p().accent} size={28} weight={2} />
                  <Text
                    testID="pairing-code"
                    style={{
                      fontSize: 22, lineHeight: 34, fontFamily: "Menlo", fontWeight: "600", textAlign: "center",
                      color: expired() ? p().hint : p().text,
                    }}
                  >
                    {code()}
                  </Text>
                  <Text testID="link-expiry" style={{ fontSize: 15, color: expired() ? p().destructive : p().hint }}>
                    {expired() ? tr("配对码已过期") : tr("{time} 后过期，只能用一次", { time: countdown(left()) })}
                  </Text>
                </If>
              </If>
            </View>
          </Section>
          <Section p={p()} footer={tr("配对码只经过网关一次，网关看不到它：它只存放用配对码加密过的数据。无论谁拿到配对码，都能在有效期内加入你的设备组，请只给你自己的手机。")}>
            <View style={{ height: 0 }} />
          </Section>
        </View>
      </FormBody>
    </NavPage>
  );
}
