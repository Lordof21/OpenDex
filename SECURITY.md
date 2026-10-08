# Security policy

OpenDeX controls an Android phone (touch, keys, shell, files, notifications), so a vulnerability can matter a lot. Thank you for reporting responsibly.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability** (a private advisory visible to the maintainers only).
Include what you found, the affected version or commit, steps to reproduce, and the impact you see. If private reporting is unavailable, open an issue that says only *"I have a security report"* — without details —
and a maintainer will arrange a private channel.

You can expect an acknowledgement within a few days and a fix or a clear plan afterwards; this is a volunteer project, so timelines are best effort. We will credit you in the release notes unless you prefer not to be named.

## Scope

In scope: the local API and its protections (token, Origin/Host guard, limits), the backend ↔ phone-helper authentication and the helper's shell/file commands, the file manager's path restrictions, secrets handling
(`~/.opendex/*`), and anything that lets a web page or another local user drive the phone. Read the [security model](docs/SECURITY_MODEL.md) first: it says what is defended, and what is a stated non-goal
(for example, malware already running as the same user).

Out of scope: vulnerabilities in Android, adb, scrcpy-server or other third-party components themselves (report those upstream; tell us if OpenDeX's use of them makes it worse), social engineering,
and issues that need physical access to an unlocked phone.

## Supported versions

Pre-1.0: only the latest commit on `main` is supported.

## Known, documented behaviour that is not a vulnerability report

OpenDeX leaves some Android developer multi-window settings on after it has run, and the release builds are obfuscated — both are described in the security model and the roadmap.
