import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apiBaseUrl, createApi, findGh, ghAuth, HttpError } from "../src/github.ts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

test("getAll follows Link pages and retries server errors", async () => {
  const calls: string[] = [];
  const pages: Response[] = [
    json([1, 2], { headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' } }),
    json({ message: "bad gateway" }, { status: 502 }),
    json([3]),
  ];
  const api = createApi({
    token: "t",
    baseUrl: "https://api.github.com",
    retryDelayMs: 0,
    fetch: async (url) => {
      calls.push(String(url));
      return pages.shift()!;
    },
  });

  assert.deepEqual(await api.getAll<number>("notifications"), [1, 2, 3]);
  assert.deepEqual(calls, [
    "https://api.github.com/notifications?per_page=100",
    "https://api.github.com/notifications?page=2",
    "https://api.github.com/notifications?page=2",
  ]);
});

test("getAll unwraps keyed lists on every page", async () => {
  const pages: Response[] = [
    json({ total_count: 3, check_runs: [1, 2] }, { headers: { link: '<https://api.github.com/check-runs?page=2>; rel="next"' } }),
    json({ total_count: 3, check_runs: [3] }),
  ];
  const api = createApi({ token: "t", baseUrl: "https://api.github.com", fetch: async () => pages.shift()! });

  assert.deepEqual(await api.getAll<number>("check-runs", "check_runs"), [1, 2, 3]);
});

test("client errors are not retried", async () => {
  let calls = 0;
  const api = createApi({
    token: "t",
    baseUrl: "https://api.github.com",
    retryDelayMs: 0,
    fetch: async () => {
      calls++;
      return json({ message: "Not Found" }, { status: 404 });
    },
  });

  await assert.rejects(api.get("repos/x/y/pulls/1"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(calls, 1);
});

test("a URL on another origin throws without calling fetch", async () => {
  let calls = 0;
  const api = createApi({
    token: "t",
    baseUrl: "https://api.github.com",
    fetch: async () => {
      calls++;
      return json([]);
    },
  });

  await assert.rejects(api.get("https://example.com/repos/x/y/pulls/1"), /refusing to send the GitHub token/);
  await assert.rejects(api.getAll("https://example.com/notifications"), /refusing to send the GitHub token/);
  await assert.rejects(api.get("https://api.github.com.example.com/repos/x/y"), /refusing to send the GitHub token/);
  await assert.rejects(api.get("https://api.github.com:8443/repos/x/y"), /refusing to send the GitHub token/);
  assert.equal(calls, 0);
});

test("getAll stops at a Link page on another origin", async () => {
  for (const next of [
    "https://example.com/notifications?page=2",
    "http://api.github.com/notifications?page=2",
    "/notifications?page=2",
  ]) {
    const calls: string[] = [];
    const pages = [json([1], { headers: { link: `<${next}>; rel="next"` } }), json([2])];
    const api = createApi({
      token: "t",
      baseUrl: "https://api.github.com",
      fetch: async (url) => {
        calls.push(String(url));
        return pages.shift()!;
      },
    });

    await assert.rejects(api.getAll("notifications"), /refusing to send the GitHub token/);
    assert.deepEqual(calls, ["https://api.github.com/notifications?per_page=100"]);
  }
});

test("GHES: requests on the host's origin carry the token, others throw", async () => {
  const calls: [string, string | undefined, string | null][] = [];
  const api = createApi({
    token: "t",
    baseUrl: "https://ghe.example/api/v3",
    fetch: async (url, init) => {
      calls.push([String(url), init?.method, new Headers(init?.headers).get("authorization")]);
      return json([]);
    },
  });

  await api.get("repos/x/y/pulls/1");
  await api.get("https://ghe.example/api/v3/repos/x/y/issues/2");
  await api.markDone("3");
  await assert.rejects(api.get("https://api.github.com/repos/x/y"), /refusing to send the GitHub token/);
  assert.deepEqual(calls, [
    ["https://ghe.example/api/v3/repos/x/y/pulls/1", "GET", "Bearer t"],
    ["https://ghe.example/api/v3/repos/x/y/issues/2", "GET", "Bearer t"],
    ["https://ghe.example/api/v3/notifications/threads/3", "DELETE", "Bearer t"],
  ]);
});

test("GHE.com: requests on the tenant's API origin carry the token, its web host and other tenants throw", async () => {
  const calls: string[] = [];
  const api = createApi({
    token: "t",
    baseUrl: apiBaseUrl("octocorp.ghe.com"),
    fetch: async (url) => {
      calls.push(String(url));
      return json([]);
    },
  });

  await api.get("repos/x/y/pulls/1");
  await api.get("https://api.octocorp.ghe.com/repos/x/y/issues/2");
  await api.markDone("3");
  for (const url of [
    "https://octocorp.ghe.com/api/v3/repos/x/y",
    "https://api.other.ghe.com/repos/x/y",
    "https://api.github.com/repos/x/y",
  ]) {
    await assert.rejects(api.get(url), /refusing to send the GitHub token/);
  }
  assert.deepEqual(calls, [
    "https://api.octocorp.ghe.com/repos/x/y/pulls/1",
    "https://api.octocorp.ghe.com/repos/x/y/issues/2",
    "https://api.octocorp.ghe.com/notifications/threads/3",
  ]);
});

test("apiBaseUrl maps each kind of host to its REST API the way gh does", () => {
  for (const [host, base] of [
    // github.com has an API host of its own.
    ["github.com", "https://api.github.com"],
    ["GitHub.com", "https://api.github.com"],
    // GitHub Enterprise Cloud with data residency: a tenant's API is on api.SUBDOMAIN.ghe.com.
    ["octocorp.ghe.com", "https://api.octocorp.ghe.com"],
    ["OctoCorp.GHE.com", "https://api.octocorp.ghe.com"],
    // GitHub Enterprise Server, and every other host gh treats as one.
    ["ghe.example", "https://ghe.example/api/v3"],
    ["ghe.com", "https://ghe.com/api/v3"],
    ["notghe.com", "https://notghe.com/api/v3"],
    ["octocorp.ghe.com.example", "https://octocorp.ghe.com.example/api/v3"],
    ["garage.github.com", "https://garage.github.com/api/v3"],
  ] as const) {
    assert.equal(apiBaseUrl(host), base, host);
  }
});

test("apiBaseUrl refuses a name with more than one label before .ghe.com, naming the tenant host", () => {
  for (const [host, message] of [
    ["api.octocorp.ghe.com", "GH_HOST api.octocorp.ghe.com isn't a GHE.com tenant host, which is SUBDOMAIN.ghe.com; use octocorp.ghe.com"],
    ["A.B.ghe.com", "GH_HOST A.B.ghe.com isn't a GHE.com tenant host, which is SUBDOMAIN.ghe.com; use b.ghe.com"],
    [".ghe.com", "GH_HOST .ghe.com isn't a GHE.com tenant host, which is SUBDOMAIN.ghe.com"],
  ] as const) {
    assert.throws(() => apiBaseUrl(host), { message }, host);
  }
});

test("apiBaseUrl refuses github.localhost, which gh reaches over plain http", () => {
  for (const host of ["github.localhost", "GitHub.LocalHost", "api.github.localhost"]) {
    assert.throws(() => apiBaseUrl(host), { message: `GH_HOST ${host} isn't supported: gh reaches github.localhost over plain http` }, host);
  }
  assert.equal(apiBaseUrl("notgithub.localhost"), "https://notgithub.localhost/api/v3");
});

test("ghAuth refuses a host before it looks for gh", () => {
  for (const host of ["api.octocorp.ghe.com", "github.localhost"]) {
    // Finds no gh, so nothing runs even if the host were checked too late.
    let looked = false;
    const isExecutable = () => {
      looked = true;
      return false;
    };
    assert.throws(() => ghAuth({ GH_HOST: host, PATH: "/nonexistent-gh-notif-clean" }, "linux", isExecutable), /^Error: GH_HOST /, host);
    assert.equal(looked, false, host);
  }
});

test("markDone refuses a thread id that isn't a number without calling fetch", async () => {
  const calls: string[] = [];
  const api = createApi({
    token: "t",
    baseUrl: "https://api.github.com",
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    },
  });

  for (const id of ["../../repos/o/r/git/refs/heads/main", "..", "", "123/..", "../123"]) {
    await assert.rejects(api.markDone(id), /refusing to mark thread/);
  }
  assert.deepEqual(calls, []);
  await api.markDone("123");
  assert.deepEqual(calls, ["https://api.github.com/notifications/threads/123"]);
});

// findGh's view of the file system: the given files are executable. Records every path it checks.
function files(...executable: string[]) {
  const checked: string[] = [];
  const isExecutable = (file: string) => {
    checked.push(file);
    return executable.includes(file);
  };
  return { checked, isExecutable };
}

test("findGh takes the first gh in PATH, skipping empty and relative entries", () => {
  const fs = files("gh", "bin/gh", "/usr/local/bin/gh", "/usr/bin/gh");

  assert.equal(findGh({ PATH: ":.:bin:/usr/local/bin::/usr/bin:" }, "linux", fs.isExecutable), "/usr/local/bin/gh");
  assert.deepEqual(fs.checked, ["/usr/local/bin/gh"]);
});

test("findGh finds nothing when no absolute PATH entry has gh", () => {
  const fs = files("bin/gh");

  assert.equal(findGh({ PATH: "/usr/bin:bin:/bin" }, "darwin", fs.isExecutable), undefined);
  assert.deepEqual(fs.checked, ["/usr/bin/gh", "/bin/gh"]);
  assert.equal(findGh({}, "linux", fs.isExecutable), undefined);
});

test("findGh on POSIX takes quotes in a PATH entry as part of it", () => {
  const fs = files("/opt/gh/gh", "/usr/bin/gh");

  assert.equal(findGh({ PATH: '"/opt/gh":/usr/bin' }, "linux", fs.isExecutable), "/usr/bin/gh");
  assert.deepEqual(fs.checked, ["/usr/bin/gh"]);
});

test("findGh on Windows uses Windows' default PATHEXT when PATHEXT is empty", () => {
  const fs = files("C:\\gh\\gh.bat", "C:\\gh\\gh.exe");

  assert.equal(findGh({ PATH: "C:\\gh", PATHEXT: "" }, "win32", fs.isExecutable), "C:\\gh\\gh.exe");
  assert.deepEqual(fs.checked, ["C:\\gh\\gh.com", "C:\\gh\\gh.exe"]);
});

test("findGh prefers GH_PATH, which gh sets for extensions, when it can run it", () => {
  const fs = files("/opt/gh/bin/gh", "/usr/bin/gh", "C:\\Program Files\\GitHub CLI\\gh.exe");

  assert.equal(findGh({ GH_PATH: "/opt/gh/bin/gh", PATH: "/usr/bin" }, "linux", fs.isExecutable), "/opt/gh/bin/gh");
  assert.equal(
    findGh({ gh_path: "C:\\Program Files\\GitHub CLI\\gh.exe", PATH: "" }, "win32", fs.isExecutable),
    "C:\\Program Files\\GitHub CLI\\gh.exe",
  );
  assert.deepEqual(fs.checked, ["/opt/gh/bin/gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]);
});

test("findGh falls back to PATH from a relative GH_PATH or one it can't run", () => {
  const fs = files("bin/gh", "/usr/bin/gh");

  assert.equal(findGh({ GH_PATH: "bin/gh", PATH: "/usr/bin" }, "linux", fs.isExecutable), "/usr/bin/gh");
  assert.equal(findGh({ GH_PATH: "/opt/gh/bin/gh", PATH: "/usr/bin" }, "linux", fs.isExecutable), "/usr/bin/gh");
  assert.deepEqual(fs.checked, ["/usr/bin/gh", "/opt/gh/bin/gh", "/usr/bin/gh"]);
});

test("findGh on Windows tries each PATH entry with each PATHEXT extension in order", () => {
  const fs = files("C:\\a\\gh.cmd", "C:\\b\\gh.com", "C:\\b\\gh.exe");

  assert.equal(findGh({ PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;;.COM;.CMD" }, "win32", fs.isExecutable), "C:\\a\\gh.cmd");
  assert.deepEqual(fs.checked, ["C:\\a\\gh.exe", "C:\\a\\gh.com", "C:\\a\\gh.cmd"]);
  assert.equal(findGh({ PATH: "C:\\b", PATHEXT: ".EXE;.COM" }, "win32", fs.isExecutable), "C:\\b\\gh.exe");
  assert.equal(findGh({ PATH: "C:\\b", PATHEXT: ".COM;.EXE" }, "win32", fs.isExecutable), "C:\\b\\gh.com");
});

test("findGh on Windows takes from PATHEXT only extensions a process starts from", () => {
  const fs = files("C:\\npm\\gh.js", "C:\\npm\\gh.vbs", "C:\\gh\\gh.exe");
  const PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

  assert.equal(findGh({ PATH: "C:\\npm;C:\\gh", PATHEXT }, "win32", fs.isExecutable), "C:\\gh\\gh.exe");
  assert.deepEqual(fs.checked, [
    "C:\\npm\\gh.com",
    "C:\\npm\\gh.exe",
    "C:\\npm\\gh.bat",
    "C:\\npm\\gh.cmd",
    "C:\\gh\\gh.com",
    "C:\\gh\\gh.exe",
  ]);
});

test("findGh on Windows skips relative entries, unquotes entries and reads Path in any case", () => {
  const fs = files("gh.exe", "C:gh.exe", "bin\\gh.exe", "C:\\Program Files\\GitHub CLI\\gh.exe");

  assert.equal(
    findGh({ Path: ';.;C:;bin;"C:\\Program Files\\GitHub CLI"' }, "win32", fs.isExecutable),
    "C:\\Program Files\\GitHub CLI\\gh.exe",
  );
  // Without PATHEXT, Windows' default order: .COM, .EXE, .BAT, .CMD.
  assert.deepEqual(fs.checked, ["C:\\Program Files\\GitHub CLI\\gh.com", "C:\\Program Files\\GitHub CLI\\gh.exe"]);
});

test("findGh on Windows takes only paths from a drive or a UNC share", () => {
  const fs = files("\\tools\\gh.exe", "/usr/bin/gh.exe", "\\\\server\\share\\bin\\gh.exe", "C:\\gh\\gh.exe", "c:\\gh\\gh.exe");

  // Three leading separators make no share: \\\tools joins as \tools, rooted without a drive.
  assert.equal(
    findGh(
      { GH_PATH: "\\tools\\gh.exe", PATH: "\\tools;/usr/bin;\\\\\\tools;\\\\server\\share\\bin" },
      "win32",
      fs.isExecutable,
    ),
    "\\\\server\\share\\bin\\gh.exe",
  );
  assert.equal(findGh({ GH_PATH: "/usr/bin/gh.exe", PATH: "C:/gh" }, "win32", fs.isExecutable), "C:\\gh\\gh.exe");
  assert.equal(findGh({ PATH: "c:\\gh" }, "win32", fs.isExecutable), "c:\\gh\\gh.exe");
  assert.deepEqual(fs.checked, [
    "\\\\server\\share\\bin\\gh.com",
    "\\\\server\\share\\bin\\gh.exe",
    "C:\\gh\\gh.com",
    "C:\\gh\\gh.exe",
    "c:\\gh\\gh.com",
    "c:\\gh\\gh.exe",
  ]);
});

test("ghAuth without a gh to run says gh isn't found", () => {
  assert.throws(() => ghAuth({ GH_HOST: "invalid.invalid", PATH: "" }, "linux"), {
    message: "gh not found in GH_PATH or PATH; install GitHub CLI: https://cli.github.com",
  });
});

test("ghAuth with a gh it can't start says so, not that gh isn't logged in", () => {
  // The check says the file is there to run, but it doesn't exist.
  assert.throws(() => ghAuth({ GH_HOST: "invalid.invalid", PATH: "/nonexistent-gh-notif-clean" }, "linux", () => true), {
    message: /^can't run \/nonexistent-gh-notif-clean\/gh: .*ENOENT/,
  });
});

test("ghAuth with a gh that exits with an error says gh isn't logged in", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-notif-clean-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    assert.throws(() => ghAuth({ GH_HOST: "invalid.invalid", PATH: dir }), {
      message: "gh is not logged in to invalid.invalid; run: gh auth login --hostname invalid.invalid",
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("ghAuth runs the first gh file in PATH it can execute", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-notif-clean-"));
  try {
    mkdirSync(join(dir, "a", "gh"), { recursive: true });
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "gh"), "#!/bin/sh\necho b\n");
    mkdirSync(join(dir, "c"));
    writeFileSync(join(dir, "c", "gh"), '#!/bin/sh\necho "$GH_HOST: $*"\n', { mode: 0o755 });
    const PATH = ["a", "b", "c"].map((name) => join(dir, name)).join(":");

    assert.deepEqual(ghAuth({ GH_HOST: "invalid.invalid", PATH }), {
      token: "invalid.invalid: auth token --hostname invalid.invalid",
      baseUrl: "https://invalid.invalid/api/v3",
    });
    // Without GH_HOST, github.com, whose API has a host of its own.
    assert.deepEqual(ghAuth({ PATH }), {
      token: ": auth token --hostname github.com",
      baseUrl: "https://api.github.com",
    });
    // A GHE.com tenant's API is on a host of its own too.
    assert.deepEqual(ghAuth({ GH_HOST: "octocorp.ghe.com", PATH }), {
      token: "octocorp.ghe.com: auth token --hostname octocorp.ghe.com",
      baseUrl: "https://api.octocorp.ghe.com",
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});
