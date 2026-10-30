# OpenDeX documentation

Start with the row that matches what you want to do.

| I want to… | Read |
|---|---|
| **install and use OpenDeX** | [INSTALL.md](INSTALL.md) → [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [FAQ.md](FAQ.md) · [DEVICE_COMPATIBILITY.md](DEVICE_COMPATIBILITY.md) |
| **understand how it works** | [ARCHITECTURE.md](ARCHITECTURE.md) (the parts, one window end to end, the device session) · [AUDIO.md](AUDIO.md) · [SECURITY_MODEL.md](SECURITY_MODEL.md) |
| **understand a hard part in depth** | [design/HANDOFF.md](design/HANDOFF.md) (PC ⇄ phone handoff, process restarts, the edge-back-gesture root cause) · [design/BROWSER_PAGE_REFRESH.md](design/BROWSER_PAGE_REFRESH.md) (Chromium pages across displays) · [design/NOTIFICATION_NAVIGATION.md](design/NOTIFICATION_NAVIGATION.md) · [design/MULTI_APP_SOUND.md](design/MULTI_APP_SOUND.md) (several apps playing at once: plan) · [design/MEDIA_CENTER.md](design/MEDIA_CENTER.md) · [design/KEYMAPPER.md](design/KEYMAPPER.md) · [design/INPUT_ANALYSIS.md](design/INPUT_ANALYSIS.md) · [design/DEVICE_MANAGER.md](design/DEVICE_MANAGER.md) |
| **see the measurements behind a decision** | [research/](research/) — dated reports with the numbers: [WebView2 memory](research/WEBVIEW2_MEMORY.md), [thermal and load](research/THERMAL_AND_LOAD_PROTECTION.md), [transfer speed and the shared adb transport](research/DATA_PATH_INTERFERENCE.md), [daemon architecture review](research/DAEMON_ARCHITECTURE_REVIEW.md) and more |
| **script it or write my own client** | [API.md](API.md) (what the API is for, rules, WebSockets, events) → [api/REFERENCE.md](api/REFERENCE.md) and [api/openapi.json](api/openapi.json) |
| **change the code** | [DEVELOPMENT.md](DEVELOPMENT.md) · [TESTING.md](TESTING.md) · [../CONTRIBUTING.md](../CONTRIBUTING.md) · [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md) (the phone helper) · [CONFIGURATION.md](CONFIGURATION.md) |
| **build a release** | [BUILD_AND_RELEASE.md](BUILD_AND_RELEASE.md) |
| **know where it is going** | [ROADMAP.md](ROADMAP.md) · [PRODUCT_IDEAS.md](PRODUCT_IDEAS.md) (candidates by kind of user) · [design/GAME_MODE.md](design/GAME_MODE.md) |
| **check a change on a real phone** | [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) |

## What is hand-written and what is generated

Generated from the code (and kept honest by tests — they fail when the file is stale): [api/openapi.json](api/openapi.json), [api/REFERENCE.md](api/REFERENCE.md),
[CONFIGURATION.md](CONFIGURATION.md), the event / WebSocket / command tables inside [API.md](API.md) and [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md), and the pictures in [images/](images/).
Everything else is written by hand. Regenerate with `python scripts/docgen.py` and `tools/screenshots/run.sh` ([DEVELOPMENT.md](DEVELOPMENT.md#generated-files--do-not-edit-by-hand)).

## Language

The documentation is English. The following are still Turkish: [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md), [CEVIRI_MEMORY.md](CEVIRI_MEMORY.md), everything in [design/](design/),
everything in [research/](research/), and [brand/BRAND.md](brand/BRAND.md) — each says so in its first line — as are many
code comments ([ROADMAP.md](ROADMAP.md)). Türkçe özet için: [../README.tr.md](../README.tr.md).
