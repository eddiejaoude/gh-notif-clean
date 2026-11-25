import type { Api } from "./github.ts";
import {
  checksReason,
  decide,
  needsWorkflowRuns,
  participants,
  type CheckRun,
  type CommitStatus,
  type ThreadActivity,
  type TimelineEvent,
  type WorkflowRun,
} from "./rules.ts";

export interface Notification {
  id: string;
  unread: boolean;
  reason: string;
  repository: { full_name: string };
  subject: { title: string; type: string; url: string | null };
}

export interface CleanOptions {
  me: string;
  ignored: ReadonlySet<string>;
  /** `owner/name` or `owner`; empty means every repository. */
  repos: readonly string[];
  unreadOnly: boolean;
  /** List only threads GitHub last updated after this time; `null` lists every thread. */
  since: Date | null;
  dryRun: boolean;
  /** Keep open PRs whose head commit has failed or unfinished checks. */
  keepFailed: boolean;
  /** Lowercased notification reasons whose threads are kept until their subject is closed or merged. */
  keepReasons: ReadonlySet<string>;
  /** Keep open PRs and issues, so only closed or merged ones are marked done. */
  closedOnly: boolean;
  concurrency?: number;
}

export type Outcome = "done" | "would-done" | "kept" | "failed";

export interface ThreadResult {
  id: string;
  repo: string;
  type: string;
  title: string;
  url: string | null;
  outcome: Outcome;
  /** Why the thread was kept or failed. */
  reason?: string;
  participants: string[];
}

interface Subject {
  html_url?: string;
  user?: { login: string } | null;
  author?: { login: string } | null;
  head?: { sha: string };
  state?: string;
  /** Who marked a discussion's current answer. `null` doesn't show that nobody did: see `loadActivity`. */
  answer_chosen_by?: { login: string } | null;
}

async function loadActivity(api: Api, url: string, type: string, subject: Subject): Promise<ThreadActivity> {
  const activity: ThreadActivity = {
    author: subject.user?.login ?? subject.author?.login ?? null,
    timeline: [],
    reviewComments: [],
    commits: [],
    discussionComments: [],
    answerChosenBy: null,
  };
  if (type === "PullRequest" || type === "Issue") {
    const issueUrl = url.replace("/pulls/", "/issues/");
    const [timeline, reviewComments, commits] = await Promise.all([
      api.getAll<TimelineEvent>(`${issueUrl}/timeline`),
      type === "PullRequest" ? api.getAll<{ user: { login: string } | null }>(`${url}/comments`) : [],
      type === "PullRequest" ? api.getAll<{ author: { login: string } | null }>(`${url}/commits`) : [],
    ]);
    Object.assign(activity, { timeline, reviewComments, commits });
  } else if (type === "Discussion") {
    // GitHub doesn't document its REST endpoints for repository discussions, so this rests on what the API
    // returned when checked in November 2026, not on a published contract.
    // The discussion itself carries who marked its current answer. `null` doesn't show that nobody did: it
    // also comes back when that account has since been deleted (`answer_chosen_at` stays set) and for an
    // answer that records no one (only `answer_html_url` is set). Neither is counted.
    activity.answerChosenBy = subject.answer_chosen_by?.login ?? null;
    // The comment list is flat: replies to a comment come back alongside top-level comments, with
    // `parent_id` set, and it pages like other lists.
    activity.discussionComments = await api.getAll<{ user: { login: string } | null }>(`${url}/comments`);
  }
  return activity;
}

/** Why the PR at `prUrl` is kept for the checks on commit `sha`, or `null`. */
async function loadChecksReason(api: Api, prUrl: string, sha: string): Promise<string | null> {
  const repo = prUrl.replace(/\/pulls\/\d+$/, "");
  const commit = `${repo}/commits/${sha}`;
  const [statuses, checkRuns] = await Promise.all([
    api.getAll<CommitStatus>(`${commit}/status`, "statuses"),
    api.getAll<CheckRun>(`${commit}/check-runs`, "check_runs"),
  ]);
  let workflowRuns: WorkflowRun[] = [];
  if (needsWorkflowRuns(checkRuns)) {
    try {
      workflowRuns = await api.getAll<WorkflowRun>(`${repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
    } catch {
      // Without them nothing is excused or dropped, so the thread is kept for its failed, cancelled and unfinished checks.
    }
  }
  return checksReason(statuses, checkRuns, workflowRuns);
}

function inRepos(fullName: string, repos: readonly string[]): boolean {
  if (repos.length === 0) return true;
  const name = fullName.toLowerCase();
  return repos.some((r) => {
    const want = r.toLowerCase();
    return want.includes("/") ? name === want : name.startsWith(`${want}/`);
  });
}

/**
 * Calls `fn` on each item, at most `limit` at a time, and returns the results in the items' order.
 * Once a call rejects, no item is started after it, and this rejects with that error only when the
 * calls already running have finished. They aren't aborted: GitHub can still act on a `DELETE`
 * whose request is aborted once sent, so a `DELETE` already sent completes before `clean()`
 * settles. A thread still being inspected sends none, as `clean()` checks for a rejected call
 * before each `DELETE`. `clean()` then rejects, and the CLI prints the error alone, without the
 * threads the run marked done.
 */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  // Boxed: a call can reject with `undefined`.
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

/** The notifications list request for `options`; `since` is sent without milliseconds, as GitHub documents it. */
function notificationsPath(options: CleanOptions): string {
  const query = new URLSearchParams();
  if (!options.unreadOnly) query.set("all", "true");
  if (options.since) query.set("since", options.since.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return query.size > 0 ? `notifications?${query}` : "notifications";
}

/**
 * Decides whether thread `n` is done and, unless this is a dry run, marks it done. `runFailed`
 * tells whether another thread's call has rejected, which fails the run.
 */
async function cleanThread(api: Api, n: Notification, options: CleanOptions, runFailed: () => boolean): Promise<ThreadResult> {
  // Filled in as the thread is read, so a thread that throws is reported with what's known of it.
  const base = {
    id: n.id,
    repo: n.repository.full_name,
    type: "",
    title: "",
    url: null as string | null,
    participants: [] as string[],
  };
  // Whatever throws before the thread is decided keeps it, as a failed request does: a
  // notification that can't be read, such as one without a subject, costs that one thread
  // rather than the run, and every thread the run marks done is still reported.
  try {
    base.type = n.subject.type;
    base.title = n.subject.title;
    const byReason = options.keepReasons.has(n.reason) ? `notification reason: ${n.reason}` : null;
    if (!n.subject.url) return { ...base, outcome: "kept", reason: byReason ?? `${n.subject.type} threads can't be inspected` };

    const subject = await api.get<Subject>(n.subject.url);
    base.url = subject.html_url ?? null;
    // A closed or merged subject no longer needs you, so it's decided as if the reason didn't match.
    // A release or commit has no state, so it keeps matching.
    if (byReason && subject.state !== "closed") return { ...base, outcome: "kept", reason: byReason };
    const logins = participants(await loadActivity(api, n.subject.url, n.subject.type, subject));
    base.participants = [...logins].sort();
    const headSha = subject.head?.sha ?? null;
    const open = subject.state === "open";

    const decision = decide(logins, options.me, options.ignored);
    if (!decision.done) return { ...base, outcome: "kept", reason: decision.reason };
    if (options.keepFailed && n.subject.type === "PullRequest" && open) {
      let reason: string | null;
      try {
        if (!headSha) throw new Error("no head commit");
        reason = await loadChecksReason(api, n.subject.url, headSha);
      } catch (error) {
        reason = `couldn't inspect checks: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (reason) return { ...base, outcome: "kept", reason };
    }
    if (options.closedOnly && open && (n.subject.type === "PullRequest" || n.subject.type === "Issue")) {
      return { ...base, outcome: "kept", reason: "still open" };
    }
  } catch (error) {
    return { ...base, outcome: "kept", reason: `couldn't inspect: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (options.dryRun) return { ...base, outcome: "would-done" };
  // A failed run rejects clean() without results, so a thread marked done now would go unreported.
  if (runFailed()) return { ...base, outcome: "kept", reason: "the run failed before this thread was marked done" };
  try {
    await api.markDone(n.id);
    return { ...base, outcome: "done" };
  } catch (error) {
    return { ...base, outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function clean(api: Api, options: CleanOptions): Promise<ThreadResult[]> {
  const list = await api.getAll<Notification>(notificationsPath(options));
  const threads = list.filter((n) => inRepos(n.repository.full_name, options.repos));

  // Set once a thread's call rejects; cleanThread checks it before marking a thread done.
  let failed = false;
  return mapPool(threads, options.concurrency ?? 8, async (n) => {
    // When one of the requests a thread makes in parallel fails, the thread is decided without
    // waiting for the others, which would run on, retries included, and keep the process alive
    // after the run. Abort them once it's decided: every request it still waited for has finished
    // by then, so the abort can't change its result.
    // One signal per thread, not one for the run: a thread's leftovers stop as soon as it's
    // decided rather than when the run ends, and fetch adds a listener to its signal for each
    // request that stays until the request is garbage-collected: with a run's thousands of
    // requests on one signal, Node 22 warns on stderr past 1,500 listeners.
    const controller = new AbortController();
    try {
      return await cleanThread(api.withSignal(controller.signal), n, options, () => failed);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      controller.abort();
    }
  });
}
