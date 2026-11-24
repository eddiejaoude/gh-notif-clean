import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
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

/**
 * The gh executable to run, as an absolute path: `GH_PATH`, which gh sets to its own path
 * when it runs an extension, if it names a file this process can run, or else the first `gh`
 * in `PATH`. Empty and relative `PATH` entries are skipped, so the result never depends on
 * the working directory or on the runtime's own search order. On Windows, a path counts only
 * from a drive (`C:\`) or a UNC share (`\\server\share`), variable names match in any case,
 * a quoted entry is unquoted, and each entry is tried with each `PATHEXT` extension that a
 * process can be started from (.com, .exe, .bat or .cmd), in `PATHEXT`'s order.
 */
export function findGh(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isExecutable: (file: string) => boolean,
): string | undefined {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const read = (name: string) =>
    windows ? env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name] : env[name];
  // On Windows, a path rooted without a drive, such as \tools or /usr/bin, is relative to the
  // current drive.
  const absolute = windows
    ? (file: string) => /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(file)
    : (file: string) => file.startsWith("/");

  const ghPath = read("GH_PATH");
  if (ghPath && absolute(ghPath) && isExecutable(ghPath)) return ghPath;

  // Windows' own default when PATHEXT is unset or empty. PATHEXT also lists script types
  // such as .js, which a process can't be started from.
  const names = windows
    ? (read("PATHEXT") || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.toLowerCase())
        .filter((ext) => [".com", ".exe", ".bat", ".cmd"].includes(ext))
        .map((ext) => `gh${ext}`)
    : ["gh"];
  for (const entry of (read("PATH") ?? "").split(path.delimiter)) {
    const dir = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!absolute(dir)) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Token and API base URL for the host `gh` is logged in to (`GH_HOST`, default github.com).
 * Tells apart a gh it can't find, one it can't start, and one that ran and failed.
 */
export function ghAuth(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = isExecutableFile,
): { token: string; baseUrl: string } {
  const host = env.GH_HOST ?? "github.com";
  const gh = findGh(env, platform, isExecutable);
  if (gh === undefined) {
    throw new Error("gh not found in GH_PATH or PATH; install GitHub CLI: https://cli.github.com");
  }
  let token: string;
  try {
    token = execFileSync(gh, ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // Only a gh that ran has an exit status.
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      throw new Error(`gh is not logged in to ${host}; run: gh auth login --hostname ${host}`);
    }
    throw new Error(`can't run ${gh}: ${error instanceof Error ? error.message : String(error)}`);
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
      // GitHub documents the thread id as an integer. Anything else is refused, not escaped: no
      // encoding stops "." or ".." from being read as a path segment to remove.
      if (!/^\d+$/.test(threadId)) {
        throw new Error(`refusing to mark thread ${JSON.stringify(threadId)} done: its id isn't a number`);
      }
      await request("DELETE", resolve(`notifications/threads/${threadId}`));
    },
  };
}
