import { openUrl, Text, View } from "nsh";
import type { Palette } from "./theme";
import { markdown, plainSpans, type Block, type Span } from "./markup";

/** A message body: Markdown when the message says so, else plain text with https links tapable. */
export function MessageBody(props: { body: string; markdown: boolean; p: Palette }) {
  const text = { fontSize: 16, lineHeight: 22, color: props.p.text };
  if (!props.markdown) {
    const spans = plainSpans(props.body);
    // No link: one plain Text, as before.
    if (!spans.some((s) => s.href)) return <Text style={text}>{props.body}</Text>;
    return <Text style={text}>{spans.map((s) => spanView(s, props.p))}</Text>;
  }
  const blocks = markdown(props.body);
  return <View style={{ gap: 6 }}>{blocks.map((b) => blockView(b, props.p, text))}</View>;
}

const open = (url: string) => void openUrl(url).catch(() => {});

function spanView(s: Span, p: Palette) {
  if (!s.href && !s.bold && !s.italic && !s.code) return s.text;
  const style: Record<string, unknown> = {};
  if (s.bold) style.fontWeight = "700";
  if (s.italic) style.fontStyle = "italic";
  if (s.code) {
    style.fontFamily = "Menlo";
    style.fontSize = 14;
  }
  if (s.href) {
    style.color = p.accent;
    style.textDecorationLine = "underline";
  }
  const href = s.href;
  return (
    <Text style={style as never} onPress={href ? () => open(href) : undefined}>
      {s.text}
    </Text>
  );
}

function blockView(b: Block, p: Palette, text: Record<string, unknown>) {
  switch (b.kind) {
    case "code":
      return (
        <View style={{ backgroundColor: p.pill, borderRadius: 8, padding: 10 }}>
          <Text style={{ fontFamily: "Menlo", fontSize: 13, color: p.text }}>{b.text}</Text>
        </View>
      );
    case "li":
      return (
        <View style={{ flexDirection: "row", gap: 6, paddingLeft: b.level * 14 }}>
          <Text style={text as never}>{b.marker}</Text>
          <Text style={{ ...text, flex: 1 } as never}>{b.spans.map((s) => spanView(s, p))}</Text>
        </View>
      );
    default:
      return <Text style={text as never}>{b.spans.map((s) => spanView(s, p))}</Text>;
  }
}
