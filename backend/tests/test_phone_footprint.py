"""Telefon izleri (device/phone_footprint.py): OpenDeX'in telefonda değiştirdiği genel ayarların listesi, kullanıcının seçimi
("auto" OpenDeX yönetsin / "system" telefonun varsayılanı) ve canlı okuma."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.device import phone_footprint as fp
from app.device.phone_footprint import PhoneFootprint
from app.windows.transition_gate import TransitionGate


def _read_output(global_lines: list[str], secure_lines: list[str], usb_lines: list[str] | None = None) -> str:
    sep = f"\n{fp._SEPARATOR}\n"
    return sep.join(["\n".join(global_lines), "\n".join(secure_lines), "\n".join(usb_lines or [])])


class _Adb:
    def __init__(self, read_output: str = "") -> None:
        self.read_output = read_output
        self.commands: list[str] = []

    async def shell(self, command: str, serial: str | None = None, timeout_s: float | None = None) -> str:
        self.commands.append(command)
        return self.read_output if command.startswith("settings list") else ""


def _footprint(adb: _Adb, *, xiaomi: bool = True, serial: str | None = "SER", **kwargs) -> PhoneFootprint:
    async def is_xiaomi(_adb, _serial):
        return xiaomi

    async def settings():
        return SimpleNamespace(phone_footprint={}, usb_stability_guard=True, multi_audio_focus_policy="ask")

    return PhoneFootprint(adb, lambda: serial, settings, is_xiaomi=is_xiaomi, **kwargs)


def _settings(policy: dict[str, str] | None = None, **extra) -> SimpleNamespace:
    return SimpleNamespace(phone_footprint=policy or {}, usb_stability_guard=extra.get("usb", True),
                           multi_audio_focus_policy=extra.get("focus", "ask"))


def test_a_saved_choice_is_normalized_unknown_ids_dropped_and_missing_ones_auto():
    policy = fp.normalize_policy({"caption": "system", "stay_awake": "bogus", "not_an_item": "system"})
    assert policy["caption"] == "system"
    assert policy["stay_awake"] == "auto"
    assert "not_an_item" not in policy
    assert set(policy) == set(fp.OWN_POLICY_IDS)


def test_the_bind_script_writes_what_opendex_manages_and_only_clears_its_own_value_elsewhere():
    auto = fp.bind_script(fp.normalize_policy(None), fp.BIND_ITEMS)
    assert "settings put global enable_freeform_support 1" in auto
    assert "settings put global force_resizable_activities 1" in auto
    assert "cmd window set-ignore-orientation-request false" in auto

    system = fp.bind_script(fp.normalize_policy({"freeform_support": "system"}), fp.BIND_ITEMS)
    assert "settings put global enable_freeform_support" not in system
    # Removed only while it is still OpenDeX's value: a value the user set themselves stays.
    assert '[ "$(settings get global enable_freeform_support)" = "1" ] && settings delete global enable_freeform_support' in system
    assert system.endswith("true")


def test_the_workspace_script_resets_the_multi_window_config_when_handed_back():
    script = fp.bind_script(fp.normalize_policy({"non_resizable_multi_window": "system"}), fp.WORKSPACE_ITEMS)
    assert "wm reset-multi-window-config" in script
    assert "wm set-multi-window-config" not in script
    assert "settings put global force_resizable_activities 1" in script      # the other Workspace item is still managed


@pytest.mark.parametrize(
    ("item_id", "values", "expected"),
    [
        ("stay_awake", {"global/stay_on_while_plugged_in": "7"}, "held"),
        ("stay_awake", {"global/stay_on_while_plugged_in": "0"}, "default"),
        ("stay_awake", {}, "default"),
        ("stay_awake", {"global/stay_on_while_plugged_in": "2"}, "custom"),
        ("freeform_support", {"global/enable_freeform_support": "1"}, "ours"),
        ("freeform_support", {}, "default"),
        ("resizable_apps", {"global/force_resizable_activities": "1"}, "ours"),          # the stray secure copy is optional
        ("display_defaults", {"global/force_desktop_mode_on_external_displays": "0", "global/overlay_display_devices": "none"}, "default"),
        ("transition_animation", {"global/transition_animation_scale": "0.5"}, "custom"),
    ],
)
def test_the_state_of_an_item_follows_the_phone_value(item_id, values, expected):
    assert fp.knob_state(fp.ITEMS_BY_ID[item_id], values) == expected


@pytest.mark.asyncio
async def test_a_snapshot_reads_the_phone_once_and_reports_values_original_and_counts():
    adb = _Adb(_read_output(
        ["stay_on_while_plugged_in=7", "opendex_stay_on_original=0", "enable_freeform_support=1", "transition_animation_scale=1.0"],
        ["disable_decoration_dot=1", "opendex_decoration_dot_original=unset"],
        ["  current_functions=mtp", "  connected=false"],
    ))
    footprint = _footprint(adb, multi_focus_snapshot=lambda: {"state": "on", "owner": "phone"})
    snap = await footprint.snapshot()

    assert [c for c in adb.commands if c.startswith("settings list")] == [fp.read_script()]
    items = {item["id"]: item for item in snap["items"]}
    assert snap["connected"] is True and snap["read"] is True
    assert items["stay_awake"]["state"] == "held" and items["stay_awake"]["original"] == "0"
    assert items["caption"]["state"] == "held" and items["caption"]["original"] == "unset"
    assert items["freeform_support"]["state"] == "ours"
    assert items["transition_animation"]["state"] == "default"
    assert items["usb_guard"]["state"] == "custom"           # MTP left on: lock/unlock would restart adbd
    assert items["multi_audio_focus"]["state"] == "custom"   # the phone had it on itself
    assert snap["active"] == sum(1 for item in snap["items"] if item["state"] in ("held", "ours"))


@pytest.mark.asyncio
async def test_the_caption_item_does_not_apply_to_a_phone_that_is_not_xiaomi():
    footprint = _footprint(_Adb(_read_output([], [])), xiaomi=False)
    items = {item["id"]: item for item in (await footprint.snapshot())["items"]}
    assert items["caption"]["applicable"] is False and items["caption"]["state"] == "unsupported"


@pytest.mark.asyncio
async def test_without_a_phone_the_choices_are_listed_and_nothing_is_read():
    adb = _Adb()
    snap = await _footprint(adb, serial=None).snapshot()
    assert snap["connected"] is False and snap["read"] is False
    assert all(item["state"] == "unknown" for item in snap["items"] if item["kind"] != "policy")
    assert adb.commands == []


@pytest.mark.asyncio
async def test_handing_a_persistent_item_back_removes_opendex_value_at_once():
    adb = _Adb()
    footprint = _footprint(adb)
    changed = await footprint.on_settings_saved(_settings({"freeform_support": "system"}))
    assert changed == ["freeform_support"]
    assert not footprint.allows("freeform_support")
    assert len(adb.commands) == 1 and "settings delete global enable_freeform_support" in adb.commands[0]

    adb.commands.clear()
    await footprint.on_settings_saved(_settings({"freeform_support": "auto"}))
    assert "settings put global enable_freeform_support 1" in adb.commands[0]


@pytest.mark.asyncio
async def test_a_lease_choice_makes_the_leases_re_decide_and_the_animation_gate_is_released():
    adb = _Adb()
    calls: list[str] = []

    async def release():
        calls.append("release")

    footprint = _footprint(adb, on_lease_policy=lambda: calls.append("leases"), transition_release=release)
    await footprint.on_settings_saved(_settings({"caption": "system", "transition_animation": "system"}))
    assert calls == ["leases", "release"]
    assert adb.commands == []                       # leases give their own value back; nothing persistent changed


@pytest.mark.asyncio
async def test_saving_unrelated_settings_touches_nothing():
    adb = _Adb()
    footprint = _footprint(adb)
    assert await footprint.on_settings_saved(_settings()) == []
    assert adb.commands == []


@pytest.mark.asyncio
async def test_the_usb_and_multi_focus_items_follow_their_own_settings():
    footprint = _footprint(_Adb(), serial=None)
    await footprint.on_settings_saved(_settings(usb=False, focus="never"))
    items = {item["id"]: item for item in (await footprint.snapshot(read=False))["items"]}
    assert items["usb_guard"]["policy"] == "system"
    assert items["multi_audio_focus"]["policy"] == "system"


@pytest.mark.asyncio
async def test_the_transition_gate_never_engages_when_the_animation_is_left_to_the_phone():
    adb = _Adb()
    gate = TransitionGate(adb, serial_getter=lambda: "SER", tail_s=0.0, allowed=lambda: False)
    async with gate.hold():
        pass
    assert adb.commands == [] and gate.engaged is False


# ── telefondaki değeri elle aç / kapat ─────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_turning_a_lease_off_writes_the_saved_original_back_or_removes_the_key():
    adb = _Adb()
    footprint = _footprint(adb)
    await footprint.set_live("stay_awake", False)
    command = adb.commands[0]
    # The user's own value (kept by the lease) is written back and the backup dropped; without a backup the key goes.
    assert 'o=$(settings get global opendex_stay_on_original)' in command
    assert 'settings put global stay_on_while_plugged_in "$o"' in command
    assert "settings delete global opendex_stay_on_original" in command
    assert "else settings delete global stay_on_while_plugged_in; fi" in command


@pytest.mark.asyncio
async def test_turning_a_persistent_item_on_and_off_writes_and_removes_it_whoever_manages_it():
    adb = _Adb()
    footprint = _footprint(adb)
    await footprint.on_settings_saved(_settings({"non_resizable_multi_window": "system"}))
    adb.commands.clear()

    await footprint.set_live("non_resizable_multi_window", True)
    assert "settings put global enable_non_resizable_multi_window 1" in adb.commands[0]
    assert "wm set-multi-window-config" in adb.commands[0]

    await footprint.set_live("non_resizable_multi_window", False)
    off = [c for c in adb.commands if "settings delete global enable_non_resizable_multi_window" in c]
    assert off and "wm reset-multi-window-config" in off[0]
    assert footprint.policy["non_resizable_multi_window"] == "system"     # the switch does not change who manages it


@pytest.mark.asyncio
async def test_turning_the_animation_off_uses_the_gate_marker_or_the_android_default():
    adb = _Adb()
    await _footprint(adb).set_live("transition_animation", False)
    command = adb.commands[0]
    assert "f=/data/local/tmp/opendex-transition-scale" in command and "rm -f $f" in command
    assert 'elif [ "$(settings get global transition_animation_scale)" = "0" ]; then settings put global transition_animation_scale 1.0' in command


@pytest.mark.asyncio
async def test_multi_app_sound_is_switched_through_its_own_service():
    calls: list[bool] = []

    async def setter(on: bool):
        calls.append(on)

    footprint = _footprint(_Adb(), multi_focus_set=setter, multi_focus_snapshot=lambda: {"state": "off", "can_set": True})
    snap = await footprint.set_live("multi_audio_focus", True)
    assert calls == [True]
    assert {i["id"]: i for i in snap["items"]}["multi_audio_focus"]["toggleable"] is True


@pytest.mark.asyncio
async def test_items_that_cannot_be_switched_refuse_and_unknown_ids_or_a_missing_phone_are_errors():
    footprint = _footprint(_Adb())
    with pytest.raises(ValueError):
        await footprint.set_live("usb_guard", False)
    with pytest.raises(ValueError):
        await footprint.set_live("display_defaults", False)
    with pytest.raises(KeyError):
        await footprint.set_live("nope", True)
    with pytest.raises(LookupError):
        await _footprint(_Adb(), serial=None).set_live("caption", True)
    items = {i["id"]: i for i in (await footprint.snapshot())["items"]}
    assert items["caption"]["toggleable"] is True and items["usb_guard"]["toggleable"] is False


@pytest.mark.asyncio
async def test_opendex_value_without_the_lease_backup_is_reported_as_left_behind():
    # Device 2026-10-29: no window open, stay_on 7 and decoration_dot 1 with no `opendex_*_original` — an earlier session's
    # value. A lease that holds a value always keeps the user's original first, so "held" needs that backup.
    adb = _Adb(_read_output(["stay_on_while_plugged_in=7"], ["disable_decoration_dot=1"]))
    snap = await _footprint(adb).snapshot()
    items = {item["id"]: item for item in snap["items"]}
    assert items["stay_awake"]["state"] == "leftover" and items["caption"]["state"] == "leftover"
    assert snap["active"] >= 2
