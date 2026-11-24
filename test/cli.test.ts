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
