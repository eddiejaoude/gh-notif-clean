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
}

const FAILED_STATES: Record<string, true> = { failure: true, error: true };
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, timed_out: true, action_required: true };

/**
 * Why a PR's head commit keeps its thread: checks that failed, or else checks
 * that haven't finished, or else check runs that were cancelled after they
 * started. A failed or cancelled check run doesn't count when the same job
 * passed in a newer run of the same workflow for the same event, which
 * `workflowRuns` (the commit's Actions runs) identifies: a later start alone
 * doesn't show a replacement, as a `push` run and a `pull_request` run of one
 * workflow queue their jobs independently. Unfinished checks keep it because a
 * status changing doesn't notify, so a thread marked done now wouldn't come
 * back if one fails. Cancelled runs keep it because GitHub Actions reports a
 * job that hit `timeout-minutes` as cancelled, not timed out. `null` otherwise.
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
    if (run.status !== "completed") pending.add(run.name);
    else if (keepsUnlessReplaced(run) && !laterPasses(run, checkRuns).some((later) => newerRunOfSameWorkflow(run, later, bySuite))) {
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
 * Whether a failed check run, or one cancelled after it started, has a
 * same-named pass that started after it completed: only then can the commit's
 * workflow runs excuse it, so they're worth fetching.
 */
export function needsWorkflowRuns(checkRuns: readonly CheckRun[]): boolean {
  return checkRuns.some((run) => keepsUnlessReplaced(run) && laterPasses(run, checkRuns).length > 0);
}

/**
 * Whether a check run keeps the thread unless the same job passed in a newer
 * run of its workflow: it failed, or it was cancelled after it started. A run
 * cancelled before it started can't have hit `timeout-minutes`.
 */
function keepsUnlessReplaced(run: CheckRun): boolean {
  if (!run.conclusion) return false;
  if (FAILED_CONCLUSIONS[run.conclusion]) return true;
  if (run.conclusion !== "cancelled" || !run.started_at || !run.completed_at) return false;
  return Date.parse(run.completed_at) > Date.parse(run.started_at);
}

/** Same-named runs that passed and started after `earlier` completed. */
function laterPasses(earlier: CheckRun, checkRuns: readonly CheckRun[]): CheckRun[] {
  return checkRuns.filter((run) => run.name === earlier.name && run.conclusion === "success" && startedAfter(run, earlier));
}

/**
 * Whether `later` ran in another workflow run of the same workflow and event
 * as `earlier`, the key `gh pr checks` keeps the newest check by. A check run
 * outside GitHub Actions, or whose workflow run wasn't listed, matches nothing.
 */
function newerRunOfSameWorkflow(earlier: CheckRun, later: CheckRun, bySuite: ReadonlyMap<number, WorkflowRun>): boolean {
  if (!earlier.check_suite || !later.check_suite || earlier.check_suite.id === later.check_suite.id) return false;
  const earlierRun = bySuite.get(earlier.check_suite.id);
  const laterRun = bySuite.get(later.check_suite.id);
  if (!earlierRun || !laterRun) return false;
  return earlierRun.workflow_id === laterRun.workflow_id && earlierRun.event === laterRun.event;
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
