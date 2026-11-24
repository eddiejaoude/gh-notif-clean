#!/usr/bin/env bash
# Checks one compiled binary without reaching GitHub or any real gh login: flag handling,
# spawning gh, and that a directory's bunfig.toml and .env take no effect. The binary runs
# with nothing but a stub gh on PATH, so it also shows that it needs neither Node nor Bun.
# Testing a Windows binary needs Bun, to compile the stub gh.exe.
# Usage: script/test-binary.sh dist/gh-notif-clean-<os>-<arch>[.exe]
# check takes each condition in single quotes, to evaluate it after the run it checks.
# shellcheck disable=SC2016
set -euo pipefail

if [[ $# -ne 1 || ! -f $1 ]]; then
  echo "usage: script/test-binary.sh BINARY" >&2
  exit 2
fi
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stubs=$work/stubs
neutral=$work/neutral
hostile=$work/hostile
mkdir "$stubs" "$neutral" "$hostile"

# The stub gh records each call in $stubs/calls and is logged in to invalid.invalid only.
# gh is a native executable on Windows, so there the stub is one too.
if [[ $bin == *.exe ]]; then
  cat >"$work/gh.ts" <<'EOF'
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2).join(" ");
appendFileSync(join(dirname(process.execPath), "calls"), `${args}\n`);
if (args !== "auth token --hostname invalid.invalid") {
  console.error("stub gh: not logged in");
  process.exit(1);
}
console.log("stub-token");
EOF
  # Built with the release flags, as the stub also runs in the hostile directory.
  (cd "$work" && bun build gh.ts --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --outfile stubs/gh.exe >/dev/null)
else
  cat >"$stubs/gh" <<'EOF'
#!/bin/sh
echo "$*" >>"${0%/*}/calls"
if [ "$*" != "auth token --hostname invalid.invalid" ]; then
  echo "stub gh: not logged in" >&2
  exit 1
fi
echo stub-token
EOF
  chmod +x "$stubs/gh"
fi

# What a repository could commit to take over a run in its checkout.
echo 'preload = ["./preload.js"]' >"$hostile/bunfig.toml"
cat >"$hostile/preload.js" <<'EOF'
require("node:fs").writeFileSync(require("node:path").join(__dirname, "preload-ran"), "");
console.error("hostile preload ran");
EOF
printf 'GH_HOST=hostile.invalid\nGH_NOTIF_CLEAN_IGNORE=hostile-bot\n' >"$hostile/.env"

# run DIR [NAME=VALUE...] BINARY [ARG...]: runs BINARY in DIR with only the stub gh on PATH,
# without any variable the binary or gh reads apart from those given, GH_PATH included, so
# the binary finds the stub through PATH. Sets status, out, err and calls, the stub's log.
run() {
  local dir=$1
  shift
  rm -f "$stubs/calls"
  status=0
  (cd "$dir" && env -u GH_HOST -u GH_PATH -u GH_NOTIF_CLEAN_IGNORE -u GH_TOKEN -u GITHUB_TOKEN \
    -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN PATH="$stubs" "$@") \
    >"$work/out" 2>"$work/err" || status=$?
  out=$(<"$work/out")
  err=$(<"$work/err")
  calls=$(cat "$stubs/calls" 2>/dev/null || true)
}

failed=0
# check DESCRIPTION CONDITION: evaluates CONDITION against the last run.
check() {
  if eval "$2"; then
    echo "ok: $1"
  else
    printf 'FAIL: %s\n  exit: %s\n  stdout: %s\n  stderr: %s\n  gh calls: %s\n' \
      "$1" "$status" "$out" "$err" "$calls" >&2
    failed=1
  fi
}

run "$neutral" "$bin" --help
check "--help exits 0" '[[ $status == 0 && $out == "Mark GitHub notifications as done "* && -z $err ]]'

run "$neutral" "$bin" --bogus
check "an unknown flag exits 2" '[[ $status == 2 && -z $out && $err == *"--bogus"* && -z $calls ]]'

run "$neutral" "$bin" --keep-reason bogus
check "--keep-reason bogus exits 2" \
  '[[ $status == 2 && -z $out && $err == "--keep-reason: unknown reason "*bogus* && -z $calls ]]'

# A gh the binary can't spawn ends in "gh is not logged in", as a host gh has no login for
# does, so the stub's log shows that gh ran, and the DNS error that its token reached fetch.
run "$neutral" GH_HOST=invalid.invalid "$bin" --dry-run
check "gh is called once and its token reaches the network" \
  '[[ $status == 1 && -z $out && $calls == "auth token --hostname invalid.invalid" &&
    $err == "gh notif-clean: "*ENOTFOUND*invalid.invalid* ]]'

run "$hostile" "$bin" --dry-run --no-default-bots
check "a .env's GH_NOTIF_CLEAN_IGNORE takes no effect" \
  '[[ $status == 2 && $err == "--no-default-bots needs at least one "* && -z $calls ]]'

run "$hostile" "$bin" --dry-run
check "a .env's GH_HOST takes no effect" \
  '[[ $status == 1 && $calls == "auth token --hostname github.com" && $err == *"not logged in to github.com;"* ]]'

check "a bunfig.toml's preload doesn't run" '[[ ! -e $hostile/preload-ran ]]'

if ((failed)); then
  echo "script/test-binary.sh: $1 failed" >&2
  exit 1
fi
