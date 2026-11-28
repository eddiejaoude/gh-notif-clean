import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clean, type ThreadResult } from "./clean.ts";
import { createApi, ghAuth } from "./github.ts";
import { DEFAULT_IGNORED, ignoredLogins, NOTIFICATION_REASONS, parseReasons, parseSince } from "./rules.ts";

const HELP = `Mark GitHub notifications as done when only ignored bots (and you) took part.

Usage: gh notif-clean [flags]

Flags:
  -n, --dry-run             List what would be marked done without changing anything
  -v, --verbose             Also list kept threads and why they were kept
  -i, --ignore LOGIN        Also ignore this account (repeatable), e.g. 'cla-assistant[bot]'
      --no-default-bots     Ignore only the accounts given with --ignore or GH_NOTIF_CLEAN_IGNORE
  -R, --repo REPO           Only process OWNER/NAME or every repo of OWNER (repeatable)
      --unread-only         Skip threads you have already read
      --since DURATION      Only check threads updated in the last DURATION: a whole number
                            of minutes (m), hours (h), days (d) or weeks (w), e.g. 7d or 12h.
                            Older threads aren't checked, even if an earlier run left them
                            in your inbox
      --keep-failed         Keep open PRs whose latest commit has failed or unfinished checks
      --closed-only         Keep open PRs and issues; mark only closed or merged ones done
      --keep-reason REASON  Keep threads whose notification reason is REASON (repeatable), e.g.
                            review_requested, until their PR or issue is closed or merged.
                            GitHub sets the reason from the latest notification on the
                            thread, not from every notification it had
      --json                Print results as JSON
      --version             Show the version
  -h, --help                Show this help

Environment:
  GH_HOST                   Host to clean, e.g. SUBDOMAIN.ghe.com or an Enterprise Server
                            host; github.com when unset, even if gh is logged in elsewhere
  GH_NOTIF_CLEAN_IGNORE     Accounts to ignore on every run, like --ignore, separated
                            by commas or whitespace

Ignored by default: ${DEFAULT_IGNORED.join(", ")}
Reasons for --keep-reason: ${NOTIFICATION_REASONS.join(", ")}
`;

// script/build.sh defines this in the release binaries, as the tag they were built from.
declare const GH_NOTIF_CLEAN_VERSION: string | undefined;

// Run from source, the version is the checkout's tag, or the commit past it, as git describes
// it. git runs in this file's own directory, so a git in the user's working directory can't.
function version(): string {
  if (typeof GH_NOTIF_CLEAN_VERSION === "string") return GH_NOTIF_CLEAN_VERSION;
  const git = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: "utf8",
  });
  return git.status === 0 ? git.stdout.trim() : "unknown";
}

const LABELS = { done: "DONE", "would-done": "WOULD DONE", kept: "KEEP", failed: "FAIL" } as const;

function line(r: ThreadResult, verbose: boolean): string {
  let text = `${LABELS[r.outcome]}  ${r.repo} ${r.type}: ${r.title}`;
  if (r.reason) text += `  [${r.reason}]`;
  if (verbose && r.url) text += `  ${r.url}`;
  return text;
}

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", short: "n", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        ignore: { type: "string", short: "i", multiple: true, default: [] },
        "no-default-bots": { type: "boolean", default: false },
        repo: { type: "string", short: "R", multiple: true, default: [] },
        "unread-only": { type: "boolean", default: false },
        since: { type: "string" },
        "keep-failed": { type: "boolean", default: false },
        "keep-reason": { type: "string", multiple: true, default: [] },
        "closed-only": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`gh notif-clean ${version()}\n`);
    return 0;
  }

  const ignored = ignoredLogins({
    noDefaultBots: values["no-default-bots"],
    env: process.env.GH_NOTIF_CLEAN_IGNORE,
    ignore: values.ignore,
  });
  if (ignored.size === 0) {
    process.stderr.write("--no-default-bots needs at least one --ignore LOGIN or GH_NOTIF_CLEAN_IGNORE entry\n");
    return 2;
  }

  let keepReasons: Set<string>;
  try {
    keepReasons = parseReasons(values["keep-reason"]);
  } catch (error) {
    process.stderr.write(`--keep-reason: ${(error as Error).message}\n`);
    return 2;
  }

  let since: Date | null = null;
  if (values.since !== undefined) {
    try {
      since = parseSince(values.since, new Date());
    } catch (error) {
      process.stderr.write(`--since: ${(error as Error).message}\n`);
      return 2;
    }
  }

  const api = createApi(ghAuth());
  const { login: me } = await api.get<{ login: string }>("user");
  const results = await clean(api, {
    me,
    ignored,
    repos: values.repo,
    unreadOnly: values["unread-only"],
    since,
    dryRun: values["dry-run"],
    keepFailed: values["keep-failed"],
    keepReasons,
    closedOnly: values["closed-only"],
  });

  const count = (...outcomes: ThreadResult["outcome"][]) =>
    results.filter((r) => outcomes.includes(r.outcome)).length;
  const failed = count("failed");

  if (values.json) {
    const summary = { scanned: results.length, done: count("done", "would-done"), kept: count("kept"), failed };
    process.stdout.write(`${JSON.stringify({ dryRun: values["dry-run"], ...summary, threads: results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      if (r.outcome === "failed") process.stderr.write(`${line(r, values.verbose)}\n`);
      else if (r.outcome !== "kept" || values.verbose) process.stdout.write(`${line(r, values.verbose)}\n`);
    }
    const verb = values["dry-run"] ? "would mark" : "marked";
    process.stdout.write(
      `\n${results.length} threads scanned; ${verb} ${count("done", "would-done")} done; kept ${count("kept")}; failed ${failed}\n`,
    );
  }
  return failed > 0 ? 1 : 0;
}

// A reader that closes the pipe early, as `| head` does, isn't a failure. Without a listener the
// failed write is thrown: a stack trace and exit 1, whatever main() returned.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

// Set the exit code rather than call process.exit(): writes to a pipe are asynchronous, and
// process.exit() ends the process before they drain, cutting piped output off at 64 KiB.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`gh notif-clean: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
