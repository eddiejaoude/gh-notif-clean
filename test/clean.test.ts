import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clean, type CleanOptions, type Notification } from "../src/clean.ts";
import type { Api } from "../src/github.ts";
import { DEFAULT_IGNORED } from "../src/rules.ts";

const API = "https://api.github.com/repos";

function thread(id: string, repo: string, type: string, url: string | null): Notification {
  return { id, unread: true, reason: "author", repository: { full_name: repo }, subject: { title: `t${id}`, type, url } };
}

/** Fake API serving fixed responses; records every path fetched and thread marked done. */
function fakeApi(notifications: Notification[], responses: Record<string, unknown>, failDone: string[] = []) {
  const marked: string[] = [];
  const requested: string[] = [];
  const lookup = (path: string) => {
    requested.push(path);
    if (!(path in responses)) throw new Error(`404 ${path}`);
    return responses[path];
  };
  const api: Api = {
    async get<T>(path: string) {
      return lookup(path) as T;
    },
    async getAll<T>(path: string, key?: string) {
      if (path.startsWith("notifications")) return notifications as T[];
      const body = lookup(path) as Record<string, unknown>;
      return (key ? body[key] : body) as T[];
    },
    async markDone(id: string) {
      if (failDone.includes(id)) throw new Error("500 server error");
      marked.push(id);
    },
  };
  return { api, marked, requested };
}

/** Responses for a PR whose timeline holds the given events. */
function pr(repo: string, n: number, author: string, timeline: unknown[], state = "open") {
  const url = `${API}/${repo}/pulls/${n}`;
  return {
    [url]: { user: { login: author }, html_url: `https://github.com/${repo}/pull/${n}`, head: { sha: `sha${n}` }, state },
    [`${API}/${repo}/issues/${n}/timeline`]: timeline,
    [`${url}/comments`]: [],
    [`${url}/commits`]: [{ author: { login: author } }],
  };
}

/** Responses for the combined status and check runs of `sha`. */
function checks(repo: string, sha: string, statuses: unknown[], checkRuns: unknown[]) {
  const commit = `${API}/${repo}/commits/${sha}`;
  return {
    [`${commit}/status`]: { total_count: statuses.length, statuses },
    [`${commit}/check-runs`]: { total_count: checkRuns.length, check_runs: checkRuns },
  };
}

const options = (overrides: Partial<CleanOptions> = {}): CleanOptions => ({
  me: "octocat",
  ignored: new Set(DEFAULT_IGNORED),
  repos: [],
  unreadOnly: false,
  dryRun: false,
  keepFailed: false,
  ...overrides,
});

const botOnly = pr("me/app", 1, "dependabot[bot]", [{ event: "labeled", actor: { login: "dependabot[bot]" } }]);
const reviewRequested = pr("me/app", 2, "dependabot[bot]", [
  { event: "review_requested", actor: { login: "maintainer" } },
]);
const notifications = [
  thread("1", "me/app", "PullRequest", `${API}/me/app/pulls/1`),
  thread("2", "me/app", "PullRequest", `${API}/me/app/pulls/2`),
  thread("3", "me/app", "CheckSuite", null),
  thread("4", "me/app", "PullRequest", `${API}/me/app/pulls/4`), // fetch fails
];

test("marks only bot-only threads done and keeps the rest with a reason", async () => {
  const { api, marked } = fakeApi(notifications, { ...botOnly, ...reviewRequested });
  const results = await clean(api, options());

  assert.deepEqual(marked, ["1"]);
  assert.deepEqual(
    results.map((r) => [r.id, r.outcome]),
    [["1", "done"], ["2", "kept"], ["3", "kept"], ["4", "kept"]],
  );
  assert.equal(results[1]?.reason, "maintainer");
  assert.match(results[3]?.reason ?? "", /^couldn't inspect/);
});

test("dry run marks nothing", async () => {
  const { api, marked } = fakeApi(notifications, { ...botOnly, ...reviewRequested });
  const results = await clean(api, options({ dryRun: true }));
  assert.deepEqual(marked, []);
  assert.equal(results[0]?.outcome, "would-done");
});

test("--repo limits processing to matching repos and owners", async () => {
  const other = pr("them/lib", 9, "vercel[bot]", []);
  const all = [...notifications, thread("9", "them/lib", "PullRequest", `${API}/them/lib/pulls/9`)];
  const { api } = fakeApi(all, { ...botOnly, ...reviewRequested, ...other });

  assert.deepEqual((await clean(api, options({ repos: ["them/lib"] }))).map((r) => r.id), ["9"]);
  assert.deepEqual((await clean(api, options({ repos: ["Them"] }))).map((r) => r.id), ["9"]);
});

test("a failed mark-done is reported as failed", async () => {
  const { api } = fakeApi([notifications[0]!], botOnly, ["1"]);
  const [result] = await clean(api, options());
  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "500 server error");
});

describe("--keep-failed", () => {
  const vercelFailed = pr("me/app", 5, "octocat", [{ event: "commented", actor: { login: "vercel[bot]" } }]);
  const botIssue = {
    [`${API}/me/app/issues/7`]: {
      user: { login: "dependabot[bot]" },
      html_url: "https://github.com/me/app/issues/7",
      state: "open",
    },
    [`${API}/me/app/issues/7/timeline`]: [],
  };
  const inbox = [
    thread("1", "me/app", "PullRequest", `${API}/me/app/pulls/1`),
    thread("2", "me/app", "PullRequest", `${API}/me/app/pulls/2`),
    thread("5", "me/app", "PullRequest", `${API}/me/app/pulls/5`),
    thread("7", "me/app", "Issue", `${API}/me/app/issues/7`),
  ];
  const responses = {
    ...botOnly,
    ...reviewRequested,
    ...vercelFailed,
    ...botIssue,
    ...checks("me/app", "sha1", [{ context: "Vercel", state: "success" }], [
      { name: "test", status: "completed", conclusion: "success" },
    ]),
    ...checks("me/app", "sha5", [{ context: "Vercel", state: "failure" }], []),
  };

  test("keeps bot-only PRs with failing checks and marks passing PRs and other threads done", async () => {
    const { api, marked, requested } = fakeApi(inbox, responses);
    const results = await clean(api, options({ keepFailed: true }));

    assert.deepEqual(marked.sort(), ["1", "7"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome, r.reason]),
      [["1", "done", undefined], ["2", "kept", "maintainer"], ["5", "kept", "checks failed: Vercel"], ["7", "done", undefined]],
    );
    assert.ok(!requested.some((p) => p.includes("/commits/sha2")), "checks fetched for a PR kept by its participants");
  });

  test("a dry run keeps the same PRs", async () => {
    const { api, marked } = fakeApi(inbox, responses);
    const results = await clean(api, options({ keepFailed: true, dryRun: true }));
    assert.deepEqual(marked, []);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome]),
      [["1", "would-done"], ["2", "kept"], ["5", "kept"], ["7", "would-done"]],
    );
  });

  test("without the flag, no checks are fetched", async () => {
    const { api, marked, requested } = fakeApi(inbox, responses);
    await clean(api, options());
    assert.deepEqual(marked.sort(), ["1", "5", "7"]);
    assert.ok(!requested.some((p) => p.includes("/commits/")));
  });

  test("keeps the PR when its checks can't be fetched", async () => {
    const { api, marked } = fakeApi([inbox[0]!], botOnly);
    const [result] = await clean(api, options({ keepFailed: true }));
    assert.deepEqual(marked, []);
    assert.match(result?.reason ?? "", /^couldn't inspect checks: 404/);
  });

  test("closed and merged PRs are marked done without reading their checks", async () => {
    const closed = pr("me/app", 6, "dependabot[bot]", [], "closed");
    const { api, marked, requested } = fakeApi([thread("6", "me/app", "PullRequest", `${API}/me/app/pulls/6`)], {
      ...closed,
      ...checks("me/app", "sha6", [{ context: "Vercel", state: "failure" }], []),
    });
    const [result] = await clean(api, options({ keepFailed: true }));
    assert.equal(result?.outcome, "done");
    assert.deepEqual(marked, ["6"]);
    assert.ok(!requested.some((p) => p.includes("/commits/")));
  });
});
