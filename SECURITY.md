# Security policy

gh-notif-clean runs with your GitHub CLI token, which can usually read and write your repositories. A vulnerability can expose that token or act on your account. Report it privately, and give us the chance to fix it before anyone else learns of it.

## Report a vulnerability

**Never report a vulnerability in a public issue, pull request, discussion, or comment.**

1. Report it through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/eddiejaoude/gh-notif-clean/security) and choose **Report a vulnerability**. Only you and the maintainers can read the report.
2. If that button isn't shown, email [eddie@jaoudestudios.com](mailto:eddie@jaoudestudios.com) with "gh-notif-clean security" in the subject.

Include what you can of:

- What the vulnerability is and what an attacker gains from it.
- The steps to reproduce it.
- The version you tested (`gh extension list`) and the affected files or functions.
- A proof of concept that uses your own account and test repositories only.

Never include a real token, even a revoked one.

## Scope

In scope: the code in this repository, including:

- The token: how it's obtained (`gh auth token`), where it's sent, and anything that could log, print, or send it to a host other than the GitHub API for the host you're logged in to.
- Requests the extension makes: URLs built from notification data (`subject.url`), pagination links, and redirects.
- Output: anything that could inject terminal escape sequences or corrupt `--json` output from data in thread titles or repository names.
- Content someone else controls (a thread title, a comment, a bot login) that makes the extension mark threads done that it shouldn't, or act on threads you didn't select with `--repo`.

Out of scope:

- Vulnerabilities in GitHub, the GitHub CLI, Node.js, or Bun, which the release binaries are built with. Report them to those projects.
- A dependency with no path to exploit it through this extension. The extension has no runtime dependencies; `typescript` and `@types/node` are used only for development.
- Findings that need an already compromised machine or a modified copy of the extension.

## Supported versions

Fixes land on `main` and in the next release. Run `gh extension upgrade notif-clean` to get them. Only the latest release is supported.

## What to expect

- We acknowledge your report within 5 business days.
- Within 10 business days of that, we tell you whether we confirmed the vulnerability and how severe we judge it, or why we didn't confirm it.
- Until it's fixed, we update you at least every 14 days.
- Once a fix is released, we publish a GitHub security advisory and credit you by name, unless you ask us not to.
- Please keep the vulnerability private until the advisory is published, or for 90 days after your report, whichever comes first, unless we agree a different date with you.
