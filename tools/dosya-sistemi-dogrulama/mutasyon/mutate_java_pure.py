"""Java saf sınıflar mutasyon testi (FsWire / FsPolicy / FsOps / FsService korumaları)

Gerçek JVM üzerinde PureClassesSelfTest'in cihaz tarafı kuralları (kök kısıtı, bağ çözümü, sayfalama imleci, tel biçimi). FsService düzeyindeki korumalar (fs_rename/fs_delete korunan klasör) android.jar gerektirir: mutate_java_service.py gerçekten yakaladığını doğrular. javac + java gerekir.

Çalıştırma (depo kökünden):  python tools/dosya-sistemi-dogrulama/mutasyon/mutate_java_pure.py [ad-parçası]

Her mutasyon kaynakta TEK bir yeri bozar, ilgili testleri çalıştırır ve dosyayı geri yazar. Test başarısız olursa mutant
"caught" (iyi), geçerse "SURVIVED" (test eksik YA DA mutant davranışsal olarak eşdeğer — bkz. README). Çalışma ağacında ilgili
dosyalarda KAYDEDİLMEMİŞ değişiklik varsa betik durur: mutasyon, dosyanın o anki hâlini geri yazar.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

J = pathlib.Path(__file__).resolve().parents[3] / "backend" / "java"
SRC = J / "src/com/opendex/tools"
M = [
 ("policy: links leading out are followed", "FsPolicy.java", "            if (!within(real.toString(), canonicalRoots)) throw new FsOps.Failure(\"outside_roots\", real.toString());\n", ""),
 ("policy: entry() follows the leaf link", "FsPolicy.java", "        Path entry = realParent.resolve(path.getFileName().toString());", "        Path entry = existing(path.toString());"),
 ("policy: .. not resolved", "FsPolicy.java", "String normal = Paths.get(raw).normalize().toString();", "String normal = Paths.get(raw).toString();"),
 ("policy: nothing is protected", "FsPolicy.java", "            if (pattern.matcher(text).matches()) return true;", "            if (false) return true;"),
 ("policy: line breaks allowed", "FsPolicy.java", " || raw.indexOf('\\n') >= 0 || raw.indexOf('\\r') >= 0", ""),
 ("policy: sibling prefix counts as inside", "FsPolicy.java", "path.startsWith(root.endsWith(\"/\") ? root : root + \"/\")", "path.startsWith(root)"),
 ("policy: mkdir -p from an outside link", "FsPolicy.java", "        Path result = existing(existing.toString());", "        Path result = existing;"),
 ("ops: delete follows links", "FsOps.java", "Files.walkFileTree(path, new SimpleFileVisitor<Path>() {", "Files.walkFileTree(path, java.util.EnumSet.of(java.nio.file.FileVisitOption.FOLLOW_LINKS), Integer.MAX_VALUE, new SimpleFileVisitor<Path>() {"),
 ("ops: rename replaces silently", "FsOps.java", "            if (!overwrite && Files.exists(to, LinkOption.NOFOLLOW_LINKS)) {\n                throw new Failure(\"exists\", to.getFileName().toString());\n            }\n", ""),
 ("ops: page cursor repeats its last entry", "FsOps.java", "start = start >= 0 ? start + 1 : -start - 1;", "start = start >= 0 ? start : -start - 1;"),
 ("ops: last page still has a cursor", "FsOps.java", "String next = index < names.size() && !items.isEmpty() ? names.get(index - 1) : null;", "String next = !items.isEmpty() ? names.get(index - 1) : null;"),
 ("ops: names not forgotten after mkdir", "FsOps.java", "            else Files.createDirectory(path);\n            forgetNames();", "            else Files.createDirectory(path);"),
 ("ops: a vanished entry is an error", "FsOps.java", "                } catch (NoSuchFileException vanished) {\n                    // gone since the listing: skip it\n", "                } catch (NoSuchFileException vanished) {\n                    throw new Failure(\"not_found\", names.get(index));\n"),
 ("ops: not_found mapped to io", "FsOps.java", "if (e instanceof NoSuchFileException) return new Failure(\"not_found\", reason);", "if (e instanceof NoSuchFileException) return new Failure(\"io\", reason);"),
 ("ops: volumes list `self`", "FsOps.java", "if (name.equals(\"emulated\") || name.equals(\"self\") || name.startsWith(\".\")) continue;", "if (name.equals(\"emulated\") || name.startsWith(\".\")) continue;"),
 ("wire: NUL allowed in paths", "FsWire.java", "return text.indexOf('\\0') >= 0 ? null : text;", "return text;"),
 ("wire: invalid UTF-8 repaired silently", "FsWire.java", ".onMalformedInput(CodingErrorAction.REPORT)", ".onMalformedInput(CodingErrorAction.REPLACE)"),
 ("wire: empty batch entries allowed", "FsWire.java", "if (path.isEmpty() || path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES) return null;", "if (path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES) return null;"),
 ("wire: wrong argument count accepted", "FsWire.java", "if (parts.length - 1 != want) return new Request(command, new String[0], \"bad_request\");", ""),
 ("wire: page size not clamped", "FsWire.java", "return Math.max(1, Math.min(n, MAX_PAGE));", "return n;"),
]
only = sys.argv[1] if len(sys.argv) > 1 else None
alive = []
for name, fname, old, new in M:
    if only and only not in name:
        continue
    path = SRC / fname
    src = path.read_text()
    if old not in src:
        print("!! cannot apply:", name); alive.append(name + " (NOT APPLIED)"); continue
    path.write_text(src.replace(old, new, 1))
    out = pathlib.Path(tempfile.mkdtemp(prefix="opdx-jm-"))
    try:
        c = subprocess.run(["javac", "-d", str(out), *[str(SRC / f"{n}.java") for n in ("ShellRunner", "ShellWire", "DaemonAuth", "ProcProbe", "FsWire", "FsPolicy", "FsOps")], str(J / "test/com/opendex/tools/PureClassesSelfTest.java")], capture_output=True, text=True)
        if c.returncode != 0:
            killed = True; why = "compile error"
        else:
            r = subprocess.run(["java", "-cp", str(out), "com.opendex.tools.PureClassesSelfTest"], capture_output=True, text=True, env={**os.environ, "LC_ALL": "C.UTF-8"}, timeout=120)
            killed = r.returncode != 0 or "ALL OK" not in r.stdout
            why = (r.stderr.strip().splitlines() or [""])[-1][:80] if killed else ""
    finally:
        path.write_text(src)
        shutil.rmtree(out, ignore_errors=True)
    print(("caught   " if killed else "SURVIVED ") + name + (f"   [{why}]" if killed else ""), flush=True)
    if not killed:
        alive.append(name)
print("\nsurvivors:", alive)
