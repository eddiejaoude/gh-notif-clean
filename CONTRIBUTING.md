# Contributing to gh-notif-clean

Thanks for helping. This guide covers what to do before you start, how to set up and check your work, and the branch, commit, and pull request conventions.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Found a security vulnerability?** Don't open an issue or a pull request. Follow [SECURITY.md](SECURITY.md).
- **Every change bigger than a typo starts with an issue.** Search the open and closed issues first, then open one from the [issue chooser](https://github.com/eddiejaoude/gh-notif-clean/issues/new/choose):
  - **Bug report:** a thread was marked done or kept wrongly, or the command failed.
  - **Feature request:** a new flag or behavior.
  - **Suggest a default bot:** a bot every user should have ignored.
- **Comment on an issue to take it**, so two people don't build the same thing. Issues labelled [`good first issue`](https://github.com/eddiejaoude/gh-notif-clean/labels/good%20first%20issue) are a good place to start.
- **Raise these on the issue before writing code:** adding a runtime dependency (there are none today), changing which threads are marked done, and adding a bot to the defaults.

## Set up

You need [GitHub CLI](https://cli.github.com/) (logged in) and Node.js 22.18 or later.

```sh
gh repo fork eddiejaoude/gh-notif-clean --clone
cd gh-notif-clean
npm install                  # TypeScript and Node types, for type-checking only
gh extension install .       # runs your working copy as `gh notif-clean`
```

`gh extension install .` links the folder, so your edits take effect on the next run. If you already have the published version installed, remove it first with `gh extension remove notif-clean`.

Always try changes with `--dry-run` first: without it, matching threads in your inbox are marked done.

## Checks

Run both before you push. CI runs the same on Node 22 and 24.

```sh
npm run typecheck
npm test
```

The tests never touch the network: `src/rules.ts` is pure, and `src/clean.ts` and `src/github.ts` take their API and `fetch` as parameters, so tests pass in fakes. Keep it that way.

- **Changing which threads are marked done?** Update the "How it decides" section and examples table in the README, and add or change the matching case in `test/rules.test.ts`. Every row in that table is a test.
- **Adding a flag?** Update `--help` in `src/cli.ts` and the flags table in the README.

## Adding a bot to the defaults

A default bot is ignored for every user, so a thread it takes part in can be marked done without anyone asking. Only bots whose activity never needs a person's attention on its own belong there. Open a **Suggest a default bot** issue first; once it's agreed, add the login to `DEFAULT_IGNORED` in `src/rules.ts` and to the list at the top of the README.

## Branches and commits

- **Branch from `main`**, named `<issue>-<slug>`, for example `12-ignore-renovate`.
- **Every commit subject is `type(scope): imperative summary`.**
  - `type` is one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
  - `scope` is the issue's `area: *` label without the prefix: `area: rules` becomes `rules`. The areas are on the [labels page](https://github.com/eddiejaoude/gh-notif-clean/labels).
  - Lowercase after the colon, present tense ("add", not "added"), no trailing period, 72 characters or fewer.
- **The commit body says why, not what.** The diff already says what.
- **The last line of the last commit is `Closes #<issue>`**, on its own line.
- **One concern per commit.** Formatting, renames, and dependency changes are their own commits.
- **Never commit** a token, `node_modules/`, or an OS file such as `.DS_Store`.

Example:

```text
fix(rules): keep threads where a reviewer was requested

A maintainer requesting a review on a Dependabot PR is a person taking
part, but the request didn't count, so the thread was marked done.

Closes #12
```

## Pull requests

- **The title follows the commit format**, because pull requests are squash-merged and the title becomes the commit subject on `main`.
- **Fill in every section of the template**: `Closes #<issue>`, what changed, why, how it was verified, and notes for review.
- **How it was verified** lists each command you ran and its result. A claim that it works is not verification.
- **Update the README in the same pull request** when behavior or flags change.

## Review

1. A maintainer reviews every pull request. Nothing merges without that review and green CI, and only a maintainer merges.
2. Reply in each review thread with `Fixed in <sha>: <what changed>` or `Not doing it: <reason>`.
3. Don't resolve a thread yourself; the reviewer resolves it once satisfied.
4. Don't force-push once review has started. Add a commit for each fix.

## Working with an AI assistant

You're responsible for every line you submit, whoever wrote it. When an assistant writes an issue, a pull request description, or a comment, end it with one line naming the model and its reasoning setting:

```text
Model: <model> | Reasoning effort: <effort>
```
