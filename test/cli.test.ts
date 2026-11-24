import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// A host gh has no login for: a run that got past validation would exit 1 without reaching GitHub.
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, GH_HOST: "invalid.invalid", ...env },
  });
}

// Runs the CLI with stderr piped to a reader that waits half a second before reading, as a busy
// `| jq` can: once the 64 KiB pipe is full, the CLI has to wait for it to drain before exiting.
// sh makes the pipe because Node's own child pipes are socket pairs, with a bigger buffer on Linux.
// The CLI's exit code comes back on sh's stderr.
function runIntoSlowPipe(args: string[], env: NodeJS.ProcessEnv = {}) {
  const script = '{ "$0" "$@" 2>&1 >/dev/null; echo $? >&3; } 3>&2 | { sleep 0.5; cat; }';
  const { stdout, stderr } = spawnSync("sh", ["-c", script, process.execPath, cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, GH_HOST: "invalid.invalid", ...env },
  });
  return { status: Number(stderr), stderr: stdout };
}

// Pipes on Windows are written synchronously, so output can't be cut off there, and there's no sh.
const posixPipes = { skip: process.platform === "win32" };

test("an unknown --keep-reason exits 2 and lists the valid reasons", () => {
  const { status, stdout, stderr } = run(["--keep-reason", "bogus"]);
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--keep-reason: unknown reason 'bogus'; valid: .*review_requested/);
});

test("--no-default-bots without --ignore exits 2 when GH_NOTIF_CLEAN_IGNORE is blank", () => {
  const { status, stdout, stderr } = run(["--no-default-bots"], { GH_NOTIF_CLEAN_IGNORE: " , " });
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--no-default-bots needs at least one --ignore LOGIN or GH_NOTIF_CLEAN_IGNORE entry/);
});

test("an invalid --since exits 2 before reaching GitHub", () => {
  const { status, stdout, stderr } = run(["--since", "7y"]);
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /^--since: .*'7y'/);
});

test("a usage error larger than a 64 KiB pipe arrives complete and exits 2", posixPipes, () => {
  // The unknown option is echoed back before the help text.
  const option = `--${"x".repeat(100_000)}`;
  const { status, stderr } = runIntoSlowPipe([option]);
  assert.equal(status, 2);
  assert.ok(stderr.startsWith(`Unknown option '${option}'`), `got ${stderr.length} bytes`);
  assert.match(stderr, /\nReasons for --keep-reason: [a-z_, ]+\n$/);
});

test("an error larger than a 64 KiB pipe arrives complete and exits 1", posixPipes, () => {
  // gh has no login for the host, so the run fails before reaching GitHub, naming the host twice.
  const host = `${"x".repeat(100_000)}.invalid`;
  const { status, stderr } = runIntoSlowPipe([], { GH_HOST: host });
  assert.equal(status, 1);
  assert.equal(stderr, `gh notif-clean: gh is not logged in to ${host}; run: gh auth login --hostname ${host}\n`);
});
