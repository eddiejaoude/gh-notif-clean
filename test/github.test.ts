import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi, HttpError } from "../src/github.ts";

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
  assert.equal(calls, 0);
});

test("getAll stops at a Link page on another origin", async () => {
  for (const next of ["https://example.com/notifications?page=2", "http://api.github.com/notifications?page=2"]) {
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
