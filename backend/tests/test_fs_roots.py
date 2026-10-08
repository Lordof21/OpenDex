"""The PC allow-list: what may be browsed, and every way a path tries to leave it."""
import sys

import pytest

from app.fs.errors import FsError
from app.fs.models import normalize_phone_path
from app.fs.roots import RootRegistry


@pytest.fixture
def tree(tmp_path):
    home = tmp_path / "home"
    docs = home / "Documents"
    docs.mkdir(parents=True)
    (docs / "a.txt").write_text("a")
    (home / ".ssh").mkdir()
    (home / ".ssh" / "id_rsa").write_text("secret")
    (home / ".opendex").mkdir()
    (home / ".opendex" / "api-token").write_text("tok")
    (home / "private").mkdir()
    (home / "private" / "diary.txt").write_text("x")
    return home


def registry(home, **kw):
    return RootRegistry(home=home, known={"documents": home / "Documents"}, **kw)


def test_default_access_is_the_known_folders_only(tree):
    roots = registry(tree)
    assert roots.check(str(tree / "Documents" / "a.txt")) == tree / "Documents" / "a.txt"
    for outside in (tree / "private" / "diary.txt", tree, tree.parent):
        with pytest.raises(FsError) as err:
            roots.check(str(outside))
        assert err.value.code == "outside_roots"


def test_a_sibling_that_merely_shares_the_prefix_is_outside(tree):
    (tree / "Documents2").mkdir()
    roots = registry(tree)
    for sibling in (tree / "Documents2", tree / "Documents2" / "x"):
        with pytest.raises(FsError):
            roots.check(str(sibling))


def test_dotdot_cannot_climb_out(tree):
    roots = registry(tree)
    with pytest.raises(FsError):
        roots.check(str(tree / "Documents" / ".." / "private" / "diary.txt"))


def test_relative_and_nul_paths_are_refused(tree):
    roots = registry(tree)
    for raw in ("Documents/a.txt", "", "a\x00b"):
        with pytest.raises(FsError) as err:
            roots.check(raw)
        assert err.value.code == "bad_request"


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation needs privileges on Windows")
def test_a_symlink_inside_a_root_cannot_lead_out(tree):
    link = tree / "Documents" / "sneak"
    link.symlink_to(tree / "private", target_is_directory=True)
    roots = registry(tree)
    with pytest.raises(FsError) as err:
        roots.check(str(link / "diary.txt"))
    assert err.value.code == "outside_roots"
    with pytest.raises(FsError):
        roots.check(str(link))                                   # following the link lands outside
    # …but the link itself can be deleted/renamed: only its parent is resolved
    assert roots.check(str(link), follow_leaf=False) == link


def test_home_access_opens_the_profile_but_the_deny_list_stays_closed(tree):
    roots = registry(tree, access="home")
    assert roots.check(str(tree / "private" / "diary.txt"))
    for secret in (tree / ".ssh" / "id_rsa", tree / ".opendex" / "api-token", tree / ".opendex"):
        with pytest.raises(FsError) as err:
            roots.check(str(secret))
        assert err.value.code == "outside_roots"


def test_all_access_still_honours_the_deny_list(tree):
    roots = registry(tree, access="all")
    assert roots.check(str(tree / "private"))
    with pytest.raises(FsError):
        roots.check(str(tree / ".opendex" / "api-token"))


def test_extra_deny_paths_win_over_a_grant(tree, tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    roots = registry(tree, deny=[vault])
    with pytest.raises(FsError):
        roots.grant("g1", vault)
    with pytest.raises(FsError):
        roots.add_custom(vault)


def test_custom_roots_and_grants(tree, tmp_path):
    extra = tmp_path / "projects"
    extra.mkdir()
    (extra / "p.txt").write_text("p")
    roots = registry(tree)
    with pytest.raises(FsError):
        roots.check(str(extra / "p.txt"))
    roots.add_custom(extra)
    assert roots.check(str(extra / "p.txt"))
    assert roots.remove_custom(extra) is True
    with pytest.raises(FsError):
        roots.check(str(extra / "p.txt"))
    roots.grant("drop-1", extra / "p.txt")
    assert roots.check(str(extra / "p.txt"))
    with pytest.raises(FsError):
        roots.check(str(extra / "other.txt"))                    # a granted FILE does not open its folder


def test_grants_expire(tree, tmp_path):
    now = [0.0]
    roots = RootRegistry(home=tree, known={}, clock=lambda: now[0])
    f = tmp_path / "f.txt"
    f.write_text("x")
    roots.grant("g", f)
    assert roots.check(str(f))
    now[0] = 9 * 3600
    with pytest.raises(FsError):
        roots.check(str(f))


def test_root_folders_are_flagged_so_they_cannot_be_deleted(tree):
    roots = registry(tree)
    assert roots.is_root(tree / "Documents")
    assert not roots.is_root(tree / "Documents" / "a.txt")


def test_places_lists_only_existing_roots(tree):
    kinds = {p.kind for p in registry(tree).places()}
    assert kinds == {"documents"}
    kinds = {p.kind for p in registry(tree, access="home").places()}
    assert kinds == {"home", "documents"}


@pytest.mark.parametrize(
    "raw, ok",
    [
        ("/sdcard/DCIM/Camera", True),
        ("/sdcard", True),
        ("/storage/emulated/0/Download", True),
        ("/storage/1234-ABCD/Music", True),
        ("/data/local/tmp/x", True),
        ("/sdcard/../data/data/com.x", False),
        ("/sdcardx/evil", False),
        ("/storagex/evil", False),
        ("/data/local/tmpx", False),
        ("/data/data/com.x", False),
        ("/proc/self/environ", False),
        ("/", False),
        ("sdcard/x", False),
    ],
)
def test_phone_paths_are_normalised_and_confined(raw, ok):
    if ok:
        assert normalize_phone_path(raw).startswith("/")
    else:
        with pytest.raises(FsError):
            normalize_phone_path(raw)


def test_phone_path_rejects_line_breaks_that_would_start_a_second_daemon_command():
    for raw in ("/sdcard/a\nping", "/sdcard/a\rb"):
        with pytest.raises(FsError):
            normalize_phone_path(raw)
