import { Picker, signal, Text, View } from "nsh";
import { AlertDialog, Input, NavPage } from "nsh/base";
import { AvatarImage, COLORS, FormBody, Glyph, Icon, ICONS, localImage, parseAvatar, presetAvatar, rememberLocalImage } from "../components";
import { LEVELS } from "../format";
import { api, type Level } from "../host";
import { chatOf, nav, reload } from "../store";
import { palette, type Palette } from "../theme";
import { tr } from "../i18n";

const ICON_NAMES = Object.keys(ICONS);
/** The largest picked image kept (a 512 px PNG can be close to this); the hosts check it too. */
const MAX_IMAGE = 1024 * 1024;
/** The formats the hosts keep; anything else the picker gives is sent as JPEG and refused there. */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** A selection ring in the colour itself, unless that colour would vanish (black on a dark page). */
function ring(c: string, p: Palette): string {
  return c === "#1c1c1e" ? p.text : c;
}

/** Creates a bot, or with `botId` edits that one's name, look and default level. */
export function NewBot(props: { botId?: string }) {
  const p = palette;
  const editing = props.botId !== undefined ? chatOf(props.botId)?.bot : undefined;
  const look = editing ? parseAvatar(editing.avatar) : undefined;
  const name = signal(editing?.name ?? "");
  const icon = signal(look?.kind === "preset" ? look.icon : "bell");
  const color = signal(look?.kind === "preset" ? look.color : COLORS[0]);
  /** A picked image (`local:<file>`), which wins over the icon and colour until one of them is chosen. */
  const custom = signal(look?.kind === "local" ? editing!.avatar : "");
  const customImage = () => (custom() ? localImage(custom()) : null);
  const choose = (set: () => void) => {
    custom.set("");
    set();
  };
  const level = signal<Level>(editing?.defaultLevel ?? "active");
  const busy = signal(false);
  const ready = () => name().trim() !== "" && !busy();

  const create = async () => {
    if (!ready()) return;
    busy.set(true);
    try {
      if (editing) {
        // An https image avatar stays unless a preset was picked.
        const avatar = custom() || (look?.kind === "image" && icon() === "bell" && color() === COLORS[0] ? editing.avatar : presetAvatar(icon(), color()));
        await api.updateBot(editing.id, { name: name().trim(), avatar, defaultLevel: level() });
        await reload();
        nav.pop();
        return;
      }
      const { bot, token } = await api.createBot(name().trim(), custom() || presetAvatar(icon(), color()), level());
      await reload();
      nav.replace({ name: "botCreated", botId: bot.id, token, botName: bot.name, avatar: bot.avatar });
    } catch (e) {
      await AlertDialog.show({ title: editing ? tr("保存失败") : tr("创建失败"), description: String((e as Error)?.message ?? e), actions: [{ id: "ok", label: tr("好") }] });
    } finally {
      busy.set(false);
    }
  };

  /** The system photo picker; the image, scaled down, is kept on this phone as the avatar. */
  const pickImage = async () => {
    try {
      const [picked] = await Picker.pickImages({ maxDimension: 512, quality: 0.85 });
      if (!picked) return;
      const type = IMAGE_TYPES.includes(picked.file.type) ? picked.file.type : "image/jpeg";
      const bytes = new Uint8Array(await picked.file.arrayBuffer());
      if (bytes.length > MAX_IMAGE) throw new Error(tr("图片太大，请换一张小一点的"));
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const data = btoa(bin);
      const avatar = await api.saveAvatar(data, type);
      rememberLocalImage(avatar, `data:${type};base64,${data}`);
      custom.set(avatar);
    } catch (e) {
      // The hosts' messages are Chinese; tr() gives their English where the table has it.
      await AlertDialog.show({ title: tr("无法使用这张图片"), description: tr(String((e as Error)?.message ?? e)), actions: [{ id: "ok", label: tr("好") }] });
    }
  };

  return (
    <NavPage headerVisible={false} testID="new-bot-page">
      <FormBody
        p={p()}
        title={editing ? tr("编辑 Bot") : tr("新建 Bot")}
        onBack={() => nav.pop()}
        footer={
          <View
            testID="create-bot"
            role="button"
            onPress={() => void create()}
            activeStyle={{ opacity: 0.85 }}
            style={{
              height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center",
              backgroundColor: ready() ? p().accent : p().pill,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "600", color: ready() ? "#ffffff" : p().hint }}>{busy() ? (editing ? tr("保存中…") : tr("创建中…")) : editing ? tr("保存") : tr("创建 Bot")}</Text>
          </View>
        }
      >
        {/* What the bot will look like in the chat list. */}
        <View style={{ alignItems: "center", gap: 10, paddingTop: 20, paddingBottom: 8 }}>
          <AvatarImage testID="custom-avatar" src={customImage()} size={88} fallback={<Glyph icon={icon()} color={color()} size={88} hairline={p().hairline} />} />
          <Text style={{ fontSize: 20, fontWeight: "600", color: name().trim() ? p().text : p().hint, numberOfLines: 1 }}>
            {name().trim() || tr("新 Bot")}
          </Text>
        </View>

        <Caption p={p()} text={tr("外观")} />
        <View style={{ marginLeft: 16, marginRight: 16, borderRadius: 12, backgroundColor: p().card, paddingTop: 14, paddingBottom: 14 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12, paddingLeft: 8, paddingRight: 8 }}>
            <Each of={ICON_NAMES}>
              {(k) => (
                <View style={{ width: "20%", alignItems: "center" }}>
                  <View
                    testID={`icon-${k()}`}
                    role="button"
                    accessibilityLabel={k()}
                    onPress={() => choose(() => icon.set(k()))}
                    style={{
                      width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center",
                      borderWidth: 2, borderColor: !custom() && icon() === k() ? ring(color(), p()) : "transparent",
                    }}
                  >
                    <If
                      when={!custom() && icon() === k()}
                      else={<Glyph icon={k()} color={p().pill} stroke={p().hint} size={42} />}
                    >
                      <Glyph icon={k()} color={color()} size={42} hairline={p().hairline} />
                    </If>
                  </View>
                </View>
              )}
            </Each>
            {/* Last: an image of the user's own, from the photo library. */}
            <View style={{ width: "20%", alignItems: "center" }}>
              <View
                testID="icon-upload"
                role="button"
                accessibilityLabel={tr("上传图片")}
                onPress={() => void pickImage()}
                style={{
                  width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center",
                  borderWidth: 2, borderColor: custom() ? p().accent : "transparent",
                }}
              >
                <AvatarImage
                  src={customImage()}
                  size={42}
                  fallback={
                    <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: p().pill, alignItems: "center", justifyContent: "center" }}>
                      <Icon name="plus" color={p().hint} size={22} />
                    </View>
                  }
                />
              </View>
            </View>
          </View>
          <View style={{ height: 0.5, backgroundColor: p().separator, marginTop: 14, marginBottom: 14, marginLeft: 16 }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 16, paddingRight: 16 }}>
            <Each of={COLORS}>
              {(c) => (
                <View
                  testID={`color-${c()}`}
                  role="button"
                  accessibilityLabel={c()}
                  onPress={() => choose(() => color.set(c()))}
                  style={{
                    width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center",
                    borderWidth: 2, borderColor: !custom() && color() === c() ? ring(c(), p()) : "transparent",
                  }}
                >
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c(), borderWidth: 1, borderColor: p().hairline }} />
                </View>
              )}
            </Each>
          </View>
        </View>

        <Caption p={p()} text={tr("名称")} />
        <View style={{ marginLeft: 16, marginRight: 16, borderRadius: 12, backgroundColor: p().card, paddingLeft: 16, paddingRight: 16, height: 48, justifyContent: "center" }}>
          <Input
            testID="bot-name"
            value={name()}
            onChange={({ value }) => name.set(value)}
            onSubmit={() => void create()}
            placeholder={tr("例如：Berth 部署")}
            maxLength={64}
            returnKeyType="done"
            style={{ fontSize: 17, color: p().text }}
          />
        </View>
        <Footer p={p()} text={tr("显示在会话列表和锁屏通知上。")} />

        <Caption p={p()} text={tr("默认提醒级别")} />
        <View style={{ marginLeft: 16, marginRight: 16, padding: 2, borderRadius: 9, backgroundColor: p().segmentTrack, flexDirection: "row" }}>
          <Each of={LEVELS}>
            {(l) => (
              <View
                testID={`level-${l().id}`}
                role="button"
                onPress={() => level.set(l().id)}
                style={{
                  flex: 1, height: 32, borderRadius: 7, alignItems: "center", justifyContent: "center",
                  backgroundColor: level() === l().id ? p().segment : "transparent",
                  boxShadow: level() === l().id ? "0 1px 3px rgba(0,0,0,0.12)" : undefined,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: level() === l().id ? "600" : "500", color: p().text }}>{tr(l().label)}</Text>
              </View>
            )}
          </Each>
        </View>
        <Footer p={p()} text={tr("静默只进通知中心，不响铃不亮屏；时效性可以穿透专注模式。发送时用 level 参数可以单条覆盖。")} />
      </FormBody>
    </NavPage>
  );
}

function Caption(props: { p: Palette; text: string }) {
  return <Text style={{ marginLeft: 32, marginTop: 22, marginBottom: 7, fontSize: 13, color: props.p.hint }}>{props.text}</Text>;
}

function Footer(props: { p: Palette; text: string }) {
  return <Text style={{ marginLeft: 32, marginRight: 32, marginTop: 7, fontSize: 13, lineHeight: 18, color: props.p.hint }}>{props.text}</Text>;
}
