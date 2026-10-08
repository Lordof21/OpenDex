# FAQ

**Is this scrcpy?** It *uses* scrcpy's phone-side server (v4.1, Apache-2.0) with four small patches, but the product is different: scrcpy mirrors the phone's
**one** screen into one window. OpenDeX opens **each app on its own virtual display** and shows it in **its own window**, so you can run several apps side by side,
resize them, snap them, hand them back to the phone, and use a taskbar, launcher, file manager, per-app audio and notification centre around them.
([ARCHITECTURE.md](ARCHITECTURE.md))

**Does it need root? Does it install anything on the phone?** No root and no app. It pushes two jars to `/data/local/tmp` and starts them with `adb` as the `shell` user.
It does change a few Android developer multi-window settings that stay on — [SECURITY_MODEL.md](SECURITY_MODEL.md#what-opendex-changes-on-the-phone).

**Which phones and Android versions?** Android 10+ for windows, 13+ for per-app audio. Verified on one phone only — [DEVICE_COMPATIBILITY.md](DEVICE_COMPATIBILITY.md).

**Windows only?** The packaged app targets Windows. The backend and the UI are cross-platform code (Linux CI), but there is no Linux/macOS package, and the Java helper build script
looks for the Android SDK in Windows locations — [ROADMAP.md](ROADMAP.md).

**Why is the interface Turkish?** The project began in Turkish and has no translation layer yet. An English UI is the first roadmap item; the code, the API and these docs are English.

**Is it safe? Does it phone home?** It makes no network connection of its own and has no accounts or telemetry. The local API is protected by an Origin/Host guard and a bearer
token — [SECURITY_MODEL.md](SECURITY_MODEL.md). Anyone with `adb` access to your phone controls it, with or without OpenDeX.

**Can I use my banking app?** Apps that mark their window *secure* (most banking and DRM apps) draw black in any screen mirror, OpenDeX included — that is Android, not a bug.
Treat a mirror of your phone like your phone: it shows everything the phone shows.

**What are the REST API, the OpenAPI file and the WebSockets for?** The desktop UI is just one client of a local API. [API.md](API.md) explains it: the REST API for commands and
reads, the WebSockets for live video / audio / touch / events, and `docs/api/openapi.json` — the machine-readable description you can feed to a client generator or Postman to script OpenDeX
from another language.

**Can I script it / make my own UI?** Yes — that is what the API is for. Read the token from `~/.opendex/api-token` and start with the quick start in [API.md](API.md#quick-start).

**Why is text typed slightly differently from a real keyboard?** Characters with a key code are injected as keys; the few without one (`ç ğ ı ö ş ü …`) go through the clipboard-and-paste path of scrcpy, because there is no keyboard app on the phone.

**Why are the release builds obfuscated if the code is open?** It was added before the project was opened, as friction against copying. It costs contributors and auditors more than it protects, so you can build a plain bundle — [BUILD_AND_RELEASE.md](BUILD_AND_RELEASE.md#hardening-of-release-builds-obfuscation--and-why-you-may-not-want-it) — and it is on the [roadmap](ROADMAP.md) to decide the default.

**Multiple phones?** One bound phone at a time; the device centre lets you switch between known phones and between USB and Wi-Fi.

**License?** GPL-3.0-or-later ([LICENSE](../LICENSE)). Third-party components and their licences: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
