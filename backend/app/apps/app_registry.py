"""Automatic app discovery.

Primary path: run the scrcpy server one-shot with ``list_apps=true`` — the exact
mechanism behind ``scrcpy --list-apps``. The server resolves REAL localized app
labels through PackageManager and prints lines like::

     - Chrome                          [com.android.chrome]
     * Ayarlar                         [com.android.settings]

(``*`` marks system apps.) No APK download, no aapt, no Play Store scraping.

Fallback path (server jar missing/failed): ``cmd package query-activities
--brief`` gives LAUNCHER components only, so names degrade to a prettified
package tail — functional, just less pretty.
"""
from __future__ import annotations

import logging
import re
import time

from ..config import Settings
from ..device.adb import Adb
from ..schemas import AppInfo, AppLayoutEntry, RegistryDiff
from ..storage import settings_db

log = logging.getLogger(__name__)

# A scrcpy --list-apps row. Two formats seen in the wild:
#   upstream scrcpy wraps the package in brackets:
#     " - Chrome                 [com.android.chrome]"
#   the OpenDeX scrcpy v4 fork prints it BARE (no brackets):
#     " - Chrome                 com.android.chrome"
# Accept both: brackets optional, and the package is the trailing DOTTED token
# (>=1 dot, starts with a letter). Requiring the dot is what lets a label that
# itself contains brackets/words — e.g. "Some App [beta]" — parse correctly, since
# only the final "com.example.beta" looks like a package.
_SCRCPY_APP_LINE = re.compile(
    r"^\s*[-*]\s+(?P<label>.*?)\s+\[?(?P<package>[A-Za-z][\w]*(?:\.[\w]+)+)\]?\s*$"
)

# --brief output line: "  com.package/com.package.MainActivity"
_BRIEF_COMPONENT = re.compile(r"^\s*(?P<package>[A-Za-z][\w.]*)/\S+$")


KNOWN_PACKAGE_NAMES: dict[str, str] = {
    "com.instagram.android": "Instagram",
    "com.zhiliaoapp.musically": "TikTok",
    "com.ss.android.ugc.trill": "TikTok",
    "com.tencent.ig": "PUBG Mobile",
    "com.pubg.krmobile": "PUBG Mobile (KR)",
    "com.pubg.imobile": "BGMI",
    "com.dts.freefireth": "Free Fire",
    "com.dts.freefiremax": "Free Fire MAX",
    "com.activision.callofduty.shooter": "Call of Duty",
    "com.supercell.clashofclans": "Clash of Clans",
    "com.supercell.clashroyale": "Clash Royale",
    "com.supercell.brawlstars": "Brawl Stars",
    "com.mojang.minecraftpe": "Minecraft",
    "com.spotify.music": "Spotify",
    "com.netflix.mediaclient": "Netflix",
    "com.android.settings": "Ayarlar",
    "com.android.camera": "Kamera",
}

GENERIC_TAILS = {"android", "app", "mobile", "lite", "main", "ui", "activity", "release", "gps", "global", "row", "client", "go"}


def prettify_package(package: str) -> str:
    if package in KNOWN_PACKAGE_NAMES:
        return KNOWN_PACKAGE_NAMES[package]
    
    parts = [p for p in package.split(".") if p]
    if not parts:
        return package
    
    chosen = parts[-1]
    if len(parts) > 1 and chosen.lower() in GENERIC_TAILS:
        chosen = parts[-2]
        if len(parts) > 2 and chosen.lower() in {"android", "google", "apps", "ugc", "sec"}:
            chosen = parts[-3]
            
    return chosen.replace("_", " ").replace("-", " ").capitalize()


def sanitize_app_label(label: str, package: str) -> str:
    label = label.strip()
    if not label or label.startswith("@") or label.startswith("0x") or label.startswith("res/"):
        return prettify_package(package)
    return label


def parse_scrcpy_app_list(output: str) -> list[AppInfo]:
    apps: dict[str, str] = {}
    for line in output.splitlines():
        m = _SCRCPY_APP_LINE.match(line)
        if m:
            pkg = m.group("package")
            lbl = sanitize_app_label(m.group("label"), pkg)
            apps.setdefault(pkg, lbl)
    return [
        AppInfo(package=pkg, display_name=name)
        for pkg, name in sorted(apps.items(), key=lambda kv: kv[1].lower())
    ]


def parse_brief_query(output: str) -> list[AppInfo]:
    packages: set[str] = set()
    for line in output.splitlines():
        m = _BRIEF_COMPONENT.match(line)
        if m:
            packages.add(m.group("package"))
    return [
        AppInfo(package=pkg, display_name=prettify_package(pkg))
        for pkg in sorted(packages)
    ]


class AppRegistry:
    def __init__(self, adb: Adb, settings: Settings) -> None:
        self._adb = adb
        self._settings = settings
        self._cache: dict[str, list[AppInfo]] = {}
        self._cache_time: dict[str, float] = {}

    async def _list_via_scrcpy(self, serial: str) -> list[AppInfo]:
        await self._adb.push(
            str(self._settings.SCRCPY_SERVER_PATH),
            self._settings.SCRCPY_DEVICE_SERVER_PATH,
            serial=serial,
        )
        out = await self._adb.shell(
            f"CLASSPATH={self._settings.SCRCPY_DEVICE_SERVER_PATH} "
            f"app_process / com.genymobile.scrcpy.Server "
            f"{self._settings.SCRCPY_CLIENT_VERSION} list_apps=true log_level=info",
            serial=serial,
            timeout_s=30.0,
        )
        apps = parse_scrcpy_app_list(out)
        if not apps:
            raise RuntimeError("scrcpy list_apps returned no parseable lines")
        return apps

    async def _list_via_pm(self, serial: str) -> list[AppInfo]:
        out = await self._adb.shell(
            "cmd package query-activities --brief -a android.intent.action.MAIN "
            "-c android.intent.category.LAUNCHER",
            serial=serial,
            timeout_s=30.0,
        )
        return parse_brief_query(out)

    async def list_launcher_apps(self, serial: str, force: bool = False) -> list[AppInfo]:
        now = time.monotonic()
        if not force and serial in self._cache and (now - self._cache_time.get(serial, 0.0)) < 60.0:
            return self._cache[serial]

        raw_apps: list[AppInfo] = []
        try:
            from . import icon_service
            labels = await icon_service.batch_extract_icons(self._adb, serial, size=128)
            if labels:
                raw_apps = [
                    AppInfo(package=pkg, display_name=sanitize_app_label(lbl, pkg))
                    for pkg, lbl in sorted(labels.items(), key=lambda kv: kv[1].lower())
                ]
        except Exception as exc:
            log.warning("batch icon extraction failed (%s); trying scrcpy list_apps", exc)

        if not raw_apps:
            try:
                raw_apps = await self._list_via_scrcpy(serial)
            except Exception as exc:
                log.warning("scrcpy list_apps failed (%s); falling back to pm query", exc)
                raw_apps = await self._list_via_pm(serial)

        # Prepend the dedicated Phone Screen Mirror item
        mirror_entry = AppInfo(package="com.opendex.screen_mirror", display_name="Telefon Ekranını Yansıt")
        filtered_apps = [a for a in raw_apps if a.package != "com.opendex.screen_mirror"]
        result = [mirror_entry] + filtered_apps
        self._cache[serial] = result
        self._cache_time[serial] = now
        return result

    async def refresh_registry(self, serial: str, android_id: str) -> RegistryDiff:
        """"Yenile" button: re-queries the launcher list AND catches
        uninstalled apps in the same pass — no separate mechanism needed."""
        self._cache.pop(serial, None)
        current = await self.list_launcher_apps(serial, force=True)
        current_packages = {a.package for a in current}

        saved_layout = await settings_db.get_app_layout(android_id)
        known_packages = {e.package for e in saved_layout}

        added = [a for a in current if a.package not in known_packages]
        removed = sorted(known_packages - current_packages)

        if removed:
            pruned = [e for e in saved_layout if e.package in current_packages]
            await settings_db.save_app_layout(android_id, pruned)
        if added and saved_layout:
            base = max((e.position for e in saved_layout), default=-1) + 1
            appended = saved_layout + [
                AppLayoutEntry(package=a.package, position=base + i)
                for i, a in enumerate(added)
            ]
            await settings_db.save_app_layout(android_id, appended)

        return RegistryDiff(added=added, removed=removed, all_apps=current)
