#!/bin/sh
# Builds the nsh app (app/) into app/dist/nsh, which the iOS and Android hosts
# ship as their UI. Xcode runs it before each build; it is also fine by hand.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/app/dist/nsh"
mkdir -p "$out"
if ! command -v nsh >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    [ -x "$p/nsh" ] && PATH="$p:$PATH" && break
  done
fi
if ! command -v nsh >/dev/null 2>&1; then
  echo "warning: nsh is not installed (brew install longbridge/tap/nsh); keeping the existing bundle in $out" >&2
  exit 0
fi
cd "$root/app"
nsh build App.tsx --release --out "$out"
