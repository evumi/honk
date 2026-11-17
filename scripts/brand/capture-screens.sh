#!/bin/sh
# Captures the app's screens with demo data for the App Store images, at the
# 6.9" iPhone size (440x956 points, 2x). Needs the nsh CLI and a Mac (it runs
# `nsh test --target macos`). Writes PNGs into $1 (default: build/screens) in
# the language of $2 (a locale, default en-US; zh-Hans-CN for Chinese).
set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(cd "$root" && mkdir -p "${1:-build/screens}" && cd "${1:-build/screens}" && pwd)"
locale="${2:-en-US}"
case "$locale" in zh*) bot_name="服务器告警" ;; *) bot_name="Server Alerts" ;; esac
test_file="$root/app/zz-capture.test.tsx"
trap 'rm -f "$test_file"' EXIT

cat > "$test_file" <<TSX
import { open, test } from "nsh/test";
const out = "$out";
// An iPhone 16 Pro Max-like screen: status bar and home indicator insets.
const size = { width: 440, height: 956, locale: "$locale", safeArea: { top: 62, bottom: 34, left: 0, right: 0 } };

test("chats", async () => {
  const app = await open("./App.tsx", { ...size, colorScheme: "light" });
  await app.waitFor("id:chat-1");
  await app.wait(400);
  await app.screenshot(out + "/chats.png");
});

test("chat", async () => {
  const app = await open("./App.tsx", { ...size, colorScheme: "light" });
  await app.press("id:chat-1");
  await app.waitFor("id:message-103");
  await app.wait(700);
  await app.screenshot(out + "/chat.png");
});

test("chat-dark", async () => {
  const app = await open("./App.tsx", { ...size, colorScheme: "dark" });
  await app.press("id:chat-1");
  await app.waitFor("id:message-103");
  await app.wait(700);
  await app.screenshot(out + "/chat-dark.png");
});

test("created", async () => {
  const app = await open("./App.tsx", { ...size, colorScheme: "light" });
  await app.press("id:new-bot");
  await app.press("id:icon-server");
  await app.press("id:color-#2f6f3e");
  await app.type("id:bot-name", "$bot_name");
  await app.press("id:create-bot");
  await app.waitFor("id:enter-chat");
  await app.wait(500);
  await app.screenshot(out + "/created.png");
});

test("gateway", async () => {
  const app = await open("./App.tsx", { ...size, colorScheme: "light" });
  await app.press("id:tab-settings");
  await app.press("id:gateway-row");
  await app.clear("id:gateway-url");
  await app.type("id:gateway-url", "https://honk.example.com/");
  await app.press("id:test-gateway");
  await app.wait(500);
  await app.screenshot(out + "/gateway.png");
});
TSX

cd "$root/app"
nsh test zz-capture.test.tsx --target macos
