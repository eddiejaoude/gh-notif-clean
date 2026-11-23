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
  /** Author of the PR, issue, release or commit the thread is about. */
  author: string | null;
  timeline: readonly TimelineEvent[];
  reviewComments: readonly { user: Account | null }[];
  commits: readonly { author: Account | null }[];
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

/** Latest status per context on a commit, from the combined status endpoint. */
export interface CommitStatus {
  context: string;
  state: string;
}

/** A check run on a commit: the latest of each name within its check suite, so a name can repeat. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

const FAILED_STATES: Record<string, true> = { failure: true, error: true };
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, timed_out: true, action_required: true };

/**
 * Why a PR's head commit keeps its thread: checks that failed, or else checks
 * that haven't finished, or else check runs that were cancelled with no
 * same-named run passing. Unfinished checks keep it because a status changing
 * doesn't notify, so a thread marked done now wouldn't come back if one fails.
 * Cancelled runs keep it because GitHub Actions reports a job that hit
 * `timeout-minutes` as cancelled, not timed out. `null` otherwise.
 */
export function checksReason(statuses: readonly CommitStatus[], checkRuns: readonly CheckRun[]): string | null {
  const failed = new Set<string>();
  const pending = new Set<string>();
  const cancelled = new Set<string>();
  const passed = new Set<string>();
  for (const status of statuses) {
    if (FAILED_STATES[status.state]) failed.add(status.context);
    else if (status.state === "pending") pending.add(status.context);
  }
  for (const run of checkRuns) {
    if (run.status !== "completed") pending.add(run.name);
    else if (run.conclusion && FAILED_CONCLUSIONS[run.conclusion]) failed.add(run.name);
    else if (run.conclusion === "cancelled") cancelled.add(run.name);
    else if (run.conclusion === "success") passed.add(run.name);
  }
  for (const name of passed) cancelled.delete(name);
  if (failed.size > 0) return `checks failed: ${[...failed].sort().join(", ")}`;
  if (pending.size > 0) return `checks pending: ${[...pending].sort().join(", ")}`;
  if (cancelled.size > 0) return `checks cancelled: ${[...cancelled].sort().join(", ")}`;
  return null;
}
