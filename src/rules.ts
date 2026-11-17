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
