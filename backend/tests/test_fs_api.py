"""The /api/fs routes, end to end through the real app: real PC files, a phone behind the fake adb server and daemon."""
import asyncio
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.config import Settings
from app.fs.adb_sync import AdbSync
from app.fs.providers.phone import PhoneProvider
from app.main import create_app
from app.storage import settings_db
from tests.conftest import TEST_API_TOKEN
from tests.fs_fakes import FakeAdbServer, FakeDevice, FakeFsDaemon, FakeShell

pytestmark = pytest.mark.asyncio
ROOT = "/storage/emulated/0"


@pytest.fixture
async def env(tmp_path, monkeypatch):
    docs = tmp_path / "home" / "Documents"
    docs.mkdir(parents=True)
    monkeypatch.setattr("app.fs.roots.default_known_folders", lambda: {"documents": docs})
    settings = Settings(
        FS_CACHE_DIR=tmp_path / "cache", DB_PATH=tmp_path / "settings.db", FS_SHELL_TOKEN_FILE=tmp_path / "shell-token",
        API_TOKEN_FILE=tmp_path / "api" / "api-token", DAEMON_TOKEN_FILE=tmp_path / "api" / "daemon-token",
    )
    await settings_db.init(settings.DB_PATH)
    app = create_app(settings)
    ctx = app.state.ctx
    dev = FakeDevice()
    dev.add_dir(f"{ROOT}/DCIM/Camera")
    dev.add_file(f"{ROOT}/DCIM/Camera/a.jpg", b"JPEG" * 100, mtime=1_650_000_000)
    dev.add_file(f"{ROOT}/Download/notes.txt", b"hello phone")
    async with FakeAdbServer({"SER1": dev}) as server:
        ctx.serial = "SER1"
        daemon = FakeFsDaemon(dev)
        shell = FakeShell(dev)
        ctx.fs._phones["SER1"] = PhoneProvider("SER1", sync=AdbSync(port=server.port, idle_timeout=2.0), daemon=daemon, shell=shell)
        await ctx.fs.start()
        queue = await ctx.event_bus.subscribe()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                     headers={"Authorization": f"Bearer {TEST_API_TOKEN}"}) as client:
            class Env:
                pass

            e = Env()
            e.client, e.ctx, e.dev, e.docs, e.daemon, e.shell, e.events, e.app = client, ctx, dev, docs, daemon, shell, queue, app
            e.tmp = tmp_path
            yield e
        await ctx.fs.stop()


async def ndjson(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line]


async def events_until(env, found, timeout: float = 5.0) -> list:
    """Collect bus events (in order) up to and including the first one `found` accepts."""
    collected = []
    async with asyncio.timeout(timeout):
        while True:
            event = await env.events.get()
            collected.append(event)
            if found(event):
                return collected


async def wait_job(env, job_id, states=("completed", "failed", "cancelled")):
    for _ in range(300):
        jobs = (await env.client.get("/api/fs/transfers")).json()["items"]
        job = next(j for j in jobs if j["id"] == job_id)
        if job["state"] in states:
            return job
        await asyncio.sleep(0.02)
    raise AssertionError("job did not finish")


# ---------------------------------------------------------------------------------------------- places and listing


async def test_everything_needs_the_api_token(env):
    bare = httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://testserver")
    async with bare:
        for path in ("/api/fs/places", "/api/fs/list?provider=pc&path=/x", "/api/fs/transfers"):
            assert (await bare.get(path)).status_code == 401


async def test_places_lists_pc_phone_and_favourites(env):
    body = (await env.client.get("/api/fs/places")).json()
    assert [p["kind"] for p in body["pc"]] == ["documents"]
    assert [p["kind"] for p in body["phone"]] == ["internal", "sdcard"] and body["device"] == "SER1"
    assert body["pc_access"] == "folders" and body["favorites"] == []


async def test_places_carry_capacity_for_drives_and_a_hung_drive_just_has_no_bar(env, monkeypatch):
    import time

    from app.fs.models import Place

    monkeypatch.setattr(env.ctx.fs.roots, "places", lambda: [
        Place("pc:drive:C", "pc", "drive", "C:\\", "C:\\"),
        Place("pc:drive:Z", "pc", "drive", "Z:\\", "Z:\\"),             # a disconnected network drive
        Place("pc:documents", "pc", "documents", "Documents", str(env.docs)),
    ])

    def usage(path):
        if path.startswith("Z"):
            time.sleep(0.4)
        return type("U", (), {"total": 1000, "free": 250})()

    monkeypatch.setattr("app.fs.service.shutil.disk_usage", usage)
    monkeypatch.setattr("app.fs.service.PLACE_CAPACITY_TIMEOUT_S", 0.05)
    by_kind = {p["name"]: p for p in (await env.client.get("/api/fs/places")).json()["pc"]}
    assert (by_kind["C:\\"]["total"], by_kind["C:\\"]["free"]) == (1000, 250)
    assert "total" not in by_kind["Z:\\"]                                  # timed out: no bar, and the sidebar still loads
    assert "total" not in by_kind["Documents"]                              # known folders do not measure


async def test_a_pc_folder_streams_as_ndjson(env):
    (env.docs / "a.txt").write_text("12345")
    (env.docs / "sub").mkdir()
    res = await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(env.docs)})
    assert res.status_code == 200 and res.headers["content-type"].startswith("application/x-ndjson")
    lines = await ndjson(res)
    assert lines[0]["type"] == "meta" and lines[0]["path"] == str(env.docs) and lines[0]["provider"] == "pc"
    assert lines[-1] == {"type": "end", "total": 2}
    items = {e["name"]: e for line in lines if line["type"] == "entries" for e in line["items"]}
    assert items["a.txt"]["size"] == 5 and items["sub"]["kind"] == "dir"


async def test_an_empty_folder_still_has_meta_and_end(env):
    lines = await ndjson(await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(env.docs)}))
    assert [l["type"] for l in lines] == ["meta", "end"] and lines[-1]["total"] == 0


async def test_listing_errors_are_real_http_errors_with_a_code(env):
    res = await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(env.docs / "nope")})
    assert res.status_code == 404 and res.json()["code"] == "not_found" and res.json()["detail"]
    res = await env.client.get("/api/fs/list", params={"provider": "pc", "path": "/etc"})
    assert res.status_code == 403 and res.json()["code"] == "outside_roots"
    res = await env.client.get("/api/fs/list", params={"provider": "phone", "path": "/data/data/com.x"})
    assert res.status_code == 403 and res.json()["code"] == "outside_roots"
    res = await env.client.get("/api/fs/list", params={"provider": "phone", "path": "/sdcard/../data"})
    assert res.status_code == 403
    res = await env.client.get("/api/fs/list", params={"provider": "tape", "path": "/x"})
    assert res.status_code == 422


async def test_the_phone_lists_through_the_daemon(env):
    lines = await ndjson(await env.client.get("/api/fs/list", params={"provider": "phone", "path": "/sdcard/DCIM/Camera"}))
    assert lines[0]["path"] == f"{ROOT}/DCIM/Camera" and lines[0]["parent"] == f"{ROOT}/DCIM"
    names = [e["name"] for l in lines if l["type"] == "entries" for e in l["items"]]
    assert names == ["a.jpg"] and any(c.startswith("fs_list") for c in env.daemon.calls)


async def test_no_device_is_a_clear_conflict(env):
    env.ctx.serial = None
    env.ctx.fs._phones.clear()
    res = await env.client.get("/api/fs/list", params={"provider": "phone", "path": "/sdcard"})
    assert res.status_code == 409 and res.json()["code"] == "device_offline"
    assert (await env.client.get("/api/fs/places")).json()["phone"] == []


async def test_stat_search_and_favourites(env):
    (env.docs / "Report 2024.pdf").write_text("x")
    (env.docs / "sub").mkdir()
    (env.docs / "sub" / "report-final.txt").write_text("x")
    res = (await env.client.get("/api/fs/stat", params={"provider": "pc", "path": str(env.docs / "Report 2024.pdf")})).json()
    assert res["name"] == "Report 2024.pdf" and res["size"] == 1
    found = (await env.client.get("/api/fs/search", params={"provider": "pc", "path": str(env.docs), "q": "REPORT"})).json()
    assert sorted(Path(i["path"]).name for i in found["items"]) == ["Report 2024.pdf", "report-final.txt"] and not found["truncated"]
    phone = (await env.client.get("/api/fs/search", params={"provider": "phone", "path": "/sdcard", "q": "A.JP"})).json()
    assert [i["path"] for i in phone["items"]] == [f"{ROOT}/DCIM/Camera/a.jpg"]
    assert (await env.client.get("/api/fs/search", params={"provider": "pc", "path": str(env.docs), "q": "x\ny"})).status_code == 400

    fav = (await env.client.post("/api/fs/favorites", json={"location": {"provider": "pc", "path": str(env.docs)}, "name": "Belgelerim"})).json()
    again = (await env.client.post("/api/fs/favorites", json={"location": {"provider": "pc", "path": str(env.docs)}, "name": "Belgelerim"})).json()
    assert again["id"] == fav["id"]
    assert (await env.client.get("/api/fs/places")).json()["favorites"][0]["name"] == "Belgelerim"
    await env.client.delete(f"/api/fs/favorites/{fav['id']}")
    assert (await env.client.get("/api/fs/favorites")).json()["items"] == []


async def test_user_added_folders_persist_in_the_database(env):
    extra = env.tmp / "projects"
    extra.mkdir()
    assert (await env.client.post("/api/fs/folders", json={"path": str(extra)})).status_code == 403          # a page cannot widen the roots…
    assert (await env.client.post("/api/fs/folders", json={"path": str(extra)}, headers={"X-OpenDex-Shell": "wrong"})).status_code == 403
    assert str(extra) not in await env.ctx.fs.store.roots()
    shell = {"X-OpenDex-Shell": (env.tmp / "shell-token").read_text().strip()}                                  # …the native shell can
    res = await env.client.post("/api/fs/folders", json={"path": str(extra)}, headers=shell)
    assert res.status_code == 200
    assert str(extra) in await env.ctx.fs.store.roots()
    assert (await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(extra)})).status_code == 200
    assert (await env.client.delete("/api/fs/folders", params={"path": str(extra)})).status_code == 200
    assert (await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(extra)})).status_code == 403
    secret = env.tmp / "api"                                                    # the folder with the tokens can never be added
    secret.mkdir(exist_ok=True)
    assert (await env.client.post("/api/fs/folders", json={"path": str(secret)}, headers=shell)).status_code == 403


# ---------------------------------------------------------------------------------------------- changes


async def test_mkdir_and_rename_with_name_rules(env):
    res = await env.client.post("/api/fs/mkdir", json={"parent": {"provider": "pc", "path": str(env.docs)}, "name": "Yeni Klasör"})
    assert res.status_code == 200 and (env.docs / "Yeni Klasör").is_dir()
    res = await env.client.post("/api/fs/mkdir", json={"parent": {"provider": "pc", "path": str(env.docs)}, "name": "Yeni Klasör"})
    assert res.status_code == 409 and res.json()["code"] == "exists"
    res = await env.client.post("/api/fs/mkdir", json={"parent": {"provider": "phone", "path": "/sdcard/Download"}, "name": "a/b"})
    assert res.status_code == 422 and res.json()["code"] == "invalid_name"
    res = await env.client.post("/api/fs/mkdir", json={"parent": {"provider": "phone", "path": "/sdcard/Download"}, "name": "Yeni"})
    assert res.status_code == 200 and f"{ROOT}/Download/Yeni" in env.dev.files
    (env.docs / "old.txt").write_text("x")
    res = await env.client.post("/api/fs/rename", json={"location": {"provider": "pc", "path": str(env.docs / "old.txt")}, "name": "new.txt"})
    assert res.status_code == 200 and (env.docs / "new.txt").exists()


async def test_a_case_only_rename_works_on_the_phone(env):
    res = await env.client.post("/api/fs/rename", json={"location": {"provider": "phone", "path": "/sdcard/Download/notes.txt"}, "name": "NOTES.txt"})
    assert res.status_code == 200
    assert f"{ROOT}/Download/NOTES.txt" in env.dev.files and f"{ROOT}/Download/notes.txt" not in env.dev.files


async def test_pc_delete_goes_to_the_recycle_bin_and_permanent_really_deletes(env, monkeypatch):
    trashed = []
    monkeypatch.setattr("send2trash.send2trash", lambda p: (trashed.append(p), os.remove(p)))
    (env.docs / "a.txt").write_text("x")
    (env.docs / "b.txt").write_text("x")
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "pc", "path": str(env.docs / "a.txt")}]})).json()
    assert res["results"][0]["ok"] and trashed == [str(env.docs / "a.txt")]
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "pc", "path": str(env.docs / "b.txt")}], "permanent": True})).json()
    assert res["results"][0]["ok"] and not (env.docs / "b.txt").exists() and len(trashed) == 1


async def test_a_delete_reports_each_item_and_refuses_the_roots(env):
    res = (await env.client.post("/api/fs/delete", json={"items": [
        {"provider": "pc", "path": str(env.docs)}, {"provider": "pc", "path": str(env.docs / "ghost")},
    ], "permanent": True})).json()["results"]
    assert [r["ok"] for r in res] == [False, False]
    assert res[0]["error"]["code"] == "permission" and res[1]["error"]["code"] == "not_found"


async def test_the_phone_recycle_bin_round_trip(env):
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "phone", "path": "/sdcard/Download/notes.txt"}]})).json()
    assert res["results"][0]["ok"], res
    assert f"{ROOT}/Download/notes.txt" not in env.dev.files
    items = (await env.client.get("/api/fs/trash")).json()["items"]
    assert len(items) == 1 and items[0]["name"] == "notes.txt" and items[0]["original"] == f"{ROOT}/Download/notes.txt"
    assert any(p.endswith("/.opendex-trash/.nomedia") for p in env.dev.files)             # the Gallery must not index the bin
    env.dev.add_file(f"{ROOT}/Download/notes.txt", b"a NEW file with the old name")
    back = (await env.client.post("/api/fs/trash/restore", json={"ids": [items[0]["id"]]})).json()["results"][0]
    assert back["ok"] and back["path"] == f"{ROOT}/Download/notes (2).txt"                  # never over a file that appeared since
    assert env.dev.files[back["path"]].data == b"hello phone"
    assert (await env.client.get("/api/fs/trash")).json()["items"] == []


async def test_emptying_the_phone_bin_deletes_for_good(env):
    await env.client.post("/api/fs/delete", json={"items": [{"provider": "phone", "path": "/sdcard/Download/notes.txt"}]})
    assert (await env.client.post("/api/fs/trash/delete", json={})).json() == {"deleted": 1}
    assert not any("/.opendex-trash/" in p and p.endswith("notes.txt") for p in env.dev.files)


async def test_a_phone_path_without_a_volume_cannot_use_the_bin_but_can_be_deleted_for_good(env):
    env.dev.add_file("/data/local/tmp/x.bin", b"x")
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "phone", "path": "/data/local/tmp/x.bin"}]})).json()["results"][0]
    assert res["error"]["code"] == "trash_unavailable"
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "phone", "path": "/data/local/tmp/x.bin"}], "permanent": True})).json()["results"][0]
    assert res["ok"]


async def test_protected_phone_folders_cannot_be_deleted_even_permanently(env):
    res = (await env.client.post("/api/fs/delete", json={"items": [{"provider": "phone", "path": "/sdcard"}], "permanent": True})).json()["results"][0]
    assert res["error"]["code"] == "permission"


# ---------------------------------------------------------------------------------------------- transfers


async def test_a_transfer_through_the_api_with_live_events(env):
    res = await env.client.post("/api/fs/transfers", json={
        "op": "copy", "sources": [{"provider": "phone", "path": "/sdcard/Download/notes.txt"}],
        "dest": {"provider": "pc", "path": str(env.docs)},
    })
    assert res.status_code == 202 and res.json()["state"] in ("queued", "scanning")
    job = await wait_job(env, res.json()["id"])
    assert job["state"] == "completed" and (env.docs / "notes.txt").read_bytes() == b"hello phone"
    # The REST state flips before the (ordered, separate) event pump has published the last event — wait for it.
    kinds = await events_until(env, lambda e: e.type == "fs_transfer" and e.payload["state"] == "completed")
    types = [k.type for k in kinds]
    assert "fs_transfer" in types and "fs_changed" in types
    last = [k.payload for k in kinds if k.type == "fs_transfer"][-1]
    assert last["state"] == "completed" and last["done_bytes"] == 11                       # the final event is the LAST one
    await asyncio.sleep(0.05)
    assert env.events.empty()                                                              # and nothing overtakes it afterwards
    history = (await env.client.get("/api/fs/transfers/history")).json()["items"]
    assert history[0]["id"] == job["id"]
    assert (await env.client.post("/api/fs/transfers/clear")).json() == {"removed": 1}


async def test_conflicts_are_answered_over_http(env):
    (env.docs / "notes.txt").write_text("PC COPY")
    res = await env.client.post("/api/fs/transfers", json={
        "op": "copy", "sources": [{"provider": "phone", "path": "/sdcard/Download/notes.txt"}], "dest": {"provider": "pc", "path": str(env.docs)},
    })
    job_id = res.json()["id"]
    for _ in range(300):
        job = next(j for j in (await env.client.get("/api/fs/transfers")).json()["items"] if j["id"] == job_id)
        if job["state"] == "waiting":
            break
        await asyncio.sleep(0.02)
    assert job["conflict"]["name"] == "notes.txt" and job["conflict"]["choices"] == ["replace", "skip", "keep_both"]
    assert (await env.client.post(f"/api/fs/transfers/{job_id}/resolve", json={"resolution": "bogus"})).status_code == 422
    assert (await env.client.post(f"/api/fs/transfers/{job_id}/resolve", json={"resolution": "keep_both"})).status_code == 200
    assert (await wait_job(env, job_id))["state"] == "completed"
    assert (env.docs / "notes.txt").read_text() == "PC COPY" and (env.docs / "notes (2).txt").read_text() == "hello phone"
    assert (await env.client.post(f"/api/fs/transfers/{job_id}/resolve", json={"resolution": "skip"})).json()["code"] == "conflict_pending"
    assert (await env.client.delete(f"/api/fs/transfers/{job_id}")).status_code == 200


async def test_transfer_requests_are_validated_before_a_job_exists(env):
    bad = await env.client.post("/api/fs/transfers", json={"op": "copy", "sources": [{"provider": "pc", "path": "/etc/passwd"}],
                                                           "dest": {"provider": "pc", "path": str(env.docs)}})
    assert bad.status_code == 403 and (await env.client.get("/api/fs/transfers")).json()["items"] == []
    assert (await env.client.post("/api/fs/transfers", json={"op": "teleport", "sources": [], "dest": {"provider": "pc", "path": "/x"}})).status_code == 422
    assert (await env.client.post("/api/fs/transfers/nope/cancel")).status_code == 404


# ---------------------------------------------------------------------------------------------- bytes for the page


async def test_thumbnails_live_in_memory_and_are_not_stored_by_the_browser_either(env):
    Image.new("RGB", (800, 600), (200, 30, 30)).save(env.docs / "p.png")
    params = {"provider": "pc", "path": str(env.docs / "p.png"), "px": 128, "v": "1-2"}
    res = await env.client.get("/api/fs/thumb", params=params)
    assert res.status_code == 200 and res.headers["content-type"] == "image/webp"
    assert res.headers["cache-control"] == "private, no-store" and res.headers["x-content-type-options"] == "nosniff"
    img = Image.open(__import__("io").BytesIO(res.content))
    assert max(img.size) == 128 and img.size == (128, 96)
    again = await env.client.get("/api/fs/thumb", params=params)
    assert again.content == res.content
    assert env.ctx.fs.thumbs._cache.bytes_used == len(res.content)                       # decoded once, kept in memory
    assert not (env.tmp / "cache").exists()                                               # ...and nothing reached the disk
    (env.docs / "t.txt").write_text("x")
    assert (await env.client.get("/api/fs/thumb", params={**params, "path": str(env.docs / "t.txt")})).status_code == 501
    (env.docs / "broken.png").write_bytes(b"not an image")
    assert (await env.client.get("/api/fs/thumb", params={**params, "path": str(env.docs / "broken.png")})).json()["code"] == "unsupported"


async def test_a_phone_thumbnail_comes_from_the_devices_own_decoder(env):
    res = await env.client.get("/api/fs/thumb", params={"provider": "phone", "path": "/sdcard/DCIM/Camera/a.jpg", "px": 160, "v": "x"})
    assert res.status_code == 200 and res.content == b"JPEGDATA" and res.headers["content-type"] == "image/jpeg"
    assert res.headers["cross-origin-resource-policy"] == "cross-origin"        # the app window is another SITE than the API
    await env.client.get("/api/fs/thumb", params={"provider": "phone", "path": "/sdcard/DCIM/Camera/a.jpg", "px": 160, "v": "x"})
    assert sum(1 for c in env.daemon.calls if c.startswith("fs_thumb")) == 1                # the second came from memory


async def test_a_phone_photo_the_daemon_cannot_decode_is_decoded_on_the_pc(env):
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), (200, 30, 30)).save(buf, "PNG")
    env.dev.add_file(f"{ROOT}/DCIM/Camera/b.png", buf.getvalue())             # the fake daemon only decodes .jpg
    res = await env.client.get("/api/fs/thumb", params={"provider": "phone", "path": "/sdcard/DCIM/Camera/b.png", "px": 96, "v": "x"})
    assert res.status_code == 200 and res.headers["content-type"] == "image/webp"
    assert max(Image.open(io.BytesIO(res.content)).size) == 96


async def test_a_serial_remembered_from_the_other_transport_still_means_the_bound_phone(env):
    # USB -> Wi-Fi renames the bound phone (R5CT… -> 192.168.1.7:5555); panels still holding the old serial must keep working.
    res = await env.client.get("/api/fs/stat", params={"provider": "phone", "path": "/sdcard/Download/notes.txt", "device": "R5CT-OLD-USB-SERIAL"})
    assert res.status_code == 200 and res.json()["name"] == "notes.txt"


async def test_content_supports_ranges_for_seeking(env):
    (env.docs / "v.mp4").write_bytes(bytes(range(256)) * 4)
    params = {"provider": "pc", "path": str(env.docs / "v.mp4")}
    full = await env.client.get("/api/fs/content", params=params)
    assert full.status_code == 200 and full.headers["content-type"] == "video/mp4" and full.headers["accept-ranges"] == "bytes"
    part = await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == bytes(range(10, 20)) and part.headers["content-range"] == "bytes 10-19/1024"
    tail = await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=-4"})
    assert tail.content == bytes([252, 253, 254, 255])
    assert (await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=5000-"})).status_code == 416


async def test_content_never_serves_active_documents_as_what_they_claim_to_be(env):
    for name, body in (("evil.html", b"<script>fetch('/api/fs/places')</script>"), ("evil.svg", b"<svg onload=alert(1)>"), ("setup.exe", b"MZ")):
        (env.docs / name).write_bytes(body)
        res = await env.client.get("/api/fs/content", params={"provider": "pc", "path": str(env.docs / name)})
        media = res.headers["content-type"]
        assert "html" not in media and "svg" not in media and "javascript" not in media, (name, media)
        assert "sandbox" in res.headers["content-security-policy"] and res.headers["x-content-type-options"] == "nosniff"
    html = await env.client.get("/api/fs/content", params={"provider": "pc", "path": str(env.docs / "evil.html")})
    assert html.headers["content-type"].startswith("text/plain") and html.headers["content-disposition"].startswith("inline")
    exe = await env.client.get("/api/fs/content", params={"provider": "pc", "path": str(env.docs / "setup.exe")})
    assert exe.headers["content-disposition"].startswith("attachment") and exe.headers["content-type"] == "application/octet-stream"
    forced = await env.client.get("/api/fs/content", params={"provider": "pc", "path": str(env.docs / "evil.html"), "download": "true"})
    assert forced.headers["content-disposition"].startswith("attachment")


async def test_a_phone_file_is_previewed_from_memory_once_and_never_touches_the_disk(env):
    params = {"provider": "phone", "path": "/sdcard/Download/notes.txt"}
    res = await env.client.get("/api/fs/content", params=params)
    assert res.status_code == 200 and res.content == b"hello phone" and res.headers["content-type"].startswith("text/plain")
    before = env.dev.sync_sessions
    part = await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=6-10"})
    assert part.status_code == 206 and part.content == b"phone" and part.headers["content-range"] == "bytes 6-10/11"
    assert env.dev.sync_sessions == before                                                 # served from memory, Range included
    assert not (env.tmp / "cache").exists() and not env.ctx.fs._staged_dir.exists()       # not a byte on the disk
    env.dev.files[f"{ROOT}/Download/big.bin"] = env.dev.files[f"{ROOT}/Download/notes.txt"].__class__("file", b"x" * 10)
    env.ctx.settings.FS_PREVIEW_MAX_MB = 1
    env.dev.files[f"{ROOT}/Download/big.bin"].data = b"x" * (2 * 1024 * 1024)
    big = await env.client.get("/api/fs/content", params={"provider": "phone", "path": "/sdcard/Download/big.bin"})
    assert big.status_code == 413 and big.json()["code"] == "too_large"


async def test_a_phone_video_plays_from_the_phone_by_byte_ranges_and_is_never_held_anywhere(env):
    video = bytes(range(256)) * 8192                                                      # 2 MB
    env.dev.add_file(f"{ROOT}/Movies/clip.mp4", video)
    env.ctx.settings.FS_PREVIEW_MAX_MB = 1                                                # 2 MB is over the in-memory preview limit
    params = {"provider": "phone", "path": "/sdcard/Movies/clip.mp4"}
    full = await env.client.get("/api/fs/content", params=params)
    assert full.status_code == 200 and full.headers["content-type"] == "video/mp4" and full.content == video
    assert full.headers["accept-ranges"] == "bytes" and full.headers["cache-control"] == "private, no-store"
    middle = await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=1000-1999"})
    assert middle.status_code == 206 and middle.content == video[1000:2000] and middle.headers["content-range"] == f"bytes 1000-1999/{len(video)}"
    tail = await env.client.get("/api/fs/content", params=params, headers={"Range": "bytes=-100"})         # the moov atom at the end
    assert tail.content == video[-100:]
    assert env.ctx.fs.previews.bytes_used == 0 and not (env.tmp / "cache").exists()                       # nothing kept, nothing on the disk
    assert env.dev.exec_log[1] == f"tail -c +1001 {ROOT}/Movies/clip.mp4 2>/dev/null | head -c 1000"           # seeks, then stops


async def test_a_phone_video_path_reaches_the_shell_quoted(env):
    name = "a'b | c; echo $HOME.mp4"
    env.dev.add_file(f"{ROOT}/Movies/{name}", b"0123456789")
    res = await env.client.get("/api/fs/content", params={"provider": "phone", "path": f"/sdcard/Movies/{name}"}, headers={"Range": "bytes=2-5"})
    assert res.content == b"2345"                                                                         # the fake shell splits like sh would
    assert env.dev.exec_log[-1].startswith("tail -c +3 ") and "'\"'\"'" in env.dev.exec_log[-1]


async def test_open_on_pc_copies_a_phone_file_under_its_own_name_only_because_the_user_asked(env, monkeypatch):
    opened = []
    monkeypatch.setattr("app.fs.service._open_default", lambda path: opened.append((path.name, path.read_bytes())))
    res = await env.client.post("/api/fs/open", json={"location": {"provider": "phone", "path": "/sdcard/Download/notes.txt"}})
    assert res.status_code == 200 and opened == [("notes.txt", b"hello phone")]            # the real name: the program picks by extension
    assert env.ctx.fs._staged_dir.is_dir()
    await env.ctx.fs.stop()
    assert not env.ctx.fs._staged_dir.exists()                                             # emptied with the backend


async def test_file_names_in_headers_survive_unicode_and_quotes(env):
    (env.docs / 'ş "q".txt').write_text("x")
    res = await env.client.get("/api/fs/content", params={"provider": "pc", "path": str(env.docs / 'ş "q".txt')})
    assert "filename*=UTF-8''%C5%9F%20%22q%22.txt" in res.headers["content-disposition"] and '"' not in res.headers["content-disposition"].split('filename="')[1].split('"')[0]


# ---------------------------------------------------------------------------------------------- the desktop


async def test_grants_need_the_shell_token_and_open_exactly_what_was_dropped(env):
    outside = env.tmp / "dropped"
    outside.mkdir()
    (outside / "d.txt").write_text("dropped")
    assert (await env.client.get("/api/fs/list", params={"provider": "pc", "path": str(outside)})).status_code == 403
    assert (await env.client.post("/api/fs/grants", json={"paths": [str(outside / "d.txt")]})).status_code == 403
    assert (await env.client.post("/api/fs/grants", json={"paths": [str(outside / "d.txt")]}, headers={"X-OpenDex-Shell": "wrong"})).status_code == 403
    token = (env.tmp / "shell-token").read_text().strip()
    res = await env.client.post("/api/fs/grants", json={"paths": [str(outside / "d.txt")]}, headers={"X-OpenDex-Shell": token})
    assert res.status_code == 200 and res.json()["items"][0]["name"] == "d.txt"
    assert (await env.client.get("/api/fs/stat", params={"provider": "pc", "path": str(outside / "d.txt")})).status_code == 200
    assert (await env.client.get("/api/fs/stat", params={"provider": "pc", "path": str(outside)})).status_code == 403   # not the folder
    assert oct((env.tmp / "shell-token").stat().st_mode & 0o777) == oct(0o600)


async def test_open_refuses_programs(env, monkeypatch):
    opened = []
    monkeypatch.setattr("app.fs.service._open_default", lambda p: opened.append(p))
    (env.docs / "doc.txt").write_text("x")
    (env.docs / "run.exe").write_bytes(b"MZ")
    assert (await env.client.post("/api/fs/open", json={"location": {"provider": "pc", "path": str(env.docs / "doc.txt")}})).status_code == 200
    res = await env.client.post("/api/fs/open", json={"location": {"provider": "pc", "path": str(env.docs / "run.exe")}})
    assert res.status_code == 403 and res.json()["code"] == "permission"
    assert [p.name for p in opened] == ["doc.txt"]


async def test_the_feature_can_be_switched_off(env):
    env.ctx.settings.FS_ENABLED = False
    assert (await env.client.get("/api/fs/places")).status_code == 404


async def test_a_dropped_device_wakes_a_parked_transfer_through_the_event_bus(env):
    called = []
    env.ctx.fs.engine.device_online = called.append
    await env.ctx.event_bus.emit("device_reconnected", android_id="x")
    await asyncio.sleep(0.05)
    assert called == ["SER1"]
