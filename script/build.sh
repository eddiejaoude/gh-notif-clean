#!/usr/bin/env bash
# Compiles src/cli.ts into one standalone executable per platform in dist/, with the
# Bun version in .bun-version. The release workflow runs this through
# cli/gh-extension-precompile, which passes the tag as $1 (unused here) and uploads
# everything in dist/. CI runs it on every pull request.
set -euo pipefail
cd "$(dirname "$0")/.."

want=$(<.bun-version)
have=$(bun --version)
if [[ $have != "$want" ]]; then
  echo "script/build.sh: .bun-version pins Bun $want, but bun is $have" >&2
  exit 1
fi

rm -rf dist

# Bun target, then the asset name's suffix: gh installs the asset whose name ends in
# <os>-<arch>, plus .exe on Windows.
targets=(
  darwin-arm64:darwin-arm64
  darwin-x64:darwin-amd64
  linux-x64:linux-amd64
  linux-arm64:linux-arm64
  windows-x64:windows-amd64.exe
  windows-arm64:windows-arm64.exe
)
for target in "${targets[@]}"; do
  # By default the executable loads .env and bunfig.toml from the directory it runs in,
  # which is often a checkout of someone else's repository. A bunfig.toml can preload
  # any script, and a .env can set GH_HOST, so both are switched off.
  bun build src/cli.ts --compile --target="bun-${target%%:*}" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --outfile "dist/gh-notif-clean-${target#*:}"
done
