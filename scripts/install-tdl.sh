#!/bin/sh
set -eu
# Official v0.20.4 release digests; never install an unpinned latest binary.
arch=${1:-$(dpkg --print-architecture)}
prefix=${2:-/usr/local}
case "$arch" in
  amd64) asset=tdl_Linux_64bit.tar.gz; digest=be251adca3ff96c14fd0417f179e9ff119b8073ed3b3c0ac6fe43ec05ebbda77 ;;
  arm64) asset=tdl_Linux_arm64.tar.gz; digest=d51f9f5d018a5dde6e208dbf27f61439aec30fc61b349e1363af5a3a576ec357 ;;
  *) echo 'Unsupported tdl image architecture (supported: amd64, arm64)' >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
  "https://github.com/iyear/tdl/releases/download/v0.20.4/$asset" -o "$tmp/tdl.tar.gz"
printf '%s  %s\n' "$digest" "$tmp/tdl.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/tdl.tar.gz" -C "$tmp" tdl LICENSE
install -d "$prefix/libexec" "$prefix/share/tdl"
install -m 0755 "$tmp/tdl" "$prefix/libexec/tdl"
install -m 0644 "$tmp/LICENSE" "$prefix/share/tdl/LICENSE"
