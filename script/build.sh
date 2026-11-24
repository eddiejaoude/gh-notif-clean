#!/usr/bin/env bash
# Compiles src/cli.ts into one standalone executable per platform in dist/, with the
# Bun version in .bun-version. The release workflow runs it, then uploads everything in
# dist/ to a draft release and attests each file. CI runs it on every pull request.
#
# It needs no Bun installed. It downloads that version's release zips, checks each against
# .bun-sha256, builds with the bun from the zip for the machine it runs on, and builds each
# executable on the runtime from its own platform's zip. That machine must be macOS, or
# Linux with glibc, on x64 or arm64: Windows isn't a build host. To change the Bun version,
# update .bun-version and copy the six zips' lines from that release's SHASUMS256.txt into
# .bun-sha256.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(<.bun-version)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) host=darwin-aarch64 ;;
  Darwin-x86_64) host=darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) host=linux-aarch64 ;;
  Linux-x86_64) host=linux-x64 ;;
  *)
    echo "script/build.sh: builds on macOS or Linux, on x64 or arm64, not on $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

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

# fetch RUNTIME: downloads Bun's release zip for RUNTIME, such as linux-x64, checks it
# against .bun-sha256 and unpacks it into $runtimes/bun-RUNTIME, once per runtime.
fetch() {
  local zip=bun-$1.zip pinned got
  if [[ -d $runtimes/bun-$1 ]]; then
    return
  fi
  pinned=$(awk -v zip="$zip" '$2 == zip { print $1 }' .bun-sha256)
  if [[ -z $pinned ]]; then
    echo "script/build.sh: .bun-sha256 has no SHA-256 for $zip" >&2
    exit 1
  fi
  curl -fsSL --retry 3 -o "$runtimes/$zip" "https://github.com/oven-sh/bun/releases/download/bun-v$version/$zip"
  got=$("${sha256[@]}" "$runtimes/$zip" | cut -d' ' -f1)
  if [[ $got != "$pinned" ]]; then
    echo "script/build.sh: $zip has SHA-256 $got, but .bun-sha256 pins $pinned" >&2
    exit 1
  fi
  unzip -q "$runtimes/$zip" -d "$runtimes"
}

fetch "$host"
bun=$runtimes/bun-$host/bun
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
  fetch "$runtime"
  exe=$runtimes/bun-$runtime/bun
  if [[ $runtime == windows-* ]]; then
    exe+=.exe
  fi

  # By default the executable loads .env and bunfig.toml from the directory it runs in,
  # which is often a checkout of someone else's repository. A bunfig.toml can preload
  # any script, and a .env can set GH_HOST, so both are switched off.
  "$bun" build src/cli.ts --compile --target="bun-$bun_target" --compile-executable-path "$exe" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --outfile "dist/gh-notif-clean-$asset"
done
