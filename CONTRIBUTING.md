# Contributing to OpenDeX

Thank you for looking. OpenDeX is a small, pre-1.0 project; good bug reports and *phone compatibility reports* are as valuable as code.

## Before you start

* **Bugs and phone reports:** use the issue forms. For a phone that behaves differently, the *Device compatibility* form asks exactly what helps ([DEVICE_COMPATIBILITY.md](docs/DEVICE_COMPATIBILITY.md)).
* **Security problems:** do **not** open an issue — see [SECURITY.md](SECURITY.md).
* **Features:** open a *Feature request* first for anything larger than a fix, so we agree on the shape before you spend a weekend ([ROADMAP.md](docs/ROADMAP.md) lists what is wanted).
* **Questions:** read the [docs](docs/README.md) and the [FAQ](docs/FAQ.md), then ask in an issue.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing you agree that your work is licensed under [GPL-3.0-or-later](LICENSE), the project's licence.

## Set up

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): run the backend and the UI, the repository map, the daily commands, the conventions. You do not need a phone to run the tests ([TESTING.md](docs/TESTING.md)).

## Making a change

1. Branch from `main`. Keep the change **small and single-purpose**; unrelated clean-ups go in their own pull request.
2. **Find the root cause.** A fix that only hides the symptom in the one place it showed will come back; see the reconcilers described in [ARCHITECTURE.md](docs/ARCHITECTURE.md).
3. **Add a test that fails without your change.** Prefer testing a pure decision over mocking the world.
4. **Run the checks** that CI runs:
   ```bash
   cd backend  && python -m pytest -q && python -m ruff check app
   cd frontend && npm test && npm run build
   python scripts/docgen.py --check          # run without --check to regenerate; commit what it changes
   ```
5. **Touched the API, a setting, an event or a daemon command?** The reference docs are generated — regenerate and commit them, or the drift tests fail ([DEVELOPMENT.md](docs/DEVELOPMENT.md#generated-files--do-not-edit-by-hand)).
6. **Touched the window manager, the audio path, the phone helper or anything only a phone can show?** Run the relevant section of [DEVICE_CHECKLIST.md](docs/DEVICE_CHECKLIST.md) on a real phone and say which in the pull request. If you changed `backend/java/`, rebuild and commit `backend/vendor/opendex-tools.jar` (or ask a maintainer to; the build needs the Android SDK).
7. **UI change?** Run `tools/screenshots/run.sh <scene>` and look at the picture; update `docs/images/` if the screen changed.

## Style

* New code, comments, log messages and docs in **English**. Existing Turkish comments may stay; translate a file as you touch it.
* User-visible UI strings are Turkish for now ([roadmap](docs/ROADMAP.md)): keep new ones short and in one place.
* Match the surrounding code: no new dependency, abstraction or framework for a one-off. Comments explain *why*, not *what*.
* Anything that reaches a shell line or the phone helper's protocol is validated at the API boundary ([SECURITY_MODEL.md](docs/SECURITY_MODEL.md)).

## Commits and pull requests

Describe *what and why* in the commit message (the repository's history is mostly Turkish; English is fine and preferred for new work). In the pull request fill in the template: what changed,
how it was tested, whether a phone was used. Small commits that each build and pass are easier to review than one large one. A maintainer may ask for changes; please do not take it personally — the bar is
"would I be comfortable debugging this at 2 a.m.".

## Where things are

`backend/app/` (Python API) · `backend/java/` (phone helper) · `frontend/src/` (UI) · `frontend/src-tauri/` (native shell) · `docs/` · `tools/` — the full map is in [DEVELOPMENT.md](docs/DEVELOPMENT.md#repository-map).
