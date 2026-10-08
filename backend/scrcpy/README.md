# OpenDeX scrcpy-server (patched v4.1)

OpenDeX uses Genymobile's scrcpy-server **v4.1** with four small patches. The first three make resizing a virtual display (VD) faster and simpler; the fourth hands out a key frame without
restarting the encoder. The upstream protocol is not touched. The unpatched server (`vendor/scrcpy-server-v4.1`) keeps working at all times.
scrcpy is Apache-2.0 — see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

| Patch | What it does |
|---|---|
| `0001-announce-and-leading-resize` | The server announces what it can do at INFO level: `OpenDex: features=…` and `OpenDex: size_alignment=N`. The resize debouncer fires on the leading edge: a request that reaches an idle debouncer is applied at once; requests in a burst are spaced at least `resize_min_interval_ms` apart (default 300) and only the newest is applied. |
| `0002-opendex-resize-message` | A new control message `OPENDEX_RESIZE` (type 200): `u8 type, u16 width, u16 height, u16 dpi, u32 bitRate`. Size and density are applied in **one** `VirtualDisplay.resize` call. A field that is 0 is kept as it is. |
| `0003-bitrate-on-reset` | The bit rate in that message is applied during the encoder reset the resize triggers. |
| `0004-opendex-keyframe-request` | A new control message `OPENDEX_REQUEST_KEYFRAME` (type 201, no payload): asks the *running* encoder for a key frame with `PARAMETER_KEY_REQUEST_SYNC_FRAME`. The encoder is not restarted and the decoder is not reconfigured (upstream's `RESET_VIDEO` rebuilds the encoder from scratch). The periodic key-frame interval goes from 10 s to 60 s. Announced as `keyframe_request`. The backend falls back to `RESET_VIDEO` if no key frame arrives within 1 s. |

## Rules (keeping the maintenance cost low)

- About 185 lines of Java in total. Only additions and the smallest necessary edits; upstream code is not reorganised.
- Upstream message types (0–22) and the handshake do not change. `VERSION_NAME` stays "4.1".
- The backend learns what the server can do from its **announcement** (`ScrcpyServer.supports()`), not from a setting. An unpatched binary, whatever its file name, simply falls back to
  today's behaviour. Type 200 is never sent to a server that has not announced it.
- The patches are a unit: `0001`'s announcement carries the first three features, `0004` adds the fourth (`keyframe_request`).

## Building

You need git, a JDK (`JAVA_HOME`, `PATH`, or Android Studio's JBR) and the Android SDK. The platform and build-tools are the ones upstream uses:

```
sdkmanager "platforms;android-36" "build-tools;36.0.0"
```

```
python backend/scrcpy/build.py
```

The script:

1. Clones `v4.1` into `backend/scrcpy/build/` and verifies the tag's commit; it stops if the tag has moved.
2. Applies the patches in order with `git apply --3way`. It stops at a patch that does not apply — there is no half-patched build.
3. Follows the steps of upstream's `server/build_without_gradle.sh`: aidl, javac, d8.
4. Writes `backend/vendor/scrcpy-server-v4.1-opendex` and `backend/vendor/scrcpy-server-v4.1-opendex.sha256`.

Other versions can be built with `ANDROID_PLATFORM` and `ANDROID_BUILD_TOOLS`, as in the upstream script. To see only whether the patches apply, no SDK is needed:
`python backend/scrcpy/build.py --apply-only`.

## Which server is used

`OPENDEX_SCRCPY_SERVER_FLAVOR` ([CONFIGURATION.md](../../docs/CONFIGURATION.md)) takes:

- `auto` (default): the patched binary in `vendor/` if present, otherwise upstream.
- `opendex`: the patched binary.
- `upstream`: for **rolling back** — behaves exactly as an unpatched server would.

The backend logs the choice at start (`[scrcpy] sunucu: opendex (…)`); when a window opens, the server's announcement is logged too:
`OpenDex sunucusu: bitrate_on_reset, keyframe_request, leading_resize, opendex_resize`.

## Checking on a phone

- **Alignment:** the log shows `OpenDex: size_alignment=`. A resize below the alignment logs `[Resize:FLEX_NOOP]`.
- **Resize with DPI:** no `[Resize:LIVE_DPI]` round; a single `OPENDEX_RESIZE` is sent.
- **Density is not forced:** `adb shell dumpsys window displays | grep -i density` must show `mIsDensityForced=false` for the VD.
- **Bit rate:** a large enlargement shows no `[Resize:FLEX_SKIP]` and no LEGACY; the server log shows `OpenDex: bit_rate=…`.

More on-phone checks: [DEVICE_CHECKLIST.md](../../docs/DEVICE_CHECKLIST.md) (§ 4 covers the key-frame patch).

## Upgrading upstream (e.g. to v4.2)

1. Update `SCRCPY_TAG`, `SCRCPY_COMMIT` and `VERSION_NAME` in `build.py`. Also update `SCRCPY_CLIENT_VERSION` in `app/config.py` and the upstream binary
   (`scripts/fetch-scrcpy-server.ps1`).
2. Run `python backend/scrcpy/build.py --apply-only`.
3. If there is a conflict, resolve it in `backend/scrcpy/build/scrcpy`, then regenerate the patches: commit each one separately and export with
   `git format-patch --zero-commit --no-signature -4`. Keep the file names.
4. Check that the new tag's `ControlMessage` types do not reach 200 and that the `RESIZE_DISPLAY` / `DisplayResizeDebouncer` flow has not changed.
5. Build, verify on a phone, and commit the binary together with its `.sha256`.
