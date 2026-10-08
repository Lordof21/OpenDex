# Roadmap

Intentions, not promises. Items marked ⚠ are known gaps that the documentation otherwise tells you about.

## Next

* **English UI** (⚠ the interface is Turkish only): extract the user-visible strings, add a locale layer, ship `en` and keep `tr`.
* **Restore what OpenDeX changes on the phone** (⚠ the developer multi-window settings stay on after uninstall — [SECURITY_MODEL.md](SECURITY_MODEL.md#what-opendex-changes-on-the-phone)): remember the original values and restore them on unbind, or at least a "reset phone settings" action.
* **Decide the release hardening default** (obfuscation on/off for the official installer — [BUILD_AND_RELEASE.md](BUILD_AND_RELEASE.md#hardening-of-release-builds-obfuscation--and-why-you-may-not-want-it)).
* **A first published release** with an automated, reproducible pipeline and a signed installer.
* **CI on Windows and for releases**: the backend (lint, tests, JVM tests, documentation drift) and frontend (tests, build) workflows exist and run on Linux; a Windows build job and a release workflow do not.
* **Typed API responses** (⚠ the OpenAPI document describes the answer of only 19 of ~123 operations — [API.md](API.md#responses-without-a-declared-schema)): give the rest `response_model`s so generated clients are typed.

## Platform and contributor experience

* **Cross-platform build of the phone helper** (⚠ `backend/java/build.py` looks for the Android SDK in Windows locations).
* **macOS and Linux packages** (the Tauri config lists a `.dmg`, never built; Linux has none).
* Remove the legacy PyInstaller build path; translate the remaining Turkish code comments and log messages; rename the Turkish-named `tools/*-dogrulama` harnesses.
* Translate [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) and [design/GAME_MODE.md](design/GAME_MODE.md).
* A compatibility matrix filled in by users ([DEVICE_COMPATIBILITY.md](DEVICE_COMPATIBILITY.md)).

## Features

* **Game mode** for mirror windows — the product requirements are in [design/GAME_MODE.md](design/GAME_MODE.md). Phase 0 (no finger ever stays stuck after a focus loss or a dropped
  connection, the on-screen D-pad fix) is done; pointer capture, the game bar, key-map profiles and gamepad are not.
* Opus audio (the setting exists, the path does not).
* More than one phone at a time.
