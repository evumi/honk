import type { JSX } from "nsh";
import { Canvas, Image, signal, keyboardFrame, Path2D, safeArea, Scroll, Text, View } from "nsh";
import { api } from "./host";
import { badgeText } from "./format";
import { tr } from "./i18n";
import { palette, type Palette } from "./theme";

/** Preset icons, drawn on a 24-unit grid. The names match HonkKit's Avatar.symbols. */
export const ICONS: Record<string, string> = {
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0",
  alert: "M12 3l9.5 17h-19z M12 10v4 M12 17.5v.01",
  check: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M8 12.5l2.7 2.7L16 9.8",
  wallet: "M5.5 6h13a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-8A2.5 2.5 0 0 1 5.5 6z M3 10h18 M16 14.5h2",
  server: "M5.5 4h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M5.5 13h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M7 7.5h.01 M7 16.5h.01",
  chart: "M4 18l5-6 4 3 7-8 M15 7h5v5",
  box: "M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5L12 12l8.5-4.5 M12 12v9",
  cloud: "M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
};

/** Interface icons on the same 24-unit grid, stroked with no disc. */
export const UI_ICONS: Record<string, string> = {
  back: "M15 18l-6-6 6-6",
  chevron: "M9 18l6-6-6-6",
  down: "M6 9l6 6 6-6",
  bell: "M10.27 21a2 2 0 0 0 3.46 0 M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33",
  bellOff: "M10.27 21a2 2 0 0 0 3.46 0 M17 17H4a1 1 0 0 1-.74-1.67C4.59 13.96 6 12.5 6 8a6 6 0 0 1 .26-1.74 M8.67 3.01A6 6 0 0 1 18 8c0 2.69.77 4.65 1.71 6.05 M2 2l20 20",
  check: "M20 6L9 17l-5-5",
  copy: "M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z M4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2",
  trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6",
  plus: "M12 5v14 M5 12h14",
  key: "M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.41-.59l.82-.81a6.5 6.5 0 1 0-4-4z M16.5 7a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1z",
};

/** A bare stroked icon from `UI_ICONS` (or `ICONS`). */
export function Icon(props: { name: string; color: string; size: number; weight?: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, size) => {
        const scale = size.width / 24;
        cx.scale(scale, scale);
        cx.strokeStyle = props.color;
        cx.lineWidth = props.weight ?? 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.stroke(new Path2D(UI_ICONS[props.name] ?? ICONS[props.name] ?? ""));
      }}
    />
  );
}

/** The shadow under floating glass controls. */
export const FLOAT_SHADOW = "0 4px 16px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)";

/** The size of the floating bar's controls (back button, title pill, avatar). */
export const BAR_H = 46;

/**
 * A floating glass control's surface: Liquid Glass on iOS 26 and later, a
 * translucent blur before that.
 */
export function glass(p: Palette) {
  return {
    backgroundColor: p.glass, backdropFilter: "blur(14px) saturate(1.5)", glassEffect: "regular" as const,
    // A bright rim on top, as light catches the edge of glass.
    boxShadow: `inset 0 1px 0 ${p.glassRim}, ${FLOAT_SHADOW}`, borderWidth: 0.5, borderColor: p.hairline,
  };
}

/** Progressive blur: each layer blurs more and covers a band nearer the edge. */
// Three layers: each is a backdrop blur redone every frame while content
// scrolls under it, so more of them cost smoothness for little gain.
const BLUR_STEPS = [1, 4, 12];

/**
 * A progressive blur along the top or bottom edge, as iOS draws under its
 * bars: stacked layers, each blurring more and masked to a band nearer the
 * edge, so the blur grows smoothly instead of a blurred copy fading in over a
 * sharp one. `tint` (the page's background) washes in lightly towards the
 * edge so the floating controls stay readable over busy content.
 */
export function EdgeBlur(props: { edge: "top" | "bottom"; height: number; tint?: string }) {
  // Gradients run from the inner side (0%) to the edge (100%).
  const dir = props.edge === "top" ? "to top" : "to bottom";
  const n = BLUR_STEPS.length;
  const band = (i: number) => {
    const at = (k: number) => `${Math.max(0, Math.min(100, (k * 100) / (n + 1))).toFixed(1)}%`;
    return `linear-gradient(${dir}, transparent ${at(i)}, #000 ${at(i + 1)}, #000 ${at(i + 2)}, transparent ${at(i + 3)})`;
  };
  return (
    <View
      style={{
        position: "absolute", left: 0, right: 0, height: props.height, pointerEvents: "none",
        ...(props.edge === "top" ? { top: 0 } : { bottom: 0 }),
      }}
    >
      {BLUR_STEPS.map((r, i) => (
        <View
          style={{
            position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
            backdropFilter: `blur(${r}px)`,
            // The last layer runs all the way to the edge.
            maskImage: i === n - 1 ? `linear-gradient(${dir}, transparent ${((i * 100) / (n + 1)).toFixed(1)}%, #000 ${(((i + 1) * 100) / (n + 1)).toFixed(1)}%)` : band(i),
          }}
        />
      ))}
      <If when={props.tint}>
        <View
          style={{
            position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
            backgroundImage: `linear-gradient(${dir}, transparent, ${props.tint})`,
            opacity: 0.55,
          }}
        />
      </If>
    </View>
  );
}

/**
 * The floating navigation of a page (the app draws its own, as in the
 * design): a round glass back button, the title in a glass pill, and an
 * optional item on the right (an avatar), over a blurred top edge.
 */
export interface BarAction { label: string; onPress: () => void; testID?: string }

export function TopBar(props: {
  /** The page's background, washed in lightly behind the bar. */
  tint?: string;
  p: Palette; title?: string; subtitle?: string; onBack?: () => void; right?: JSX.Element; action?: BarAction; testID?: string;
}) {
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: safeArea().top + BAR_H + 26, pointerEvents: "box-none" }}>
      <EdgeBlur edge="top" height={safeArea().top + BAR_H + 30} tint={props.tint} />
      <View
        testID={props.testID}
        style={{ position: "absolute", left: 12, right: 12, top: safeArea().top + 2, flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        <If when={props.onBack} else={<View style={{ width: BAR_H }} />}>
          <View
            testID="back"
            role="button"
            accessibilityLabel={tr("返回")}
            onPress={() => props.onBack?.()}
            activeStyle={{ opacity: 0.7 }}
            style={{ width: BAR_H, height: BAR_H, borderRadius: BAR_H / 2, alignItems: "center", justifyContent: "center", ...glass(props.p) }}
          >
            <Icon name="back" color={props.p.text} size={28} weight={2} />
          </View>
        </If>
        <If when={props.title} else={<View style={{ flex: 1 }} />}>
          <View style={{ flex: 1, height: BAR_H, borderRadius: BAR_H / 2, alignItems: "center", justifyContent: "center", paddingLeft: 14, paddingRight: 14, ...glass(props.p) }}>
            <Text style={{ fontSize: 17, lineHeight: 21, fontWeight: "600", color: props.p.text, numberOfLines: 1 }}>{props.title}</Text>
            <If when={props.subtitle}>
              <Text style={{ fontSize: 13, lineHeight: 16, color: props.p.hint, numberOfLines: 1 }}>{props.subtitle}</Text>
            </If>
          </View>
        </If>
        <If
          when={props.action}
          else={
            <If when={props.right} else={<View style={{ width: BAR_H }} />}>
              {/* A glass ring around the avatar, as the other controls. */}
              <View style={{ width: BAR_H, height: BAR_H, borderRadius: BAR_H / 2, padding: 3, ...glass(props.p) }}>{props.right}</View>
            </If>
          }
        >
          {(a) => (
            <View
              testID={a().testID}
              role="button"
              onPress={() => a().onPress()}
              activeStyle={{ opacity: 0.7 }}
              style={{ height: BAR_H, minWidth: BAR_H, paddingLeft: 18, paddingRight: 18, borderRadius: BAR_H / 2, alignItems: "center", justifyContent: "center", ...glass(props.p) }}
            >
              <Text style={{ fontSize: 17, color: props.p.text }}>{a().label}</Text>
            </View>
          )}
        </If>
      </View>
    </View>
  );
}

/** Avatar colours; the first is the default for a new bot. */
export const COLORS = ["#0a6ed1", "#2f6f3e", "#c2410c", "#6741d9", "#c2255c", "#5c6770", "#1c1c1e"];

export interface ParsedAvatar {
  /** `local`: an image the user picked, kept on this phone only (`local:<file>`). */
  kind: "preset" | "image" | "local";
  icon: string;
  color: string;
  url: string;
}

/**
 * Reads `preset:<icon>:<#rrggbb>`, an https URL or `local:<file>`; anything
 * else is the default bell. A preset whose icon the app no longer offers (the
 * ship) keeps its colour with the bell.
 */
export function parseAvatar(s: string): ParsedAvatar {
  if (s.startsWith("https://")) return { kind: "image", icon: "bell", color: "#0a6ed1", url: s };
  if (/^local:[A-Za-z0-9_-]+\.(jpg|png|webp|gif)$/.test(s)) return { kind: "local", icon: "bell", color: "#0a6ed1", url: "" };
  const [kind, icon, color] = s.split(":");
  if (kind === "preset" && /^#[0-9a-fA-F]{6}$/.test(color ?? "")) return { kind: "preset", icon: ICONS[icon] ? icon : "bell", color, url: "" };
  return { kind: "preset", icon: "bell", color: "#0a6ed1", url: "" };
}

export function presetAvatar(icon: string, color: string): string {
  return `preset:${icon}:${color}`;
}

/** Local avatars' images as `data:` URLs, read from the host once each; `null`: the file is gone. */
const localImages = signal<Record<string, string | null>>({});
const loading = new Set<string>();

/** The image of a `local:` avatar, loading it the first time; `null` until then or when it is gone. */
export function localImage(avatar: string): string | null {
  const v = localImages()[avatar];
  if (v === undefined && !loading.has(avatar)) {
    loading.add(avatar);
    api.avatarImage(avatar).then(
      (url) => localImages.update((m) => ({ ...m, [avatar]: url })),
      // Not answered (the host not ready yet): ask again on the next render.
      () => loading.delete(avatar),
    );
  }
  return v ?? null;
}

/** Remembers the image of an avatar just saved, so it shows without asking the host. */
export function rememberLocalImage(avatar: string, url: string) {
  loading.add(avatar);
  localImages.update((m) => ({ ...m, [avatar]: url }));
}

/** Image sources that failed to load; their avatars fall back to the glyph. */
const broken = signal<Record<string, true>>({});

/** An avatar image that falls back to `fallback` when it cannot be shown. */
export function AvatarImage(props: { src: string | null; size: number; fallback: JSX.Element; testID?: string }) {
  const ok = () => props.src && !broken()[props.src];
  return (
    <If when={ok()} else={props.fallback}>
      <Image
        testID={props.testID}
        src={props.src ?? ""}
        onError={() => props.src && broken.update((m) => ({ ...m, [props.src!]: true }))}
        style={{ width: props.size, height: props.size, borderRadius: props.size / 2 }}
      />
    </If>
  );
}

export function Avatar(props: { avatar: string; size: number; iconScale?: number }) {
  const a = () => parseAvatar(props.avatar);
  const src = () => (a().kind === "local" ? localImage(props.avatar) : a().kind === "image" ? a().url : null);
  return (
    <AvatarImage
      src={src()}
      size={props.size}
      fallback={<Glyph icon={a().icon} color={a().color} size={props.size} hairline={palette().hairline} iconScale={props.iconScale} />}
    />
  );
}

/** A preset avatar: `icon` stroked in `stroke` (white) on a `color` disc, with an optional hairline edge. */
export function Glyph(props: { icon: string; color: string; size: number; stroke?: string; hairline?: string; iconScale?: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, size) => {
        const r = size.width / 2;
        cx.fillStyle = props.color;
        cx.beginPath();
        cx.arc(r, r, r, 0, Math.PI * 2);
        cx.fill();
        if (props.hairline) {
          cx.strokeStyle = props.hairline;
          cx.lineWidth = 1;
          cx.beginPath();
          cx.arc(r, r, r - 0.5, 0, Math.PI * 2);
          cx.stroke();
        }
        const scale = (size.width * (props.iconScale ?? 0.5)) / 24;
        cx.save();
        cx.translate(r - 12 * scale, r - 12 * scale);
        cx.scale(scale, scale);
        cx.strokeStyle = props.stroke ?? "#ffffff";
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
      <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>{badgeText(props.count)}</Text>
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
  onPress?: () => void; right?: JSX.Element; testID?: string; chevron?: boolean; mono?: boolean;
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
      <Text style={{ flex: props.center ? undefined : 1, textAlign: props.center ? "center" : undefined, fontSize: props.mono ? 15 : 16, fontFamily: props.mono ? "Menlo" : undefined, color: props.color ?? props.p.text }}>{props.label}</Text>
      <If when={props.value}>
        <Text style={{ fontSize: 16, color: props.p.hint }}>{props.value}</Text>
      </If>
      {props.right}
      <If when={props.chevron}>
        <Icon name="chevron" color={props.p.separator} size={18} weight={2.2} />
      </If>
    </View>
  );
}

/**
 * A grouped-style page: the floating `TopBar` (when it has a `title`), content
 * that scrolls under it (so nothing is pushed off a small screen or under
 * large text), and `footer` (the page's main button) pinned above the home
 * indicator, or above the keyboard while it is up.
 */
export function FormBody(props: {
  p: Palette;
  children: JSX.Element;
  title?: string;
  onBack?: () => void;
  action?: BarAction;
  footer?: JSX.Element;
}) {
  const bar = () => props.title !== undefined || props.onBack !== undefined || props.action !== undefined;
  const bottom = () => Math.max(safeArea().bottom, keyboardFrame().height);
  return (
    <View style={{ flex: 1, backgroundColor: props.p.groupedBg }}>
      <Scroll
        style={{ flex: 1 }}
        contentStyle={{
          paddingTop: safeArea().top + (bar() ? 60 : 16),
          paddingBottom: props.footer ? 16 : bottom() + 24,
        }}
        keyboardDismissMode="interactive"
      >
        {props.children}
      </Scroll>
      <If when={props.footer}>
        <View style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: bottom() + (bottom() > 0 ? 8 : 16), backgroundColor: props.p.groupedBg }}>
          {props.footer}
        </View>
      </If>
      <If when={bar()}>
        <TopBar p={props.p} tint={props.p.groupedBg} title={props.title} onBack={props.onBack} action={props.action} />
      </If>
    </View>
  );
}
