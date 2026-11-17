#!/bin/sh
# Downloads nsh's iOS embedding frameworks into ios/Frameworks, checking the
# release's sha256. The version matches the nsh CLI that builds app/.
set -eu
version="${NSH_VERSION:-v0.5.1}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/ios/Frameworks"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

base="https://github.com/longbridge/nsh/releases/download/$version"
curl -fL --retry 3 -o "$tmp/nsh-embed-ios.zip" "$base/nsh-embed-ios.zip"
curl -fL --retry 3 -o "$tmp/nsh-embed-ios.zip.sha256" "$base/nsh-embed-ios.zip.sha256"
(cd "$tmp" && shasum -a 256 -c nsh-embed-ios.zip.sha256)

unzip -q "$tmp/nsh-embed-ios.zip" -d "$tmp/out"
mkdir -p "$dest"
rm -rf "$dest/NativeShell.xcframework" "$dest/NativeShellDev.xcframework"
mv "$tmp/out/nsh-embed-ios/NativeShell.xcframework" "$tmp/out/nsh-embed-ios/NativeShellDev.xcframework" "$dest/"
echo "nsh $version frameworks are in $dest"
