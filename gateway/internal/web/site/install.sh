#!/bin/sh
# Installs honk, the Honk gateway binary and its command line, from the
# project's GitHub Releases, after checking the archive's sha256.
#
#   curl -fsSL https://<your gateway>/install.sh | sh
#
# Every gateway serves this file at /install.sh. Settings (environment):
#   HONK_VERSION       release tag to install, e.g. v1.2.3 (default: the newest
#                      release that has the command line in it)
#   HONK_INSTALL_DIR   where to put honk (default: /usr/local/bin when it is
#                      writable, else ~/.local/bin or ~/bin when one of them is
#                      on PATH, else ~/.local/bin)
#   HONK_DOWNLOAD_URL  a mirror: the directory that holds honk_<os>_<arch>.tar.gz
#                      and honk_checksums.txt of one release (replaces HONK_VERSION)
#
# Windows: download honk_windows_amd64.zip from the releases page instead.
set -eu

repo="evumi/honk"

say() { printf '%s\n' "$*" >&2; }
die() { say "honk install: $*"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported system $(uname -s); download a build from https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m); download a build from https://github.com/$repo/releases" ;;
esac
asset="honk_${os}_${arch}.tar.gz"

if [ -n "${HONK_DOWNLOAD_URL:-}" ] && [ -n "${HONK_VERSION:-}" ]; then
  die "set HONK_VERSION or HONK_DOWNLOAD_URL, not both (a mirror URL names one release)"
fi

# Plain http only for a mirror that asks for it; GitHub is https all the way,
# redirects included.
case "${HONK_DOWNLOAD_URL:-https:}" in
  http:*) proto='=https,http' ;;
  *) proto='=https' ;;
esac
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto "$proto" --proto-redir "$proto" --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  # GNU wget can refuse plain http (redirects included); BusyBox wget cannot.
  wget_https=""
  if [ "$proto" = '=https' ] && wget --help 2>&1 | grep -q -- --https-only; then wget_https="--https-only"; fi
  fetch() { wget -q $wget_https -O "$2" "$1"; }
else
  die "needs curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "needs sha256sum or shasum to check the download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t honk)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

if [ -n "${HONK_DOWNLOAD_URL:-}" ]; then
  base="${HONK_DOWNLOAD_URL%/}"
  label="$base"
elif [ -n "${HONK_VERSION:-}" ]; then
  version="$HONK_VERSION"
  case "$version" in v*) ;; *) version="v$version" ;; esac
  base="https://github.com/$repo/releases/download/$version"
  label="$version"
else
  # The newest release that carries the command line: a tag's release can
  # exist (the Android build attached to it) before or without honk's files.
  base="https://github.com/$repo/releases/latest/download"
  label="latest"
  if fetch "https://api.github.com/repos/$repo/releases?per_page=30" "$tmp/releases" 2>/dev/null; then
    url="$(tr ',' '\n' <"$tmp/releases" | grep -o '"browser_download_url": *"https://[^"]*/honk_checksums\.txt"' | head -n 1 | sed 's/.*"\(https:[^"]*\)"$/\1/')" || true
    if [ -n "$url" ]; then
      base="${url%/honk_checksums.txt}"
      label="${base##*/}"
    fi
  fi
fi

say "Downloading $asset ($label)…"
fetch "$base/$asset" "$tmp/$asset" || die "could not download $base/$asset"
fetch "$base/honk_checksums.txt" "$tmp/sums" || die "could not download $base/honk_checksums.txt"

want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/sums")"
[ -n "$want" ] || die "$asset is not in honk_checksums.txt"
got="$(sha256 "$tmp/$asset")"
[ "$want" = "$got" ] || die "checksum mismatch for $asset (want $want, got $got)"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/honk" ] || die "the archive has no honk binary"

on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
dir="${HONK_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
  else
    dir="$HOME/.local/bin"
    for d in "$HOME/.local/bin" "$HOME/bin"; do
      if on_path "$d"; then dir="$d"; break; fi
    done
  fi
fi
mkdir -p "$dir" || die "cannot create $dir (set HONK_INSTALL_DIR, or run with sudo)"
# Write next to the target and rename, so a running honk is never half overwritten.
cp "$tmp/honk" "$dir/.honk.new"
chmod 755 "$dir/.honk.new"
mv -f "$dir/.honk.new" "$dir/honk"

say "Installed $("$dir/honk" version 2>/dev/null || echo honk) to $dir/honk"
if ! on_path "$dir"; then
  # Name the file the user's login shell actually reads.
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" line="export PATH=\"$dir:\$PATH\"" ;;
    */bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\"" ;;
    */fish) rc="$HOME/.config/fish/config.fish" line="fish_add_path $dir" ;;
    *) rc="$HOME/.profile" line="export PATH=\"$dir:\$PATH\"" ;;
  esac
  say ""
  say "$dir is not on your PATH. Add it, then open a new terminal:"
  say "  echo '$line' >> $rc"
  say "Or install system-wide instead:"
  say "  curl -fsSL <this URL> | sudo env HONK_INSTALL_DIR=/usr/local/bin sh"
fi
say "Next: export HONK_URL=<gateway> HONK_TOKEN=<bot token>; honk send \"hello\""
