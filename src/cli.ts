import { parseArgs } from "node:util";
import { clean, type ThreadResult } from "./clean.ts";
import { createApi, ghAuth } from "./github.ts";
import { DEFAULT_IGNORED, NOTIFICATION_REASONS, parseReasons } from "./rules.ts";

const HELP = `Mark GitHub notifications as done when only ignored bots (and you) took part.

Usage: gh notif-clean [flags]

Flags:
  -n, --dry-run             List what would be marked done without changing anything
  -v, --verbose             Also list kept threads and why they were kept
  -i, --ignore LOGIN        Also ignore this account (repeatable), e.g. 'cla-assistant[bot]'
      --no-default-bots     Ignore only the accounts given with --ignore
  -R, --repo REPO           Only process OWNER/NAME or every repo of OWNER (repeatable)
      --unread-only         Skip threads you have already read
      --keep-failed         Keep open PRs whose latest commit has failed or unfinished checks
      --keep-reason REASON  Keep threads whose notification reason is REASON (repeatable), e.g.
                            review_requested. GitHub sets the reason from the latest
                            notification on the thread, not from every notification it had
      --json                Print results as JSON
  -h, --help                Show this help

Ignored by default: ${DEFAULT_IGNORED.join(", ")}
Reasons for --keep-reason: ${NOTIFICATION_REASONS.join(", ")}
`;

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
        "keep-failed": { type: "boolean", default: false },
        "keep-reason": { type: "string", multiple: true, default: [] },
        json: { type: "boolean", default: false },
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

  const ignoredLogins = [...(values["no-default-bots"] ? [] : DEFAULT_IGNORED), ...values.ignore];
  if (ignoredLogins.length === 0) {
    process.stderr.write("--no-default-bots needs at least one --ignore LOGIN\n");
    return 2;
  }

  let keepReasons: Set<string>;
  try {
    keepReasons = parseReasons(values["keep-reason"]);
  } catch (error) {
    process.stderr.write(`--keep-reason: ${(error as Error).message}\n`);
    return 2;
  }

  const api = createApi(ghAuth());
  const { login: me } = await api.get<{ login: string }>("user");
  const results = await clean(api, {
    me,
    ignored: new Set(ignoredLogins.map((l) => l.toLowerCase())),
    repos: values.repo,
    unreadOnly: values["unread-only"],
    dryRun: values["dry-run"],
    keepFailed: values["keep-failed"],
    keepReasons,
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`gh notif-clean: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
