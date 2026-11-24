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
 * REST API base URL for the host gh logs in to, in any case. For the three kinds of host people
 * log in to, it's the URL gh 2.102.0 uses (`RESTPrefix` in cli/cli `internal/ghinstance/host.go`):
 * `https://api.github.com` for github.com, `https://api.SUBDOMAIN.ghe.com` for a GitHub
 * Enterprise Cloud tenant on GHE.com, and `https://HOST/api/v3` for GitHub Enterprise Server.
 *
 * Other names aren't mapped the way gh maps them. A name with more than one label before
 * `.ghe.com` is refused (see below), and so are `github.localhost` and its subdomains, which gh
 * reaches over plain http. A subdomain of github.com gets the Enterprise Server form here, where
 * gh uses `https://api.HOST`. gh reads the token for such a name from the github.com login, as it
 * does for a nested GHE.com name from its tenant's, yet it isn't refused: `garage.github.com`,
 * which gh maps to the Enterprise Server form by a special case, gets that form only by falling
 * through here, and the token stays on github.com's own domain. A host name may hold only
 * letters, digits, dots and hyphens, and must parse back as itself in a URL, which rules out
 * names a URL rewrites as an IP address, such as 2130706433, or can't read; a plain IPv4
 * address such as 10.0.0.5 comes back unchanged and is accepted.
 */
export function apiBaseUrl(host: string): string {
  const name = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/i.test(host) || URL.parse(`https://${name}`)?.hostname !== name) {
    throw new Error(`GH_HOST must be a host name, such as github.com or SUBDOMAIN.ghe.com; got ${JSON.stringify(host)}`);
  }
  if (name === "github.com") return "https://api.github.com";
  if (name === "github.localhost" || name.endsWith(".github.localhost")) {
    throw new Error(`GH_HOST ${host} isn't supported: gh reaches github.localhost over plain http`);
  }
  if (name.endsWith(".ghe.com")) {
    // gh reads the token for a.b.ghe.com from its login to b.ghe.com, so a name with more than
    // one label before .ghe.com would send tenant b's token to another host.
    const tenant = name.slice(0, -".ghe.com".length);
    if (!/^[a-z0-9-]+$/.test(tenant)) {
      const last = tenant.slice(tenant.lastIndexOf(".") + 1);
      throw new Error(
        `GH_HOST ${host} isn't a GHE.com tenant host, which is SUBDOMAIN.ghe.com` +
          (/^[a-z0-9-]+$/.test(last) ? `; use ${last}.ghe.com` : ""),
      );
    }
    return `https://api.${name}`;
  }
  return `https://${name}/api/v3`;
}

/**
 * Token and API base URL for the host `gh` is logged in to (`GH_HOST`, default github.com,
 * as when it's empty). Tells apart a gh it can't find, one it can't start, and one that ran
 * and failed.
 */
export function ghAuth(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = isExecutableFile,
): { token: string; baseUrl: string } {
  const host = env.GH_HOST || "github.com";
  // Before gh runs, so no token is read for a host that's refused.
  const baseUrl = apiBaseUrl(host);
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
