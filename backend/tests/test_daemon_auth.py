"""The daemon's key: HMAC challenge-response and the per-install key file (0600, shell-safe by construction)."""
import hashlib
import hmac
import os
import stat
import sys

import pytest

from app import main as main_module
from app.config import Settings
from app.device import daemon_auth
from app.storage.private_file import write_private

POSIX_MODES = pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")


NS = "00ff" * 8   # a server (daemon) nonce
NC = "a1b2" * 8   # a client (backend) nonce


def test_hmac_primitive_matches_the_published_sha256_vector():
    # The fixed HMAC-SHA256 test vector (key "key"): any implementation must give this.
    assert daemon_auth._hmac_hex("key", "The quick brown fox jumps over the lazy dog") == (
        "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    )


def test_the_client_answer_is_an_hmac_over_the_role_and_the_servers_nonce():
    key = "ab" * 32
    assert daemon_auth.client_answer(key, NS) == hmac.new(key.encode(), f"client|{NS}".encode(), hashlib.sha256).hexdigest()


def test_the_server_proof_is_an_hmac_over_the_role_and_both_nonces_in_order():
    key = "ab" * 32
    assert daemon_auth.server_proof(key, NC, NS) == hmac.new(key.encode(), f"server|{NC}|{NS}".encode(), hashlib.sha256).hexdigest()


def test_the_answer_line_is_auth_answer_and_the_clients_nonce_without_a_line_break():
    line = daemon_auth.answer_line("ab" * 32, NS, NC)
    assert line == f"auth {daemon_auth.client_answer('ab' * 32, NS)} {NC}" and "\n" not in line and len(line) == 5 + 64 + 1 + 32


def test_answers_depend_on_both_the_key_and_the_nonce():
    base = daemon_auth.client_answer("ab" * 32, NS)
    assert daemon_auth.client_answer("cd" * 32, NS) != base and daemon_auth.client_answer("ab" * 32, "n" + NS[1:]) != base


def test_the_two_roles_cannot_stand_in_for_each_other():
    """A recorded client answer must not pass as a daemon proof, nor the reverse — and swapping the nonces changes it."""
    key = "ab" * 32
    assert daemon_auth.client_answer(key, NS) != daemon_auth.server_proof(key, NC, NS)
    assert daemon_auth.server_proof(key, NC, NS) != daemon_auth.server_proof(key, NS, NC)
    assert daemon_auth.server_proof(key, NC, NS) != daemon_auth.server_proof(key, daemon_auth.new_nonce(), NS), "a recorded greeting is worthless on the next connection"


def test_the_proof_check_accepts_only_the_right_proof():
    key = "ab" * 32
    good = daemon_auth.server_proof(key, NC, NS)
    assert daemon_auth.proof_is_valid(key, NC, NS, good)
    for bad in (None, "", 7, good[:-1], good.upper(), daemon_auth.server_proof("cd" * 32, NC, NS), daemon_auth.client_answer(key, NS)):
        assert not daemon_auth.proof_is_valid(key, NC, NS, bad), bad
    assert not daemon_auth.proof_is_valid(key, NC, "f" * 32, good), "a proof for another server nonce"


@pytest.mark.parametrize("nonce", ["0" * 16, "ab" * 16, "f" * 64])
def test_nonces_are_lowercase_hex_of_16_to_64_characters(nonce):
    assert daemon_auth.is_nonce(nonce)


@pytest.mark.parametrize("nonce", [None, 7, "", "abc", "0" * 15, "0" * 65, "AB" * 16, "g" * 32, "ab|cd" + "0" * 16, "ab cd" + "0" * 16, "ab\n" + "0" * 30])
def test_anything_else_is_not_a_nonce_so_it_can_never_carry_a_delimiter(nonce):
    assert not daemon_auth.is_nonce(nonce)


def test_new_nonces_are_valid_and_different():
    a, b = daemon_auth.new_nonce(), daemon_auth.new_nonce()
    assert daemon_auth.is_nonce(a) and a != b


def test_the_key_never_appears_in_either_side_of_the_exchange():
    key = "ab" * 32
    assert key not in daemon_auth.answer_line(key, NS, NC) and key not in daemon_auth.server_proof(key, NC, NS)


@pytest.mark.parametrize("good", ["ab" * 32, "0123456789abcdef" * 4])
def test_valid_keys_are_64_lowercase_hex(good):
    assert daemon_auth.is_valid_token(good)


@pytest.mark.parametrize(
    "bad",
    ["", "ab" * 31, "ab" * 33, "AB" * 32, "g" * 64, "ab" * 32 + "\n", "ab; reboot" + "0" * 54, " " + "a" * 63, None, 7],
)
def test_anything_else_is_not_a_key_and_therefore_never_reaches_a_command_line(bad):
    assert not daemon_auth.is_valid_token(bad)


def test_a_new_key_is_valid_and_different_each_time():
    a, b = daemon_auth.new_token(), daemon_auth.new_token()
    assert daemon_auth.is_valid_token(a) and a != b


def test_the_key_file_is_created_and_then_reused(tmp_path):
    path = tmp_path / "sub" / "daemon-token"
    first = daemon_auth.load_or_create_token(path)
    assert daemon_auth.is_valid_token(first) and path.read_text().strip() == first
    assert daemon_auth.load_or_create_token(path) == first, "the same key survives restarts (a running daemon keeps accepting it)"


@POSIX_MODES
def test_the_key_file_is_private_from_its_first_byte(tmp_path):
    path = tmp_path / "daemon-token"
    daemon_auth.load_or_create_token(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.parametrize("damaged", ["", "short", "not hex " * 10, "AB" * 32, "ab" * 32 + " ; reboot"])
def test_a_damaged_or_unsafe_key_file_is_replaced_not_trusted(tmp_path, damaged):
    path = tmp_path / "daemon-token"
    path.write_text(damaged)
    key = daemon_auth.load_or_create_token(path)
    assert daemon_auth.is_valid_token(key) and path.read_text().strip() == key


def test_an_unwritable_location_raises_oserror_for_the_caller_to_handle(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    with pytest.raises(OSError):
        daemon_auth.load_or_create_token(blocker / "daemon-token")


@POSIX_MODES
def test_write_private_narrows_a_world_readable_file(tmp_path):
    path = tmp_path / "secret"
    path.write_text("old")
    os.chmod(path, 0o644)
    write_private(path, "new")
    assert path.read_text() == "new\n" and stat.S_IMODE(path.stat().st_mode) == 0o600


def test_the_backend_still_starts_when_the_key_file_cannot_be_used(tmp_path, caplog):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert main_module._load_daemon_token(Settings(DAEMON_TOKEN_FILE=blocker / "daemon-token")) is None
    assert "adb" in caplog.text, "and says what that means: shell commands keep going through adb"


def test_the_key_file_is_a_different_file_from_the_api_token():
    settings = Settings()
    assert settings.DAEMON_TOKEN_FILE != settings.API_TOKEN_FILE and settings.DAEMON_TOKEN_FILE.name == "daemon-token"


def test_create_app_hands_the_key_to_the_daemon_client_and_wires_it_as_the_shell_transport(tmp_path):
    settings = Settings(DAEMON_TOKEN_FILE=tmp_path / "daemon-token")
    app = main_module.create_app(settings)
    ctx = app.state.ctx
    key = (tmp_path / "daemon-token").read_text().strip()

    assert daemon_auth.is_valid_token(key) and ctx.daemon_client._token == key
    assert ctx.adb._shell_transport is ctx.daemon_client, "the first stop of every shell command is the daemon"
    assert key not in ctx.settings.model_dump_json() and key != app.state.api_token


def test_the_way_back_to_plain_adb_is_one_setting(tmp_path):
    """OPENDEX_DAEMON_SHELL=false: nothing is attached, so every shell command runs on adb as it did before."""
    ctx = main_module.create_app(Settings(DAEMON_TOKEN_FILE=tmp_path / "daemon-token", DAEMON_SHELL=False)).state.ctx
    assert ctx.adb._shell_transport is None
    assert ctx.daemon_client._token is not None, "the daemon's socket stays protected either way"
