"""HyperOS freeform caption lease (device/freeform_caption.py): hidden only while wanted, the user's value given back."""
from __future__ import annotations

import asyncio
import subprocess

import pytest

from app.device import freeform_caption
from app.device.freeform_caption import ENGAGE_CMD, RELEASE_CMD, FreeformCaptionLease


class FakeAdb:
    """Runs the lease's commands against an in-memory `settings` table (the real `sh -c` logic is checked separately)."""

    def __init__(self, secure: dict[str, str] | None = None) -> None:
        self.secure: dict[str, str] = dict(secure or {})
        self.calls: list[str] = []

    async def shell(self, cmd: str, *, serial: str, timeout_s: float = 0) -> str:
        self.calls.append(cmd)
        original = self.secure.get(freeform_caption.ORIGINAL_KEY)
        if cmd == ENGAGE_CMD:
            if original is None:
                self.secure[freeform_caption.ORIGINAL_KEY] = self.secure.get(freeform_caption.SETTING, freeform_caption.UNSET)
            self.secure[freeform_caption.SETTING] = "1"
        elif cmd == RELEASE_CMD and original is not None:
            if original == freeform_caption.UNSET:
                self.secure.pop(freeform_caption.SETTING, None)
            else:
                self.secure[freeform_caption.SETTING] = original
            del self.secure[freeform_caption.ORIGINAL_KEY]
        return ""


def make(adb: FakeAdb, wanted: list[bool], *, xiaomi: bool = True) -> FreeformCaptionLease:
    async def want() -> bool:
        return wanted[0]

    async def is_xiaomi(_adb, _serial) -> bool:
        return xiaomi

    return FreeformCaptionLease(adb, lambda: "SER", want, is_xiaomi=is_xiaomi)


async def test_engages_with_windows_and_gives_back_an_unset_value() -> None:
    adb = FakeAdb()
    wanted = [True]
    lease = make(adb, wanted)
    await lease.sync()
    assert lease.engaged and adb.secure[freeform_caption.SETTING] == "1"
    assert adb.secure[freeform_caption.ORIGINAL_KEY] == freeform_caption.UNSET
    wanted[0] = False
    await lease.sync()
    assert not lease.engaged
    assert adb.secure == {}  # the setting did not exist before: deleted again, backup removed


async def test_users_own_value_is_restored() -> None:
    adb = FakeAdb({freeform_caption.SETTING: "0"})
    lease = make(adb, [True])
    await lease.sync()
    await lease.release("SER")
    assert adb.secure == {freeform_caption.SETTING: "0"}


async def test_crashed_session_backup_is_kept_and_restored_on_next_bind() -> None:
    # A previous session crashed while holding: the device still has 1 and the backup of the user's real value.
    adb = FakeAdb({freeform_caption.SETTING: "1", freeform_caption.ORIGINAL_KEY: "0"})
    lease = make(adb, [False])
    await lease.sync()
    assert adb.secure == {freeform_caption.SETTING: "0"}


async def test_engage_does_not_overwrite_a_crashed_sessions_backup() -> None:
    adb = FakeAdb({freeform_caption.SETTING: "1", freeform_caption.ORIGINAL_KEY: "0"})
    lease = make(adb, [True])
    await lease.sync()
    assert adb.secure[freeform_caption.ORIGINAL_KEY] == "0"  # not the leftover "1"
    await lease.release("SER")
    assert adb.secure == {freeform_caption.SETTING: "0"}


async def test_non_xiaomi_phone_is_never_touched() -> None:
    adb = FakeAdb()
    lease = make(adb, [True], xiaomi=False)
    await lease.sync()
    assert adb.calls == [] and not lease.engaged


async def test_request_sync_coalesces_and_ignores_event_payload() -> None:
    adb = FakeAdb()
    lease = make(adb, [True])
    lease.request_sync(window_id="w1", package="p")
    lease.request_sync()
    await asyncio.sleep(0.01)
    assert lease.engaged
    assert adb.calls.count(ENGAGE_CMD) == 1


async def test_release_when_not_engaged_sends_nothing() -> None:
    adb = FakeAdb()
    lease = make(adb, [False])
    await lease.release("SER")
    assert adb.calls == []


def _sh(probe_dir: Any) -> str | None:
    for candidate in ("sh", "bash", r"C:\Program Files\Git\bin\sh.exe"):
        try:
            # Rejects Windows' System32\bash.exe (WSL wrapper), which strips $vars and cannot see Windows paths.
            subprocess.run(
                [candidate, "-c", f'v=ok; [ "$v" = ok ] && [ -d "{probe_dir.as_posix()}" ]'],
                check=True, capture_output=True, timeout=5,
            )
            return candidate
        except Exception:  # noqa: BLE001
            continue
    return None


@pytest.mark.parametrize(
    ("before", "after_release"),
    [({}, {}), ({"disable_decoration_dot": "0"}, {"disable_decoration_dot": "0"})],
)
def test_shell_commands_round_trip_against_a_fake_settings_binary(tmp_path, before, after_release) -> None:
    """The real `sh -c` text: engage then release leaves the device exactly as it was (`settings` faked as a shell function
    over a directory of files, one per key)."""
    shell = _sh(tmp_path)
    if shell is None:
        pytest.skip("no POSIX shell")
    store = tmp_path / "store"
    store.mkdir()
    for key, value in before.items():
        (store / key).write_text(value)
    env_path = (
        f'S="{store.as_posix()}"; '
        'settings() { case $1 in '
        'get) if [ -f "$S/$3" ]; then cat "$S/$3"; else echo null; fi ;; '
        'put) printf %s "$4" > "$S/$3" ;; '
        'delete) rm -f "$S/$3" ;; '
        'esac; }; '
    )

    def state() -> dict[str, str]:
        return {p.name: p.read_text() for p in store.iterdir()}

    subprocess.run([shell, "-c", env_path + ENGAGE_CMD], check=True, timeout=10)
    assert state()["disable_decoration_dot"] == "1"
    assert state()["opendex_decoration_dot_original"] == before.get("disable_decoration_dot", "unset")
    subprocess.run([shell, "-c", env_path + ENGAGE_CMD], check=True, timeout=10)  # a second engage keeps the first backup
    assert state()["opendex_decoration_dot_original"] == before.get("disable_decoration_dot", "unset")
    subprocess.run([shell, "-c", env_path + RELEASE_CMD], check=True, timeout=10)
    assert state() == after_release
    subprocess.run([shell, "-c", env_path + RELEASE_CMD], check=True, timeout=10)  # release with no backup: no-op
    assert state() == after_release
