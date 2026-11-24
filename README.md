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
gh notif-clean --closed-only                 # but keep open PRs and issues until they're merged or closed
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
| `--closed-only` | Keep open PRs and issues, so only closed or merged ones are marked done |
| `--keep-reason REASON` | Keep threads whose [notification reason](https://docs.github.com/en/rest/activity/notifications#about-notification-reasons) is `REASON`, such as `review_requested` or `assign`, until their PR or issue is closed or merged (repeatable, any case). GitHub sets the reason from the latest notification on the thread |
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

Being mentioned in or subscribed to a thread doesn't count as taking part.

For discussions, it collects the author and everyone who commented, replies to comments included. That adds one API request per discussion (more past 100 comments). Other discussion activity, such as labelling it or marking an answer, isn't checked. For releases and commits, only the author is checked.

It then checks the whole group:

1. **Everyone is you or an ignored bot.** One other person or one other bot is enough to keep the thread.
2. **At least one ignored bot is present.** A thread where only you took part is kept, because no bot generated it.

The thread is marked done only if both checks pass. The check covers the thread's whole history, not just its latest activity. Once a real person takes part, that thread is never marked done, even if bots comment many times afterwards.

With `--keep-failed`, an open PR that passes both checks is still kept if a check on its latest commit failed or hasn't finished. That covers commit statuses that are `failure` or `error` (how Vercel reports a failed deploy) and check runs that ended `failure`, `timed_out` or `action_required`. A check run cancelled after it started keeps it too, because GitHub Actions reports a job that hit `timeout-minutes` as cancelled. A run cancelled before it started, such as one a newer run on the same commit replaced, doesn't keep it. A failed or cancelled check run doesn't keep it when the same job passed in a new run of the same workflow for the same event on the same commit, started after it completed; that's how `gh pr checks` picks the check it shows. A same-named job in a run for another event (a `push` run beside a `pull_request` run), in another workflow or in the same run doesn't count, even if it started later, and nor does a newer run that skipped the job or was neutral. Re-running a failed or cancelled job from the Actions page needs none of this: the new attempt replaces the old one in GitHub's list of check runs. Unfinished checks keep the thread too: a check changing later doesn't send a notification, so a thread marked done before its deploy fails wouldn't come back. Passed, neutral and skipped checks don't keep it. A PR whose checks can't be read is kept too. Closed and merged PRs are left to the two checks above: a failed check there is no longer anyone's to fix. The flag adds two API requests (more past 100 checks) for each open PR that passes both checks, and one more to list the commit's workflow runs when a failed check run, or one cancelled after it started, has a same-named pass that started after it completed. If that list can't be read, the failed or cancelled run keeps the thread.

With `--closed-only`, an open PR or issue that passes both checks is still kept, with the reason `still open`, so an open Dependabot bump stays in your inbox until it's merged or closed. A thread an earlier run already marked done isn't brought back: it's listed as kept, but stays out of your inbox until the PR or issue notifies you again or you move it back yourself. Releases, commits and discussions are unaffected. The flag uses the PR or issue already fetched, so it adds no API requests. With `--keep-failed` as well, a failed or unfinished check is the reason given, and `still open` covers the rest.

With `--keep-reason`, a thread whose [notification reason](https://docs.github.com/en/rest/activity/notifications#about-notification-reasons) matches is kept whoever took part, unless its PR, issue or discussion is closed or merged: a merged bump no longer needs your review, so it's decided as if the reason didn't match. Only the PR, issue or other subject is fetched to check that, not its history, so a matching thread costs one API request, and `-v` and `--json` show it with its URL but no participants. That keeps review requests and assignments that only bots took part in, such as a review that CODEOWNERS requested from you on a Dependabot bump. GitHub sets a thread's reason from its latest notification and doesn't keep earlier ones, so a review request is matched only while no later notification has changed the reason. Threads that can't be inspected, such as check suites, are kept with their notification reason when it matches.

| Example thread | Who took part | Anyone else? | Ignored bot present? | Result |
|---|---|---|---|---|
| Your PR with a Vercel preview comment | you, `vercel[bot]` | no | yes | **Done** |
| Dependabot version bump | `dependabot[bot]`, you | no | yes | **Done** |
| Your PR with code scanning alerts | you, `vercel[bot]`, `github-advanced-security[bot]` | no | yes | **Done** |
| Your PR whose Vercel deploy failed, run with `--keep-failed` | you, `vercel[bot]` | no | yes | **Kept**: checks failed |
| Your PR whose CI failed, then passed in a new run of the same workflow on the same commit, run with `--keep-failed` | you, `vercel[bot]` | no | yes | **Done**: the new run replaced the failure |
| Dependabot bump whose CI job failed in its `push` run and passed later in its `pull_request` run, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks failed |
| Dependabot bump whose CI is still running, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks pending, so the next run checks it again |
| Dependabot bump whose Actions deploy job timed out, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks cancelled |
| Your PR whose CI job was cancelled mid-run, then passed in a new run of the same workflow on the same commit, run with `--keep-failed` | you, `vercel[bot]` | no | yes | **Done**: the new run replaced the cancelled one |
| Dependabot bump whose Actions deploy job timed out in its `push` run while the same job passed in its `pull_request` run, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Kept**: checks cancelled |
| Closed Dependabot bump whose CI failed, run with `--keep-failed` | `dependabot[bot]`, you | no | yes | **Done**: the PR is closed |
| Open Dependabot bump, run with `--closed-only` | `dependabot[bot]`, you | no | yes | **Kept**: still open |
| Merged Dependabot bump, run with `--closed-only` | `dependabot[bot]`, you | no | yes | **Done** |
| Open Dependabot bump that requested your review through CODEOWNERS, run with `--keep-reason review_requested` | `dependabot[bot]` | no | yes | **Kept**: notification reason `review_requested`, without loading the thread's history |
| The same bump once merged, run with `--keep-reason review_requested` | `dependabot[bot]` | no | yes | **Done**: the PR is merged |
| The open bump, run without `--keep-reason` | `dependabot[bot]` | no | yes | **Done** |
| Dependabot bump that the CLA bot commented on | `dependabot[bot]`, `vercel[bot]`, `cla-assistant[bot]`, you | `cla-assistant[bot]` | yes | **Kept**: that bot isn't ignored (use `--ignore 'cla-assistant[bot]'`) |
| Your issue that a contributor commented on | you, a contributor | the contributor | no | **Kept**: a real person |
| A contributor's PR with a Vercel preview comment | a contributor, `vercel[bot]` | the contributor | yes | **Kept**: a real person, even though Vercel commented |
| Your own PR with no bot activity | you | no | no | **Kept**: nothing bot-generated |
| Dependabot PR where a contributor comments "LGTM" | `dependabot[bot]`, a contributor | the contributor | yes | **Kept** |
| Dependabot PR where a maintainer only requested your review | `dependabot[bot]`, the maintainer | the maintainer | yes | **Kept** |
| Discussion a workflow opened as `github-actions[bot]`, where a contributor replied to the bot's comment, run with `--ignore 'github-actions[bot]'` | `github-actions[bot]`, a contributor | the contributor | yes | **Kept**: a real person, even in a reply |
| A discussion that workflow opened where only you commented, run with `--ignore 'github-actions[bot]'` | `github-actions[bot]`, you | no | yes | **Done** |
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
| `src/clean.ts` | Lists notifications, keeps open ones whose reason matches `--keep-reason`, loads each other thread's activity and, with `--keep-failed`, its PR checks, applies the rules, marks threads done |
| `src/github.ts` | REST client: `gh auth token`, pagination, retries on 429/5xx |
| `src/cli.ts` | Flags and output |

## Contributing

Bug reports, feature ideas, and bots to ignore by default are welcome: open one from the [issue chooser](https://github.com/eddiejaoude/gh-notif-clean/issues/new/choose). [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and conventions, and [`good first issue`](https://github.com/eddiejaoude/gh-notif-clean/labels/good%20first%20issue) lists places to start. Report security issues privately as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
