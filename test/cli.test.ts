import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

// A reader that starts reading after 200 ms. The delay is real time on purpose: a reader that keeps
// up, like cat, sometimes drains the pipe before an early exit and hides the cut-off (1 run in 20 on
// Linux, Node 24). It's Node because POSIX `sleep` only takes whole seconds; "$0" is Node in runIntoPipe.
const slowReader = `"$0" -e 'setTimeout(() => process.stdin.pipe(process.stdout), 200)'`;

// Runs the CLI with stderr piped to the shell command `reader`. The output in these tests is larger
// than the 64 KiB a pipe holds, so the CLI has to wait for the reader before it exits. sh makes the
// pipe because Node's own child pipes are socket pairs, with a bigger buffer on Linux. The CLI's exit
// code comes back on sh's stderr.
function runIntoPipe(reader: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const script = `{ "$0" "$@" 2>&1 >/dev/null; echo $? >&3; } 3>&2 | ${reader}`;
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
  const { status, stderr } = runIntoPipe(slowReader, [option]);
  assert.equal(status, 2);
  assert.ok(stderr.startsWith(`Unknown option '${option}'`), `got ${stderr.length} bytes`);
  assert.match(stderr, /\nReasons for --keep-reason: [a-z_, ]+\n$/);
});

test("a reader that closes the pipe early doesn't change the exit code", posixPipes, () => {
  // head takes one byte and exits, so the rest of the usage error can't be written.
  const { status, stderr } = runIntoPipe("head -c 1", [`--${"x".repeat(100_000)}`]);
  assert.equal(status, 2);
  assert.equal(stderr, "U");
});

test("an error larger than a 64 KiB pipe arrives complete and exits 1", posixPipes, (t) => {
  // A gh with no login for any host, found before the real one, so the developer's logins and
  // token variables can't change the outcome. The run fails before reaching GitHub, naming the host twice.
  const dir = mkdtempSync(join(tmpdir(), "gh-notif-clean-"));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const host = `${"x".repeat(100_000)}.invalid`;
  const { status, stderr } = runIntoPipe(slowReader, [], { GH_HOST: host, PATH: `${dir}${delimiter}${process.env.PATH}` });
  assert.equal(status, 1);
  const expected = `gh notif-clean: gh is not logged in to ${host}; run: gh auth login --hostname ${host}\n`;
  assert.ok(stderr === expected, `got ${stderr.length} of ${expected.length} bytes`);
});
