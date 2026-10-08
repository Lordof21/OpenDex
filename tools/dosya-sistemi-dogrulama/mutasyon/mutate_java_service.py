"""Java FsService mutasyon testi (gerçek servis, gerçek soket + dosya)

Gerçek FsService'i (android-all.jar ile derlenmiş) çalıştıran test_fs_real_daemon.py'nin servis katmanı kurallarını yakaladığını doğrular.

Çalıştırma (depo kökünden):  python tools/dosya-sistemi-dogrulama/mutasyon/mutate_java_service.py [ad-parçası]

Her mutasyon kaynakta TEK bir yeri bozar, ilgili testleri çalıştırır ve dosyayı geri yazar. Test başarısız olursa mutant
"caught" (iyi), geçerse "SURVIVED" (test eksik YA DA mutant davranışsal olarak eşdeğer — bkz. README). Çalışma ağacında ilgili
dosyalarda KAYDEDİLMEMİŞ değişiklik varsa betik durur: mutasyon, dosyanın o anki hâlini geri yazar.
"""
import os
import pathlib
import subprocess
import sys

J = pathlib.Path(__file__).resolve().parents[3] / "backend"
F = J / "java/src/com/opendex/tools/FsService.java"
M = [
 ("fs_rename not protected", "                if (policy.isProtected(source)) throw new FsOps.Failure(\"permission\", \"protected folder\");\n                FsOps.rename", "                FsOps.rename"),
 ("fs_delete not protected", "                if (policy.isProtected(target)) throw new FsOps.Failure(\"permission\", \"protected folder\");\n                return Json.obj(\"type\", type, \"ok\", true, \"deleted\"", "                return Json.obj(\"type\", type, \"ok\", true, \"deleted\""),
 ("mkdir -p ignores parents", "FsOps.mkdir(parents ? policy.forCreateWithParents(path) : policy.forCreate(path), parents);", "FsOps.mkdir(policy.forCreate(path), parents);"),
 ("fs_list cursor dropped", "FsOps.Page page = FsOps.list(dir, after, FsWire.clampPage(args[2]));", "FsOps.Page page = FsOps.list(dir, null, FsWire.clampPage(args[2]));"),
 ("stat follows the leaf link", "Path path = policy.entry(need(b64));\n        return Json.obj(\"type\", type, \"ok\", true, \"path\"", "Path path = policy.existing(need(b64));\n        return Json.obj(\"type\", type, \"ok\", true, \"path\""),
]
src = F.read_text()
if "OPENDEX_ANDROID_JAR" not in os.environ:
    sys.exit("OPENDEX_ANDROID_JAR=<android-all.jar yolu> verilmeli (gerçek FsService derlemesi için).")
env = dict(os.environ)
for name, old, new in M:
    assert old in src, name
    F.write_text(src.replace(old, new, 1))
    try:
        r = subprocess.run([sys.executable, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", "tests/test_fs_real_daemon.py"], cwd=J, capture_output=True, text=True, env=env, timeout=300)
        print(("caught   " if r.returncode != 0 else "SURVIVED ") + name, flush=True)
    finally:
        F.write_text(src)
