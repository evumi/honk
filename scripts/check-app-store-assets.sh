#!/bin/sh
# Fails if the iOS app icon or an App Store screenshot has an alpha channel:
# App Store Connect rejects those (alpha_channel), even when every pixel is
# opaque. scripts/brand/render.swift writes them as RGB.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
python3 -I - ios/App/Assets.xcassets/AppIcon.appiconset/*.png public/appstore/*/*/*.png <<'PY'
import struct, sys
bad = 0
for path in sys.argv[1:]:
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        print(f"{path}: not a PNG"); bad += 1; continue
    i, color, trns = 8, None, False
    while i < len(data):
        n, kind = struct.unpack(">I4s", data[i:i + 8])
        if kind == b"IHDR":
            color = data[i + 17]
        elif kind == b"tRNS":
            trns = True
        i += 12 + n
    # Colour types 4 and 6 carry alpha; tRNS adds transparency to the others.
    if color in (4, 6) or trns:
        print(f"{path}: has an alpha channel (PNG colour type {color}{', tRNS' if trns else ''})"); bad += 1
print(f"{len(sys.argv) - 1} App Store PNGs checked, {bad} with alpha")
sys.exit(1 if bad else 0)
PY
