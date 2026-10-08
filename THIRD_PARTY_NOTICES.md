# Third-party notices

OpenDeX itself is free software under the **GNU General Public License, version 3 or (at your option) any later version** ([`LICENSE`](LICENSE)).
It is built on, and ships with, the open-source components below. This file says what they are, under which licence, and where their terms are.

* The full texts of the licences that need to travel with a copy are in [`LICENSES/`](LICENSES) (Apache-2.0, OFL-1.1); the GPL is in [`LICENSE`](LICENSE).
* Every dependency's exact version is pinned in a lock file: `frontend/package-lock.json` (npm), `frontend/src-tauri/Cargo.lock` (Rust).
  Python dependencies are declared in `backend/pyproject.toml`.
* **Compatibility.** Every licence below is compatible with distributing OpenDeX under GPL-3.0-or-later: Apache-2.0, MIT, BSD, ISC, PSF, Zlib, OFL, Unicode and
  MPL-2.0 (file-level copyleft, no "incompatible with secondary licences" notice) code may be combined into a GPL-3.0 work; LGPL-2.1-or-later (see *zeroconf*) allows being
  used under the GPL-3.0. A consequence worth knowing: because Apache-2.0 is compatible with GPL **3** but not GPL 2, OpenDeX cannot be re-licensed "GPL-2.0-only".

## Derived from scrcpy — the phone-side video server

| | |
|---|---|
| **Project** | [scrcpy](https://github.com/Genymobile/scrcpy) |
| **Licence** | Apache License 2.0 — [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| **Copyright** | © Genymobile and Romain Vimont (see the upstream `LICENSE` and `README`) |
| **What is here** | `backend/vendor/scrcpy-server-v4.1` and `scrcpy-server-v3.3.1`: the upstream release binaries, **unmodified** (the server that runs on the phone; v4.1 is downloaded from the project's GitHub release by `scripts/fetch-scrcpy-server.ps1`). `backend/vendor/scrcpy-server-v4.1-opendex`: the v4.1 server built **with OpenDeX's four patches** (`backend/scrcpy/patches/*.patch`; ≈ 185 lines of Java, described in [`backend/scrcpy/README.md`](backend/scrcpy/README.md)), reproducible from the upstream tag with `python backend/scrcpy/build.py`. |
| **Changes** | Stated as Apache-2.0 §4(b) requires: each patch's header says which upstream files it changes and how. OpenDeX's patches are offered under the same Apache-2.0 terms as the files they modify. |
| **Checksums** | To compare with the upstream release assets — `scrcpy-server-v4.1`: `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`; `scrcpy-server-v3.3.1`: `a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8`; the patched build's is in `scrcpy-server-v4.1-opendex.sha256`. |
| **Also inside** | The upstream v4.1 jar carries Kotlin standard-library metadata (JetBrains, Apache-2.0). |

OpenDeX's *client* side of the protocol (`backend/app/streams/`, `backend/app/windows/scrcpy_launcher.py`, the WebCodecs decoder in `frontend/src/media/`) is OpenDeX's own code written
against the published behaviour of the server; it contains no scrcpy source. "scrcpy" is used here only to name the project this builds on.

## The phone helper (`opendex-tools.jar`)

OpenDeX's own code (`backend/java/src`, GPL-3.0-or-later). It bundles **no** third-party code: it uses the Android framework and Java standard library already on the phone
(including the platform's `org.json`). `backend/java/stubs/` holds small *compile-only* stand-ins for hidden framework classes, written for this project and never packaged into the jar.

## Fonts (shipped inside the desktop app)

All four are under the **SIL Open Font License 1.1** ([`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt)) and are used unmodified, through the `@fontsource` packages.

| Font | Copyright |
|---|---|
| Inter (variable) | © 2016 The Inter Project Authors — <https://github.com/rsms/inter> |
| Manrope (variable) | © 2019 The Manrope Project Authors — <https://github.com/sharanda/manrope> |
| IBM Plex Mono | © 2017 IBM Corp. — <https://github.com/IBM/plex> |
| Instrument Serif | © 2022 The Instrument Serif Project Authors — <https://github.com/Instrument/instrument-serif> |

Icons in the interface come from **Lucide** (ISC; a subset derived from Feather is MIT, © Cole Bemis) — see the table below. The built-in wallpapers are drawn by code
(`frontend/src/desktop/wallpaper/art.js`), so there are no image files to attribute; the application icon (`frontend/src-tauri/icons`, `frontend/public/favicon.svg`) is OpenDeX's own.
The screenshots in `docs/images/` show invented sample data and drawn illustrations, never real apps or personal content.

## Desktop interface (npm — runtime dependencies)

Direct dependencies of `frontend/package.json` that end up in the shipped bundle, with the licence found in each installed package. (The ≈ 80 packages, direct and transitive, that the production
dependencies install are all MIT, ISC, BSD, 0BSD, Apache-2.0, OFL-1.1, or the dual licences noted; none is copyleft-only.)

| Package | Licence |
|---|---|
| react, react-dom | MIT |
| zustand, clsx, tailwind-merge, framer-motion, fflate, qrcode, read-excel-file | MIT |
| lucide-react | ISC (+ MIT for the Feather-derived icons) |
| @tauri-apps/api | Apache-2.0 OR MIT |
| pdfjs-dist (PDF preview) | Apache-2.0 — [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| mammoth (Word preview) and its dependencies *lop*, *dingbat-to-unicode*, *option* | BSD-2-Clause |
| *jszip* (via mammoth) | MIT OR GPL-3.0-or-later — used under either; OpenDeX takes the MIT option |
| *pako* (via jszip) | MIT AND Zlib |
| *tslib* | 0BSD |

`pdfjs-dist` has an optional Node-only native dependency (`@napi-rs/canvas`, MIT) that the browser bundle does not use.
Development-only tools (Vite, Vitest, Tailwind CSS, PostCSS, `javascript-obfuscator`, Testing Library, jsdom, the Tauri CLI) are not distributed.

## Backend (Python — runtime dependencies)

| Package | Licence |
|---|---|
| fastapi, pydantic, pydantic-core, pydantic-settings, aiosqlite, anyio, h11, httptools, uvloop, watchfiles, PyYAML, ifaddr, annotated-types, annotated-doc, typing-inspection | MIT |
| uvicorn, starlette, websockets, click, python-dotenv, idna, send2trash | BSD-3-Clause |
| Pillow | MIT-CMU (HPND) |
| typing-extensions | PSF-2.0 |
| **zeroconf** | **LGPL-2.1-or-later** |

*zeroconf* (mDNS discovery of phones for wireless pairing) is used as an unmodified library; its source is at <https://github.com/python-zeroconf/python-zeroconf>. LGPL-2.1 §3 lets a copy
of the library be used under the ordinary GPL instead (a newer GPL version is expressly allowed), which is how it travels inside OpenDeX's GPL-3.0-or-later builds; OpenDeX's complete source is public. The
packaged backend is a Nuitka-compiled bundle, so in a source checkout you can run the backend against any newer zeroconf (`pip install --upgrade zeroconf`).

The packaged backend is compiled with Nuitka and embeds the **CPython** runtime (PSF-2.0, <https://docs.python.org/3/license.html>).
Test and lint tools (pytest, pytest-asyncio, httpx, ruff, openapi-spec-validator) are not distributed. The screenshot generator in `tools/screenshots` uses
[Playwright](https://playwright.dev) (Apache-2.0) at development time only.

## Desktop shell (Rust / Tauri)

`frontend/src-tauri` uses [Tauri 2](https://tauri.app) (Apache-2.0 OR MIT) with its shell, dialog and log plugins. `Cargo.lock` pins 449 crates. Their licences, from the crates' own
metadata, fall in these families:

| Licence (as declared by the crates) | Crates |
|---|---|
| MIT, Apache-2.0, or both (`MIT OR Apache-2.0`) | by far the most |
| Unicode-3.0 (the ICU data crates), Zlib, BSD-3-Clause, ISC, 0BSD, Unlicense OR MIT, CC0-1.0 OR MIT-0 OR Apache-2.0 | a few dozen |
| **MPL-2.0** | `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors` — unmodified; MPL-2.0 is file-level copyleft and GPL-compatible |

Verified from crate metadata for the crates built on Linux (306 of 449). The remaining crates are target-specific (Windows, macOS, Android bindings) and were **not** inspected
here; they are the usual Microsoft/Apple/Android binding crates published under MIT and/or Apache-2.0, but run `cargo deny check licenses` (or `cargo about`) against the final lock file when a
release is cut — see [BUILD_AND_RELEASE.md](docs/BUILD_AND_RELEASE.md#cutting-a-release).

The desktop window renders with the **system WebView** (Microsoft Edge WebView2 on Windows, WebKit on macOS). It is not redistributed with OpenDeX and is governed by its vendor's terms.

## Build tools (not distributed)

The Android SDK build-tools and platform (`d8`/R8, `aidl`, `android.jar`) used to build the helper and the patched scrcpy server — Google, under the Android SDK licence terms; no SDK file is copied into this
repository or into a release — plus Nuitka (Apache-2.0), the Rust toolchain (MIT OR Apache-2.0), Node.js and Python.

## Agent tooling in `.claude/skills/`

The `.claude/` directory holds third-party *Claude Code skill packs* used while developing (authors named in each skill's front matter; `ui-styling` ships its own Apache-2.0
`LICENSE.txt`). They are development aids, not part of OpenDeX, not used at runtime and not part of any release artefact; each pack remains under its own author's terms.

## Trademarks

Android and Google are trademarks of Google LLC. Xiaomi, POCO and HyperOS are trademarks of Xiaomi. Samsung and DeX are trademarks of Samsung Electronics. Windows and Microsoft Edge are trademarks of
Microsoft. All other names belong to their owners. OpenDeX is an independent project and is not affiliated with, sponsored or endorsed by any of them; the names appear only to say what OpenDeX works with.

## Corrections

Spotted a missing attribution or a wrong licence? Please open an issue ([forms](.github/ISSUE_TEMPLATE)) or a pull request against this file — it is maintained by hand.
