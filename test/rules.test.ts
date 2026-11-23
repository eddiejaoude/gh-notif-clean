import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checksReason,
  DEFAULT_IGNORED,
  decide,
  NOTIFICATION_REASONS,
  parseReasons,
  participants,
  type ThreadActivity,
} from "../src/rules.ts";

const ME = "octocat";
const IGNORED = new Set(DEFAULT_IGNORED);
const who = (login: string) => ({ login });

function activity(parts: Partial<ThreadActivity>): ThreadActivity {
  return { author: null, timeline: [], reviewComments: [], commits: [], ...parts };
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
  /** A check run that started `start` seconds after 10:00 and, once completed, ran for `seconds`. */
  const run = (name: string, status: string, conclusion: string | null = null, seconds = 60, start = 0) => {
    const startedAt = Date.parse("2026-11-23T10:00:00Z") + start * 1000;
    return {
      name,
      status,
      conclusion,
      started_at: new Date(startedAt).toISOString(),
      completed_at: status === "completed" ? new Date(startedAt + seconds * 1000).toISOString() : null,
    };
  };
  const gate = "All required checks pass";

  test("a failed Vercel deploy keeps the thread", () => {
    assert.equal(checksReason([{ context: "Vercel", state: "failure" }], []), "checks failed: Vercel");
  });

  test("errored statuses and failed, timed out or blocked check runs count as failed", () => {
    const reason = checksReason(
      [{ context: "ci/legacy", state: "error" }],
      [run("test", "completed", "failure"), run("e2e", "completed", "timed_out"), run("gate", "completed", "action_required")],
    );
    assert.equal(reason, "checks failed: ci/legacy, e2e, gate and 1 more");
  });

  test("unfinished checks keep the thread", () => {
    assert.equal(
      checksReason([{ context: "Vercel", state: "pending" }], [run("build", "in_progress"), run("lint", "queued")]),
      "checks pending: Vercel, build, lint",
    );
  });

  test("failed checks are reported over unfinished ones", () => {
    assert.equal(checksReason([{ context: "Vercel", state: "pending" }], [run("test", "completed", "failure")]), "checks failed: test");
  });

  test("a failed run that a same-named run started after it completed passed doesn't keep the thread", () => {
    for (const conclusion of ["failure", "timed_out", "action_required"]) {
      const reRun = run(gate, "completed", "success", 60, 86_400);
      assert.equal(checksReason([], [run(gate, "completed", conclusion), reRun]), null, conclusion);
      assert.equal(checksReason([], [reRun, run(gate, "completed", conclusion)]), null, `${conclusion}, listed after`);
    }
  });

  test("a failed run whose same-named pass overlapped it or came first keeps the thread", () => {
    // Same job in parallel push and pull_request suites; one starting the second the failure ended; an earlier pass.
    for (const start of [30, 60, -120]) {
      assert.equal(
        checksReason([], [run(gate, "completed", "failure"), run(gate, "completed", "success", 60, start)]),
        `checks failed: ${gate}`,
        `pass started at ${start}s`,
      );
    }
  });

  test("a failed run whose later namesake failed, was skipped, neutral or cancelled keeps the thread", () => {
    for (const conclusion of ["failure", "skipped", "neutral", "cancelled"]) {
      assert.equal(
        checksReason([], [run(gate, "completed", "failure"), run(gate, "completed", conclusion, 60, 3600)]),
        `checks failed: ${gate}`,
        conclusion,
      );
    }
  });

  test("a later pass doesn't excuse a failed run of another name", () => {
    assert.equal(
      checksReason([], [run("test", "completed", "failure"), run("lint", "completed", "success", 60, 3600)]),
      "checks failed: test",
    );
  });

  test("a failed run or a later pass with a missing time keeps the thread", () => {
    const failure = run(gate, "completed", "failure");
    const reRun = run(gate, "completed", "success", 60, 3600);
    for (const runs of [
      [{ ...failure, completed_at: null }, reRun],
      [failure, { ...reRun, started_at: null }],
    ]) {
      assert.equal(checksReason([], runs), `checks failed: ${gate}`);
    }
  });

  test("a run cancelled after it started keeps the thread, as a timed-out Actions job reports cancelled", () => {
    assert.equal(checksReason([], [run("deploy", "completed", "cancelled", 1826)]), "checks cancelled: deploy");
  });

  test("a run cancelled before it started doesn't keep the thread", () => {
    assert.equal(checksReason([], [run("cargo test (${{ matrix.platform }})", "completed", "cancelled", 0)]), null);
  });

  test("a cancelled run whose namesake passed, was skipped or was neutral doesn't keep the thread", () => {
    for (const conclusion of ["success", "skipped", "neutral"]) {
      assert.equal(checksReason([], [run("e2e", "completed", "cancelled"), run("e2e", "completed", conclusion)]), null, conclusion);
    }
  });

  test("passed, neutral and skipped checks, or none, don't keep the thread", () => {
    const done = [run("a", "completed", "success"), run("b", "completed", "neutral"), run("c", "completed", "skipped")];
    assert.equal(checksReason([{ context: "Vercel", state: "success" }], done), null);
    assert.equal(checksReason([], []), null);
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
