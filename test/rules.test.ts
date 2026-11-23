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
  return { author: null, timeline: [], reviewComments: [], commits: [], discussionComments: [], ...parts };
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
  /** A check run that started at 10:00 and, once completed, ran for `seconds`. */
  const run = (name: string, status: string, conclusion: string | null = null, seconds = 60) => ({
    name,
    status,
    conclusion,
    started_at: "2026-11-23T10:00:00Z",
    completed_at: status === "completed" ? new Date(Date.parse("2026-11-23T10:00:00Z") + seconds * 1000).toISOString() : null,
  });

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

  test("counts discussion commenters", () => {
    const logins = participants(
      activity({
        author: "github-actions[bot]",
        discussionComments: [{ user: who("commenter") }, { user: who("replier") }, { user: null }],
      }),
    );
    assert.deepEqual([...logins].sort(), ["commenter", "github-actions[bot]", "replier"]);
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
