<div align="center">

# OpenDeX

**Your Android phone as a multi-window desktop on Windows.**
Every app in its own resizable window — with its own sound, a taskbar, a file manager and your notifications.

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-pre--1.0-orange)
![Desktop](https://img.shields.io/badge/desktop-Windows-lightgrey)
![Android](https://img.shields.io/badge/Android-10%2B-green)

[Download](#download) · [Install](docs/INSTALL.md) · [Documentation](docs/README.md) · [Türkçe](README.tr.md)

<img alt="OpenDeX: several phone apps in resizable windows on a Windows desktop with a taskbar" src="docs/images/live/hero.webp" width="900">

</div>

## Hand an app over, take it back

<!-- TODO: add docs/images/live/handoff.gif (6-10 s: app in a PC window -> "Send to phone" -> phone screen -> back), then uncomment:
<div align="center">
<img alt="An app moves from its PC window to the phone's own screen and back" src="docs/images/live/handoff.gif" width="760">
</div>
-->

Screen mirroring shows the phone's *one* screen in *one* window. OpenDeX gives **each app its own virtual display** and its own window, so apps run side by side — and one click
hands a running app to the phone's screen and back. Nothing is installed on the phone and no root is needed; OpenDeX drives it over `adb`, building on [scrcpy](https://github.com/Genymobile/scrcpy).

## What you get

<table>
<tr>
<td width="50%"><img src="docs/images/live/window-hub.webp" alt="A window with its hub: send to the phone, fill the area, picture-in-picture, key layout, density"><br><b>One hub per window.</b> Send it to the phone, snap, picture-in-picture, key layout, density.</td>
<td width="50%"><img src="docs/images/live/audio.webp" alt="Per-app audio mixer"><br><b>Sound per app.</b> Send each app to the phone, the PC or both, kept in step. <a href="docs/AUDIO.md">How</a></td>
</tr>
<tr>
<td><img src="docs/images/live/files.webp" alt="File manager showing the phone and the PC with a transfer running"><br><b>Files.</b> Phone and PC side by side, resumable transfers, previews.</td>
<td><img src="docs/images/live/media-center.webp" alt="Media center with the playing track and other streams"><br><b>Media Center.</b> Control whatever plays on the phone, pause all streams at once.</td>
</tr>
<tr>
<td><img src="docs/images/live/notifications.webp" alt="Notification center with a calendar"><br><b>Notifications.</b> Grouped by app; open or reply from the desktop.</td>
<td><img src="docs/images/live/phone-load.webp" alt="Phone load panel with temperature and processor charts"><br><b>Phone Load.</b> CPU, temperature and what OpenDeX asks of the phone, in plain words.</td>
</tr>
<tr>
<td><img src="docs/images/live/quick-settings.webp" alt="Quick control center"><br><b>Quick controls.</b> Wi-Fi, Bluetooth, torch, volumes, default sound output.</td>
<td><img src="docs/images/live/settings.webp" alt="OpenDeX settings overview with ready-made profiles"><br><b>Settings.</b> Ready-made profiles for quality, battery or a weak network.</td>
</tr>
</table>

## Download

**Windows (x64)** — from the [`download/`](download/) folder or the [Releases page](https://github.com/Lordof21/OpenDex/releases) (checksums in `SHA256SUMS.txt`):

* `OpenDeX_0.1.0_x64_tr-TR.msi` — installer
* `OpenDeX_0.1.0_windows-x64_portable.zip` — unzip and run `opendex.exe`

The builds are **unsigned**, so SmartScreen may warn (*More info → Run anyway*).

## Get started

1. Install Android **platform-tools** (`adb`) and turn on **USB debugging** on the phone.
2. Install OpenDeX, plug the phone in, accept the prompt.
3. Open OpenDeX and pick an app. No cable? The pairing dialog does QR / code pairing over Wi-Fi.

Details and per-Android-version notes: **[docs/INSTALL.md](docs/INSTALL.md)**. From source: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

> **Pre-1.0.** Verified on one phone (Xiaomi POCO X7 Pro, Android 16) — [what is verified](docs/DEVICE_COMPATIBILITY.md). The interface speaks **20 languages** (machine-translated, not yet reviewed by native speakers — [translating](docs/TRANSLATING.md)); code, API and docs are English.

## More

[Troubleshooting](docs/TROUBLESHOOTING.md) · [FAQ](docs/FAQ.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Security model](docs/SECURITY_MODEL.md) · [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

Local only: no accounts, no cloud, no telemetry. The backend is a local HTTP/WebSocket API — the UI is one client of it ([API](docs/API.md)).

[GPL-3.0-or-later](LICENSE). Builds on [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0) and other open-source components — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
"Android" is a trademark of Google LLC; OpenDeX is not affiliated with or endorsed by Google, Samsung or Genymobile.
