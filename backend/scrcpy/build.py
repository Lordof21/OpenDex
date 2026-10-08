"""Builds OpenDex's patched scrcpy-server: upstream v4.1 + backend/scrcpy/patches → vendor/scrcpy-server-v4.1-opendex.

    python backend/scrcpy/build.py               # clone (once), apply the patches, compile, write the binary + .sha256
    python backend/scrcpy/build.py --apply-only  # only check that the patches still apply (no Android SDK needed)

The same steps as upstream's server/build_without_gradle.sh (platform >= 31 branch: d8), in Python so it runs the
same on Windows, macOS and Linux. Needs git, a JDK (javac/java: JAVA_HOME, PATH or Android Studio's bundled JBR) and
the Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT, else the default install location) with the platform and
build-tools upstream builds with — install them with:  sdkmanager "platforms;android-36" "build-tools;36.0.0"
(other versions: ANDROID_PLATFORM / ANDROID_BUILD_TOOLS, exactly as with upstream's script).

Upstream is pinned to a tag AND its commit: a moved tag stops the build instead of silently building something else.
A patch that no longer applies stops it too (git apply --3way leaves the conflict to look at); nothing half-patched
is ever built. Upgrading upstream: see README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

SCRCPY_REPO = "https://github.com/Genymobile/scrcpy.git"
SCRCPY_TAG = "v4.1"
SCRCPY_COMMIT = "2926c06c5dc3064ae6d8db706f1a98a37cfcf3f0"
VERSION_NAME = "4.1"  # unchanged: the server checks the client's version against it (Options.java)

HERE = Path(__file__).resolve().parent
PATCHES_DIR = HERE / "patches"
WORK_DIR = HERE / "build"
SOURCE_DIR = WORK_DIR / "scrcpy"
OUTPUT = HERE.parent / "vendor" / f"scrcpy-server-v{VERSION_NAME}-opendex"

WINDOWS = platform.system() == "Windows"


class BuildError(RuntimeError):
    pass


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise BuildError(f"{' '.join(cmd[:3])} … failed ({result.returncode}):\n{result.stdout}{result.stderr}")
    return result.stdout


# ------------------------------------------------------------------ sources


def prepare_sources() -> None:
    """A clean checkout of the pinned upstream commit with every patch applied, in order."""
    if not (SOURCE_DIR / ".git").is_dir():
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Cloning scrcpy {SCRCPY_TAG} ...")
        run(["git", "clone", "--depth", "1", "--branch", SCRCPY_TAG, SCRCPY_REPO, str(SOURCE_DIR)])
    run(["git", "reset", "--hard", "--quiet", SCRCPY_COMMIT], cwd=SOURCE_DIR)
    run(["git", "clean", "-fdxq"], cwd=SOURCE_DIR)
    head = run(["git", "rev-parse", "HEAD"], cwd=SOURCE_DIR).strip()
    if head != SCRCPY_COMMIT:
        raise BuildError(f"{SCRCPY_TAG} is {head}, expected {SCRCPY_COMMIT} — refusing to build an unknown upstream")

    patches = sorted(PATCHES_DIR.glob("*.patch"))
    if not patches:
        raise BuildError(f"no patches in {PATCHES_DIR}")
    for patch in patches:
        print(f"Applying {patch.name}")
        run(["git", "apply", "--3way", "--ignore-whitespace", "--ignore-space-change", str(patch)], cwd=SOURCE_DIR)


# ------------------------------------------------------------------ toolchain


def find_sdk() -> Path:
    candidates = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")]
    if WINDOWS:
        candidates.append(os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk"))
    elif platform.system() == "Darwin":
        candidates.append(str(Path.home() / "Library" / "Android" / "sdk"))
    else:
        candidates.append(str(Path.home() / "Android" / "Sdk"))
    for candidate in candidates:
        if candidate and Path(candidate).is_dir():
            return Path(candidate)
    raise BuildError("Android SDK not found: set ANDROID_HOME")


def find_jdk_tool(name: str) -> Path:
    exe = name + (".exe" if WINDOWS else "")
    candidates = []
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]) / "bin" / exe)
    if found := shutil.which(name):
        candidates.append(Path(found))
    if WINDOWS:
        candidates.append(Path(r"C:\Program Files\Android\Android Studio\jbr\bin") / exe)
    elif platform.system() == "Darwin":
        candidates.append(Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin") / exe)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise BuildError(f"{name} not found: install a JDK or set JAVA_HOME")


def toolchain() -> dict[str, Path]:
    sdk = find_sdk()
    platform_dir = sdk / "platforms" / f"android-{os.environ.get('ANDROID_PLATFORM', '36')}"
    build_tools = sdk / "build-tools" / os.environ.get("ANDROID_BUILD_TOOLS", "36.0.0")
    tools = {
        "android_jar": platform_dir / "android.jar",
        "framework_aidl": platform_dir / "framework.aidl",
        "aidl": build_tools / ("aidl.exe" if WINDOWS else "aidl"),
        "lambda_jar": build_tools / "core-lambda-stubs.jar",
        "d8_jar": build_tools / "lib" / "d8.jar",
        "javac": find_jdk_tool("javac"),
        "java": find_jdk_tool("java"),
    }
    missing = [f"{key}: {path}" for key, path in tools.items() if not path.is_file()]
    if missing:
        raise BuildError(
            "missing from the Android SDK / JDK:\n  " + "\n  ".join(missing)
            + '\ninstall them with: sdkmanager "platforms;android-36" "build-tools;36.0.0"'
        )
    return tools


# ------------------------------------------------------------------ build (= build_without_gradle.sh)


def compile_server(tools: dict[str, Path]) -> Path:
    server = SOURCE_DIR / "server"
    out = WORK_DIR / "out"
    if out.exists():
        shutil.rmtree(out)
    gen, classes = out / "gen", out / "classes"
    (gen / "com" / "genymobile" / "scrcpy").mkdir(parents=True)
    classes.mkdir(parents=True)

    (gen / "com" / "genymobile" / "scrcpy" / "BuildConfig.java").write_text(
        "package com.genymobile.scrcpy;\n\n"
        "public final class BuildConfig {\n"
        "  public static final boolean DEBUG = false;\n"
        f'  public static final String VERSION_NAME = "{VERSION_NAME}";\n'
        "}\n",
        encoding="utf-8",
    )

    print("Generating java from aidl...")
    aidl_dir = server / "src" / "main" / "aidl"
    clip_listener = f".\\{Path('android', 'content', 'IOnPrimaryClipChangedListener.aidl')}" if WINDOWS else "android/content/IOnPrimaryClipChangedListener.aidl"
    window_listener = f".\\{Path('android', 'view', 'IDisplayWindowListener.aidl')}" if WINDOWS else "android/view/IDisplayWindowListener.aidl"
    run([str(tools["aidl"]), f"-o{gen}", "-I", ".", clip_listener], cwd=aidl_dir)
    run([str(tools["aidl"]), f"-o{gen}", "-I", ".", "-p", str(tools["framework_aidl"]),
         window_listener], cwd=aidl_dir)

    print("Compiling java sources...")
    java_dir = server / "src" / "main" / "java"
    sources = [p.relative_to(java_dir).as_posix() for p in sorted((java_dir / "android" / "content").glob("*.java"))]
    sources += [p.relative_to(java_dir).as_posix() for p in sorted((java_dir / "com" / "genymobile" / "scrcpy").rglob("*.java"))]
    sources += [str(p) for p in sorted(gen.rglob("*.java"))]
    run([str(tools["javac"]), "-encoding", "UTF-8", "-bootclasspath", str(tools["android_jar"]),
         "-cp", os.pathsep.join([str(tools["lambda_jar"]), str(gen)]), "-d", str(classes),
         "-source", "1.8", "-target", "1.8", "-nowarn", *sources], cwd=java_dir)

    print("Dexing...")
    class_files = [p.relative_to(classes).as_posix() for p in sorted(classes.rglob("*.class"))]
    dex_zip = out / "classes.zip"
    run([str(tools["java"]), "-cp", str(tools["d8_jar"]), "com.android.tools.r8.D8",
         "--classpath", str(tools["android_jar"]), "--output", str(dex_zip), *class_files], cwd=classes)
    return dex_zip


def install(binary: Path) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binary, OUTPUT)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    OUTPUT.with_name(OUTPUT.name + ".sha256").write_text(f"{digest}  {OUTPUT.name}\n", encoding="utf-8")
    print(f"\nServer generated: {OUTPUT} ({OUTPUT.stat().st_size} bytes)\nsha256 {digest}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply-only", action="store_true", help="only check that the patches apply")
    args = parser.parse_args()
    try:
        prepare_sources()
        if args.apply_only:
            print("\nAll patches apply.")
            return 0
        install(compile_server(toolchain()))
    except BuildError as exc:
        print(f"\nBUILD FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
