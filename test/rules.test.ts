import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checksReason,
  DEFAULT_IGNORED,
  decide,
  needsWorkflowRuns,
  NOTIFICATION_REASONS,
  parseReasons,
  participants,
  type ThreadActivity,
} from "../src/rules.ts";

const ME = "octocat";
const IGNORED = new Set(DEFAULT_IGNORED);
const who = (login: string) => ({ login });

function activity(parts: Partial<ThreadActivity>): ThreadActivity {
  return { author: null, timeline: [], reviewComments: [], commits: [], discussionComments: [], answerChosenBy: null, ...parts };
}

describe("decide (README examples)", () => {
  const cases: [string, string[], boolean][] = [
    ["your PR with a Vercel preview comment", [ME, "vercel[bot]"], true],
    ["Dependabot version bump", ["dependabot[bot]", ME], true],
    ["your PR with code scanning alerts", [ME, "vercel[bot]", "github-advanced-security[bot]"], true],
    ["Dependabot bump the CLA bot commented on", ["dependabot[bot]", "vercel[bot]", "cla-assistant[bot]", ME], false],
    ["your issue a contributor commented on", [ME, "contributor"], false],
    ["contributor's PR with a Vercel preview comment", ["contributor", "vercel[bot]"], false],
    ["your own PR with no bot activity", [ME], false],
    ["Dependabot PR a contributor commented LGTM on", ["dependabot[bot]", "contributor"], false],
  ];
  for (const [name, logins, done] of cases) {
    test(name, () => assert.equal(decide(new Set(logins), ME, IGNORED).done, done));
  }

  test("names the accounts that kept the thread", () => {
    assert.deepEqual(decide(new Set(["vercel[bot]", "zed", "amy"]), ME, IGNORED), {
      done: false,
      reason: "amy, zed",
    });
  });

  test("compares logins case-insensitively", () => {
    assert.equal(decide(new Set(["OctoCat", "Vercel[bot]"]), ME, IGNORED).done, true);
  });
});

describe("parseReasons (--keep-reason)", () => {
  test("accepts repeated values case-insensitively and lowercases them", () => {
    assert.deepEqual(
      [...parseReasons(["Review_Requested", "team_mention", "REVIEW_REQUESTED"])].sort(),
      ["review_requested", "team_mention"],
    );
  });

  test("rejects an unknown reason, naming it and every valid reason", () => {
    assert.throws(
      () => parseReasons(["mention", "bogus"]),
      (error: Error) =>
        error.message.includes("'bogus'") &&
        !error.message.includes("'mention'") &&
        NOTIFICATION_REASONS.every((r) => error.message.includes(r)),
    );
  });
});

describe("checksReason (README --keep-failed examples)", () => {
  /** A check run in check suite `suite` that started `start` seconds after 10:00 and, once completed, ran for `seconds`. */
  const run = (name: string, status: string, conclusion: string | null = null, seconds = 60, start = 0, suite = 1) => {
    const startedAt = Date.parse("2026-11-23T10:00:00Z") + start * 1000;
    return {
      name,
      status,
      conclusion,
      started_at: new Date(startedAt).toISOString(),
      completed_at: status === "completed" ? new Date(startedAt + seconds * 1000).toISOString() : null,
      check_suite: { id: suite },
    };
  };
  /** Suites 1, 2 and 5 are `pull_request` runs of workflow 10, suite 3 is its `push` run, suite 4 is another workflow's. */
  const workflowRuns = [
    { check_suite_id: 1, workflow_id: 10, event: "pull_request" },
    { check_suite_id: 2, workflow_id: 10, event: "pull_request" },
    { check_suite_id: 3, workflow_id: 10, event: "push" },
    { check_suite_id: 4, workflow_id: 20, event: "pull_request" },
    { check_suite_id: 5, workflow_id: 10, event: "pull_request" },
  ];
  const gate = "All required checks pass";
  const failure = run(gate, "completed", "failure");
  /** The gate passing in the newer `pull_request` run, an hour after `failure`. */
  const newerPass = run(gate, "completed", "success", 60, 3600, 2);
  /** `deploy` cancelled half an hour into the first `pull_request` run, as a job that hit `timeout-minutes` reports. */
  const timedOut = run("deploy", "completed", "cancelled", 1800);
  /** `deploy` passing in the newer `pull_request` run, an hour after `timedOut` started. */
  const deployPassed = run("deploy", "completed", "success", 60, 3600, 2);

  test("a failed Vercel deploy keeps the thread", () => {
    assert.equal(checksReason([{ context: "Vercel", state: "failure" }], [], workflowRuns), "checks failed: Vercel");
  });

  test("errored statuses and failed, timed out or blocked check runs count as failed", () => {
    const reason = checksReason(
      [{ context: "ci/legacy", state: "error" }],
      [run("test", "completed", "failure"), run("e2e", "completed", "timed_out"), run("gate", "completed", "action_required")],
      workflowRuns,
    );
    assert.equal(reason, "checks failed: ci/legacy, e2e, gate and 1 more");
  });

  test("unfinished checks keep the thread", () => {
    assert.equal(
      checksReason([{ context: "Vercel", state: "pending" }], [run("build", "in_progress"), run("lint", "queued")], workflowRuns),
      "checks pending: Vercel, build, lint",
    );
  });

  test("failed checks are reported over unfinished ones", () => {
    assert.equal(
      checksReason([{ context: "Vercel", state: "pending" }], [run("test", "completed", "failure")], workflowRuns),
      "checks failed: test",
    );
  });

  test("a failed run whose job passed in a newer run of the same workflow for the same event doesn't keep the thread", () => {
    for (const conclusion of ["failure", "timed_out", "action_required"]) {
      const failed = run(gate, "completed", conclusion);
      assert.equal(checksReason([], [failed, newerPass], workflowRuns), null, conclusion);
      assert.equal(checksReason([], [newerPass, failed], workflowRuns), null, `${conclusion}, listed after`);
    }
  });

  test("a failed run whose job passed later in the workflow's run for another event keeps the thread", () => {
    const pushFailure = run(gate, "completed", "failure", 60, 0, 3);
    const pushPass = run(gate, "completed", "success", 60, 3600, 3);
    assert.equal(checksReason([], [pushFailure, newerPass], workflowRuns), `checks failed: ${gate}`, "push failed");
    assert.equal(checksReason([], [failure, pushPass], workflowRuns), `checks failed: ${gate}`, "pull_request failed");
  });

  test("a failed run whose namesake passed later in another workflow or in the same run keeps the thread", () => {
    for (const suite of [4, 1]) {
      const pass = run(gate, "completed", "success", 60, 3600, suite);
      assert.equal(checksReason([], [failure, pass], workflowRuns), `checks failed: ${gate}`, `suite ${suite}`);
    }
  });

  test("a failed run keeps the thread when the workflow runs don't show the pass replaced it", () => {
    for (const [runs, workflows, label] of [
      [[failure, newerPass], [], "no workflow runs"],
      [[failure, { ...newerPass, check_suite: { id: 99 } }], workflowRuns, "pass's run not listed"],
      [[{ ...failure, check_suite: { id: 99 } }, newerPass], workflowRuns, "failure's run not listed"],
      [[failure, { ...newerPass, check_suite: null }], workflowRuns, "pass outside a check suite"],
    ] as const) {
      assert.equal(checksReason([], runs, workflows), `checks failed: ${gate}`, label);
    }
  });

  test("a failed run whose newer run's pass overlapped it or came first keeps the thread", () => {
    // Started while the failure ran; the second it ended; before it started.
    for (const start of [30, 60, -120]) {
      assert.equal(
        checksReason([], [failure, run(gate, "completed", "success", 60, start, 2)], workflowRuns),
        `checks failed: ${gate}`,
        `pass started at ${start}s`,
      );
    }
  });

  test("a failed run whose job in the newer run failed, was skipped, neutral or cancelled keeps the thread", () => {
    for (const conclusion of ["failure", "skipped", "neutral", "cancelled"]) {
      assert.equal(
        checksReason([], [failure, run(gate, "completed", conclusion, 60, 3600, 2)], workflowRuns),
        `checks failed: ${gate}`,
        conclusion,
      );
    }
  });

  test("a newer pass doesn't excuse a failed run of another name", () => {
    assert.equal(
      checksReason([], [run("test", "completed", "failure"), run("lint", "completed", "success", 60, 3600, 2)], workflowRuns),
      "checks failed: test",
    );
  });

  test("a failed run or a newer pass with a missing time keeps the thread", () => {
    for (const runs of [
      [{ ...failure, completed_at: null }, newerPass],
      [failure, { ...newerPass, started_at: null }],
    ]) {
      assert.equal(checksReason([], runs, workflowRuns), `checks failed: ${gate}`);
    }
  });

  test("each failed run is judged on its own: a failure after the pass still keeps the thread", () => {
    const newestFailure = run(gate, "completed", "failure", 60, 7200, 5);
    assert.equal(checksReason([], [failure, newerPass, newestFailure], workflowRuns), `checks failed: ${gate}`);
  });

  test("a failure with a newer pass, and the job still running in a third run, reports pending", () => {
    const running = run(gate, "in_progress", null, 60, 7200, 5);
    assert.equal(checksReason([], [failure, newerPass, running], workflowRuns), `checks pending: ${gate}`);
  });

  test("an older run with cancelled jobs and a failed gate, replaced by a green run, doesn't keep the thread", () => {
    const older = [run("build", "completed", "cancelled", 30), run(gate, "completed", "failure", 5, 40)];
    const newer = [run("build", "completed", "success", 300, 3600, 2), run(gate, "completed", "success", 5, 3910, 2)];
    assert.equal(checksReason([], [...older, ...newer], workflowRuns), null);
  });

  test("a job that failed in the push run and passed later in a pull_request run keeps the thread (real payload)", () => {
    // An open Dependabot bump: one workflow on push and pull_request; the second
    // pull_request job started 7 s after the push job failed. Fields trimmed to those read.
    const runs = [
      { name: "commitlint check", status: "completed", conclusion: "success", started_at: "2026-11-23T17:35:03Z", completed_at: "2026-11-23T17:36:08Z", check_suite: { id: 122392093118 } },
      { name: "commitlint check", status: "completed", conclusion: "success", started_at: "2026-11-23T17:34:45Z", completed_at: "2026-11-23T17:35:51Z", check_suite: { id: 122392092245 } },
      { name: "commitlint check", status: "completed", conclusion: "failure", started_at: "2026-11-23T17:34:02Z", completed_at: "2026-11-23T17:34:56Z", check_suite: { id: 122392057324 } },
    ];
    const workflows = [
      { workflow_id: 428028452, event: "pull_request", check_suite_id: 122392092245 },
      { workflow_id: 428028452, event: "pull_request", check_suite_id: 122392093118 },
      { workflow_id: 428028452, event: "push", check_suite_id: 122392057324 },
    ];
    assert.equal(checksReason([], runs, workflows), "checks failed: commitlint check");
  });

  test("a run cancelled after it started keeps the thread, as a timed-out Actions job reports cancelled", () => {
    assert.equal(checksReason([], [run("deploy", "completed", "cancelled", 1826)], workflowRuns), "checks cancelled: deploy");
  });

  test("a run cancelled before it started, or with a missing time, doesn't keep the thread", () => {
    assert.equal(checksReason([], [run("cargo test (${{ matrix.platform }})", "completed", "cancelled", 0)], workflowRuns), null);
    assert.equal(checksReason([], [{ ...timedOut, started_at: null }], workflowRuns), null, "no start time");
  });

  test("a cancelled run whose job passed in a newer run of the same workflow for the same event doesn't keep the thread", () => {
    assert.equal(checksReason([], [timedOut, deployPassed], workflowRuns), null);
    assert.equal(checksReason([], [deployPassed, timedOut], workflowRuns), null, "listed after");
  });

  test("a cancelled run whose job passed in a parallel or later run for another event keeps the thread", () => {
    const pushTimedOut = run("deploy", "completed", "cancelled", 1800, 0, 3);
    for (const start of [30, 3600]) {
      const pass = run("deploy", "completed", "success", 60, start, 2);
      assert.equal(checksReason([], [pushTimedOut, pass], workflowRuns), "checks cancelled: deploy", `push cancelled, pass started at ${start}s`);
    }
    const pushPass = run("deploy", "completed", "success", 60, 3600, 3);
    assert.equal(checksReason([], [timedOut, pushPass], workflowRuns), "checks cancelled: deploy", "pull_request cancelled");
  });

  test("a cancelled run whose namesake passed later in another workflow or the same run, or without both workflow runs listed, keeps the thread", () => {
    for (const suite of [4, 1]) {
      const pass = run("deploy", "completed", "success", 60, 3600, suite);
      assert.equal(checksReason([], [timedOut, pass], workflowRuns), "checks cancelled: deploy", `suite ${suite}`);
    }
    assert.equal(checksReason([], [timedOut, deployPassed], []), "checks cancelled: deploy", "no workflow runs");
    assert.equal(checksReason([], [{ ...timedOut, check_suite: { id: 99 } }, deployPassed], workflowRuns), "checks cancelled: deploy", "cancelled run's workflow run not listed");
    assert.equal(checksReason([], [timedOut, { ...deployPassed, check_suite: { id: 99 } }], workflowRuns), "checks cancelled: deploy", "pass's workflow run not listed");
    assert.equal(checksReason([], [timedOut, { ...deployPassed, check_suite: null }], workflowRuns), "checks cancelled: deploy", "pass outside a check suite");
  });

  test("a cancelled run whose newer run's pass overlapped it or came first keeps the thread", () => {
    // Started while it ran; the second it was cancelled; before it started.
    for (const start of [30, 1800, -120]) {
      const pass = run("deploy", "completed", "success", 60, start, 2);
      assert.equal(checksReason([], [timedOut, pass], workflowRuns), "checks cancelled: deploy", `pass started at ${start}s`);
    }
  });

  test("a cancelled run whose job in the newer run was skipped or neutral keeps the thread", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const newer = run("deploy", "completed", conclusion, 0, 3600, 2);
      assert.equal(checksReason([], [timedOut, newer], workflowRuns), "checks cancelled: deploy", conclusion);
    }
  });

  test("each cancelled run is judged on its own: a cancellation after the pass still keeps the thread", () => {
    const newestTimedOut = run("deploy", "completed", "cancelled", 1800, 7200, 5);
    assert.equal(checksReason([], [timedOut, deployPassed, newestTimedOut], workflowRuns), "checks cancelled: deploy");
  });

  test("passed, neutral and skipped checks, or none, don't keep the thread", () => {
    const done = [run("a", "completed", "success"), run("b", "completed", "neutral"), run("c", "completed", "skipped")];
    assert.equal(checksReason([{ context: "Vercel", state: "success" }], done, workflowRuns), null);
    assert.equal(checksReason([], [], []), null);
  });
});

describe("needsWorkflowRuns", () => {
  const at = (conclusion: string, start: number, name = "test") => ({
    name,
    status: "completed",
    conclusion,
    started_at: new Date(Date.parse("2026-11-23T10:00:00Z") + start * 1000).toISOString(),
    completed_at: new Date(Date.parse("2026-11-23T10:00:00Z") + (start + 60) * 1000).toISOString(),
    check_suite: { id: 1 },
  });

  test("only a failed run, or one cancelled after it started, with a same-named pass that started after it completed needs them", () => {
    const neverRan = { ...at("cancelled", 0), completed_at: at("cancelled", 0).started_at };
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 3600)]), true);
    assert.equal(needsWorkflowRuns([at("timed_out", 0), at("success", 3600)]), true);
    assert.equal(needsWorkflowRuns([at("cancelled", 0), at("success", 3600)]), true, "cancelled after it started");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 30)]), false, "overlapping pass");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("skipped", 3600)]), false, "later skip");
    assert.equal(needsWorkflowRuns([at("cancelled", 0), at("skipped", 3600)]), false, "cancelled, later skip");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 3600, "lint")]), false, "other name");
    assert.equal(needsWorkflowRuns([neverRan, at("success", 3600)]), false, "cancelled before it started");
    assert.equal(needsWorkflowRuns([at("success", 0), at("success", 3600)]), false, "nothing failed");
  });
});

describe("participants", () => {
  test("counts people who requested reviews, assigned, labelled or merged", () => {
    for (const event of ["review_requested", "assigned", "labeled", "merged", "closed", "cross-referenced"]) {
      const logins = participants(
        activity({ author: "dependabot[bot]", timeline: [{ event, actor: who("maintainer") }] }),
      );
      assert.ok(logins.has("maintainer"), event);
    }
  });

  test("counts commenters, reviewers, review commenters and commit authors", () => {
    const logins = participants(
      activity({
        author: "dependabot[bot]",
        timeline: [
          { event: "commented", actor: who("commenter"), user: who("commenter") },
          { event: "reviewed", user: who("reviewer") },
          { event: "commit-commented", comments: [{ user: who("commit-commenter") }] },
        ],
        reviewComments: [{ user: who("line-commenter") }],
        commits: [{ author: who("pusher") }, { author: null }],
      }),
    );
    assert.deepEqual(
      [...logins].sort(),
      ["commenter", "commit-commenter", "dependabot[bot]", "line-commenter", "pusher", "reviewer"],
    );
  });

  test("counts discussion commenters", () => {
    const logins = participants(
      activity({
        author: "github-actions[bot]",
        discussionComments: [{ user: who("commenter") }, { user: who("replier") }, { user: null }],
      }),
    );
    assert.deepEqual([...logins].sort(), ["commenter", "github-actions[bot]", "replier"]);
  });

  test("counts who marked a discussion's answer", () => {
    const logins = participants(
      activity({ author: "github-actions[bot]", discussionComments: [{ user: who(ME) }], answerChosenBy: "maintainer" }),
    );
    assert.deepEqual([...logins].sort(), ["github-actions[bot]", "maintainer", ME]);
  });

  test("ignores the account notified by mentioned and subscribed events", () => {
    const logins = participants(
      activity({
        author: "dependabot[bot]",
        timeline: [
          { event: "mentioned", actor: who("bystander") },
          { event: "subscribed", actor: who("bystander") },
        ],
      }),
    );
    assert.deepEqual([...logins], ["dependabot[bot]"]);
  });
});
