"""Python tarafı mutasyon testi (dosya sistemi)

Güvenlik/veri-kaybı özelliklerini (atomik yazma, taşıma sonrası silme, üzerine yazmama, kök/bağ kısıtı, içerik türü, kabuk jetonu…) test paketinin gerçekten koruduğunu doğrular.

Çalıştırma (depo kökünden):  python tools/dosya-sistemi-dogrulama/mutasyon/mutate_python.py [ad-parçası]

Her mutasyon kaynakta TEK bir yeri bozar, ilgili testleri çalıştırır ve dosyayı geri yazar. Test başarısız olursa mutant
"caught" (iyi), geçerse "SURVIVED" (test eksik YA DA mutant davranışsal olarak eşdeğer — bkz. README). Çalışma ağacında ilgili
dosyalarda KAYDEDİLMEMİŞ değişiklik varsa betik durur: mutasyon, dosyanın o anki hâlini geri yazar.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3] / "backend"
T = "tests/test_fs_transfer.py"
M = [
 ("move deletes nothing from the source", "app/fs/transfer.py", "            await src.delete(task.src.path)                       # only now — copied, size-checked, optionally hashed\n", "            pass\n", [T]),
 ("cancel leaves the temp file", "app/fs/transfer.py", "                    await asyncio.shield(writer.abort())", "                    pass", [T]),
 ("a retry re-decides (and renames itself)", "app/fs/transfer.py", "                    if task.decided is None:", "                    if True:", [T]),
 ("size mismatch not checked", "app/fs/transfer.py", "            if sent != reader.size:", "            if False:", [T]),
 ("policies all replace", "app/fs/transfer.py", "            return \"replace\" if task.mtime > existing.mtime + 1 else \"skip\"\n        return policy", "            return \"replace\" if task.mtime > existing.mtime + 1 else \"skip\"\n        return \"replace\"", [T]),
 ("move removes folders that kept files", "app/fs/transfer.py", "            if folder.keep or folder.broken or folder.pending:", "            if folder.broken:", [T]),
 ("no free-space check", "app/fs/transfer.py", "        if job.total_bytes > free:", "        if False:", [T]),
 ("links are followed as sources", "app/fs/transfer.py", "            if entry.symlink:                                     # links are never followed, never copied", "            if False:", [T]),
 ("windows names not converted", "app/fs/transfer.py", "    if provider.windows:\n        return windows_safe_name(name)", "    if False:\n        return windows_safe_name(name)", [T]),
 ("failed files stay in the totals", "app/fs/transfer.py", "        self.total_files -= 1\n        self.total_bytes -= task.size\n", "", [T]),
 ("a dropped device is just retried", "app/fs/transfer.py", "                        if exc.code == \"device_offline\":", "                        if False:", [T]),
 ("no sweep of a job's leftovers", "app/fs/transfer.py", "            await self._store.sweep_job(job.id)", "            pass", [T]),
 ("one-name collisions inside a job overwrite", "app/fs/transfer.py", "                resolution = \"skip\" if job.policy == \"skip\" else \"keep_both\"", "                resolution = job.policy if job.policy != \"ask\" else \"keep_both\"", [T]),
 ("apply to all is not remembered", "app/fs/transfer.py", "            if apply_all:\n                job.policy = resolution", "            if False:\n                job.policy = resolution", [T]),
 ("queued jobs cannot be cancelled (slot inside try)", "app/fs/transfer.py", "        try:\n            async with self._slots:", "        async with self._slots:\n          try:\n            if False:", [T]),
 ("local writer clobbers", "app/fs/providers/local.py", "            if not self._overwrite and os.path.lexists(_verbatim(self._final)):", "            if False:", ["tests/test_fs_local.py"]),
 ("local delete follows links", "app/fs/providers/local.py", "            st = os.lstat(target)\n            if stat_mod.S_ISDIR", "            st = os.stat(target)\n            if stat_mod.S_ISDIR", ["tests/test_fs_local.py"]),
 ("local rename clobbers", "app/fs/providers/local.py", "                if not same:                                   # a case-only rename on Windows IS the same file\n                    raise FsError(\"exists\", path=dst)", "                pass", ["tests/test_fs_local.py"]),
 ("roots: deny list ignored", "app/fs/roots.py", "        if self._denied(candidate):\n            raise FsError(\"outside_roots\", path=raw)\n", "", ["tests/test_fs_roots.py", "tests/test_fs_api.py"]),
 ("roots: links not resolved", "app/fs/roots.py", "        if follow_leaf:\n            resolved = os.path.realpath(raw)", "        if follow_leaf:\n            resolved = os.path.abspath(raw)", ["tests/test_fs_roots.py"]),
 ("roots: prefix match without separator", "app/fs/roots.py", "    return candidate.startswith(root if root.endswith(os.sep) else root + os.sep)", "    return candidate.startswith(root)", ["tests/test_fs_roots.py"]),
 ("roots: grants never expire", "app/fs/roots.py", "            for gid in [g for g, grant in self._grants.items() if grant.expires <= now]:\n                del self._grants[gid]", "            pass", ["tests/test_fs_roots.py"]),
 ("names: reserved device names allowed", "app/fs/names.py", "        if name.split(\".\", 1)[0].rstrip(\" \").upper() in _WINDOWS_RESERVED:\n            raise FsError(\"invalid_name\", \"Bu ad Windows'ta ayrılmış bir aygıt adıdır.\")", "        pass", ["tests/test_fs_names.py"]),
 ("names: unique_name ignores case on windows", "app/fs/names.py", "    return unicodedata.normalize(\"NFC\", name).casefold() if casefold else name", "    return name", ["tests/test_fs_names.py", T]),
 ("phone path prefix without separator", "app/fs/models.py", "        if path == root or path.startswith(root.rstrip(\"/\") + \"/\"):", "        if path.startswith(root):", ["tests/test_fs_roots.py"]),
 ("phone: line breaks allowed in paths", "app/fs/models.py", " or \"\\n\" in raw or \"\\r\" in raw:", ":", ["tests/test_fs_roots.py"]),
 ("sync: a broken push loses adbd's reason", "app/fs/adb_sync.py", "        if self._verdict is not None:\n            with contextlib.suppress(Exception):", "        if False:\n            with contextlib.suppress(Exception):", ["tests/test_fs_adb_sync.py"]),
 ("sync: DATA frames above 64 KiB", "app/fs/adb_sync.py", "        for start in range(0, len(view), SYNC_DATA_MAX):\n            piece = view[start:start + SYNC_DATA_MAX]", "        for start in range(0, len(view), 4 * SYNC_DATA_MAX):\n            piece = view[start:start + 4 * SYNC_DATA_MAX]", ["tests/test_fs_adb_sync.py"]),
 ("sync: server refusal read as not_found", "app/fs/adb_sync.py", "        raise FsError(\"device_offline\", detail=message or f\"adb refused {request!r}\")", "        raise failure_to_error(message or f\"adb refused {request!r}\")", ["tests/test_fs_adb_sync.py"]),
 ("phone: protected folders deletable", "app/fs/providers/phone.py", "        if is_protected_phone_path(norm):\n            raise FsError(\"permission\", \"Bu klasör silinemez.\", path=path)", "        pass", ["tests/test_fs_phone.py", "tests/test_fs_api.py"]),
 ("phone: shell fallback unquoted", "app/fs/providers/phone.py", "        await self._sh(f\"mkdir {'-p ' if parents else ''}-- {shlex.quote(norm)}\", path=norm)", "        await self._sh(f\"mkdir {'-p ' if parents else ''}-- {norm}\", path=norm)", ["tests/test_fs_phone.py"]),
 ("phone: upload overwrites silently", "app/fs/providers/phone.py", "        guard = \"\" if overwrite else f\"if [ -e {t} ] || [ -L {t} ]; then exit 17; fi; \"", "        guard = \"\"", ["tests/test_fs_phone.py"]),
 ("phone: partial file kept after abort", "app/fs/providers/phone.py", "        await self._session.close()                       # hangs up mid-SEND: adbd keeps what it got\n        await self._phone._discard_temp(self.temp_path)", "        await self._session.close()", ["tests/test_fs_phone.py", T]),
 ("phone: a half-used session is pooled", "app/fs/providers/phone.py", "        if self._complete:\n            await self._pool.release(self._session)", "        if True:\n            await self._pool.release(self._session)", ["tests/test_fs_phone.py"]),
 ("content: html served as html", "app/fs/content.py", "        return ContentPolicy(\"text/plain; charset=utf-8\", True, \"text\")", "        return ContentPolicy(\"text/html; charset=utf-8\", True, \"text\")", ["tests/test_fs_api.py"]),
 ("content: svg inline as image", "app/fs/content.py", "\"bmp\": \"image/bmp\",", "\"bmp\": \"image/bmp\", \"svg\": \"image/svg+xml\",", ["tests/test_fs_api.py"]),
 ("open: programs allowed", "app/fs/service.py", "        if os.path.splitext(content.filename)[1].lower() in RISKY_EXTENSIONS:", "        if False:", ["tests/test_fs_api.py"]),
 ("grants: token not checked", "app/fs/service.py", "        return bool(self._shell_token and presented and hmac.compare_digest(presented, self._shell_token))", "        return True", ["tests/test_fs_api.py"]),
 ("range: unsatisfiable range served", "app/fs/ranged.py", "    if wanted == \"invalid\":", "    if False:", ["tests/test_fs_api.py"]),
 ("trash: bin not hidden from the gallery", "app/fs/service.py", "            await phone.touch(f\"{bin_root}/.nomedia\")           # the Gallery must not show what was deleted", "            pass", ["tests/test_fs_api.py"]),
 ("rename: case-only goes straight through", "app/fs/service.py", "        if provider.casefold and comparison_key(old_name, casefold=True) == comparison_key(new_name, casefold=True) and old_name != new_name:", "        if False:", ["tests/test_fs_api.py"]),
 ("restore: overwrites a newer file", "app/fs/service.py", "                if await _exists(phone, target):\n                    taken", "                if False:\n                    taken", ["tests/test_fs_api.py"]),
 ("events: not ordered (spawned per event)", "app/fs/service.py", "        self._queue.put_nowait((event, payload))", "        asyncio.get_running_loop().create_task(self._bus.emit(event, **payload))", ["tests/test_fs_events.py"]),
 ("wire: batch with newline accepted", "app/fs/daemon_wire.py", "any(not p or \"\\n\" in p for p in paths)", "any(not p for p in paths)", ["tests/test_fs_java_contract.py"]),
]


def _refuse_if_dirty(files):
    out = subprocess.run(["git", "status", "--porcelain", "--", *files], cwd=ROOT, capture_output=True, text=True).stdout
    if out.strip():
        sys.exit("Mutasyon yapılacak dosyalarda kaydedilmemiş değişiklik var; önce commit/stash edin:\n" + out)


_refuse_if_dirty(sorted({rel for _, rel, *_ in M}))
only = sys.argv[1] if len(sys.argv) > 1 else None
survivors = []
for name, rel, old, new, tests in M:
    if only and only not in name:
        continue
    path = ROOT / rel
    src = path.read_text()
    if old not in src:
        print(f"!! cannot apply: {name}"); survivors.append(name + " (NOT APPLIED)"); continue
    path.write_text(src.replace(old, new, 1))
    try:
        r = subprocess.run([sys.executable, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", *tests], cwd=ROOT, capture_output=True, text=True, timeout=300)
        caught = r.returncode != 0
    except subprocess.TimeoutExpired:
        caught = True
    finally:
        path.write_text(src)
    print(("caught   " if caught else "SURVIVED ") + name, flush=True)
    if not caught:
        survivors.append(name)
print("\nsurvivors:", survivors)
