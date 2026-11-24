import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clean, type CleanOptions, type Notification } from "../src/clean.ts";
import { createApi, type Api } from "../src/github.ts";
import { DEFAULT_IGNORED } from "../src/rules.ts";

const API = "https://api.github.com/repos";

function thread(id: string, repo: string, type: string, url: string | null, reason = "author"): Notification {
  return { id, unread: true, reason, repository: { full_name: repo }, subject: { title: `t${id}`, type, url } };
}

/** Fake API serving fixed responses; records the notifications lists, every path fetched and thread marked done. */
function fakeApi(notifications: Notification[], responses: Record<string, unknown>, failDone: string[] = []) {
  const marked: string[] = [];
  const listed: string[] = [];
  const requested: string[] = [];
  const lookup = (path: string) => {
    requested.push(path);
    if (!(path in responses)) throw new Error(`404 ${path}`);
    return responses[path];
  };
  const api: Api = {
    async get<T>(path: string) {
      const body = lookup(path);
      // The real `get` reads one page, so a list has to go through `getAll`,
      // including lists GitHub wraps in an object with a `total_count`.
      if (Array.isArray(body)) throw new Error(`get() on a list: ${path}`);
      if (body && typeof body === "object" && "total_count" in body) {
        throw new Error(`get() on a wrapped list: ${path}`);
      }
      return body as T;
    },
    async getAll<T>(path: string, key?: string) {
      if (path.startsWith("notifications")) {
        listed.push(path);
        return notifications as T[];
      }
      const body = lookup(path) as Record<string, unknown>;
      // Keep wrapped-list fixtures shaped like GitHub's, so `get` above can tell them apart.
      if (key && !("total_count" in body)) throw new Error(`wrapped list fixture without total_count: ${path}`);
      return (key ? body[key] : body) as T[];
    },
    async markDone(id: string) {
      if (failDone.includes(id)) throw new Error("500 server error");
      marked.push(id);
    },
    // Every answer is immediate, so no request is ever left to cancel.
    withSignal: () => api,
  };
  return { api, marked, listed, requested };
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
  since: null,
  dryRun: false,
  keepFailed: false,
  keepReasons: new Set(),
  closedOnly: false,
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

test("--since and --unread-only shape the notifications list request", async () => {
  const since = new Date("2026-11-17T12:34:56.789Z");
  const { api, listed } = fakeApi([], {});
  await clean(api, options());
  await clean(api, options({ unreadOnly: true }));
  await clean(api, options({ since }));
  await clean(api, options({ since, unreadOnly: true }));
  const queries = listed.map((path) => Object.fromEntries(new URL(path, "https://api.github.com").searchParams));
  assert.deepEqual(queries, [
    { all: "true" },
    {},
    { all: "true", since: "2026-11-17T12:34:56Z" },
    { since: "2026-11-17T12:34:56Z" },
  ]);
});

test("a thread kept on a failed request has its other requests cancelled before clean() returns", async () => {
  // PR 1's timeline is missing, so its thread is kept on that 404, while its review comments and
  // commits, requested alongside, answer only once cancelled, as over a stalled connection. PR 2
  // is bot-only, and every one of its requests is answered at once.
  const responses: Record<string, unknown> = {
    "https://api.github.com/notifications?all=true": [
      thread("1", "me/app", "PullRequest", `${API}/me/app/pulls/1`),
      thread("2", "me/app", "PullRequest", `${API}/me/app/pulls/2`),
    ],
    [`${API}/me/app/pulls/1`]: { user: { login: "dependabot[bot]" }, state: "open" },
    ...pr("me/app", 2, "dependabot[bot]", []),
  };
  const stalled = new Set<string>();
  const deleted: string[] = [];
  const api = createApi({
    token: "t",
    baseUrl: "https://api.github.com",
    fetch: async (input, init) => {
      // Like fetch, which doesn't send a request whose signal has aborted.
      init?.signal?.throwIfAborted();
      const url = String(input).replace(/[?&]per_page=100$/, "");
      if (init?.method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      if (url === `${API}/me/app/pulls/1/comments` || url === `${API}/me/app/pulls/1/commits`) {
        stalled.add(url);
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            stalled.delete(url);
            reject(signal.reason);
          });
        });
      }
      return url in responses ? Response.json(responses[url]) : Response.json({ message: "Not Found" }, { status: 404 });
    },
  });

  // One thread at a time, so PR 2 starts after PR 1's abort: an abort that reached past its own
  // thread would cancel PR 2's requests too.
  const results = await clean(api, options({ concurrency: 1 }));

  assert.deepEqual([...stalled], [], "requests still running when clean() returned");
  assert.deepEqual(
    results.map((r) => [r.id, r.outcome, r.reason]),
    [
      ["1", "kept", `couldn't inspect: GET ${API}/me/app/issues/1/timeline?per_page=100: 404 {"message":"Not Found"}`],
      ["2", "done", undefined],
    ],
  );
  assert.deepEqual(deleted, ["https://api.github.com/notifications/threads/2"]);
});

describe("discussions", () => {
  /** Responses for a discussion `github-actions[bot]` started, with the given comments and the account that marked its answer. */
  const discussion = (n: number, comments: unknown[], answeredBy: string | null = null) => ({
    [`${API}/me/app/discussions/${n}`]: {
      user: { login: "github-actions[bot]" },
      html_url: `https://github.com/me/app/discussions/${n}`,
      state: "open",
      answer_chosen_by: answeredBy ? { login: answeredBy } : null,
    },
    [`${API}/me/app/discussions/${n}/comments`]: comments,
  });
  /** A discussion comment; `parentId` makes it a reply to that comment. */
  const comment = (id: number, login: string, parentId: number | null = null) => ({ id, parent_id: parentId, user: { login } });
  const ignored = new Set([...DEFAULT_IGNORED, "github-actions[bot]"]);

  test("keeps a bot-started discussion a person replied to and marks one only you commented on done", async () => {
    const inbox = [
      thread("1", "me/app", "Discussion", `${API}/me/app/discussions/1`),
      thread("2", "me/app", "Discussion", `${API}/me/app/discussions/2`),
    ];
    const { api, marked } = fakeApi(inbox, {
      ...discussion(1, [comment(10, "github-actions[bot]"), comment(11, "contributor", 10)]),
      ...discussion(2, [comment(20, "octocat")]),
    });
    const results = await clean(api, options({ ignored }));

    assert.deepEqual(marked, ["2"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome, r.reason, r.participants]),
      [
        ["1", "kept", "contributor", ["contributor", "github-actions[bot]"]],
        ["2", "done", undefined, ["github-actions[bot]", "octocat"]],
      ],
    );
  });

  test("keeps a discussion a person marked the answer on and marks one whose answer you marked done", async () => {
    const inbox = [
      thread("1", "me/app", "Discussion", `${API}/me/app/discussions/1`),
      thread("2", "me/app", "Discussion", `${API}/me/app/discussions/2`),
    ];
    const { api, marked, requested } = fakeApi(inbox, {
      ...discussion(1, [comment(10, "octocat")], "maintainer"),
      ...discussion(2, [comment(20, "octocat")], "octocat"),
    });
    const results = await clean(api, options({ ignored }));

    assert.deepEqual(marked, ["2"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome, r.reason, r.participants]),
      [
        ["1", "kept", "maintainer", ["github-actions[bot]", "maintainer", "octocat"]],
        ["2", "done", undefined, ["github-actions[bot]", "octocat"]],
      ],
    );
    // The answer comes with the discussion, so no request is added for it.
    assert.deepEqual(requested.sort(), [
      `${API}/me/app/discussions/1`,
      `${API}/me/app/discussions/1/comments`,
      `${API}/me/app/discussions/2`,
      `${API}/me/app/discussions/2/comments`,
    ]);
  });

  test("keeps a discussion whose comments can't be fetched", async () => {
    const { api, marked } = fakeApi([thread("1", "me/app", "Discussion", `${API}/me/app/discussions/1`)], {
      [`${API}/me/app/discussions/1`]: { user: { login: "github-actions[bot]" }, state: "open" },
    });
    const [result] = await clean(api, options({ ignored }));
    assert.deepEqual(marked, []);
    assert.match(result?.reason ?? "", /^couldn't inspect: 404 .*\/discussions\/1\/comments$/);
  });

  test("fetches comments only for discussions", async () => {
    const inbox = [
      thread("1", "me/app", "Discussion", `${API}/me/app/discussions/1`),
      thread("2", "me/app", "Issue", `${API}/me/app/issues/2`),
      thread("3", "me/app", "Release", `${API}/me/app/releases/3`),
      thread("4", "me/app", "Commit", `${API}/me/app/commits/abc4`),
    ];
    const { api, marked, requested } = fakeApi(inbox, {
      ...discussion(1, []),
      [`${API}/me/app/issues/2`]: { user: { login: "github-actions[bot]" }, state: "open" },
      [`${API}/me/app/issues/2/timeline`]: [],
      [`${API}/me/app/releases/3`]: { author: { login: "github-actions[bot]" } },
      [`${API}/me/app/commits/abc4`]: { author: { login: "github-actions[bot]" } },
    });
    await clean(api, options({ ignored }));

    assert.deepEqual(marked.sort(), ["1", "2", "3", "4"]);
    assert.deepEqual(requested.sort(), [
      `${API}/me/app/commits/abc4`,
      `${API}/me/app/discussions/1`,
      `${API}/me/app/discussions/1/comments`,
      `${API}/me/app/issues/2`,
      `${API}/me/app/issues/2/timeline`,
      `${API}/me/app/releases/3`,
    ]);
  });
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

  for (const [kind, conclusion] of [
    ["failed", "failure"],
    ["cancelled", "cancelled"],
  ] as const) {
    describe(`a ${kind} run whose job passed in a newer workflow run`, () => {
      const older = {
        name: "test",
        status: "completed",
        conclusion,
        started_at: "2026-11-23T10:00:00Z",
        completed_at: "2026-11-23T10:01:00Z",
        check_suite: { id: 1 },
      };
      const passed = { ...older, conclusion: "success", started_at: "2026-11-23T11:00:00Z", completed_at: "2026-11-23T11:01:00Z", check_suite: { id: 2 } };
      const runsPath = (sha: string) => `${API}/me/app/actions/runs?head_sha=${sha}`;
      const inbox = [
        thread("11", "me/app", "PullRequest", `${API}/me/app/pulls/11`),
        thread("12", "me/app", "PullRequest", `${API}/me/app/pulls/12`),
      ];
      const responses = {
        ...pr("me/app", 11, "dependabot[bot]", []),
        ...pr("me/app", 12, "dependabot[bot]", []),
        ...checks("me/app", "sha11", [], [older, passed]),
        ...checks("me/app", "sha12", [], [older]),
      };

      test("is excused, and the workflow runs are fetched only for the PR that has one", async () => {
        const { api, marked, requested } = fakeApi(inbox, {
          ...responses,
          [runsPath("sha11")]: {
            total_count: 2,
            workflow_runs: [
              { check_suite_id: 1, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
              { check_suite_id: 2, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
            ],
          },
        });
        const results = await clean(api, options({ keepFailed: true }));
        assert.deepEqual(marked, ["11"]);
        assert.equal(results[1]?.reason, `checks ${kind}: test`);
        assert.ok(requested.includes(runsPath("sha11")));
        assert.ok(!requested.includes(runsPath("sha12")), "workflow runs fetched for a PR with no later pass");
      });

      test(`keeps the PR for its ${kind} check when the workflow runs can't be fetched`, async () => {
        const { api, marked } = fakeApi([inbox[0]!], responses);
        const [result] = await clean(api, options({ keepFailed: true }));
        assert.deepEqual(marked, []);
        assert.equal(result?.reason, `checks ${kind}: test`);
      });
    });
  }

  describe("a failed run that the PR's check list leaves out", () => {
    // Workflow 10's `workflow_dispatch` run (suite 1) failed `test`; its `pull_request` run (suite 2), which
    // started first, passed it on PR 13 and skipped it on PR 14.
    const dispatched = {
      name: "test",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-11-23T10:00:00Z",
      completed_at: "2026-11-23T10:30:00Z",
      check_suite: { id: 1 },
    };
    const listed = (conclusion: string) => ({ ...dispatched, conclusion, started_at: "2026-11-23T09:59:00Z", completed_at: "2026-11-23T10:01:00Z", check_suite: { id: 2 } });
    const runsPath = (sha: string) => `${API}/me/app/actions/runs?head_sha=${sha}`;
    const inbox = [
      thread("13", "me/app", "PullRequest", `${API}/me/app/pulls/13`),
      thread("14", "me/app", "PullRequest", `${API}/me/app/pulls/14`),
    ];
    const responses = {
      ...pr("me/app", 13, "dependabot[bot]", []),
      ...pr("me/app", 14, "dependabot[bot]", []),
      ...checks("me/app", "sha13", [], [dispatched, listed("success")]),
      ...checks("me/app", "sha14", [], [dispatched, listed("skipped")]),
    };

    test("is excused by the list's earlier pass, and keeps the PR whose list skipped the job without listing its workflow runs", async () => {
      const { api, marked, requested } = fakeApi(inbox, {
        ...responses,
        [runsPath("sha13")]: {
          total_count: 2,
          workflow_runs: [
            { check_suite_id: 1, workflow_id: 10, event: "workflow_dispatch", path: ".github/workflows/ci.yml" },
            { check_suite_id: 2, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
          ],
        },
      });
      const results = await clean(api, options({ keepFailed: true }));
      assert.deepEqual(marked, ["13"]);
      assert.equal(results[1]?.reason, "checks failed: test");
      assert.ok(requested.includes(runsPath("sha13")), "workflow runs not fetched for a pass that started first");
      assert.ok(!requested.includes(runsPath("sha14")), "workflow runs fetched for a PR with no pass of the job");
    });
  });

  describe("a job of one of GitHub's own workflows that the PR's check list leaves out", () => {
    const runsPath = (sha: string) => `${API}/me/app/actions/runs?head_sha=${sha}`;
    /** A check run in check suite `suite` that started at 10:00 and, once completed, ran for five minutes. */
    const job = (name: string, suite: number, conclusion: string | null = "failure") => ({
      name,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
      started_at: "2026-11-23T10:00:00Z",
      completed_at: conclusion ? "2026-11-23T10:05:00Z" : null,
      check_suite: { id: suite },
    });
    /** The `actions/runs` response for workflow runs given as [check suite, event, path]. */
    const runsList = (...runs: [suite: number, event: string, path: string][]) => ({
      total_count: runs.length,
      workflow_runs: runs.map(([suite, event, path]) => ({ check_suite_id: suite, workflow_id: suite * 10, event, path })),
    });
    // PR 15 is Copilot's, and its head commit's only check run is the cloud agent's job, cancelled 22 s in, as GitHub
    // returned them (fields trimmed to those read). PR 16 is yours, with Copilot's review still running. PRs 17 to 19
    // are Dependabot's: CodeQL default setup failed a job, the repository's own `dependabot.yml` workflow failed a job
    // named `Dependabot`, and a `dynamic` workflow not known to be left out had a job named `copilot` cancelled.
    const inbox = [15, 16, 17, 18, 19].map((n) => thread(String(n), "me/app", "PullRequest", `${API}/me/app/pulls/${n}`));
    const responses = {
      ...pr("me/app", 15, "Copilot", []),
      ...pr("me/app", 16, "octocat", [{ event: "commented", actor: { login: "vercel[bot]" } }]),
      ...pr("me/app", 17, "dependabot[bot]", []),
      ...pr("me/app", 18, "dependabot[bot]", []),
      ...pr("me/app", 19, "dependabot[bot]", []),
      ...checks("me/app", "sha15", [], [
        { name: "copilot", status: "completed", conclusion: "cancelled", started_at: "2026-09-16T00:09:29Z", completed_at: "2026-09-16T00:09:51Z", check_suite: { id: 94888567577 } },
      ]),
      ...checks("me/app", "sha16", [{ context: "Vercel", state: "success" }], [job("copilot-pull-request-reviewer", 1, null), job("test", 2, "success")]),
      ...checks("me/app", "sha17", [], [job("Analyze (actions)", 1)]),
      ...checks("me/app", "sha18", [], [job("Dependabot", 1)]),
      ...checks("me/app", "sha19", [], [job("copilot", 1, "cancelled")]),
    };
    const listed = {
      [runsPath("sha15")]: {
        total_count: 2,
        workflow_runs: [
          { check_suite_id: 94888573084, workflow_id: 335335940, event: "pull_request", path: ".github/workflows/firebase-hosting-pull-request.yml" },
          { check_suite_id: 94888567577, workflow_id: 335862696, event: "dynamic", path: "dynamic/copilot-swe-agent/copilot" },
        ],
      },
      [runsPath("sha16")]: runsList([1, "dynamic", "dynamic/agents/copilot-pull-request-reviewer"], [2, "pull_request", ".github/workflows/ci.yml"]),
      [runsPath("sha17")]: runsList([1, "dynamic", "dynamic/github-code-scanning/codeql"]),
      [runsPath("sha18")]: runsList([1, "pull_request", ".github/workflows/dependabot.yml"]),
      [runsPath("sha19")]: runsList([1, "dynamic", "dynamic/agents/new-agent"]),
    };
    const ignored = new Set([...DEFAULT_IGNORED, "copilot"]);

    test("doesn't keep the PR once the workflow runs show it, while other dynamic runs and namesakes still do", async () => {
      const { api, marked, requested } = fakeApi(inbox, { ...responses, ...listed });
      const results = await clean(api, options({ keepFailed: true, ignored }));
      assert.deepEqual(marked.sort(), ["15", "16"]);
      assert.deepEqual(
        results.map((r) => [r.id, r.outcome, r.reason]),
        [
          ["15", "done", undefined],
          ["16", "done", undefined],
          ["17", "kept", "checks failed: Analyze (actions)"],
          ["18", "kept", "checks failed: Dependabot"],
          ["19", "kept", "checks cancelled: copilot"],
        ],
      );
      // CodeQL's job doesn't have the name of a job GitHub leaves out, so its PR costs no request for them.
      assert.deepEqual(requested.filter((p) => p.includes("/actions/runs")).sort(), [
        runsPath("sha15"),
        runsPath("sha16"),
        runsPath("sha18"),
        runsPath("sha19"),
      ]);
    });

    test("keeps the PR for the agent's job when the workflow runs can't be fetched", async () => {
      const { api, marked } = fakeApi([inbox[0]!], responses);
      const [result] = await clean(api, options({ keepFailed: true, ignored }));
      assert.deepEqual(marked, []);
      assert.equal(result?.reason, "checks cancelled: copilot");
    });
  });
});

describe("--keep-reason", () => {
  // Dependabot requested your review through CODEOWNERS: the request's actor is the bot itself.
  const codeownersRequest = pr("me/app", 8, "dependabot[bot]", [
    { event: "review_requested", actor: { login: "dependabot[bot]" } },
  ]);
  const mergedRequest = pr("me/app", 9, "dependabot[bot]", [], "closed");
  const inbox = [
    thread("8", "me/app", "PullRequest", `${API}/me/app/pulls/8`, "review_requested"),
    thread("9", "me/app", "PullRequest", `${API}/me/app/pulls/9`, "review_requested"),
    thread("3", "me/app", "CheckSuite", null, "ci_activity"),
    thread("1", "me/app", "PullRequest", `${API}/me/app/pulls/1`, "subscribed"),
  ];
  const responses = { ...codeownersRequest, ...mergedRequest, ...botOnly };

  test("keeps open threads with a matching reason after fetching only their subject", async () => {
    const { api, marked, requested } = fakeApi(inbox, responses);
    const results = await clean(api, options({ keepReasons: new Set(["review_requested", "ci_activity"]) }));

    assert.deepEqual(marked.sort(), ["1", "9"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome, r.reason, r.url]),
      [
        ["8", "kept", "notification reason: review_requested", "https://github.com/me/app/pull/8"],
        ["9", "done", undefined, "https://github.com/me/app/pull/9"],
        ["3", "kept", "notification reason: ci_activity", null],
        ["1", "done", undefined, "https://github.com/me/app/pull/1"],
      ],
    );
    assert.deepEqual(
      requested.filter((p) => p.includes("/8")),
      [`${API}/me/app/pulls/8`],
      "a thread kept by its reason had its activity loaded",
    );
  });

  test("without a matching reason, the same threads are decided by who took part", async () => {
    const { api, marked } = fakeApi(inbox, responses);
    const results = await clean(api, options({ keepReasons: new Set(["mention"]) }));

    assert.deepEqual(marked.sort(), ["1", "8", "9"]);
    assert.equal(results[2]?.reason, "CheckSuite threads can't be inspected");
  });

  test("keeps a matching thread whose subject has no state, such as a release", async () => {
    const release = {
      [`${API}/me/app/releases/5`]: { author: { login: "dependabot[bot]" }, html_url: "https://github.com/me/app/releases/tag/v5" },
    };
    const inbox = [thread("5", "me/app", "Release", `${API}/me/app/releases/5`, "subscribed")];

    const kept = fakeApi(inbox, release);
    const [result] = await clean(kept.api, options({ keepReasons: new Set(["subscribed"]) }));
    assert.deepEqual(kept.marked, []);
    assert.equal(result?.reason, "notification reason: subscribed");

    // Without the flag the same release is bot-only, so the reason is what keeps it.
    const done = fakeApi(inbox, release);
    await clean(done.api, options());
    assert.deepEqual(done.marked, ["5"]);
  });
});

describe("--closed-only", () => {
  const you = { event: "commented", actor: { login: "octocat" } };
  const issue = (n: number, state: string) => ({
    [`${API}/me/app/issues/${n}`]: { user: { login: "dependabot[bot]" }, html_url: `https://github.com/me/app/issues/${n}`, state },
    [`${API}/me/app/issues/${n}/timeline`]: [],
  });
  const inbox = [
    thread("1", "me/app", "PullRequest", `${API}/me/app/pulls/1`), // open bump
    thread("2", "me/app", "PullRequest", `${API}/me/app/pulls/2`), // open, a maintainer took part
    thread("3", "me/app", "PullRequest", `${API}/me/app/pulls/3`), // merged bump
    thread("4", "me/app", "Issue", `${API}/me/app/issues/4`),
    thread("5", "me/app", "Issue", `${API}/me/app/issues/5`),
    thread("6", "me/app", "Release", `${API}/me/app/releases/6`),
    thread("7", "me/app", "Commit", `${API}/me/app/commits/abc7`),
    thread("8", "me/app", "Discussion", `${API}/me/app/discussions/8`),
  ];
  const responses = {
    ...pr("me/app", 1, "dependabot[bot]", [you]),
    ...reviewRequested,
    ...pr("me/app", 3, "dependabot[bot]", [you, { event: "merged", actor: { login: "octocat" } }], "closed"),
    ...issue(4, "open"),
    ...issue(5, "closed"),
    [`${API}/me/app/releases/6`]: { author: { login: "github-actions[bot]" }, html_url: "https://github.com/me/app/releases/v6" },
    [`${API}/me/app/commits/abc7`]: { author: { login: "dependabot[bot]" }, html_url: "https://github.com/me/app/commit/abc7" },
    // Only PRs and issues are held back, even when another subject reports itself open.
    [`${API}/me/app/discussions/8`]: { user: { login: "dependabot[bot]" }, state: "open" },
    [`${API}/me/app/discussions/8/comments`]: [],
  };
  const ignored = new Set([...DEFAULT_IGNORED, "github-actions[bot]"]);

  test("keeps open PRs and issues and marks closed, merged and other threads done", async () => {
    const { api, marked } = fakeApi(inbox, responses);
    const results = await clean(api, options({ closedOnly: true, ignored }));

    assert.deepEqual(marked.sort(), ["3", "5", "6", "7", "8"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome, r.reason]),
      [
        ["1", "kept", "still open"],
        ["2", "kept", "maintainer"],
        ["3", "done", undefined],
        ["4", "kept", "still open"],
        ["5", "done", undefined],
        ["6", "done", undefined],
        ["7", "done", undefined],
        ["8", "done", undefined],
      ],
    );
  });

  test("a dry run keeps the same threads", async () => {
    const { api, marked } = fakeApi(inbox, responses);
    const results = await clean(api, options({ closedOnly: true, ignored, dryRun: true }));
    assert.deepEqual(marked, []);
    assert.deepEqual(
      results.map((r) => [r.id, r.outcome]),
      [
        ["1", "kept"],
        ["2", "kept"],
        ["3", "would-done"],
        ["4", "kept"],
        ["5", "would-done"],
        ["6", "would-done"],
        ["7", "would-done"],
        ["8", "would-done"],
      ],
    );
  });

  test("without the flag, open PRs and issues are marked done", async () => {
    const { api, marked } = fakeApi(inbox, responses);
    await clean(api, options({ ignored }));
    assert.deepEqual(marked.sort(), ["1", "3", "4", "5", "6", "7", "8"]);
  });

  test("with --keep-failed, a failed check is the reason given and other open PRs are still open", async () => {
    const { api, marked } = fakeApi([inbox[0]!, thread("9", "me/app", "PullRequest", `${API}/me/app/pulls/9`)], {
      ...responses,
      ...pr("me/app", 9, "dependabot[bot]", [you]),
      ...checks("me/app", "sha1", [{ context: "Vercel", state: "failure" }], []),
      ...checks("me/app", "sha9", [{ context: "Vercel", state: "success" }], []),
    });
    const results = await clean(api, options({ closedOnly: true, keepFailed: true }));
    assert.deepEqual(marked, []);
    assert.deepEqual(
      results.map((r) => [r.id, r.reason]),
      [
        ["1", "checks failed: Vercel"],
        ["9", "still open"],
      ],
    );
  });
});
