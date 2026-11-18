// The in-app notification banner (design: 站内通知): a glass card that slides
// down from the top while the app is open. Tap opens the chat, swipe up
// dismisses it, and it leaves by itself after a few seconds (inapp.ts).
import { createAnimatedValue, effect, safeArea, signal, Text, View } from "nsh";
import { Avatar, FLOAT_SHADOW } from "./components";
import { tr } from "./i18n";
import { banner, dismissBanner, openBanner, type Banner } from "./inapp";
import { palette } from "./theme";

const HIDDEN = -160;

export function InAppBanner() {
  const p = palette;
  // What is drawn: it outlives `banner()` while sliding out.
  const shown = signal<Banner | null>(null);
  const y = createAnimatedValue(HIDDEN);
  const drag = createAnimatedValue(0);
  // Follows the finger upwards freely, downwards only a little.
  const pull = drag.interpolate({ inputRange: [-300, 0, 200], outputRange: [-300, 0, 24], extrapolate: "clamp" });

  effect(() => {
    const b = banner();
    if (b) {
      const fresh = !shown();
      shown.set(b);
      void drag.timing(0, { duration: 0 });
      if (fresh) void y.timing(HIDDEN, { duration: 0 }).then(() => y.spring(0, { damping: 20, stiffness: 220 }));
    } else if (shown()) {
      void y.timing(HIDDEN, { duration: 220, easing: "easeIn" }).then(() => shown.set(null));
    }
  });

  const glass = () => ({
    backgroundColor: p().banner,
    backdropFilter: "blur(24px) saturate(1.6)",
    glassEffect: "regular" as const,
    borderWidth: 0.5,
    borderColor: p().hairline,
    boxShadow: `inset 0 1px 0 ${p().glassRim}, 0 10px 30px rgba(0,0,0,0.16), ${FLOAT_SHADOW}`,
  });

  return (
    <If when={shown()}>
      {(b) => (
        <View
          style={{ position: "absolute", left: 10, right: 10, top: safeArea().top + 6, translate: [0, y], pointerEvents: "box-none" }}
        >
          {/* Another bot's banner was showing: a layer peeks out below. */}
          <If when={b().stacked}>
            <View style={{ position: "absolute", left: 12, right: 12, top: 14, bottom: -8, borderRadius: 24, ...glass(), opacity: 0.7 }} />
          </If>
          <View
            testID="in-app-banner"
            role="button"
            accessibilityLabel={`${b().name}: ${b().title} ${b().body}`}
            onPress={openBanner}
            pan={{ y: drag }}
            panActivation={{ activeOffsetY: 8, failOffsetX: 20 }}
            onPanEnd={(e) => {
              if (!e.cancelled && (e.translation.y < -30 || e.velocity.y < -500)) dismissBanner();
              else void drag.spring(0, { damping: 18, stiffness: 260 });
            }}
            style={{
              translate: [0, pull],
              flexDirection: "row", alignItems: "flex-start", gap: 12,
              paddingTop: 12, paddingBottom: 14, paddingLeft: 12, paddingRight: 14, borderRadius: 26,
              overflow: "hidden",
              ...glass(),
            }}
          >
            {/* Time-sensitive: an orange edge. */}
            <If when={b().timeSensitive}>
              <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: "#ff8a00" }} />
            </If>
            <Avatar avatar={b().avatar} size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: p().text, numberOfLines: 1 }}>{b().name}</Text>
                <Text testID="in-app-banner-meta" style={{ fontSize: 13, color: p().hint }}>
                  {b().count > 1 ? tr("{n} 条新消息", { n: b().count }) : tr("现在")}
                </Text>
              </View>
              <Text style={{ fontSize: 15, lineHeight: 20, color: p().text, numberOfLines: 2 }}>
                <If when={b().title}>
                  <Text style={{ fontWeight: "600" }}>{`${b().title}　`}</Text>
                </If>
                {b().body}
              </Text>
            </View>
            {/* The grab handle: swipe up to dismiss. */}
            <View style={{ position: "absolute", left: "50%", bottom: 5, width: 36, height: 4, marginLeft: -18, borderRadius: 2, backgroundColor: p().separator }} />
          </View>
        </View>
      )}
    </If>
  );
}
