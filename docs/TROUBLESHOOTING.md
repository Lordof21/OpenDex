# Troubleshooting

Find your symptom, check the likely cause, then look at the log. The backend log is `logs/opendex-YYYYMMDD.log` next to the backend (INFO and above;
`OPENDEX_LOG_LEVEL=DEBUG` adds DEBUG); the phone helper's is `/data/local/tmp/opendex-daemon.log` (`adb shell cat …`). Settings → *Sistem & Teşhis* can produce a diagnostics report to attach to an issue.

## It will not start

| Symptom | Likely cause and fix |
|---|---|
| Boot screen stays on **"Çekirdek servisi — Başlatılıyor…"**, then an error | The backend did not answer on `127.0.0.1:8710`. Another program holds the port (OpenDeX only stops a previous OpenDeX backend, never someone else's process), or the sidecar was not found (development: start `python -m app.main` yourself). |
| `adb` not found | Install Android platform-tools and put them on `PATH`, or set `OPENDEX_ADB_PATH`. |
| Everything returns **401** after you restarted the backend | The UI re-reads the token on a 401 once; if you run the dev server, restart it too (it reads `~/.opendex/api-token` at start). |
| A request from your own script gets **403** | It sent an `Origin` header (browsers do) or a non-loopback `Host`. Curl and scripts should send neither — [API.md → browser protection](API.md#browser-protection-origin-and-host). |

## The phone is not found

* `adb devices` should list it as `device`. **`unauthorized`** → unlock the phone, accept the *Allow USB debugging?* prompt (tick *Always allow*); if the prompt never
  appears, *Developer options → Revoke USB debugging authorizations*, replug. **`offline`** → replug, try another cable/port, `adb kill-server`.
* A charge-only cable looks like "nothing happens". Try a data cable.
* Wireless: the computer and the phone must be on the **same network**; Windows must call it **Private**; a phone that hosts a hotspot *for the laptop* cannot do wireless
  debugging at all. mDNS discovery can be blocked by a firewall or a router with client isolation — use the dialog's *manual IP : port* or the *5555 / USB* tab.

## The window opens but…

| Symptom | Likely cause and fix |
|---|---|
| **Black window**, or the app asks for its lock again | The phone fell asleep (lock screen and OEM app-lock re-lock take over the virtual display). OpenDeX keeps the phone awake **while charging** only; plug it in, or use *screen off while mirroring* instead of letting it sleep. A banking/DRM app with a *secure* window is black in any mirror by design. |
| **Touch does nothing** (Xiaomi / HyperOS and some others) | Developer options → turn on **USB debugging (Security settings)**. |
| App opens **on the phone** instead of in the window | The app is already running on the phone's own screen; OpenDeX brings it into the window (a hand-off); check the window's *Telefona aktar / PC'ye geri al* state. |
| Text looks tiny or huge | Density (DPI) differs per window; *Settings → Görüntü & Çözünürlük* chooses the strategy. A density change relaunches the app (Android 12+: only its process). |
| **Choppy** or lagging video | Wi-Fi: use 5 GHz, get closer, or use USB. Open **Phone Load** (thermometer in the tray): a hot phone throttles its encoder. Lower the frame rate / bit rate in *Yayın Kalitesi*. Press **F8** to see each window's RTT / FPS / decode queue. |
| Toast **"Bu webview … decode desteklemiyor"** | The WebView cannot decode H.264/HEVC. Update Microsoft Edge WebView2; if the setting is HEVC, switch the codec to H.264. |

## The helper (daemon)

* Boot screen says **"3 denemede yanıt yok — ADB ile devam ediliyor"**: the helper did not answer its health checks. Everything still works through `adb`, but slower and
  noisier (see *Phone Load*). Read `/data/local/tmp/opendex-daemon.log`; make sure the phone's battery manager is not killing background shell processes; replug.
* The backend says it refused a daemon (*unverified*): something else answers on `127.0.0.1:28100`. Another program holds the forwarded port; free it
  ([DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md#transport)).
* After you update `backend/vendor/opendex-tools.jar` the backend restarts the old process by itself (it compares MD5s).

## Audio

| Symptom | Cause |
|---|---|
| No sound on the computer | Android below 13 has one session stream and no per-app choice; check *Output* is *DeX* or *İkisi*, `enable_audio` is on, and the app's route in the mixer. |
| **Echo** with *İkisi* | The two copies are apart: use *Telefon–DeX ince ayarı → Oto* (microphone calibration) or adjust by ear. See [AUDIO.md](AUDIO.md#fine-tune-and-automatic-calibration). |
| Sound **chops** on Wi-Fi | The link delivers unevenly. The player lengthens its cushion after each gap, so it settles within seconds; a USB cable or a better 5 GHz link removes the cause. See [AUDIO.md](AUDIO.md#weak-or-unstable-links). |
| Sound plays twice | Two tabs/windows of the UI: the newest listener wins; close the other. |

## Files

* *"Telefona ulaşılamıyor"* — the phone is not bound or went to sleep; reconnect. On Wi-Fi large transfers resume after a drop (same session).
* A PC folder is missing: the file manager sees only the user folders by default; add a folder with *Klasör ekle…*.

## Still stuck

Open an issue ([forms](../.github/ISSUE_TEMPLATE)) with: OpenDeX version, Windows version, phone model + Android version + OEM skin, USB or Wi-Fi, what you did, what you expected, and the
relevant lines from the two logs (they contain package names and window ids, **not** notification text — skim before posting). A security problem goes to [SECURITY.md](../SECURITY.md), not an issue.
