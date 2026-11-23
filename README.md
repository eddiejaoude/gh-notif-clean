# gh-notif-clean

[![CI](https://github.com/eddiejaoude/gh-notif-clean/actions/workflows/ci.yml/badge.svg)](https://github.com/eddiejaoude/gh-notif-clean/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/eddiejaoude/gh-notif-clean)](https://github.com/eddiejaoude/gh-notif-clean/releases/latest)
[![License: MIT](https://img.shields.io/github/license/eddiejaoude/gh-notif-clean)](LICENSE)

`gh` extension that marks GitHub notification threads as **done** when only bots took part, so your inbox shows threads that real people are in.

Ignored by default: `vercel[bot]`, `dependabot[bot]`, `dependabot-preview[bot]`, `github-advanced-security[bot]`.

## Requirements

- [GitHub CLI](https://cli.github.com/) 2.0 or later, logged in (`gh auth login`)
- Node.js 22.18 or later. The extension is TypeScript that Node runs directly, so there's no build step.

## Install

```sh
gh extension install eddiejaoude/gh-notif-clean
gh extension upgrade notif-clean   # later, to update
```

## Use

```sh
gh notif-clean --dry-run -v                  # preview what would be marked done and why others are kept
gh notif-clean                               # mark matching threads done
gh notif-clean --ignore 'cla-assistant[bot]' # also ignore another bot for this run
gh notif-clean -R eddiejaoude/StackDash      # only one repository
gh notif-clean -R paypal                     # only repositories owned by paypal
gh notif-clean --keep-failed                 # but keep open PRs whose deploy or CI failed or is still running
gh notif-clean --keep-reason review_requested --keep-reason assign  # but keep threads where you were asked to review or assigned
gh notif-clean --json -n | jq '.threads[] | select(.outcome == "kept")'
```

| Flag | Description |
|---|---|
| `-n`, `--dry-run` | List what would be marked done without changing anything |
| `-v`, `--verbose` | Also list kept threads, why each was kept, and their URLs |
| `-i`, `--ignore LOGIN` | Also ignore this account (repeatable). Quote logins containing `[bot]` |
| `--no-default-bots` | Ignore only the accounts given with `--ignore` |
| `-R`, `--repo REPO` | Only process `OWNER/NAME`, or every repository of `OWNER` (repeatable) |
| `--unread-only` | Skip threads you've already read |
| `--keep-failed` | Keep open PRs whose latest commit has failed or unfinished checks, such as a failed Vercel deploy |
| `--keep-reason REASON` | Keep threads whose [notification reason](https://docs.github.com/en/rest/activity/notifications#about-notification-reasons) is `REASON`, such as `review_requested` or `assign` (repeatable, any case). GitHub sets the reason from the latest notification on the thread |
| `--json` | Print the summary and every thread's outcome as JSON |
| `-h`, `--help` | Show help |

It exits with `0` on success, `1` if marking any thread done failed, and `2` for invalid flags.

To always ignore extra bots, create a `gh` alias:

```sh
gh alias set notif-clean-all "notif-clean --ignore 'cla-assistant[bot]' --ignore 'github-actions[bot]'"
```

The REST API keeps returning done threads from `notifications?all=true`, so each run checks them again. Marking an already-done thread done again does nothing.

## How it decides

Each notification is a thread about one PR, issue, release, commit or discussion. For PRs and issues, the extension reads the thread's full history and collects everyone who has:

- opened the PR or issue (author)
- commented, reviewed, or commented on a line of code
- pushed a commit to the PR (commit author account)
- requested a review, assigned, labelled, merged, closed, reopened, renamed, or referenced the thread from elsewhere. This covers any action in the PR or issue timeline.

Being mentioned in or subscribed to a thread doesn't count as taking part. For releases, commits and discussions, only the author is checked.

It then checks the whole group:

1. **Everyone is you or an ignored bot.** One other person or one other bot is enough to keep the thread.
2. **At least one ignored bot is present.** A thread where only you took part is kept, because no bot generated it.

The thread is marked done only if both checks pass. The check covers the thread's whole history, not just its latest activity. Once a real person takes part, that thread is never marked done, even if bots comment many times afterwards.

With `--keep-failed`, an open PR that passes both checks is still kept if a check on its latest commit failed or hasn't finished. That covers commit statuses that are `failure` or `error` (how Vercel reports a failed deploy) and check runs that ended `failure`, `timed_out` or `action_required`. Unfinished checks keep the thread too: a check changing later doesn't send a notification, so a thread marked done before its deploy fails wouldn't come back. A check run cancelled after it started keeps it unless another run with the same name passed, was skipped or was neutral, because GitHub Actions reports a job that hit `timeout-minutes` as cancelled. A run cancelled before it started, such as one a newer run on the same commit replaced, doesn't keep it. Passed, neutral and skipped checks don't keep it. A PR whose checks can't be read is kept too. Closed and merged PRs are left to the two checks above: a failed check there is no longer anyone's to fix. The flag adds two API requests (more past 100 checks) for each open PR that would otherwise be marked done.

With `--keep-reason`, a thread whose [notification reason](https://docs.github.com/en/rest/activity/notifications#about-notification-reasons) matches is kept before anything else is checked or fetched, whoever took part, so it costs no API requests. That keeps review requests and assignments that only bots took part in, such as a review that CODEOWNERS requested from you on a Dependabot bump. GitHub sets a thread's reason from its latest notification and doesn't keep earlier ones, so a review request is matched only while no later notification has changed the reason. Threads that can't be inspected, such as check suites, are kept with their notification reason when it matches.

| Example thread | Who took part | Anyone else? | Ignored bot present? | Result |
|---|---|---|---|---|
| Your PR with a Vercel preview comment | you, `vercel[bot]` | no | yes | **Done** |
| Dependabot version bump | `dependabot[bot]`, you | no | yes | **Done** |
| Your PR with code scanning alerts | you, `vercel[bot]`, `github-advanced-security[bot]` | no | yes | **Done** |
| Your PR whose Vercel deploy failed, run with `--keep-failed` | you, `vercel[bot]` | no | yes | **Kept**: checks failed |
| Dependabot bump whose CI is still running, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks pending, so the next run checks it again |
| Dependabot bump whose Actions deploy job timed out, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks cancelled |
| Closed Dependabot bump whose CI failed, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Done**: the PR is closed |
| Dependabot bump that requested your review through CODEOWNERS, run with `--keep-reason review_requested` | `dependabot[bot]` | no | yes | **Kept**: notification reason `review_requested`, without fetching the thread |
| The same bump, run without `--keep-reason` | `dependabot[bot]` | no | yes | **Done** |
| Dependabot bump that the CLA bot commented on | `dependabot[bot]`, `vercel[bot]`, `cla-assistant[bot]`, you | `cla-assistant[bot]` | yes | **Kept**: that bot isn't ignored (use `--ignore 'cla-assistant[bot]'`) |
| Your issue that a contributor commented on | you, a contributor | the contributor | no | **Kept**: a real person |
| A contributor's PR with a Vercel preview comment | a contributor, `vercel[bot]` | the contributor | yes | **Kept**: a real person, even though Vercel commented |
| Your own PR with no bot activity | you | no | no | **Kept**: nothing bot-generated |
| Dependabot PR where a contributor comments "LGTM" | `dependabot[bot]`, a contributor | the contributor | yes | **Kept** |
| Dependabot PR where a maintainer only requested your review | `dependabot[bot]`, the maintainer | the maintainer | yes | **Kept** |
| Check suite, or a thread whose details can't be fetched | unknown | — | — | **Kept**: can't be inspected |

## Development

```sh
npm install        # TypeScript and Node types, for type-checking only
npm run typecheck
npm test           # node:test, no network access
```

| Path | Contents |
|---|---|
| `gh-notif-clean` | Entry point `gh` runs; starts `src/cli.ts` with Node |
| `src/rules.ts` | Pure rules: who took part (`participants`), done or kept (`decide`), which checks keep a PR (`checksReason`), and which notification reasons `--keep-reason` accepts (`parseReasons`) |
| `src/clean.ts` | Lists notifications, keeps those whose reason matches `--keep-reason`, loads each other thread's activity and, with `--keep-failed`, its PR checks, applies the rules, marks threads done |
| `src/github.ts` | REST client: `gh auth token`, pagination, retries on 429/5xx |
| `src/cli.ts` | Flags and output |

## Contributing

Bug reports, feature ideas, and bots to ignore by default are welcome: open one from the [issue chooser](https://github.com/eddiejaoude/gh-notif-clean/issues/new/choose). [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and conventions, and [`good first issue`](https://github.com/eddiejaoude/gh-notif-clean/labels/good%20first%20issue) lists places to start. Report security issues privately as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
