# Device compatibility

OpenDeX uses Android internals (virtual displays, `app_process`, Binder services), and phone makers change those. This page says what has actually
been verified, what the code does about known vendor quirks, and how to tell us about your phone.

## Verified

| | |
|---|---|
| **Primary test phone** | Xiaomi **POCO X7 Pro** (HyperOS, **Android 16**), USB and Wi-Fi, Windows 11 |
| Everything else | **Not verified.** The automated tests never touch a phone; the checks that need one are in [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md). |

Treat any other phone as "should work, may surprise you" and please report what you see.

## What the code assumes

| Need | Minimum | Where it matters |
|---|---|---|
| Launch an app on a virtual display | Android 10 (API 29) | windows (`MIN_API_FOR_VIRTUAL_DISPLAY_LAUNCH`) |
| Flexible display resize | API 29 | faster window resize (`MIN_API_FOR_FLEX_DISPLAY`) |
| Wireless debugging, QR pairing | Android 11 | the pairing dialog |
| Per-app audio | Android **13** (API 33) | [AUDIO.md](AUDIO.md) — below it: one session stream |
| Restart only an app's *process* after a density change | Android 12 (API 31) | density reconciler — below it the app is relaunched |

Everything else is detected at run time (`device/capability_probe.py` asks the encoder what it supports instead of guessing) and every helper capability has an `adb shell` fallback.

## Vendor behaviour the code already deals with

These are written into the code because they bit someone; they are also a list of places to look first on a new phone.

* **HyperOS / MIUI (Xiaomi):** *USB debugging (Security settings)* must be on or injected touch is refused; the OEM *app lock* re-locks when the phone sleeps (OpenDeX keeps the phone awake while charging); locking the display orientation globally can deadlock the window-manager watchdog, so OpenDeX never does; the gesture-bar setting (`hide_gesture_line`) is never touched.
* **MediaTek fuel gauges** may report *full = design* capacity to the unit (the driver repeating the rating); the battery page then estimates health from the charge counter or shows "—" instead of a made-up percentage.
* **Vendors disagree on the sign of battery current**; direction comes from the charging *status*, not the sign.
* **Notification and media APIs** differ in what they expose; the helper reads them in-process and falls back to `dumpsys` parsing.
* **Encoder limits** differ: the number of simultaneous windows is bounded by what the phone's encoders accept (`encoder_limit_hit` event); an optional stress test measures it (`POST /device/encoder-stress-test`).

## Report your phone

Open the *Device compatibility* issue form and include the output of:

```bash
adb shell getprop ro.product.manufacturer ; adb shell getprop ro.product.model
adb shell getprop ro.build.version.release ; adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.incremental     # the vendor build
```

plus USB or Wi-Fi, what worked, what did not, and the log lines from [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Do **not** include serial numbers, IMEI or your Wi-Fi name.
