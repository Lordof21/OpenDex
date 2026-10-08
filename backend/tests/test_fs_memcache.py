"""The memory-only cache previews and thumbnails live in (fs/memcache.py)."""
from app.fs.memcache import MemoryCache, purge_legacy_disk_cache


def test_the_least_recently_used_go_first_and_an_oversized_item_is_not_kept():
    cache = MemoryCache(10)
    assert cache.put("a", b"1234") and cache.put("b", b"1234")
    cache.get("a")                                           # a is now the most recently used
    assert cache.put("c", b"1234")                           # 12 > 10: b (the least recently used) goes
    assert cache.get("b") is None and cache.get("a") == ("", b"1234") and cache.bytes_used == 8
    assert cache.put("big", b"x" * 11) is False and cache.get("big") is None


def test_the_old_disk_cache_is_removed_but_nothing_else_in_the_folder(tmp_path):
    root = tmp_path / "fs"
    (root / "ab").mkdir(parents=True)
    ours = [root / "ab" / ("a" * 64 + ".bin"), root / "ab" / ("b" * 64 + ".webp"), root / "ab" / ("c" * 64 + ".bin.123.tmp")]
    for path in ours:
        path.write_bytes(b"x")
    foreign = root / "ab" / "notes.txt"
    foreign.write_text("keep me")
    assert purge_legacy_disk_cache(root) == 3
    assert not any(p.exists() for p in ours) and foreign.read_text() == "keep me" and root.exists()
    foreign.unlink()
    assert purge_legacy_disk_cache(root) == 0 and not root.exists()      # the emptied folder goes too
