#!/usr/bin/env bash
# Compiles src/cli.ts into one standalone executable per platform in dist/, with the
# Bun version in .bun-version. The release workflow runs this through
# cli/gh-extension-precompile, which passes the tag as $1 (unused here) and uploads
# everything in dist/. CI runs it on every pull request.
#
# Each executable is built on the Bun runtime from that version's release zip, which is
# downloaded and checked against .bun-sha256 first. To change the Bun version, update
# .bun-version and copy the six zips' lines from that release's SHASUMS256.txt into
# .bun-sha256.
set -euo pipefail
cd "$(dirname "$0")/.."

want=$(<.bun-version)
have=$(bun --version)
if [[ $have != "$want" ]]; then
  echo "script/build.sh: .bun-version pins Bun $want, but bun is $have" >&2
  exit 1
fi

# bun build --compile takes a file named like bun-linux-x64-v1.4.5 in the working directory
# as the runtime for that target, unchecked.
for file in bun-*-v*; do
  if [[ -e $file ]]; then
    echo "script/build.sh: remove $file first: bun build would use it as a runtime" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null; then
  sha256=(sha256sum)
else
  sha256=(shasum -a 256)
fi
runtimes=$(mktemp -d)
trap 'rm -rf "$runtimes"' EXIT
rm -rf dist

# Bun target, the runtime's name in Bun's release, and the asset name's suffix: gh installs
# the asset whose name ends in <os>-<arch>, plus .exe on Windows.
targets=(
  darwin-arm64:darwin-aarch64:darwin-arm64
  darwin-x64:darwin-x64:darwin-amd64
  linux-x64:linux-x64:linux-amd64
  linux-arm64:linux-aarch64:linux-arm64
  windows-x64:windows-x64:windows-amd64.exe
  windows-arm64:windows-aarch64:windows-arm64.exe
)
for target in "${targets[@]}"; do
  IFS=: read -r bun_target runtime asset <<<"$target"
  zip=bun-$runtime.zip
  pinned=$(awk -v zip="$zip" '$2 == zip { print $1 }' .bun-sha256)
  if [[ -z $pinned ]]; then
    echo "script/build.sh: .bun-sha256 has no SHA-256 for $zip" >&2
    exit 1
  fi
  curl -fsSL --retry 3 -o "$runtimes/$zip" "https://github.com/oven-sh/bun/releases/download/bun-v$want/$zip"
  got=$("${sha256[@]}" "$runtimes/$zip" | cut -d' ' -f1)
  if [[ $got != "$pinned" ]]; then
    echo "script/build.sh: $zip has SHA-256 $got, but .bun-sha256 pins $pinned" >&2
    exit 1
  fi
  unzip -q "$runtimes/$zip" -d "$runtimes"
  exe=$runtimes/bun-$runtime/bun
  if [[ $runtime == windows-* ]]; then
    exe+=.exe
  fi

  # By default the executable loads .env and bunfig.toml from the directory it runs in,
  # which is often a checkout of someone else's repository. A bunfig.toml can preload
  # any script, and a .env can set GH_HOST, so both are switched off.
  bun build src/cli.ts --compile --target="bun-$bun_target" --compile-executable-path "$exe" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --outfile "dist/gh-notif-clean-$asset"
done
