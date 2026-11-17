import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, type CleanOptions, type Notification } from "../src/clean.ts";
import type { Api } from "../src/github.ts";
import { DEFAULT_IGNORED } from "../src/rules.ts";

const API = "https://api.github.com/repos";

function thread(id: string, repo: string, type: string, url: string | null): Notification {
  return { id, unread: true, reason: "author", repository: { full_name: repo }, subject: { title: `t${id}`, type, url } };
}

/** Fake API serving fixed responses; records every thread marked done. */
function fakeApi(notifications: Notification[], responses: Record<string, unknown>, failDone: string[] = []) {
  const marked: string[] = [];
  const lookup = (path: string) => {
    if (!(path in responses)) throw new Error(`404 ${path}`);
    return responses[path];
  };
  const api: Api = {
    async get<T>(path: string) {
      return lookup(path) as T;
    },
    async getAll<T>(path: string) {
      return (path.startsWith("notifications") ? notifications : lookup(path)) as T[];
    },
    async markDone(id: string) {
      if (failDone.includes(id)) throw new Error("500 server error");
      marked.push(id);
    },
  };
  return { api, marked };
}

/** Responses for a PR whose timeline holds the given events. */
function pr(repo: string, n: number, author: string, timeline: unknown[]) {
  const url = `${API}/${repo}/pulls/${n}`;
  return {
    [url]: { user: { login: author }, html_url: `https://github.com/${repo}/pull/${n}` },
    [`${API}/${repo}/issues/${n}/timeline`]: timeline,
    [`${url}/comments`]: [],
    [`${url}/commits`]: [{ author: { login: author } }],
  };
}

const options = (overrides: Partial<CleanOptions> = {}): CleanOptions => ({
  me: "octocat",
  ignored: new Set(DEFAULT_IGNORED),
  repos: [],
  unreadOnly: false,
  dryRun: false,
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
