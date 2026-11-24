export const DEFAULT_IGNORED: readonly string[] = [
  "vercel[bot]",
  "dependabot[bot]",
  "dependabot-preview[bot]",
  "github-advanced-security[bot]",
];

interface Account {
  login: string;
}

export interface TimelineEvent {
  event: string;
  actor?: Account | null;
  user?: Account | null;
  comments?: readonly { user?: Account | null }[];
}

/** Everything fetched for one notification thread. */
export interface ThreadActivity {
  /** Author of the PR, issue, release, commit or discussion the thread is about. */
  author: string | null;
  timeline: readonly TimelineEvent[];
  reviewComments: readonly { user: Account | null }[];
  commits: readonly { author: Account | null }[];
  /** Comments on a discussion, threaded replies included. */
  discussionComments: readonly { user: Account | null }[];
  /** Who marked a comment on the discussion as its answer. */
  answerChosenBy: string | null;
}

/**
 * Timeline events whose actor did not act on the thread: the actor of
 * `mentioned`/`subscribed` is the person notified, and `committed` events carry
 * only a git name (commit accounts come from `commits`).
 */
const PASSIVE_EVENTS: Record<string, true> = { mentioned: true, subscribed: true, unsubscribed: true, committed: true };

/** Logins of everyone who took part in the thread. */
export function participants(activity: ThreadActivity): Set<string> {
  const logins = new Set<string>();
  const add = (account: Account | null | undefined) => {
    if (account?.login) logins.add(account.login);
  };
  if (activity.author) logins.add(activity.author);
  for (const event of activity.timeline) {
    if (PASSIVE_EVENTS[event.event]) continue;
    add(event.actor);
    add(event.user);
    for (const comment of event.comments ?? []) add(comment.user);
  }
  for (const comment of activity.reviewComments) add(comment.user);
  for (const commit of activity.commits) add(commit.author);
  for (const comment of activity.discussionComments) add(comment.user);
  if (activity.answerChosenBy) logins.add(activity.answerChosenBy);
  return logins;
}

export type Decision = { done: true } | { done: false; reason: string };

/**
 * A thread is done when every participant is `me` or an ignored account and at
 * least one ignored account took part. Logins compare case-insensitively.
 */
export function decide(
  logins: ReadonlySet<string>,
  me: string,
  ignored: ReadonlySet<string>,
): Decision {
  const self = me.toLowerCase();
  const isIgnored = (login: string) => ignored.has(login.toLowerCase());
  const others = [...logins].filter((l) => l.toLowerCase() !== self && !isIgnored(l)).sort();
  if (others.length > 0) return { done: false, reason: others.join(", ") };
  if (![...logins].some(isIgnored)) return { done: false, reason: "no ignored bot took part" };
  return { done: true };
}

/** Notification reasons GitHub documents, as `--keep-reason` accepts them. */
export const NOTIFICATION_REASONS: readonly string[] = [
  "agent_session_finished",
  "approval_requested",
  "assign",
  "author",
  "ci_activity",
  "comment",
  "invitation",
  "manual",
  "member_feature_requested",
  "mention",
  "review_requested",
  "security_advisory_credit",
  "security_alert",
  "state_change",
  "subscribed",
  "team_mention",
];

/** Lowercased set of `values`; throws listing the valid reasons if one isn't a notification reason. */
export function parseReasons(values: readonly string[]): Set<string> {
  const unknown = values.filter((v) => !NOTIFICATION_REASONS.includes(v.toLowerCase()));
  if (unknown.length > 0) {
    throw new Error(`unknown reason ${unknown.map((v) => `'${v}'`).join(", ")}; valid: ${NOTIFICATION_REASONS.join(", ")}`);
  }
  return new Set(values.map((v) => v.toLowerCase()));
}

/** Logins from a list such as GH_NOTIF_CLEAN_IGNORE, separated by commas and/or whitespace; empty entries skipped. */
export function parseIgnoreList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter((v) => v !== "");
}

/** Lowercased logins to ignore: the defaults unless dropped, then GH_NOTIF_CLEAN_IGNORE and --ignore entries. */
export function ignoredLogins(options: {
  noDefaultBots: boolean;
  env: string | undefined;
  ignore: readonly string[];
}): Set<string> {
  const logins = [
    ...(options.noDefaultBots ? [] : DEFAULT_IGNORED),
    ...parseIgnoreList(options.env),
    ...options.ignore,
  ];
  return new Set(logins.map((l) => l.toLowerCase()));
}

const DURATION_UNITS_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * The time `duration` before `now`, for `--since`: a whole number of minutes (`m`), hours (`h`), days (`d`)
 * or weeks (`w`), such as `7d`. Throws if it's anything else, zero, or reaches back before the Unix epoch,
 * which no thread predates and which keeps the cutoff in the range GitHub accepts.
 */
export function parseSince(duration: string, now: Date): Date {
  const match = /^(\d+)([mhdw])$/.exec(duration);
  const amount = Number(match?.[1]);
  if (!match || amount === 0) {
    throw new Error(`expected a positive whole number followed by m, h, d or w, such as 7d; got '${duration}'`);
  }
  const cutoff = new Date(now.getTime() - amount * DURATION_UNITS_MS[match[2] as keyof typeof DURATION_UNITS_MS]);
  if (!(cutoff.getTime() >= 0)) {
    throw new Error(`'${duration}' reaches back before 1970; leave --since out to check every thread`);
  }
  return cutoff;
}

/** Latest status per context on a commit, from the combined status endpoint. */
export interface CommitStatus {
  context: string;
  state: string;
}

/**
 * A check run on a commit, as the check-runs endpoint lists it by default: the
 * latest attempt of each job. A name can repeat across check suites and within one.
 */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  check_suite: { id: number } | null;
}

/** A GitHub Actions workflow run on a commit, from `actions/runs?head_sha=`; its jobs are the check runs of its suite. */
export interface WorkflowRun {
  check_suite_id: number;
  workflow_id: number;
  event: string;
  /** The workflow's file, or `dynamic/…` for one of GitHub's own workflows, such as `dynamic/copilot-swe-agent/copilot`. */
  path: string;
}

const FAILED_STATES: Record<string, true> = { failure: true, error: true };
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, timed_out: true, action_required: true };

/**
 * Workflow events whose runs a PR's check list includes: the ones GitHub
 * documents as evaluated for a PR, plus `merge_group`, whose runs it lists
 * too, and `dynamic`, below. A run for any other event, such as
 * `workflow_dispatch` on the PR's branch, is on the head commit but not in
 * `gh pr checks` or on the PR page. An entry works both ways: a failed run for
 * a listed event can't be excused by another event's pass, and a pass for a
 * listed event excuses a failed run for an event left out. So add an event
 * only once GitHub is seen to list its runs. `dynamic` runs are listed for
 * some of GitHub's own workflows (CodeQL default setup, Pages builds) and not
 * for others, whose jobs `LEFT_OUT_DYNAMIC` drops; the entry changes nothing
 * either way, because a dynamic workflow has no runs for another event.
 * https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated
 */
const CHECK_LIST_EVENTS: Record<string, true> = {
  push: true,
  pull_request: true,
  pull_request_review: true,
  pull_request_target: true,
  deployment: true,
  deployment_status: true,
  merge_group: true,
  dynamic: true,
};

/**
 * GitHub's own `dynamic` workflows whose runs a PR's check list leaves out, by
 * the `path` of their workflow runs, with the names of the jobs they run. None
 * of them can be the PR's CI, so their jobs don't count, whatever their result.
 * A check run has to match both: a check run that a workflow creates through
 * the API can land in a `dynamic` workflow's check suite. Every other `dynamic`
 * workflow counts: the check list includes CodeQL default setup, CodeQL code
 * quality, Pages builds and automatic dependency submission, and dropping a
 * check that GitHub lists, which a branch rule can require, would mark done a
 * thread whose PR GitHub shows failing. So add a workflow only once GitHub is
 * seen to leave it out.
 */
const LEFT_OUT_DYNAMIC: Record<string, RegExp> = {
  // Copilot code review.
  "dynamic/agents/copilot-pull-request-reviewer": /^copilot-pull-request-reviewer$/,
  // Copilot code review until May 2026, when it moved to the workflow above. Its runs stay on commits not pushed since.
  "dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer": /^(Prepare|Agent|Upload results|Cleanup artifacts|Autovalidate|CodeQL analysis( \(.+\))?)$/,
  // GitHub Advanced Security's AI code scanning findings on a PR.
  "dynamic/agents/github-advanced-security": /^github-advanced-security$/,
  // Copilot cloud agent.
  "dynamic/copilot-swe-agent/copilot": /^copilot$/,
  // The Claude and OpenAI Codex cloud agents.
  "dynamic/agents/anthropic-code-agent": /^claude$/,
  "dynamic/agents/openai-code-agent": /^codex$/,
  // Dependabot's version and security updates.
  "dynamic/dependabot/dependabot-updates": /^Dependabot$/,
  // Dependabot's dependency graph builds: one job per ecosystem, such as `update-pip-graph`.
  "dynamic/dependabot/update-graph": /^update-.+-graph$/,
  // Codespaces prebuilds (Dev Environment Prebuilds), with the `(development)` and `(ppe)` variants one repository runs.
  "dynamic/codespaces/create_codespaces_prebuilds": /^prebuild$/,
  "dynamic/codespaces/create_codespaces_prebuilds_development": /^prebuild$/,
  "dynamic/codespaces/create_codespaces_prebuilds_ppe": /^prebuild$/,
};

/** The job names in `LEFT_OUT_DYNAMIC`. A name alone doesn't show a check run is one of those jobs: any workflow can use it. */
const LEFT_OUT_DYNAMIC_JOBS = Object.values(LEFT_OUT_DYNAMIC);

/**
 * Why a PR's head commit keeps its thread: checks that failed, or else checks
 * that haven't finished, or else check runs that were cancelled after they
 * started. `workflowRuns`, the commit's Actions runs, can show that a check
 * run doesn't count. A job of one of GitHub's own workflows that the PR's
 * check list leaves out, such as Copilot's code review, never does. A failed
 * or cancelled check run doesn't when a same-named pass replaced it: a pass in
 * a newer run of the same workflow for the same event, as a later start alone
 * doesn't show a replacement (a `push` run and a `pull_request` run of one
 * workflow queue their jobs independently), or, for a run the PR's check list
 * leaves out, a pass in a run of the same workflow that the list includes.
 * Unfinished checks keep it because a status changing doesn't notify, so a
 * thread marked done now wouldn't come back if one fails. Cancelled runs keep
 * it because GitHub Actions reports a job that hit `timeout-minutes` as
 * cancelled, not timed out. `null` otherwise.
 */
export function checksReason(
  statuses: readonly CommitStatus[],
  checkRuns: readonly CheckRun[],
  workflowRuns: readonly WorkflowRun[],
): string | null {
  const failed = new Set<string>();
  const pending = new Set<string>();
  const cancelled = new Set<string>();
  const bySuite = new Map(workflowRuns.map((workflowRun) => [workflowRun.check_suite_id, workflowRun]));
  for (const status of statuses) {
    if (FAILED_STATES[status.state]) failed.add(status.context);
    else if (status.state === "pending") pending.add(status.context);
  }
  for (const run of checkRuns) {
    if (leftOutDynamicJob(run, bySuite)) continue;
    if (run.status !== "completed") pending.add(run.name);
    else if (keepsUnlessReplaced(run) && !passesElsewhere(run, checkRuns).some((pass) => replaced(run, pass, bySuite))) {
      if (run.conclusion === "cancelled") cancelled.add(run.name);
      else failed.add(run.name);
    }
  }
  if (failed.size > 0) return `checks failed: ${names(failed)}`;
  if (pending.size > 0) return `checks pending: ${names(pending)}`;
  if (cancelled.size > 0) return `checks cancelled: ${names(cancelled)}`;
  return null;
}

/**
 * Whether the commit's workflow runs could change `checksReason`, so they're
 * worth fetching: a failed check run, or one cancelled after it started, has a
 * same-named pass in another check suite, which they may show replaced it; or
 * a check run that would keep the thread has the name of a job in
 * `LEFT_OUT_DYNAMIC`, which they may show it is.
 */
export function needsWorkflowRuns(checkRuns: readonly CheckRun[]): boolean {
  return checkRuns.some(
    (run) =>
      (keepsUnlessReplaced(run) && passesElsewhere(run, checkRuns).length > 0) ||
      ((run.status !== "completed" || keepsUnlessReplaced(run)) && LEFT_OUT_DYNAMIC_JOBS.some((job) => job.test(run.name))),
  );
}

/** Whether `run` is a job of a workflow in `LEFT_OUT_DYNAMIC`: both its name and its workflow run's path match. */
function leftOutDynamicJob(run: CheckRun, bySuite: ReadonlyMap<number, WorkflowRun>): boolean {
  const workflowRun = run.check_suite ? bySuite.get(run.check_suite.id) : undefined;
  return !!workflowRun && !!LEFT_OUT_DYNAMIC[workflowRun.path]?.test(run.name);
}

/**
 * Whether a check run keeps the thread unless a same-named pass replaced it:
 * it failed, or it was cancelled after it started. A run cancelled before it
 * started can't have hit `timeout-minutes`.
 */
function keepsUnlessReplaced(run: CheckRun): boolean {
  if (!run.conclusion) return false;
  if (FAILED_CONCLUSIONS[run.conclusion]) return true;
  if (run.conclusion !== "cancelled" || !run.started_at || !run.completed_at) return false;
  return Date.parse(run.completed_at) > Date.parse(run.started_at);
}

/**
 * Same-named runs that passed in a check suite other than `run`'s. A skipped
 * or neutral run doesn't count: it tested nothing, so it can't show that a
 * failure or a possible timeout is gone.
 */
function passesElsewhere(run: CheckRun, checkRuns: readonly CheckRun[]): CheckRun[] {
  return checkRuns.filter(
    (other) =>
      other.name === run.name &&
      other.conclusion === "success" &&
      !!other.check_suite &&
      !!run.check_suite &&
      other.check_suite.id !== run.check_suite.id,
  );
}

/**
 * Whether `pass`, a same-named pass in another check suite, replaced `run`.
 * Both must be in runs of the same workflow. Then either `pass` is in a run
 * for the same event and started after `run` completed, the key and order
 * `gh pr checks` keeps the newest check by, or `run` is in a run the PR's
 * check list leaves out and `pass` in one the list includes, at any time: the
 * PR shows the job passing, and the run left out may have had other inputs.
 * A check run outside GitHub Actions, or whose workflow run wasn't listed,
 * matches nothing.
 */
function replaced(run: CheckRun, pass: CheckRun, bySuite: ReadonlyMap<number, WorkflowRun>): boolean {
  const runWorkflow = run.check_suite ? bySuite.get(run.check_suite.id) : undefined;
  const passWorkflow = pass.check_suite ? bySuite.get(pass.check_suite.id) : undefined;
  if (!runWorkflow || !passWorkflow || runWorkflow.workflow_id !== passWorkflow.workflow_id) return false;
  if (runWorkflow.event === passWorkflow.event) return startedAfter(pass, run);
  return !CHECK_LIST_EVENTS[runWorkflow.event] && !!CHECK_LIST_EVENTS[passWorkflow.event];
}

/** Whether `later` started after `earlier` completed; a missing time doesn't prove it. */
function startedAfter(later: CheckRun, earlier: CheckRun): boolean {
  if (!later.started_at || !earlier.completed_at) return false;
  return Date.parse(later.started_at) > Date.parse(earlier.completed_at);
}

/** The first three names, sorted, then how many more: head commits can carry over 100 checks. */
function names(set: ReadonlySet<string>): string {
  const sorted = [...set].sort();
  if (sorted.length <= 3) return sorted.join(", ");
  return `${sorted.slice(0, 3).join(", ")} and ${sorted.length - 3} more`;
}
