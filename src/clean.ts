import type { Api } from "./github.ts";
import { decide, participants, type ThreadActivity, type TimelineEvent } from "./rules.ts";

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
  return { activity, htmlUrl: subject.html_url ?? null };
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
    try {
      const { activity, htmlUrl } = await loadActivity(api, n.subject.url, n.subject.type);
      base.url = htmlUrl;
      logins = participants(activity);
      base.participants = [...logins].sort();
    } catch (error) {
      return { ...base, outcome: "kept", reason: `couldn't inspect: ${error instanceof Error ? error.message : String(error)}` };
    }

    const decision = decide(logins, options.me, options.ignored);
    if (!decision.done) return { ...base, outcome: "kept", reason: decision.reason };
    if (options.dryRun) return { ...base, outcome: "would-done" };
    try {
      await api.markDone(n.id);
      return { ...base, outcome: "done" };
    } catch (error) {
      return { ...base, outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}
