"""Phone panel metrics for the "phone_scale" mode."""
from unittest.mock import AsyncMock

import pytest

from app.device import android_shell
from app.device.capability_probe import CapabilityProbe
from app.schemas import DeviceProfile, ProjectSettings
from app.storage import settings_db


class Phone:
    def __init__(self, size="Physical size: 1080x2400", density="Physical density: 440"):
        self.size, self.density = size, density

    async def shell(self, cmd, serial=None, timeout_s=0):
        if cmd == "wm size":
            return self.size
        if cmd == "wm density":
            return self.density
        raise AssertionError(cmd)


def test_density_parsing_prefers_a_plausible_user_override():
    assert android_shell.parse_phone_density("Physical density: 440\nOverride density: 480") == 480
    assert android_shell.parse_phone_density("Physical density: 440\nOverride density: 200") == 440   # leaked VD value
    assert android_shell.parse_phone_density("garbage") is None


async def test_metrics_are_sorted_short_long_and_include_overrides():
    phone = Phone(size="Physical size: 1080x2400\nOverride size: 1440x3200", density="Physical density: 560")
    assert await android_shell.read_phone_metrics(phone, "S") == (1440, 3200, 560)


async def test_unreadable_metrics_are_none_never_a_fabricated_value():
    assert await android_shell.read_phone_metrics(Phone(density="error: no display"), "S") is None
    assert await android_shell.read_phone_metrics(Phone(size=""), "S") is None


async def test_refresh_updates_in_place_and_persists_only_a_change(monkeypatch):
    save = AsyncMock()
    monkeypatch.setattr(settings_db, "save_device_profile", save)
    probe = CapabilityProbe(Phone(), devices=None, settings=None)
    profile = DeviceProfile(android_id="aid", encoder_limit=8, android_api=34)

    assert await probe.refresh_phone_metrics("S", profile) is profile
    assert (profile.phone_width, profile.phone_height, profile.phone_density) == (1080, 2400, 440)
    save.assert_awaited_once()

    await probe.refresh_phone_metrics("S", profile)          # unchanged → no write
    save.assert_awaited_once()


def test_profile_and_settings_round_trip():
    profile = DeviceProfile(android_id="a", encoder_limit=8, android_api=34, phone_width=1080, phone_height=2400,
                            phone_density=440)
    assert DeviceProfile.model_validate_json(profile.model_dump_json()) == profile
    assert DeviceProfile.model_validate_json('{"android_id":"a","encoder_limit":8,"android_api":34}').phone_density is None
    assert ProjectSettings(resolution_mode="phone_scale").resolution_mode == "phone_scale"
    with pytest.raises(ValueError):
        ProjectSettings(resolution_mode="zoom")


# ---------------------------------------------------------------- the live reader (daemon first, shell fallback)
SNAPSHOT = {"type": "display_update", "ok": True, "id": 0, "density": 513, "physical_density": 520,
            "w": 1220, "h": 2712, "physical_w": 1220, "physical_h": 2712}


class _Daemon:
    is_connected = True
    daemon_capabilities = {"display_get"}

    def __init__(self, reply):
        self.reply, self.calls = reply, 0

    async def phone_display(self):
        self.calls += 1
        return self.reply


@pytest.fixture
def daemon(monkeypatch):
    from app.device import daemon_registry

    def install(reply):
        d = _Daemon(reply)
        monkeypatch.setattr(daemon_registry, "_client", d)
        return d

    monkeypatch.setattr(daemon_registry, "_client", None)
    return install


class _NoShell:
    async def shell(self, cmd, serial=None, timeout_s=0):
        raise AssertionError(f"the daemon answered — no shell command expected, got {cmd!r}")


async def test_the_daemon_read_is_used_and_carries_the_users_smallest_width(daemon):
    daemon(SNAPSHOT)
    display = await android_shell.read_phone_display(_NoShell(), "S")
    assert (display.density, display.physical_density, display.source) == (513, 520, "daemon")
    assert display.smallest_width_dp == 380
    assert await android_shell.phone_density(_NoShell(), "S") == 513


async def test_a_daemon_that_cannot_answer_falls_back_to_the_shell(daemon):
    d = daemon(None)  # an older jar / no reply
    phone = Phone(size="Physical size: 1220x2712", density="Physical density: 520\nOverride density: 513")
    display = await android_shell.read_phone_display(phone, "S")
    assert (display.density, display.source) == (513, "shell")
    assert d.calls == 1


async def test_without_a_daemon_the_shell_is_read(daemon):
    phone = Phone(density="Physical density: 520\nOverride density: 513")
    assert await android_shell.phone_density(phone, "S") == 513


async def test_nothing_readable_is_none_never_a_made_up_density(daemon):
    assert await android_shell.phone_density(Phone(density="error: no display"), "S") is None
    daemon(None)
    assert await android_shell.phone_density(Phone(density=""), "S") is None


def test_a_leaked_virtual_display_override_is_not_the_phones_density():
    leaked = dict(SNAPSHOT, density=180)
    assert android_shell.phone_display_from_snapshot(leaked).density == 520
    assert android_shell.parse_phone_density("Physical density: 520\nOverride density: 180") == 520


@pytest.mark.parametrize("bad", [None, {}, {"ok": False}, dict(SNAPSHOT, w=0), dict(SNAPSHOT, density="x"), {"ok": True}])
def test_unusable_snapshots_are_rejected(bad):
    assert android_shell.phone_display_from_snapshot(bad) is None


async def test_the_daemons_push_updates_the_profile_and_tells_the_frontend(monkeypatch):
    """The user changes smallest width while OpenDeX is connected: the daemon pushes it and the profile ("Telefon ölçeği")
    follows at once — it used to stay stale until the next reconnect."""
    from types import SimpleNamespace

    from app.main import AppContext

    saved = []
    monkeypatch.setattr(settings_db, "save_device_profile", AsyncMock(side_effect=lambda *a: saved.append(a)))
    profile = DeviceProfile(android_id="A", encoder_limit=4, android_api=34, phone_width=1220, phone_height=2712, phone_density=520)
    emitted = []

    async def emit(name, **payload):
        emitted.append((name, payload))

    probe = CapabilityProbe(None, None, None)
    ctx = SimpleNamespace(
        window_manager=SimpleNamespace(profile=profile), capability_probe=probe, event_bus=SimpleNamespace(emit=emit),
    )
    await AppContext._on_phone_display_changed(ctx, SNAPSHOT)
    assert profile.phone_density == 513
    assert emitted and emitted[0][0] == "device_profile_changed"
    assert emitted[0][1]["profile"]["phone_density"] == 513
    assert len(saved) == 1

    emitted.clear()
    await AppContext._on_phone_display_changed(ctx, SNAPSHOT)  # the same value again: nothing to tell
    assert emitted == [] and len(saved) == 1
