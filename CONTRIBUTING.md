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

CI also compiles the release binaries with Bun and runs `script/test-binary.sh` on each one, on a runner of its own OS and architecture. The binaries run `src/` on Bun, not the Node that `npm test` runs on.

- **Changing which threads are marked done?** Update the "How it decides" section and examples table in the README, and add or change the matching case in `test/rules.test.ts`. Every row in that table is a test.
- **Adding a flag?** Update `--help` in `src/cli.ts` and the flags table in the README.
- **Changing `script/`, `.bun-version` or the workflows, or using a Node API the code doesn't use yet?** Build a binary and check it with `script/test-binary.sh`, as the README's [Development](README.md#development) section describes. Bun implements most of Node's APIs, not all of them.

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

## Releasing

A maintainer releases by pushing a tag from `main`. The release workflow runs five jobs:

1. **build** stops unless the tag's commit is on `main`, then builds the binaries and records their digests. Its token can only read the repository and it can't request a signing identity, so `script/build.sh` and the Bun it downloads can't sign an attestation or write to the repository or its releases.
2. **release** stops unless the binaries it downloads match the digests build recorded, then creates a draft release with generated notes and those binaries, and attests each binary. It checks nothing out and runs nothing that build made. Installs never see a draft.
3. **verify** takes each binary to a runner of its own OS and architecture, checks that its attestation comes from this workflow for this tag, and runs `script/test-binary.sh` on it.
4. **publish** checks that the draft holds exactly the binaries verify checked, then makes the release public.
5. **install**, for a stable tag only, installs the extension with `gh` on the same six runners and checks that `gh extension list` shows the tag, which only a binary install does.

```sh
git tag v0.2.0-rc.1 && git push origin v0.2.0-rc.1   # a tag with a "-" makes a prerelease, which gh extension install skips
git tag v0.2.0 && git push origin v0.2.0
```

Never create a release by hand: the workflow then uploads into it afterwards, and until it does, the latest release has no binaries, so new installs get the script and upgrades of binary installs fail.

The check that the tag is on `main` catches a slip, not a person: a pushed tag runs the workflow files of the commit it points to, so anyone who can push a `v*` tag can run a release with that commit's `release.yml`. A tag ruleset that lets only the maintainer create `v*` tags is what limits who can release. A deployment environment with required reviewers on the release and publish jobs also catches a slip, but not a person: it gates only jobs that name it, and the tagged commit's `release.yml` decides that. Write access is release authority too, since a pushed branch can run a workflow with the same permissions, so keep it limited. These are repository settings, outside this repository's files.

When a job fails, `gh release view <tag>` shows whether its draft exists. Before tagging again, delete your local tag too, with `git tag -d <tag>`, or `git tag` refuses.

- **The tag isn't on `main`**: build stopped before building anything. Delete the tag with `git push origin --delete <tag>` and tag a commit on `main`.
- **build failed, or release failed before the draft existed**: there's no release to delete, so `gh release delete` would stop with an error. If the cause was transient, such as a network error while build downloaded Bun, re-run the failed jobs. Otherwise fix the cause on `main`, delete the tag with `git push origin --delete <tag>`, and tag again.
- **release, verify or publish failed after the draft existed**: the release is still a draft. If the cause was transient, such as a network error, re-run the failed jobs. A re-run release job, with the failed jobs or on its own, doesn't build again: it stops unless the `dist` artifact matches the digests build recorded, then uploads build's binaries into the existing draft again and attests them again. Otherwise fix the cause on `main`, delete the draft and the tag on GitHub with `gh release delete <tag> --cleanup-tag`, and tag again. If release stopped at its check, a re-run stops there too: a job other than build replaced the artifact, or build's output never reached release (the check's diff then lists all six files on the downloaded side only). Find out which before you tag again.
- **install failed**: the release is already public and the latest. Mark it a prerelease with `gh release edit <tag> --prerelease`, so `gh extension install` and `gh extension upgrade` stop choosing it, fix the cause on `main`, and release a new tag.

The binaries keep the Bun runtime they were built with, and Dependabot doesn't watch `.bun-version`. When Bun publishes a security fix that affects the extension, update `.bun-version` and `.bun-sha256` in a pull request, then release, so users get the fix with `gh extension upgrade notif-clean`.

## Working with an AI assistant

You're responsible for every line you submit, whoever wrote it. When an assistant writes an issue, a pull request description, or a comment, end it with one line naming the model and its reasoning setting:

```text
Model: <model> | Reasoning effort: <effort>
```
