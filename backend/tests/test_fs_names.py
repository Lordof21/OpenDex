"""File names: validation per platform, Windows-safe conversion, and "Keep both" numbering."""
import pytest

from app.fs.errors import FsError
from app.fs.names import (
    comparison_key,
    phone_safe_name,
    split_extension,
    unique_name,
    validate_name,
    windows_safe_name,
)


@pytest.mark.parametrize(
    "name, expected",
    [
        ("photo.jpg", ("photo", ".jpg")),
        (".bashrc", (".bashrc", "")),
        ("README", ("README", "")),
        ("archive.tar.gz", ("archive", ".tar.gz")),
        ("a.b.c", ("a.b", ".c")),
        (".tar.gz", (".tar", ".gz")),
    ],
)
def test_split_extension(name, expected):
    assert split_extension(name) == expected


@pytest.mark.parametrize("bad", ["", ".", "..", "a/b", "a\x00b", "x‮exe.jpg"])
def test_validate_rejects_universally_bad_names(bad):
    for windows in (True, False):
        with pytest.raises(FsError) as err:
            validate_name(bad, windows=windows)
        assert err.value.code == "invalid_name"


@pytest.mark.parametrize("bad", ['a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a|b', 'a\\b', "tab\there", "dot.", "space ", "CON", "con.txt", "NUL", "com1", "LPT9.log"])
def test_validate_rejects_windows_only_names(bad):
    with pytest.raises(FsError):
        validate_name(bad, windows=True)
    if "\\" not in bad:
        assert validate_name(bad, windows=False) == bad          # all legal on the phone


def test_phone_limit_is_bytes_windows_limit_is_utf16_units():
    name = "ş" * 128                                             # 128 chars, 256 UTF-8 bytes
    with pytest.raises(FsError):
        validate_name(name, windows=False)
    assert validate_name(name, windows=True) == name             # 128 UTF-16 units
    assert validate_name("a" * 255, windows=False)
    with pytest.raises(FsError):
        validate_name("a" * 256, windows=True)


@pytest.mark.parametrize(
    "name, expected",
    [
        ("IMG: 2024?.jpg", "IMG_ 2024_.jpg"),
        ("CON", "_CON"),
        ("aux.txt", "_aux.txt"),
        ("trailing. ", "trailing"),
        ("ok.txt", "ok.txt"),
        ("a‮b", "a_b"),
        ("...", "_"),
    ],
)
def test_windows_safe_name(name, expected):
    assert windows_safe_name(name) == expected
    assert validate_name(windows_safe_name(name), windows=True)
    assert windows_safe_name(windows_safe_name(name)) == windows_safe_name(name)    # idempotent


def test_windows_safe_name_shortens_but_keeps_the_extension():
    long = "x" * 400 + ".jpeg"
    safe = windows_safe_name(long)
    assert safe.endswith(".jpeg") and len(safe) == 255


def test_phone_safe_name_cuts_on_a_character_boundary():
    safe = phone_safe_name("ş" * 200 + ".png")
    assert len(safe.encode()) <= 255 and safe.endswith(".png")
    safe.encode("utf-8").decode("utf-8")                         # still valid UTF-8


def test_unique_name_numbers_and_continues_a_suffix():
    taken = {"a.txt", "a (2).txt"}
    assert unique_name("b.txt", taken, casefold=False) == "b.txt"
    assert unique_name("a.txt", taken, casefold=False) == "a (3).txt"
    assert unique_name("a (2).txt", taken, casefold=False) == "a (3).txt"          # continued, not "a (2) (2).txt"
    assert unique_name("x.tar.gz", {"x.tar.gz"}, casefold=False) == "x (2).tar.gz"
    assert unique_name(".env", {".env"}, casefold=False) == ".env (2)"


def test_unique_name_on_a_case_insensitive_destination():
    taken = {comparison_key("Photo.JPG", casefold=True)}
    assert unique_name("photo.jpg", taken, casefold=True) == "photo (2).jpg"
    assert unique_name("photo.jpg", {"Photo.JPG"}, casefold=False) == "photo.jpg"  # the phone: different file


def test_comparison_key_normalises_unicode_on_case_insensitive_targets():
    decomposed = "Café.txt"
    composed = "Café.txt"
    assert comparison_key(decomposed, casefold=True) == comparison_key(composed, casefold=True)
    assert comparison_key(decomposed, casefold=False) != comparison_key(composed, casefold=False)
