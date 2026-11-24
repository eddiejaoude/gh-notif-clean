import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface Api {
  get<T>(path: string): Promise<T>;
  /**
   * GET every page of a list endpoint by following `Link: rel="next"`. `key`
   * names the list for endpoints that wrap it in an object.
   */
  getAll<T>(path: string, key?: string): Promise<T[]>;
  markDone(threadId: string): Promise<void>;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Token and API base URL for the host `gh` is logged in to (`GH_HOST`, default github.com). */
export function ghAuth(): { token: string; baseUrl: string } {
  const host = process.env.GH_HOST ?? "github.com";
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`gh is not logged in to ${host}; run: gh auth login --hostname ${host}`);
  }
  const baseUrl = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  return { token, baseUrl };
}

export interface ApiOptions {
  token: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Attempts per request; network errors, 429 and 5xx are retried. */
  attempts?: number;
  retryDelayMs?: number;
}

export function createApi({
  token,
  baseUrl,
  fetch: fetchFn = fetch,
  attempts = 3,
  retryDelayMs = 500,
}: ApiOptions): Api {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const resolve = (path: string) =>
    path.startsWith("https://") ? path : `${baseUrl}/${path.replace(/^\//, "")}`;
  // The token belongs to the API host. Absolute URLs come from GitHub's
  // responses (subject URLs, Link headers), so check each one rather than trust it.
  // Redirects never reach this check: fetch follows them itself, and drops
  // Authorization when one leaves the origin, as the Fetch standard requires.
  const origin = new URL(baseUrl).origin;

  async function request(method: string, url: string): Promise<Response> {
    const target = URL.parse(url);
    if (target?.origin !== origin) {
      throw new Error(`refusing to send the GitHub token to ${target?.href ?? JSON.stringify(url)}: not on ${origin}`);
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetchFn(url, { method, headers });
        if (res.ok) return res;
        const body = await res.text();
        lastError = new HttpError(res.status, `${method} ${url}: ${res.status} ${body.slice(0, 200)}`);
        if (res.status !== 429 && res.status < 500) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) await sleep(retryDelayMs * attempt);
    }
    throw lastError;
  }

  return {
    async get<T>(path: string) {
      return (await (await request("GET", resolve(path))).json()) as T;
    },
    async getAll<T>(path: string, key?: string) {
      const first = new URL(resolve(path));
      if (!first.searchParams.has("per_page")) first.searchParams.set("per_page", "100");
      const items: T[] = [];
      let url: string | undefined = first.toString();
      while (url) {
        const res = await request("GET", url);
        const body = await res.json();
        items.push(...((key ? body[key] : body) as T[]));
        url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
      }
      return items;
    },
    async markDone(threadId: string) {
      await request("DELETE", resolve(`notifications/threads/${threadId}`));
    },
  };
}
