"""The daemon's `display_get` (PhoneDisplay.java) on a JVM, read back with the backend's own parser.

The density the phone's apps use comes from IWindowManager over Binder; here the Binder is a fake with the same method
signatures, so the reflective calls PhoneDisplay makes are exactly the ones that run on the phone. What both languages
must agree on: field names, the base-vs-initial density, and that an absent window manager / display is `ok: false`
(the backend then falls back to the shell instead of using a value).

Opt-in like the other Android-class tests: OPENDEX_ANDROID_JAR=/path/to/android-all.jar
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.device import android_shell

JAVA = Path(__file__).resolve().parent.parent / "java"
SOURCES = [JAVA / "src/com/opendex/tools" / f"{n}.java" for n in ("Json", "Binders", "PhoneDisplay")]
HARNESS = JAVA / "test/com/opendex/tools/DisplayHarness.java"
ANDROID_JAR = os.environ.get("OPENDEX_ANDROID_JAR")

pytestmark = pytest.mark.skipif(
    not ANDROID_JAR or shutil.which("javac") is None, reason="set OPENDEX_ANDROID_JAR (android-all.jar) and have a JDK",
)


@pytest.fixture(scope="module")
def classes(tmp_path_factory):
    out = tmp_path_factory.mktemp("java-display")
    result = subprocess.run(
        ["javac", "-nowarn", "-source", "8", "-target", "8", "-Xlint:-options", "-cp", ANDROID_JAR, "-d", str(out),
         *map(str, SOURCES), str(HARNESS)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return out


def run(classes, *args):
    result = subprocess.run(
        ["java", "-cp", f"{classes}{os.pathsep}{ANDROID_JAR}", "com.opendex.tools.DisplayHarness", *map(str, args)],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return [json.loads(line) for line in lines[:3]], lines[3]


def test_the_users_smallest_width_is_the_density_the_backend_lands_apps_on(classes):
    """1220 px panel, 520 dpi, user picked 380 dp smallest width → Android forces 513 dpi; that is the answer."""
    (unreachable, phone, missing), signature = run(classes, 520, 513, 1220, 2712)

    assert phone["type"] == "display_update" and phone["ok"] is True and phone["id"] == 0
    display = android_shell.phone_display_from_snapshot(phone)
    assert (display.density, display.physical_density, display.width, display.height) == (513, 520, 1220, 2712)
    assert display.smallest_width_dp == 380
    assert signature == "513@1220x2712"

    # no window manager / no such display: not ok — the backend falls back to the shell instead of using a value
    assert unreachable["ok"] is False and unreachable["error"] == "window_manager_unavailable"
    assert missing["ok"] is False and missing["error"] == "display_not_found"
    assert android_shell.phone_display_from_snapshot(unreachable) is None
    assert android_shell.phone_display_from_snapshot(missing) is None


def test_without_a_user_choice_the_panels_own_density_is_reported(classes):
    (_, phone, _), _ = run(classes, 520, 520, 1220, 2712)
    display = android_shell.phone_display_from_snapshot(phone)
    assert (display.density, display.smallest_width_dp) == (520, 375)
