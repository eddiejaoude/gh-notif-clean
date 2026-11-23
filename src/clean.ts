import type { Api } from "./github.ts";
import {
  checksReason,
  decide,
  participants,
  type CheckRun,
  type CommitStatus,
  type ThreadActivity,
  type TimelineEvent,
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
  dryRun: boolean;
  /** Keep PRs whose head commit has failed or unfinished checks. */
  keepFailed: boolean;
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
}

async function loadActivity(api: Api, url: string, type: string) {
  const subject = await api.get<Subject>(url);
  const activity: ThreadActivity = {
    author: subject.user?.login ?? subject.author?.login ?? null,
    timeline: [],
    reviewComments: [],
    commits: [],
  };
  if (type === "PullRequest" || type === "Issue") {
    const issueUrl = url.replace("/pulls/", "/issues/");
    const [timeline, reviewComments, commits] = await Promise.all([
      api.getAll<TimelineEvent>(`${issueUrl}/timeline`),
      type === "PullRequest" ? api.getAll<{ user: { login: string } | null }>(`${url}/comments`) : [],
      type === "PullRequest" ? api.getAll<{ author: { login: string } | null }>(`${url}/commits`) : [],
    ]);
    Object.assign(activity, { timeline, reviewComments, commits });
  }
  return { activity, htmlUrl: subject.html_url ?? null, headSha: subject.head?.sha ?? null };
}

/** Every page of an endpoint that wraps its list in an object with `total_count`. */
async function getWrapped<T>(api: Api, url: string, key: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const body = await api.get<{ total_count: number } & Record<string, unknown>>(`${url}?per_page=100&page=${page}`);
    const batch = body[key] as T[];
    items.push(...batch);
    if (batch.length === 0 || items.length >= body.total_count) return items;
  }
}

/** Why the PR at `prUrl` is kept for the checks on commit `sha`, or `null`. */
async function loadChecksReason(api: Api, prUrl: string, sha: string): Promise<string | null> {
  const commit = `${prUrl.replace(/\/pulls\/\d+$/, "")}/commits/${sha}`;
  const [statuses, checkRuns] = await Promise.all([
    getWrapped<CommitStatus>(api, `${commit}/status`, "statuses"),
    getWrapped<CheckRun>(api, `${commit}/check-runs`, "check_runs"),
  ]);
  return checksReason(statuses, checkRuns);
}

function inRepos(fullName: string, repos: readonly string[]): boolean {
  if (repos.length === 0) return true;
  const name = fullName.toLowerCase();
  return repos.some((r) => {
    const want = r.toLowerCase();
    return want.includes("/") ? name === want : name.startsWith(`${want}/`);
  });
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function clean(api: Api, options: CleanOptions): Promise<ThreadResult[]> {
  const list = await api.getAll<Notification>(options.unreadOnly ? "notifications" : "notifications?all=true");
  const threads = list.filter((n) => inRepos(n.repository.full_name, options.repos));

  return mapPool(threads, options.concurrency ?? 8, async (n): Promise<ThreadResult> => {
    const base = {
      id: n.id,
      repo: n.repository.full_name,
      type: n.subject.type,
      title: n.subject.title,
      url: null as string | null,
      participants: [] as string[],
    };
    if (!n.subject.url) return { ...base, outcome: "kept", reason: `${n.subject.type} threads can't be inspected` };

    let logins: Set<string>;
    let headSha: string | null;
    try {
      const loaded = await loadActivity(api, n.subject.url, n.subject.type);
      base.url = loaded.htmlUrl;
      headSha = loaded.headSha;
      logins = participants(loaded.activity);
      base.participants = [...logins].sort();
    } catch (error) {
      return { ...base, outcome: "kept", reason: `couldn't inspect: ${error instanceof Error ? error.message : String(error)}` };
    }

    const decision = decide(logins, options.me, options.ignored);
    if (!decision.done) return { ...base, outcome: "kept", reason: decision.reason };
    if (options.keepFailed && n.subject.type === "PullRequest") {
      let reason: string | null;
      try {
        if (!headSha) throw new Error("no head commit");
        reason = await loadChecksReason(api, n.subject.url, headSha);
      } catch (error) {
        reason = `couldn't inspect checks: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (reason) return { ...base, outcome: "kept", reason };
    }
    if (options.dryRun) return { ...base, outcome: "would-done" };
    try {
      await api.markDone(n.id);
      return { ...base, outcome: "done" };
    } catch (error) {
      return { ...base, outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}
