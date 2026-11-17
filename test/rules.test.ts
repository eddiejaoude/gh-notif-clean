import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_IGNORED, decide, participants, type ThreadActivity } from "../src/rules.ts";

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
