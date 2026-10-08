"""daemon_wire against replies the REAL Java service produced (tests/fixtures/fs_daemon_replies.json), and the fake daemon
the other fs tests rely on against the same replies — a fake that drifts from the real service would make every test
that uses it worthless.

The fixture is regenerated from a JVM running FsService (java/test/.../FsHarness.java)."""
import json
from pathlib import Path

import pytest

from app.fs import daemon_wire as wire
from app.fs.errors import FsError
from tests.fs_fakes import FakeDevice, FakeFsDaemon

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "fs_daemon_replies.json").read_text(encoding="utf-8"))
ROOT = "/storage/emulated/0"


def reply(name):
    return GOLDEN[name]["request_reply"]


def test_a_list_page_parses_into_entries_and_a_cursor():
    page = reply("list_first_page")
    entries = [wire.parse_item(raw) for raw in page["items"]]
    assert [e.name for e in entries] == [".hidden", "Sub"]
    assert entries[0].hidden and not entries[0].symlink and entries[0].size == 1 and entries[0].mtime == 1_650_000_000
    assert entries[1].kind == "dir" and entries[1].size == 0
    assert wire.unb64(page["next"]) == "Sub"
    assert wire.check(page)["path"] == f"{ROOT}/Golden"
    rest = [wire.parse_item(raw) for raw in reply("list_next_page")["items"]]
    assert [e.name for e in rest] == ["a.jpg", "link-to-sub"] and reply("list_next_page")["next"] is not None


def test_the_whole_listing_has_every_kind_of_entry():
    entries = {e.name: e for e in map(wire.parse_item, reply("list_all")["items"])}
    assert set(entries) == {".hidden", "Sub", "a.jpg", "link-to-sub", "ş ö.txt"}
    assert entries["link-to-sub"].symlink and entries["link-to-sub"].kind == "dir" and entries["link-to-sub"].link_target == f"{ROOT}/Golden/Sub"
    assert reply("list_all")["next"] is None


@pytest.mark.parametrize(
    "case, code",
    [("list_missing", "not_found"), ("list_outside", "outside_roots"), ("list_not_a_dir", "not_a_dir"), ("stat_missing", "not_found"),
     ("mkdir_exists", "exists"), ("rename_exists", "exists"), ("rename_protected", "permission"), ("delete_protected", "permission"),
     ("thumb_unsupported", "unsupported"), ("bad_request", "bad_request")],
)
def test_every_refusal_becomes_the_matching_error_code(case, code):
    with pytest.raises(FsError) as err:
        wire.check(reply(case), "/some/path")
    assert err.value.code == code and err.value.path == "/some/path"


def test_an_unknown_error_word_is_io_not_a_crash():
    with pytest.raises(FsError) as err:
        wire.check({"ok": False, "error": "something_new", "detail": "x"})
    assert err.value.code == "io"
    assert reply("unknown_command")["error"] == "unknown_command"               # the one the provider falls back on


def test_stat_stat_many_and_roots():
    link = wire.parse_item(reply("stat_link")["item"])
    assert link.symlink and link.kind == "dir"
    items = reply("stat_many")["items"]
    assert [None if i is None else wire.parse_item(i).name for i in items] == ["a.jpg", None, "Sub"]
    places = wire.parse_roots(reply("roots"))
    assert [(p.kind, p.path) for p in places][0] == ("internal", ROOT)
    assert all(p.provider == "phone" and p.total and p.free for p in places)


def test_malformed_entries_are_an_error_not_a_crash():
    for bad in (None, [], ["only-a-name"], "x"):
        with pytest.raises(FsError):
            wire.parse_item(bad)


def shape(value):
    """The structure of a reply: key sets and value types, never the values."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__ if value is not None else "null"


@pytest.mark.asyncio
async def test_the_fake_daemon_answers_with_the_real_services_shapes():
    dev = FakeDevice()
    dev.add_file(f"{ROOT}/Golden/a.jpg", b"x" * 10)
    dev.add_file(f"{ROOT}/Golden/.hidden", b"h")
    dev.add_dir(f"{ROOT}/Golden/Sub")
    dev.add_link(f"{ROOT}/Golden/link-to-sub", f"{ROOT}/Golden/Sub")
    fake = FakeFsDaemon(dev)
    checks = {
        "list_first_page": wire.list_request(f"{ROOT}/Golden", None, 2),
        "list_missing": wire.list_request(f"{ROOT}/Nope", None, 10),
        "list_not_a_dir": wire.list_request(f"{ROOT}/Golden/a.jpg", None, 10),
        "stat_file": wire.stat_request(f"{ROOT}/Golden/a.jpg"),
        "stat_link": wire.stat_request(f"{ROOT}/Golden/link-to-sub"),
        "stat_missing": wire.stat_request(f"{ROOT}/Golden/ghost"),
        "stat_many": wire.stat_many_request([f"{ROOT}/Golden/a.jpg", f"{ROOT}/Golden/ghost", f"{ROOT}/Golden/Sub"]),
        "roots": wire.roots_request(),
    }
    for case, line in checks.items():
        got = await fake.fs_rpc(line)
        assert shape(got) == shape(reply(case)), f"{case}: the fake's reply shape drifted from the real service"
    assert (await fake.fs_rpc(checks["list_missing"]))["error"] == reply("list_missing")["error"]
    assert (await fake.fs_rpc(checks["list_not_a_dir"]))["error"] == reply("list_not_a_dir")["error"]
