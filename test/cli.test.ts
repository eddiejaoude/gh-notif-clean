import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("an unknown --keep-reason exits 2 and lists the valid reasons", () => {
  // A host gh has no login for: a run that got past validation would exit 1 without reaching GitHub.
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, "--keep-reason", "bogus"], {
    encoding: "utf8",
    env: { ...process.env, GH_HOST: "invalid.invalid" },
  });
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--keep-reason: unknown reason 'bogus'; valid: .*review_requested/);
});

function runWithEnvIgnore(args: string[], ignore: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, GH_HOST: "invalid.invalid", GH_NOTIF_CLEAN_IGNORE: ignore },
  });
}

test("--no-default-bots without --ignore exits 2 when GH_NOTIF_CLEAN_IGNORE is blank", () => {
  assert.equal(runWithEnvIgnore(["--no-default-bots"], " , ").status, 2);
});
