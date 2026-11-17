import type { JSX } from "nsh";
import { Canvas, Image, Path2D, Text, View } from "nsh";
import type { Palette } from "./theme";

/** Preset icons, drawn on a 24-unit grid. The names match HonkKit's Avatar.symbols. */
export const ICONS: Record<string, string> = {
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0",
  ship: "M4 15h16l-2.5 4h-11z M7 15V9h7l3 6",
  alert: "M12 3l9.5 17h-19z M12 10v4 M12 17.5v.01",
  check: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M8 12.5l2.7 2.7L16 9.8",
  wallet: "M5.5 6h13a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-8A2.5 2.5 0 0 1 5.5 6z M3 10h18 M16 14.5h2",
  server: "M5.5 4h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M5.5 13h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M7 7.5h.01 M7 16.5h.01",
  chart: "M4 18l5-6 4 3 7-8 M15 7h5v5",
  box: "M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5L12 12l8.5-4.5 M12 12v9",
  cloud: "M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
};

export const COLORS = ["#1c1c1e", "#0a6ed1", "#2f6f3e", "#c2410c", "#6741d9", "#5c6770"];

export interface ParsedAvatar {
  kind: "preset" | "image";
  icon: string;
  color: string;
  url: string;
}

/** Reads `preset:<icon>:<#rrggbb>` or an https URL; anything else is the default bell. */
export function parseAvatar(s: string): ParsedAvatar {
  if (s.startsWith("https://")) return { kind: "image", icon: "bell", color: "#0a6ed1", url: s };
  const [kind, icon, color] = s.split(":");
  if (kind === "preset" && ICONS[icon] && /^#[0-9a-fA-F]{6}$/.test(color ?? "")) return { kind: "preset", icon, color, url: "" };
  return { kind: "preset", icon: "bell", color: "#0a6ed1", url: "" };
}

export function presetAvatar(icon: string, color: string): string {
  return `preset:${icon}:${color}`;
}

export function Avatar(props: { avatar: string; size: number }) {
  const a = () => parseAvatar(props.avatar);
  return (
    <If when={a().kind === "image"} else={<Glyph icon={a().icon} color={a().color} size={props.size} />}>
      <Image src={a().url} style={{ width: props.size, height: props.size, borderRadius: props.size / 2 }} />
    </If>
  );
}

export function Glyph(props: { icon: string; color: string; size: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, size) => {
        const r = size.width / 2;
        cx.fillStyle = props.color;
        cx.beginPath();
        cx.arc(r, r, r, 0, Math.PI * 2);
        cx.fill();
        const scale = (size.width * 0.5) / 24;
        cx.save();
        cx.translate(r - 12 * scale, r - 12 * scale);
        cx.scale(scale, scale);
        cx.strokeStyle = "#ffffff";
        cx.lineWidth = 1.8;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.stroke(new Path2D(ICONS[props.icon] ?? ICONS.bell));
        cx.restore();
      }}
    />
  );
}

/** A count in a pill; grey when muted. */
export function Badge(props: { count: number; muted?: boolean; p: Palette }) {
  return (
    <View
      style={{
        minWidth: 22, height: 22, paddingLeft: 7, paddingRight: 7, borderRadius: 11,
        backgroundColor: props.muted ? "#8e8e93" : props.p.accent, alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>{String(props.count)}</Text>
    </View>
  );
}

/** A grouped-list section in the iOS settings style. */
export function Section(props: { title?: string; footer?: string; p: Palette; children: JSX.Element }) {
  return (
    <View style={{ gap: 6 }}>
      <If when={props.title}>
        <Text style={{ marginLeft: 32, fontSize: 13, color: props.p.hint }}>{props.title}</Text>
      </If>
      <View style={{ marginLeft: 16, marginRight: 16, backgroundColor: props.p.card, borderRadius: 12, overflow: "hidden" }}>
        {props.children}
      </View>
      <If when={props.footer}>
        <Text style={{ marginLeft: 32, marginRight: 32, fontSize: 13, lineHeight: 18, color: props.p.hint }}>{props.footer}</Text>
      </If>
    </View>
  );
}

/** One row of a Section. */
export function Row(props: {
  p: Palette; label: string; value?: string; color?: string; first?: boolean; center?: boolean;
  onPress?: () => void; right?: JSX.Element; testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      role={props.onPress ? "button" : undefined}
      onPress={props.onPress}
      activeStyle={props.onPress ? { backgroundColor: props.p.pill } : undefined}
      style={{
        minHeight: 46, paddingLeft: 16, paddingRight: 16, flexDirection: "row", alignItems: "center", gap: 12,
        borderTopWidth: props.first ? 0 : 0.5, borderTopColor: props.p.separator,
        justifyContent: props.center ? "center" : "flex-start",
      }}
    >
      <Text style={{ flex: props.center ? 0 : 1, fontSize: 16, color: props.color ?? props.p.text }}>{props.label}</Text>
      <If when={props.value}>
        <Text style={{ fontSize: 16, color: props.p.hint }}>{props.value}</Text>
      </If>
      {props.right}
    </View>
  );
}
