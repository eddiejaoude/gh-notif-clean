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

test("an invalid or zero --since exits 2 before reaching GitHub", () => {
  for (const duration of ["7y", "0d", "-7d"]) {
    const { status, stdout, stderr } = spawnSync(process.execPath, [cli, `--since=${duration}`], {
      encoding: "utf8",
      env: { ...process.env, GH_HOST: "invalid.invalid" },
    });
    assert.equal(status, 2, duration);
    assert.equal(stdout, "", duration);
    assert.match(stderr, new RegExp(`^--since: .*'${duration}'`), duration);
  }
});
