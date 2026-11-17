import { signal, Text, View, safeArea } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { COLORS, Glyph, ICONS, presetAvatar } from "../components";
import { LEVELS } from "../format";
import { api, type Level } from "../host";
import { nav, reload } from "../store";
import { palette } from "../theme";

export function NewBot() {
  const p = palette;
  const name = signal("");
  const icon = signal("ship");
  const color = signal(COLORS[0]);
  const level = signal<Level>("active");
  const busy = signal(false);

  const create = async () => {
    const n = name().trim();
    if (!n || busy()) return;
    busy.set(true);
    try {
      const { bot, token } = await api.createBot(n, presetAvatar(icon(), color()), level());
      await reload();
      nav.replace({ name: "botCreated", botId: bot.id, token, botName: bot.name, avatar: bot.avatar });
    } catch (e) {
      await AlertDialog.show({ title: "创建失败", description: String((e as Error)?.message ?? e), actions: [{ id: "ok", label: "好" }] });
    } finally {
      busy.set(false);
    }
  };

  const caption = (t: string) => <Text style={{ marginLeft: 32, marginTop: 20, marginBottom: 6, fontSize: 13, color: p().hint }}>{t}</Text>;

  return (
    <NavPage title="新建 Bot" testID="new-bot-page" animation="default">
      <View style={{ flex: 1, backgroundColor: p().groupedBg }}>
        <View style={{ alignItems: "center", paddingTop: 16 }}>
          <Glyph icon={icon()} color={color()} size={96} />
        </View>

        {caption("图标")}
        <View style={{ marginLeft: 16, marginRight: 16, padding: 12, borderRadius: 12, backgroundColor: p().card, gap: 12 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between" }}>
            <Each of={Object.keys(ICONS)}>
              {(k) => (
                <View
                  role="button"
                  accessibilityLabel={k()}
                  onPress={() => icon.set(k())}
                  style={{ borderRadius: 24, borderWidth: 2, borderColor: icon() === k() ? p().accent : "transparent", padding: 2 }}
                >
                  <Glyph icon={k()} color={icon() === k() ? color() : "#8e8e93"} size={40} />
                </View>
              )}
            </Each>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Each of={COLORS}>
              {(c) => (
                <View
                  role="button"
                  accessibilityLabel={c()}
                  onPress={() => color.set(c())}
                  style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c(), borderWidth: 3, borderColor: color() === c() ? p().accent : p().card }}
                />
              )}
            </Each>
          </View>
        </View>

        {caption("名称")}
        <View style={{ marginLeft: 16, marginRight: 16, borderRadius: 12, backgroundColor: p().card, paddingLeft: 16, paddingRight: 16, height: 48, justifyContent: "center" }}>
          <Input
            testID="bot-name"
            value={name()}
            onChange={({ value }) => name.set(value)}
            onSubmit={() => void create()}
            placeholder="例如：Berth 部署"
            maxLength={64}
            returnKeyType="done"
            style={{ fontSize: 17, color: p().text }}
          />
        </View>
        <Text style={{ marginLeft: 32, marginRight: 32, marginTop: 6, fontSize: 13, color: p().hint }}>显示在会话列表和锁屏通知上。</Text>

        {caption("默认提醒级别")}
        <View style={{ marginLeft: 16, marginRight: 16, padding: 3, borderRadius: 10, backgroundColor: p().pill, flexDirection: "row", gap: 2 }}>
          <Each of={LEVELS}>
            {(l) => (
              <View
                role="button"
                onPress={() => level.set(l().id)}
                style={{
                  flex: 1, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center",
                  backgroundColor: level() === l().id ? p().card : "transparent",
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: level() === l().id ? "600" : "400", color: p().text }}>{l().label}</Text>
              </View>
            )}
          </Each>
        </View>
        <Text style={{ marginLeft: 32, marginRight: 32, marginTop: 6, fontSize: 13, lineHeight: 18, color: p().hint }}>
          静默只进通知中心，不响不亮屏；时效性可以穿透专注模式。发送时用 level 参数可以单条覆盖。
        </Text>

        <View style={{ flex: 1 }} />
        <View style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: safeArea().bottom + 16 }}>
          <View
            testID="create-bot"
            role="button"
            onPress={() => void create()}
            activeStyle={{ opacity: 0.85 }}
            style={{
              height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center",
              backgroundColor: name().trim() && !busy() ? p().accent : "#8e8e93",
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "600", color: "#ffffff" }}>{busy() ? "创建中…" : "创建 Bot"}</Text>
          </View>
        </View>
      </View>
    </NavPage>
  );
}
