"""
Automated Java Build Script for OpenDeX Tools
Compiles every source under java/src (daemon + CLI tools) with javac + R8/d8 and packages
the single on-device artifact backend/vendor/opendex-tools.jar (see app/device/tools_jar.py).
Supports Google R8 maximum code obfuscation, shrinking, package flattening, and debug symbol stripping.
"""
import os
import sys
import glob
import shutil
import subprocess
import zipfile
import pathlib

BASE_DIR = pathlib.Path(__file__).parent.resolve()
BACKEND_DIR = BASE_DIR.parent
VENDOR_DIR = BACKEND_DIR / "vendor"
SRC_DIR = BASE_DIR / "src"
PROGUARD_RULES = BASE_DIR / "proguard.pro"
# Compile-only stand-ins for hidden framework classes (e.g. android.app.TaskStackListener). They are on the javac
# classpath but NEVER dexed: inside the jar they would shadow the real framework class on the device.
STUBS_DIR = BASE_DIR / "stubs"
BUILD_DIR = BASE_DIR / "build"
CLASSES_DIR = BUILD_DIR / "classes"
STUB_CLASSES_DIR = BUILD_DIR / "stub-classes"
DEX_DIR = BUILD_DIR / "dex"

def find_tools():
    # 1. android.jar
    sdk_platforms = glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk\platforms\*\android.jar"))
    if not sdk_platforms:
        sdk_platforms = glob.glob(r"C:\Users\*\AppData\Local\Android\Sdk\platforms\*\android.jar")
    if not sdk_platforms:
        raise RuntimeError("android.jar not found in Android SDK platforms")
    android_jar = sorted(sdk_platforms)[-1]

    # 2. d8
    d8_list = glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk\build-tools\*\d8.bat"))
    if not d8_list:
        d8_list = glob.glob(r"C:\Users\*\AppData\Local\Android\Sdk\build-tools\*\d8.bat")
    if not d8_list:
        raise RuntimeError("d8.bat not found in Android SDK build-tools")
    d8_bat = sorted(d8_list)[-1]

    # 3. javac & java home
    javac_candidates = (
        glob.glob(r"C:\Program Files\Android\Android Studio\jbr\bin\javac.exe") +
        glob.glob(r"C:\Program Files\Java\*\bin\javac.exe") +
        glob.glob(r"C:\Program Files\Android\*\jbr\bin\javac.exe")
    )
    if not javac_candidates:
        javac_exe = shutil.which("javac")
        if not javac_exe:
            raise RuntimeError("javac.exe not found")
        java_home = str(pathlib.Path(javac_exe).parent.parent)
    else:
        javac_exe = javac_candidates[0]
        java_home = str(pathlib.Path(javac_exe).parent.parent)

    return android_jar, d8_bat, javac_exe, java_home

def compile_stubs(javac_exe, android_jar, env):
    """Compiles STUBS_DIR into STUB_CLASSES_DIR (classpath only). None when there are no stubs."""
    stub_sources = [str(p) for p in STUBS_DIR.rglob("*.java")]
    if not stub_sources:
        return None
    STUB_CLASSES_DIR.mkdir(parents=True, exist_ok=True)
    res = subprocess.run(
        [javac_exe, "-encoding", "UTF-8", "-source", "1.8", "-target", "1.8", "-cp", android_jar,
         "-d", str(STUB_CLASSES_DIR), *stub_sources],
        capture_output=True, text=True, env=env,
    )
    if res.returncode != 0:
        print("Stub compilation error:\n", res.stdout, res.stderr)
        raise RuntimeError("javac (stubs) failed")
    return STUB_CLASSES_DIR

def assert_no_stub_classes_dexed():
    """d8/r8 only packages what it is given (CLASSES_DIR); a stub class there would shadow the device's real framework
    class (AbstractMethodError at runtime). Guards against a source file accidentally named like a stub."""
    if not STUB_CLASSES_DIR.exists():
        return
    stubs = {p.relative_to(STUB_CLASSES_DIR).as_posix() for p in STUB_CLASSES_DIR.rglob("*.class")}
    dexed = {p.relative_to(CLASSES_DIR).as_posix() for p in CLASSES_DIR.rglob("*.class")}
    leaked = sorted(stubs & dexed)
    if leaked:
        raise RuntimeError(f"framework stub classes would be packaged: {leaked}")

def build(obfuscate=True):
    print("=== OpenDeX Java Build (Max Obfuscation & Hardening) ===")
    android_jar, d8_bat, javac_exe, java_home = find_tools()
    java_exe = str(pathlib.Path(java_home) / "bin" / ("java.exe" if os.name == "nt" else "java"))
    d8_jar = pathlib.Path(d8_bat).parent / "lib" / "d8.jar"

    print(f"Using Android JAR : {android_jar}")
    print(f"Using D8/R8 Tool  : {d8_bat}")
    print(f"Using Javac       : {javac_exe}")
    print(f"Using JAVA_HOME   : {java_home}")

    # `obfuscate=True` (the default — every call site except the explicit `--no-obfuscate` opt-out) is a promise
    # that the shipped jar is protected, not a best-effort wish: if the R8 rules or d8.jar aren't where expected
    # (wrong SDK layout, proguard.pro deleted, build-tools downgraded), the OLD code quietly fell through to plain
    # d8 — a fully readable classes.dex, built and reported as success. A release pipeline must fail loudly here,
    # the same way a CI step that silently skips its tests would be a bug, not a feature.
    r8_ready = PROGUARD_RULES.exists() and d8_jar.exists()
    if obfuscate and not r8_ready:
        missing = [str(p) for p in (PROGUARD_RULES, d8_jar) if not p.exists()]
        raise RuntimeError(
            "R8 obfuscation was requested (default) but required tooling is missing: "
            + ", ".join(missing)
            + ". Fix the SDK/build-tools setup, or pass --no-obfuscate to build an UNPROTECTED jar on purpose "
            "(never for a release)."
        )
    print(f"Obfuscation (R8)  : {'ENABLED' if obfuscate else 'DISABLED (--no-obfuscate — do not ship this build)'}")

    # Set JAVA_HOME and PATH for d8.bat / r8
    env = os.environ.copy()
    env["JAVA_HOME"] = java_home
    env["PATH"] = str(pathlib.Path(java_home) / "bin") + os.pathsep + env.get("PATH", "")

    # Clean build dirs
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    CLASSES_DIR.mkdir(parents=True, exist_ok=True)
    DEX_DIR.mkdir(parents=True, exist_ok=True)
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Compile Java files
    java_files = list(SRC_DIR.glob("**/*.java"))
    print(f"\n[1/3] Compiling {len(java_files)} Java files...")
    for jf in java_files:
        print(f"  - {jf.name}")

    stub_cp = compile_stubs(javac_exe, android_jar, env)
    classpath = android_jar + (os.pathsep + str(stub_cp) if stub_cp else "")
    
    javac_args = [
        javac_exe,
        "-encoding", "UTF-8",
        "-source", "1.8",
        "-target", "1.8",
        "-g:none" if obfuscate else "-g",  # Strip debug info in release/obfuscated mode
        "-cp", classpath,
        "-d", str(CLASSES_DIR),
    ] + [str(f) for f in java_files]

    res = subprocess.run(javac_args, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        print("Compilation Error stdout:\n", res.stdout)
        print("Compilation Error stderr:\n", res.stderr)
        raise RuntimeError("javac compilation failed")
    print("  -> Classes compiled successfully (debug info stripped).")

    assert_no_stub_classes_dexed()

    # 2. Convert .class to classes.dex using R8 (Obfuscated) or D8 (Standard)
    class_files = list(CLASSES_DIR.glob("**/*.class"))
    if obfuscate:  # r8_ready was already verified above (raised otherwise) — this branch is unreachable without it
        print("\n[2/3] Obfuscating & Dexing with Google R8...")
        r8_cmd = [
            java_exe,
            "-cp", str(d8_jar),
            "com.android.tools.r8.R8",
            "--release",
            "--dex",
            "--output", str(DEX_DIR),
            "--lib", str(android_jar),
            "--min-api", "29",
            "--pg-conf", str(PROGUARD_RULES),
        ] + [str(cf) for cf in class_files]
        res = subprocess.run(r8_cmd, capture_output=True, text=True, env=env)
        if res.returncode != 0:
            print("R8 Error stdout:\n", res.stdout)
            print("R8 Error stderr:\n", res.stderr)
            raise RuntimeError("R8 obfuscation failed")
        print("  -> R8 Obfuscation & Dexing complete.")
    else:
        print("\n[2/3] Converting to DEX (d8)...")
        d8_cmd = [
            f'"{d8_bat}"',
            "--output", f'"{DEX_DIR}"',
            "--lib", f'"{android_jar}"',
            "--min-api", "29",
        ] + [f'"{cf}"' for cf in class_files]

        d8_cmd_str = " ".join(d8_cmd)
        res = subprocess.run(d8_cmd_str, capture_output=True, text=True, env=env, shell=True)
        if res.returncode != 0:
            print("D8 Error stdout:\n", res.stdout)
            print("D8 Error stderr:\n", res.stderr)
            raise RuntimeError("D8 dexing failed")
        print("  -> Generated classes.dex.")
    
    dex_file = DEX_DIR / "classes.dex"
    if not dex_file.exists():
        raise RuntimeError("classes.dex was not generated")
    print(f"  -> Generated classes.dex ({dex_file.stat().st_size} bytes)")

    # 3. Package the single vendor JAR (every tool is a main class in the same dex)
    print("\n[3/3] Packaging JAR...")
    target_jar = VENDOR_DIR / "opendex-tools.jar"
    with zipfile.ZipFile(target_jar, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(dex_file, "classes.dex")
    print(f"  -> Created {target_jar.name} ({target_jar.stat().st_size} bytes)")

    # Clean legacy artifacts
    legacy_jar = VENDOR_DIR / "opendex-icon-extractor.jar"
    if legacy_jar.exists():
        legacy_jar.unlink()

    print("\n[SUCCESS] Obfuscated Java build completed successfully!")

if __name__ == "__main__":
    do_obfuscate = "--no-obfuscate" not in sys.argv
    build(obfuscate=do_obfuscate)
