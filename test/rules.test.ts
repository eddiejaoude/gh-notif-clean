import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checksReason,
  DEFAULT_IGNORED,
  decide,
  needsWorkflowRuns,
  NOTIFICATION_REASONS,
  parseIgnoreList,
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
  /**
   * Suites 1, 2 and 5 are `pull_request` runs of workflow 10, suite 3 is its `push` run, suite 4 is another workflow's.
   * Suites 6 and 7 are `workflow_dispatch` runs of workflow 10 and suite 8 is its `issue_comment` run: the PR's check
   * list leaves those three out.
   */
  const workflowRuns = [
    { check_suite_id: 1, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
    { check_suite_id: 2, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
    { check_suite_id: 3, workflow_id: 10, event: "push", path: ".github/workflows/ci.yml" },
    { check_suite_id: 4, workflow_id: 20, event: "pull_request", path: ".github/workflows/lint.yml" },
    { check_suite_id: 5, workflow_id: 10, event: "pull_request", path: ".github/workflows/ci.yml" },
    { check_suite_id: 6, workflow_id: 10, event: "workflow_dispatch", path: ".github/workflows/ci.yml" },
    { check_suite_id: 7, workflow_id: 10, event: "workflow_dispatch", path: ".github/workflows/ci.yml" },
    { check_suite_id: 8, workflow_id: 10, event: "issue_comment", path: ".github/workflows/ci.yml" },
  ];
  const gate = "All required checks pass";
  const failure = run(gate, "completed", "failure");
  /** The gate passing in the newer `pull_request` run, an hour after `failure`. */
  const newerPass = run(gate, "completed", "success", 60, 3600, 2);
  /** `deploy` cancelled half an hour into the first `pull_request` run, as a job that hit `timeout-minutes` reports. */
  const timedOut = run("deploy", "completed", "cancelled", 1800);
  /** `deploy` passing in the newer `pull_request` run, an hour after `timedOut` started. */
  const deployPassed = run("deploy", "completed", "success", 60, 3600, 2);
  /** The gate failing half an hour into the first `workflow_dispatch` run, which the PR's check list leaves out. */
  const dispatched = run(gate, "completed", "failure", 1800, 0, 6);

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

  test("unfinished checks are reported over cancelled ones", () => {
    assert.equal(checksReason([], [timedOut, run("build", "in_progress")], workflowRuns), "checks pending: build");
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
      { workflow_id: 428028452, event: "pull_request", path: ".github/workflows/continuous-integration.yaml", check_suite_id: 122392092245 },
      { workflow_id: 428028452, event: "pull_request", path: ".github/workflows/continuous-integration.yaml", check_suite_id: 122392093118 },
      { workflow_id: 428028452, event: "push", path: ".github/workflows/continuous-integration.yaml", check_suite_id: 122392057324 },
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

  test("a failed or cancelled run the check list leaves out doesn't keep the thread when the list's run of its workflow passed the job, whichever ran first", () => {
    for (const conclusion of ["failure", "timed_out", "action_required", "cancelled"]) {
      const leftOut = run(gate, "completed", conclusion, 1800, 0, 6);
      // Started an hour before it, while it ran, and an hour after it started.
      for (const start of [-3600, 30, 3600]) {
        const pass = run(gate, "completed", "success", 60, start, 1);
        assert.equal(checksReason([], [leftOut, pass], workflowRuns), null, `${conclusion}, pass started at ${start}s`);
        assert.equal(checksReason([], [pass, leftOut], workflowRuns), null, `${conclusion}, pass started at ${start}s, listed first`);
      }
    }
  });

  test("a failed run the check list leaves out keeps the thread when the list's run of its workflow skipped the job", () => {
    assert.equal(checksReason([], [dispatched, run(gate, "completed", "skipped", 0, 5, 1)], workflowRuns), `checks failed: ${gate}`);
  });

  test("a failed run the check list leaves out keeps the thread unless the job passed in a listed run of its workflow", () => {
    for (const [runs, label] of [
      [[dispatched], "no other run of the job, as when the workflow has no run in the list"],
      [[dispatched, run(gate, "completed", "neutral", 60, 3600, 1)], "neutral in the list's run"],
      [[dispatched, run(gate, "completed", "success", 60, 3600, 4)], "passed in another workflow's listed run"],
      [[dispatched, run(gate, "completed", "success", 60, 3600, 8)], "passed in a run for another event the list leaves out"],
      [[dispatched, run(gate, "completed", "success", 60, 30, 7)], "passed in an overlapping run for the same event"],
    ] as const) {
      assert.equal(checksReason([], runs, workflowRuns), `checks failed: ${gate}`, label);
    }
  });

  test("a failed run the check list leaves out is still excused by a newer run for its event, like a listed one", () => {
    assert.equal(checksReason([], [dispatched, run(gate, "completed", "success", 60, 3600, 7)], workflowRuns), null);
  });

  test("an unfinished run the check list leaves out keeps the thread, even when the list's run of its workflow passed the job", () => {
    const pass = run(gate, "completed", "success", 60, 0, 1);
    for (const status of ["in_progress", "queued"]) {
      assert.equal(checksReason([], [run(gate, status, null, 60, 30, 6), pass], workflowRuns), `checks pending: ${gate}`, status);
    }
  });

  test("a failed run in the check list keeps the thread when the job passed only in a run the list leaves out", () => {
    assert.equal(checksReason([], [failure, run(gate, "completed", "success", 60, 3600, 6)], workflowRuns), `checks failed: ${gate}`);
  });

  test("a failed run the check list leaves out keeps the thread when the workflow runs don't show the listed pass", () => {
    const pass = run(gate, "completed", "success", 60, 3600, 1);
    for (const [runs, workflows, label] of [
      [[dispatched, pass], [], "no workflow runs"],
      [[{ ...dispatched, check_suite: { id: 99 } }, pass], workflowRuns, "failure's run not listed"],
      [[dispatched, { ...pass, check_suite: { id: 99 } }], workflowRuns, "pass's run not listed"],
      [[dispatched, { ...pass, check_suite: null }], workflowRuns, "pass outside a check suite"],
    ] as const) {
      assert.equal(checksReason([], runs, workflows), `checks failed: ${gate}`, label);
    }
  });

  test("only a pass in a run for an event the check list includes excuses a failed run for an event it leaves out", () => {
    const listed = ["push", "pull_request", "pull_request_review", "pull_request_target", "deployment", "deployment_status", "merge_group", "dynamic"];
    const leftOut = ["workflow_dispatch", "pull_request_review_comment", "issue_comment", "schedule", "create"];
    // The pass started first, so a newer run for the same event can't be what excuses the failure.
    const runs = [run(gate, "completed", "failure", 60, 0, 1), run(gate, "completed", "success", 60, -3600, 2)];
    for (const failedEvent of [...listed, ...leftOut]) {
      for (const passEvent of [...listed, ...leftOut].filter((event) => event !== failedEvent)) {
        const workflows = [
          { check_suite_id: 1, workflow_id: 10, event: failedEvent, path: ".github/workflows/ci.yml" },
          { check_suite_id: 2, workflow_id: 10, event: passEvent, path: ".github/workflows/ci.yml" },
        ];
        const excused = leftOut.includes(failedEvent) && listed.includes(passEvent);
        assert.equal(checksReason([], runs, workflows), excused ? null : `checks failed: ${gate}`, `${failedEvent} failed, ${passEvent} passed`);
      }
    }
  });

  test("dispatched jobs that were cancelled or failed, then passed in the PR's own run of that workflow, don't keep the thread (real payload)", () => {
    // An open PR: a `workflow_dispatch` run on its branch had five jobs cancelled about 15 minutes in and its
    // summary job failed; the same jobs then passed in the PR's `pull_request` run of that workflow, the only
    // one `gh pr checks` lists. Fields trimmed to those read, and check runs to that workflow's two runs (12 of
    // the commit's 39): the PR's other checks still keep it.
    const runs = [
      { name: "diagnostics table, all runs", status: "completed", conclusion: "success", started_at: "2026-11-24T01:39:21Z", completed_at: "2026-11-24T01:39:33Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics table, all runs", status: "completed", conclusion: "failure", started_at: "2026-11-24T00:02:19Z", completed_at: "2026-11-24T00:02:34Z", check_suite: { id: 122560397435 } },
      { name: "diagnostics run 1", status: "completed", conclusion: "success", started_at: "2026-11-24T00:02:17Z", completed_at: "2026-11-24T01:35:48Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics run 5", status: "completed", conclusion: "success", started_at: "2026-11-24T00:02:16Z", completed_at: "2026-11-24T00:20:39Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics run 3", status: "completed", conclusion: "success", started_at: "2026-11-24T00:02:31Z", completed_at: "2026-11-24T01:39:18Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics run 4", status: "completed", conclusion: "success", started_at: "2026-11-24T00:02:17Z", completed_at: "2026-11-24T01:30:17Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics run 2", status: "completed", conclusion: "success", started_at: "2026-11-24T00:02:25Z", completed_at: "2026-11-24T00:20:42Z", check_suite: { id: 122560583971 } },
      { name: "diagnostics run 1", status: "completed", conclusion: "cancelled", started_at: "2026-11-23T23:47:37Z", completed_at: "2026-11-24T00:02:13Z", check_suite: { id: 122560397435 } },
      { name: "diagnostics run 3", status: "completed", conclusion: "cancelled", started_at: "2026-11-23T23:47:37Z", completed_at: "2026-11-24T00:02:14Z", check_suite: { id: 122560397435 } },
      { name: "diagnostics run 4", status: "completed", conclusion: "cancelled", started_at: "2026-11-23T23:47:36Z", completed_at: "2026-11-24T00:02:09Z", check_suite: { id: 122560397435 } },
      { name: "diagnostics run 2", status: "completed", conclusion: "cancelled", started_at: "2026-11-23T23:47:37Z", completed_at: "2026-11-24T00:02:14Z", check_suite: { id: 122560397435 } },
      { name: "diagnostics run 5", status: "completed", conclusion: "cancelled", started_at: "2026-11-23T23:47:36Z", completed_at: "2026-11-24T00:02:10Z", check_suite: { id: 122560397435 } },
    ];
    const workflows = [
      { workflow_id: 421617442, event: "pull_request", path: ".github/workflows/build1-arm-diagnostics.yml", check_suite_id: 122560583971 },
      { workflow_id: 421617442, event: "workflow_dispatch", path: ".github/workflows/build1-arm-diagnostics.yml", check_suite_id: 122560397435 },
    ];
    assert.equal(checksReason([], runs, workflows), null);
  });

  test("integration tests that failed in a dispatched run keep the thread when the PR's own run of that workflow skipped them (real payload)", () => {
    // An open PR that GitHub showed passing: its check list holds only the `pull_request` run of the integration
    // workflow, which skipped every job, while a `workflow_dispatch` run on the same commit ran them and two
    // failed. Fields trimmed to those read, and to three of each run's jobs.
    const runs = [
      { name: "Build (Linux)", status: "completed", conclusion: "success", started_at: "2026-11-24T05:33:04Z", completed_at: "2026-11-24T05:34:05Z", check_suite: { id: 122669514299 } },
      { name: "Integration Tests Shard 7 (Linux)", status: "completed", conclusion: "failure", started_at: "2026-11-24T05:34:36Z", completed_at: "2026-11-24T05:48:00Z", check_suite: { id: 122669514299 } },
      { name: "Integration Tests (Linux)", status: "completed", conclusion: "failure", started_at: "2026-11-24T05:51:32Z", completed_at: "2026-11-24T05:52:03Z", check_suite: { id: 122669514299 } },
      { name: "Integration Tests Shard ${{ matrix.shard }} (Linux)", status: "completed", conclusion: "skipped", started_at: "2026-11-24T05:33:37Z", completed_at: "2026-11-24T05:33:36Z", check_suite: { id: 122669537975 } },
      { name: "Integration Tests (Linux)", status: "completed", conclusion: "skipped", started_at: "2026-11-24T05:33:37Z", completed_at: "2026-11-24T05:33:37Z", check_suite: { id: 122669537975 } },
      { name: "Build (Linux)", status: "completed", conclusion: "skipped", started_at: "2026-11-24T05:33:37Z", completed_at: "2026-11-24T05:33:36Z", check_suite: { id: 122669537975 } },
    ];
    const workflows = [
      { workflow_id: 238019698, event: "pull_request", path: ".github/workflows/ci-integration.yml", check_suite_id: 122669537975 },
      { workflow_id: 238019698, event: "workflow_dispatch", path: ".github/workflows/ci-integration.yml", check_suite_id: 122669514299 },
    ];
    assert.equal(checksReason([], runs, workflows), "checks failed: Integration Tests (Linux), Integration Tests Shard 7 (Linux)");
  });

  /** A `dynamic` workflow run, one of GitHub's own workflows, in check suite `suite`. */
  const dynamic = (suite: number, path: string) => ({ check_suite_id: suite, workflow_id: suite * 10, event: "dynamic", path });
  /**
   * A job of each of GitHub's own workflows that the PR's check list leaves out, as sampled: Copilot's code review,
   * GitHub Advanced Security's AI findings, Copilot's cloud agent, Dependabot's updates, two dependency graph builds,
   * the Claude and Codex cloud agents, three jobs of the workflow Copilot's code review ran until May 2026, and the
   * three Codespaces prebuild workflows. Job `i` is in suite `20 + i`, which `leftOutRuns` gives the workflow's path.
   */
  const leftOutJobs = [
    ["copilot-pull-request-reviewer", "dynamic/agents/copilot-pull-request-reviewer"],
    ["github-advanced-security", "dynamic/agents/github-advanced-security"],
    ["copilot", "dynamic/copilot-swe-agent/copilot"],
    ["Dependabot", "dynamic/dependabot/dependabot-updates"],
    ["update-pip-graph", "dynamic/dependabot/update-graph"],
    ["update-go_modules-graph", "dynamic/dependabot/update-graph"],
    ["claude", "dynamic/agents/anthropic-code-agent"],
    ["codex", "dynamic/agents/openai-code-agent"],
    ["Agent", "dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer"],
    ["Cleanup artifacts", "dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer"],
    ["CodeQL analysis (go)", "dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer"],
    ["prebuild", "dynamic/codespaces/create_codespaces_prebuilds"],
    ["prebuild", "dynamic/codespaces/create_codespaces_prebuilds_development"],
    ["prebuild", "dynamic/codespaces/create_codespaces_prebuilds_ppe"],
  ] as const;
  const leftOutRuns = leftOutJobs.map(([, path], i) => dynamic(20 + i, path));

  test("a job of GitHub's own workflows that the check list leaves out doesn't keep the thread, whatever its result", () => {
    leftOutJobs.forEach(([job], i) => {
      for (const [status, conclusion] of [
        ["completed", "failure"],
        ["completed", "timed_out"],
        ["completed", "action_required"],
        ["completed", "cancelled"],
        ["in_progress", null],
        ["queued", null],
      ] as const) {
        const runs = [run(job, status, conclusion, 1800, 0, 20 + i)];
        const label = `${job}, ${conclusion ?? status}`;
        assert.equal(checksReason([], runs, leftOutRuns), null, label);
        assert.notEqual(checksReason([], runs, []), null, `${label}, without its workflow run`);
      }
    });
  });

  test("Copilot reviewing the PR doesn't keep the thread", () => {
    const reviewing = run("copilot-pull-request-reviewer", "in_progress", null, 60, 0, 20);
    const passed = [{ context: "Vercel", state: "success" }];
    assert.equal(checksReason(passed, [reviewing, run("test", "completed", "success")], [...workflowRuns, ...leftOutRuns]), null);
  });

  test("a failed Dependabot update job on a PR from the default branch doesn't keep the thread", () => {
    const update = run("Dependabot", "completed", "failure", 300, 0, 23);
    const passed = [{ context: "Vercel", state: "success" }];
    assert.equal(checksReason(passed, [update, run("test", "completed", "success")], [...workflowRuns, ...leftOutRuns]), null);
  });

  test("Copilot's PR whose cloud agent job was cancelled 22 s in doesn't keep the thread (real payload)", () => {
    // An open PR that Copilot's cloud agent opened ten weeks earlier, which GitHub shows with no checks: the agent's
    // job is its head commit's only check run, and the commit's other workflow run, a `pull_request` run that failed,
    // has no jobs. Fields trimmed to those read.
    const runs = [
      { name: "copilot", status: "completed", conclusion: "cancelled", started_at: "2026-09-16T00:09:29Z", completed_at: "2026-09-16T00:09:51Z", check_suite: { id: 94888567577 } },
    ];
    const workflows = [
      { workflow_id: 335335940, event: "pull_request", path: ".github/workflows/firebase-hosting-pull-request.yml", check_suite_id: 94888573084 },
      { workflow_id: 335862696, event: "dynamic", path: "dynamic/copilot-swe-agent/copilot", check_suite_id: 94888567577 },
    ];
    assert.equal(needsWorkflowRuns(runs), true);
    assert.equal(checksReason([], runs, workflows), null);
    // Without its workflow runs, nothing shows that the job is the agent's, so it's kept as before.
    assert.equal(checksReason([], runs, []), "checks cancelled: copilot");
  });

  test("Codex's PR whose agent job failed doesn't keep the thread (real payload)", () => {
    // An open PR that the Codex cloud agent opened, which GitHub shows with no checks: the agent's job is its head
    // commit's only check run, and its `pull_request` run waits for approval with no jobs. Fields trimmed to those read.
    const runs = [
      { name: "codex", status: "completed", conclusion: "failure", started_at: "2026-11-21T00:26:16Z", completed_at: "2026-11-21T00:31:43Z", check_suite: { id: 121376385623 } },
    ];
    const workflows = [
      { workflow_id: 422174901, event: "pull_request", path: ".github/workflows/ci.yml", check_suite_id: 121376391469 },
      { workflow_id: 425502401, event: "dynamic", path: "dynamic/agents/openai-code-agent", check_suite_id: 121376385623 },
    ];
    assert.equal(needsWorkflowRuns(runs), true);
    assert.equal(checksReason([], runs, workflows), null);
    assert.equal(checksReason([], runs, []), "checks failed: codex");
  });

  test("a PR that Copilot reviewed before May 2026, whose review run failed to clean up, doesn't keep the thread (real payload)", () => {
    // An open PR that GitHub shows with no checks: its head commit's only check runs are the six jobs of the workflow
    // that Copilot's code review ran then. Fields trimmed to those read.
    const suite = { id: 54268968288 };
    const runs = [
      { name: "Cleanup artifacts", status: "completed", conclusion: "failure", started_at: "2026-01-13T15:53:44Z", completed_at: "2026-01-13T15:53:50Z", check_suite: suite },
      { name: "Upload results", status: "completed", conclusion: "success", started_at: "2026-01-13T15:53:29Z", completed_at: "2026-01-13T15:53:41Z", check_suite: suite },
      { name: "CodeQL analysis (go)", status: "completed", conclusion: "success", started_at: "2026-01-13T15:50:18Z", completed_at: "2026-01-13T15:51:08Z", check_suite: suite },
      { name: "Agent", status: "completed", conclusion: "success", started_at: "2026-01-13T15:50:19Z", completed_at: "2026-01-13T15:53:26Z", check_suite: suite },
      { name: "Autovalidate", status: "completed", conclusion: "skipped", started_at: "2026-01-13T15:50:09Z", completed_at: "2026-01-13T15:50:09Z", check_suite: suite },
      { name: "Prepare", status: "completed", conclusion: "success", started_at: "2026-01-13T15:50:12Z", completed_at: "2026-01-13T15:50:16Z", check_suite: suite },
    ];
    const workflows = [
      { workflow_id: 223038474, event: "dynamic", path: "dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer", check_suite_id: 54268968288 },
    ];
    assert.equal(needsWorkflowRuns(runs), true);
    assert.equal(checksReason([], runs, workflows), null);
    assert.equal(checksReason([], runs, []), "checks failed: Cleanup artifacts");
  });

  test("a job of GitHub's own workflows that the check list includes keeps the thread, such as a failed CodeQL default setup analysis", () => {
    const listed = [
      dynamic(30, "dynamic/github-code-scanning/codeql"),
      dynamic(31, "dynamic/github-code-quality/codeql"),
      dynamic(32, "dynamic/pages/pages-build-deployment"),
      dynamic(33, "dynamic/dependency-graph/auto-submission"),
    ];
    for (const [job, label, reason] of [
      [run("Analyze (javascript-typescript)", "completed", "failure", 120, 0, 30), "CodeQL default setup", "checks failed: Analyze (javascript-typescript)"],
      [run("Analyze (python)", "in_progress", null, 60, 0, 31), "CodeQL code quality", "checks pending: Analyze (python)"],
      [run("deploy", "completed", "cancelled", 600, 0, 32), "Pages build", "checks cancelled: deploy"],
      [run("submit-maven", "completed", "failure", 60, 0, 33), "dependency submission", "checks failed: submit-maven"],
    ] as const) {
      assert.equal(checksReason([], [job], listed), reason, label);
    }
  });

  test("a job of a `dynamic` workflow not known to be left out keeps the thread, even with a left-out job's name", () => {
    const unknown = [dynamic(40, "dynamic/agents/new-agent"), dynamic(41, "dynamic/copilot-swe-agent/copilot-next")];
    assert.equal(checksReason([], [run("new-agent", "completed", "failure", 60, 0, 40)], unknown), "checks failed: new-agent");
    assert.equal(checksReason([], [run("copilot", "completed", "cancelled", 22, 0, 41)], unknown), "checks cancelled: copilot");
  });

  test("a check run with a left-out job's name keeps the thread unless its workflow run is that job's workflow", () => {
    const own = { check_suite_id: 50, workflow_id: 500, event: "pull_request", path: ".github/workflows/dependabot.yml" };
    const dependabot = run("Dependabot", "completed", "failure");
    for (const [runs, workflows, label] of [
      [[{ ...dependabot, check_suite: { id: 50 } }], [own], "a job of the PR's own workflow"],
      [[{ ...dependabot, check_suite: { id: 22 } }], leftOutRuns, "in the cloud agent's workflow run"],
      [[{ ...dependabot, check_suite: { id: 99 } }], leftOutRuns, "its workflow run not listed"],
      [[{ ...dependabot, check_suite: null }], leftOutRuns, "outside a check suite"],
      [[{ ...dependabot, check_suite: { id: 23 } }], [], "no workflow runs"],
    ] as const) {
      assert.equal(checksReason([], runs, workflows), "checks failed: Dependabot", label);
    }
  });

  test("a check run that a workflow created in a left-out workflow's check suite keeps the thread", () => {
    // Check runs created through the API, such as a deploy preview, can land in any of the commit's Actions suites.
    assert.equal(checksReason([], [run("Deploy Preview", "completed", "failure", 60, 0, 20)], leftOutRuns), "checks failed: Deploy Preview");
  });

  test("left-out jobs are dropped from the reason the PR's other checks give", () => {
    const reviewing = run("copilot-pull-request-reviewer", "in_progress", null, 60, 0, 20);
    const update = run("Dependabot", "completed", "failure", 60, 0, 23);
    const all = [...workflowRuns, ...leftOutRuns];
    assert.equal(checksReason([], [reviewing, update, run("test", "completed", "failure")], all), "checks failed: test");
    // The review still running doesn't make the checks pending: the cancelled deploy is the reason.
    assert.equal(checksReason([], [reviewing, update, timedOut], all), "checks cancelled: deploy");
  });

  test("passed, neutral and skipped checks, or none, don't keep the thread", () => {
    const done = [run("a", "completed", "success"), run("b", "completed", "neutral"), run("c", "completed", "skipped")];
    assert.equal(checksReason([{ context: "Vercel", state: "success" }], done, workflowRuns), null);
    assert.equal(checksReason([], [], []), null);
  });
});

describe("needsWorkflowRuns", () => {
  /** A check run in check suite `suite` that started `start` seconds after 10:00 and ran for a minute. */
  const at = (conclusion: string, start: number, suite = 1, name = "test") => ({
    name,
    status: "completed",
    conclusion,
    started_at: new Date(Date.parse("2026-11-23T10:00:00Z") + start * 1000).toISOString(),
    completed_at: new Date(Date.parse("2026-11-23T10:00:00Z") + (start + 60) * 1000).toISOString(),
    check_suite: { id: suite },
  });

  test("a failed run, or one cancelled after it started, needs them when the job passed in another check suite", () => {
    const neverRan = { ...at("cancelled", 0), completed_at: at("cancelled", 0).started_at };
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 3600, 2)]), true);
    assert.equal(needsWorkflowRuns([at("timed_out", 0), at("success", 3600, 2)]), true);
    assert.equal(needsWorkflowRuns([at("cancelled", 0), at("success", 3600, 2)]), true, "cancelled after it started");
    // A listed pass excuses a run the check list leaves out whichever ran first.
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 30, 2)]), true, "overlapping pass");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", -3600, 2)]), true, "earlier pass");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 3600)]), false, "pass in the same check suite");
    assert.equal(needsWorkflowRuns([at("failure", 0), { ...at("success", 3600), check_suite: null }]), false, "pass outside a check suite");
    assert.equal(needsWorkflowRuns([{ ...at("failure", 0), check_suite: null }, at("success", 3600, 2)]), false, "failure outside a check suite");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("skipped", 3600, 2)]), false, "later skip");
    assert.equal(needsWorkflowRuns([at("cancelled", 0), at("skipped", 3600, 2)]), false, "cancelled, later skip");
    assert.equal(needsWorkflowRuns([at("failure", 0), at("success", 3600, 2, "lint")]), false, "other name");
    assert.equal(needsWorkflowRuns([neverRan, at("success", 3600, 2)]), false, "cancelled before it started");
    assert.equal(needsWorkflowRuns([at("success", 0), at("success", 3600, 2)]), false, "nothing failed");
  });

  test("a failed or unfinished run, or one cancelled after it started, needs them when it has the name of a job GitHub leaves out", () => {
    for (const name of [
      "copilot-pull-request-reviewer",
      "github-advanced-security",
      "copilot",
      "Dependabot",
      "update-pip-graph",
      "update-go_modules-graph",
      "claude",
      "codex",
      "Prepare",
      "Agent",
      "Upload results",
      "Cleanup artifacts",
      "Autovalidate",
      "CodeQL analysis",
      "CodeQL analysis (go)",
      "prebuild",
    ]) {
      assert.equal(needsWorkflowRuns([at("failure", 0, 1, name)]), true, `${name} failed`);
      assert.equal(needsWorkflowRuns([at("timed_out", 0, 1, name)]), true, `${name} timed out`);
      assert.equal(needsWorkflowRuns([at("cancelled", 0, 1, name)]), true, `${name} cancelled after it started`);
      assert.equal(needsWorkflowRuns([{ ...at("success", 0, 1, name), status: "in_progress", conclusion: null, completed_at: null }]), true, `${name} unfinished`);
      for (const conclusion of ["success", "skipped", "neutral"]) {
        assert.equal(needsWorkflowRuns([at(conclusion, 0, 1, name)]), false, `${name} ${conclusion}`);
      }
      assert.equal(needsWorkflowRuns([{ ...at("cancelled", 0, 1, name), completed_at: at("cancelled", 0).started_at }]), false, `${name} cancelled before it started`);
    }
    // Names that only look like those jobs, such as one with a word before or after it or in another case, and a job
    // of a `dynamic` workflow that GitHub lists.
    for (const name of [
      "Copilot",
      "github-copilot",
      "copilot-setup-steps",
      "copilot-pull-request-reviewer-2",
      "my-copilot-pull-request-reviewer",
      "github-advanced-security-scan",
      "pre-github-advanced-security",
      "dependabot",
      "Dependabot auto-merge",
      "Auto-merge Dependabot",
      "update-graph",
      "pre-update-pip-graph",
      "update-pip-graph-2",
      "claude-review",
      "run-claude",
      "Claude",
      "codex-review",
      "run-codex",
      "Prepare release",
      "Pre-Prepare",
      "CodeQL analysis go",
      "prebuild (linux)",
      "npm prebuild",
      "prepare",
      "agent",
      "CodeQL Analysis (rust)",
      "Codex",
      "Prebuild",
      "Copilot-Pull-Request-Reviewer",
      "GitHub-Advanced-Security",
      "Update-pip-graph",
      "Analyze (actions)",
    ]) {
      assert.equal(needsWorkflowRuns([at("failure", 0, 1, name)]), false, name);
    }
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

describe("parseIgnoreList (GH_NOTIF_CLEAN_IGNORE)", () => {
  test("trims entries and skips empty ones", () => {
    assert.deepEqual(parseIgnoreList(" cla-assistant[bot] ,, github-actions[bot],  ,"), [
      "cla-assistant[bot]",
      "github-actions[bot]",
    ]);
  });

  test("is empty when unset or blank", () => {
    assert.deepEqual(parseIgnoreList(undefined), []);
    assert.deepEqual(parseIgnoreList(" , "), []);
  });
});
