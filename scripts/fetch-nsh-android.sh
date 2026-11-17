#!/bin/sh
# Downloads nsh's Android embedding libraries (nsh.aar and nsh-dev.aar) into
# android/app/libs, checking the release's sha256. The version matches the nsh
# CLI that builds app/.
set -eu
version="${NSH_VERSION:-v0.5.1}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/android/app/libs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

base="https://github.com/longbridge/nsh/releases/download/$version"
curl -fL --retry 3 -o "$tmp/nsh-embed-android.zip" "$base/nsh-embed-android.zip"
curl -fL --retry 3 -o "$tmp/nsh-embed-android.zip.sha256" "$base/nsh-embed-android.zip.sha256"
(cd "$tmp" && shasum -a 256 -c nsh-embed-android.zip.sha256)

unzip -q "$tmp/nsh-embed-android.zip" -d "$tmp/out"
mkdir -p "$dest"
rm -f "$dest/nsh.aar" "$dest/nsh-dev.aar"
mv "$tmp/out/nsh-embed-android/nsh.aar" "$tmp/out/nsh-embed-android/nsh-dev.aar" "$dest/"
echo "nsh $version libraries are in $dest"
