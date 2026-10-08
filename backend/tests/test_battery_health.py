"""The Battery page's numbers (device/battery_health.py), built from the phone's facts — the figures below are the ones a
POCO X7 Pro (MediaTek MT6375, HyperOS) reported, plugged into a PC's USB port at 80 %."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from app.device import battery_health as bh
from app.main import create_app

FIRST_USE_MS = 1_758_535_122_427                      # 2025-09-22
NOW_MS = FIRST_USE_MS + 14 * 86_400_000 + 3_600_000   # 14 days and an hour later

POCO = {
    "level": 80, "status": 2, "plugged": "USB", "voltage_mv": 4221, "temp_c": 33.8, "technology": "Li-poly",
    "max_current_ua": 500_000, "max_voltage_uv": 5_000_000, "charge_counter_uah": 4_431_000,
    "current_ua": 500_000, "usb_type": "SDP", "design_mah": 6000, "first_use_ms": FIRST_USE_MS,
    "energy_full": 56573, "energy_full_design": 56573,           # the gauge repeating its rating
    "vendor": {"battery.health.optimise": True, "battery.health": True, "night.charge": True},
}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def report(facts, journal=None, **kw):
    return bh.build_report(facts, journal=journal or bh.BatteryJournal(Clock()), now_ms=NOW_MS, **kw)


# --------------------------------------------------------------------------- the phone as it was measured

def test_the_poco_x7_pro_at_80_percent_on_a_pc_port():
    r = report(POCO, soc_c=41.0, android_thermal="none")
    assert (r["level"], r["status"], r["plugged"], r["technology"]) == (80, "charging", "usb", "Li-poly")
    assert r["voltage_v"] == 4.22

    # capacity: the rating comes from the power profile; what the cell holds NOW is measured by the charge counter, and
    # what it holds when FULL follows from that and the level (the gauge only repeats its rating, so it is not believed)
    assert r["capacity"] == {"now_mah": 4431, "full_mah": 5539, "design_mah": 6000, "full_source": "estimate"}
    assert r["health"] == {"percent": 92, "source": "estimate", "estimated": True}
    assert r["cycles"] is None                               # this phone does not report one: shown as "—", not 0
    assert r["first_use"] == {"at_ms": FIRST_USE_MS, "age_days": 14}

    c = r["charging"]
    assert (c["source"], c["usb_type"], c["direction"]) == ("pc_port", "SDP", "in")
    assert (c["limit_ma"], c["limit_v"], c["limit_w"]) == (500, 5.0, 2.5)        # 5 V × 0.5 A: what the port may supply
    assert (c["current_ma"], c["battery_w"]) == (500, 2.1)                       # what actually flows into the cell
    # (5539 − 4431) mAh at 500 mA = 2 h 13 min — and it will run longer: charging slows past 80 %
    assert c["eta"] == {"minutes": 133, "kind": "full", "tapers": True}

    assert r["thermal"] == {
        "battery_c": 33.8, "battery_state": "ok", "soc_c": 41.0, "soc_state": "ok", "android_level": "none",
        "charge_throttle_likely": False,
    }
    assert r["protection"] == {"on": True, "kind": "xiaomi", "night_charge": True}
    assert r["diagnoses"] == ["slow_port"]
    assert r["limited"] is False and r["session"] is None


# --------------------------------------------------------------------------- health: who is believed

def test_androids_own_health_figure_beats_everything_else():
    r = report({**POCO, "soh_pct": 97})
    assert r["health"] == {"percent": 97, "source": "android", "estimated": False}


def test_a_gauge_that_measures_its_full_capacity_is_believed_when_it_differs_from_the_rating():
    r = report({**POCO, "charge_full_uah": 5_400_000, "charge_full_design_uah": 6_000_000})
    assert r["health"] == {"percent": 90, "source": "gauge", "estimated": False}
    assert r["capacity"]["full_mah"] == 5400 and r["capacity"]["full_source"] == "gauge"


def test_a_gauge_reporting_full_equal_to_design_is_a_rating_not_a_measurement():
    facts = {**POCO, "charge_full_uah": 6_000_000, "charge_full_design_uah": 6_000_000}
    assert report(facts)["health"]["source"] == "estimate"
    # and with no counter to estimate from there is no health at all — never a confident 100 %
    nothing = {k: v for k, v in facts.items() if k not in ("charge_counter_uah",)}
    assert report(nothing)["health"] is None


def test_a_full_figure_that_is_a_unit_mixup_is_not_used():
    # a gauge in the wrong unit: "full" is a thousandth of the rating
    r = report({**POCO, "charge_full_uah": 6_000, "charge_full_design_uah": 6_000_000})
    assert r["health"]["source"] == "estimate"
    assert r["capacity"]["full_source"] == "estimate"


def test_a_cell_that_holds_half_again_its_rating_is_a_unit_mixup_too():
    r = report({**POCO, "charge_full_uah": 9_000_000, "charge_full_design_uah": 6_000_000})
    assert r["health"]["source"] == "estimate" and r["capacity"]["full_source"] == "estimate"
    # a new cell a few percent ABOVE its rating is normal and believed
    ok = report({**POCO, "charge_full_uah": 6_200_000, "charge_full_design_uah": 6_000_000})
    assert ok["health"] == {"percent": 100, "source": "gauge", "estimated": False}      # capped: a battery is not "103 % healthy"


@pytest.mark.parametrize("level", [5, 14, 99, 100])
def test_the_estimate_is_only_made_where_the_level_is_precise_enough(level):
    r = report({**POCO, "level": level})
    assert r["capacity"]["full_mah"] is None and r["health"] is None


def test_an_estimate_that_makes_no_sense_against_the_rating_is_dropped():
    r = report({**POCO, "charge_counter_uah": 900_000})     # 900 mAh at 80 % → "1125 mAh battery" of a 6000 mAh phone
    assert r["capacity"]["full_mah"] is None and r["health"] is None
    assert r["capacity"]["now_mah"] == 900                  # the measured part is still shown


def test_without_a_rating_the_estimate_still_gives_the_full_capacity_but_no_percentage():
    r = report({k: v for k, v in POCO.items() if k != "design_mah"})
    assert r["capacity"]["full_mah"] == 5539 and r["capacity"]["design_mah"] is None
    assert r["health"] is None


def test_the_rating_can_come_from_the_gauge_when_there_is_no_power_profile():
    facts = {k: v for k, v in POCO.items() if k != "design_mah"}
    r = report({**facts, "charge_full_design_uah": 6_000_000})
    assert r["capacity"]["design_mah"] == 6000


# --------------------------------------------------------------------------- the charger

@pytest.mark.parametrize("plugged,usb,expected", [
    ("NONE", None, None), ("USB", "SDP", "pc_port"), ("USB", "CDP", "pc_port"), ("USB", "DCP", "adapter"),
    ("AC", None, "adapter"), ("AC", "DCP", "adapter"), ("USB", "PD", "pd"), ("USB", "PD_DRP", "pd"),
    ("WIRELESS", None, "wireless"), ("USB", None, "usb"), ("USB", "Weird", "usb"),
])
def test_who_is_charging(plugged, usb, expected):
    assert bh.charge_source(plugged, usb) == expected


def test_a_fast_adapter_is_not_called_slow():
    r = report({**POCO, "plugged": "AC", "usb_type": "PD", "max_current_ua": 3_000_000, "max_voltage_uv": 9_000_000, "current_ua": 3_000_000})
    assert r["charging"]["limit_w"] == 27.0 and r["charging"]["source"] == "pd"
    assert r["diagnoses"] == []


def test_a_slow_wall_adapter_is_named_for_what_it_is():
    r = report({**POCO, "plugged": "AC", "usb_type": "DCP", "max_current_ua": 1_000_000})
    assert r["diagnoses"] == ["slow_adapter"]


def test_a_charged_phone_on_a_slow_port_is_not_nagged():
    assert report({**POCO, "status": 5, "level": 100})["diagnoses"] == []


def test_plugged_in_but_draining_is_said_out_loud():
    r = report({**POCO, "status": 3, "current_ua": -300_000})
    assert "draining_while_plugged" in r["diagnoses"]
    assert (r["charging"]["direction"], r["charging"]["current_ma"]) == ("out", 300)
    assert r["charging"]["eta"]["kind"] == "empty"


def test_a_paused_charge_below_100_is_reported():
    plain = {k: v for k, v in POCO.items() if k != "vendor"}          # no protection feature to blame
    assert "charge_paused" in report({**plain, "status": 4})["diagnoses"]
    assert "charge_paused" not in report({**plain, "status": 4, "level": 100})["diagnoses"]


def test_a_hot_battery_while_charging_throttles_and_says_so():
    r = report({**POCO, "temp_c": 41.5})
    assert r["thermal"]["battery_state"] == "warm" and r["thermal"]["charge_throttle_likely"] is True
    assert "charge_throttled_hot" in r["diagnoses"]
    assert report({**POCO, "temp_c": 46.0})["thermal"]["battery_state"] == "hot"
    # hot but not charging: nothing is being throttled
    cool = report({**POCO, "temp_c": 41.5, "status": 3})
    assert cool["thermal"]["charge_throttle_likely"] is False and "charge_throttled_hot" not in cool["diagnoses"]


def test_the_soc_has_its_own_thresholds():
    assert report(POCO, soc_c=72.0)["thermal"]["soc_state"] == "warm"
    assert report(POCO, soc_c=90.0)["thermal"]["soc_state"] == "hot"
    assert report(POCO)["thermal"]["soc_c"] is None


def test_the_current_is_in_micro_amps_unless_the_vendor_says_milli():
    assert bh.current_ua(500_000) == 500_000
    assert bh.current_ua(-1_200_000) == -1_200_000
    assert bh.current_ua(500) == 500_000                    # a vendor that reports mA
    assert bh.current_ua(0) is None and bh.current_ua(None) is None and bh.current_ua(True) is None


# --------------------------------------------------------------------------- the ETA

def _cap(now, full, design=6000):
    return {"now_mah": now, "full_mah": full, "design_mah": design, "full_source": "gauge"}


def test_eta_arithmetic_and_its_refusals():
    assert bh.eta_block("in", 500, _cap(4431, 6000), 80) == {"minutes": 188, "kind": "full", "tapers": True}    # 1569 mAh ÷ 500 mA
    assert bh.eta_block("in", 500, _cap(2000, 6000), 33)["tapers"] is False
    assert bh.eta_block("out", 300, _cap(3000, 6000), 50) == {"minutes": 600, "kind": "empty", "tapers": False}
    assert bh.eta_block("in", 10, _cap(4431, 6000), 80) is None                 # a trickle: the quotient is noise
    assert bh.eta_block(None, 500, _cap(4431, 6000), 80) is None                # full / paused: no direction
    assert bh.eta_block("in", None, _cap(4431, 6000), 80) is None
    assert bh.eta_block("in", 500, _cap(6000, 6000), 100) is None               # nothing left to charge
    assert bh.eta_block("in", 60, _cap(1000, 6000), 16) is None                 # 83 hours is not an estimate anyone should read
    # no measured full capacity: the rating stands in
    assert bh.eta_block("in", 500, _cap(4431, None), 80)["minutes"] == 188


# --------------------------------------------------------------------------- protection

def test_protection_as_the_phone_reports_it():
    assert bh.protection_block({"charging_policy": 4}) == {"on": True, "kind": "android", "policy": "long_life"}
    assert bh.protection_block({"charging_policy": 3}) == {"on": True, "kind": "android", "policy": "adaptive"}
    assert bh.protection_block({"charging_policy": 1}) == {"on": False, "kind": "android", "policy": "default"}
    assert bh.protection_block({"vendor": {"battery.health.optimise": False, "battery.health": False}}) == {
        "on": False, "kind": "xiaomi", "night_charge": False}
    assert bh.protection_block({}) is None                  # a phone that says nothing: no badge, no guess
    # Android's own policy outranks a vendor flag
    assert bh.protection_block({"charging_policy": 4, "vendor": {"battery.health": False}})["kind"] == "android"


def test_a_protected_phone_that_holds_its_charge_is_explained_not_called_a_fault():
    r = report({**POCO, "level": 82, "status": 4})
    assert "protection_holding" in r["diagnoses"] and "charge_paused" not in r["diagnoses"]
    low = report({**POCO, "level": 60, "status": 4})["diagnoses"]
    assert "protection_holding" not in low and "charge_paused" in low        # 60 %: the care limit is not why
    assert "protection_holding" not in report({**POCO, "status": 5, "level": 100})["diagnoses"]     # simply full


# --------------------------------------------------------------------------- the session and the smoothed current

def test_the_session_balance_and_the_smoothing():
    clock = Clock()
    journal = bh.BatteryJournal(clock)
    report({**POCO, "level": 65, "charge_counter_uah": 3_600_000}, journal)
    assert journal.session(65, 3_600_000) is None            # not even a minute yet: nothing worth saying
    clock.t += 2 * 3600
    r = report({**POCO, "level": 80, "charge_counter_uah": 4_500_000}, journal)
    assert r["session"] == {"minutes": 120, "delta_pct": 15, "delta_mah": 900}


def test_the_current_is_smoothed_and_restarts_when_the_direction_flips():
    journal = bh.BatteryJournal(Clock())
    for ua in (500_000, 500_000, 800_000):
        journal.observe(80, None, "in", ua)
    assert 500 < journal.current_ma < 800                    # a spike moves it, but not all the way
    journal.observe(80, None, "out", 300_000)
    assert journal.current_ma == 300                         # charging history is not averaged into discharging
    journal.observe(80, None, None, 300_000)
    assert journal.current_ma is None                        # full / paused: no direction, no figure


def test_a_session_without_a_counter_still_gives_the_percentage():
    clock = Clock()
    journal = bh.BatteryJournal(clock)
    journal.observe(50, None, None, None)
    clock.t += 600
    assert journal.session(55, None) == {"minutes": 10, "delta_pct": 5, "delta_mah": None}


# --------------------------------------------------------------------------- the service

class FakeDaemon:
    def __init__(self, *, connected=True, caps=("battery_health",), facts=None, push=None):
        self.is_connected = connected
        self._caps = caps
        self.facts = facts
        self.last_battery_state = push or {"ok": False}
        self.battery_health = AsyncMock(side_effect=lambda: self.facts)

    def supports(self, cap):
        return self.is_connected and cap in self._caps


def service(daemon, **kw):
    return bh.BatteryHealthService(lambda: daemon, wall_clock=lambda: NOW_MS / 1000, clock=Clock(), **kw)


def test_the_service_builds_the_page_from_the_daemons_facts_and_the_soc_reading():
    daemon = FakeDaemon(facts={"type": "battery_health", "ok": True, **POCO})
    svc = service(daemon, temps_getter=lambda: {"soc": 41.0, "gpu": 40.0}, thermal_level_getter=lambda: "none")
    r = asyncio.run(svc.report("SER"))
    assert r["ok"] and r["limited"] is False and r["health"]["percent"] == 92
    assert r["thermal"]["soc_c"] == 41.0 and r["thermal"]["android_level"] == "none"
    assert "type" not in r


def test_an_old_phone_helper_still_gets_a_page_built_from_the_five_second_push_and_is_told_so():
    push = {"ok": True, "level": 61, "status": 3, "voltage_mv": 3900, "temperature_c": 35.0, "charging_type": "NONE", "technology": "Li-ion"}
    daemon = FakeDaemon(caps=(), push=push)
    r = asyncio.run(service(daemon).report("SER"))
    assert r["limited"] is True and (r["level"], r["status"]) == (61, "discharging")
    assert r["capacity"]["now_mah"] is None and r["health"] is None and r["charging"]["eta"] is None   # nothing invented
    assert r["thermal"]["battery_c"] == 35.0
    daemon.battery_health.assert_not_awaited()


def test_a_daemon_that_fails_the_command_falls_back_to_the_push():
    daemon = FakeDaemon(facts=None, push={"ok": True, "level": 50, "status": 2, "charging_type": "AC"})
    r = asyncio.run(service(daemon).report("SER"))
    assert r["limited"] is True and r["plugged"] == "ac"


def test_no_daemon_and_no_data_are_errors_not_empty_pages():
    assert asyncio.run(service(FakeDaemon(connected=False)).report("S")) == {"ok": False, "error": "daemon_not_connected"}
    assert asyncio.run(service(None).report("S")) == {"ok": False, "error": "daemon_not_connected"}
    assert asyncio.run(service(FakeDaemon(caps=())).report("S")) == {"ok": False, "error": "battery_unavailable"}


def test_a_broken_soc_reading_does_not_take_the_page_down():
    def boom():
        raise RuntimeError("thermal HAL gone")

    daemon = FakeDaemon(facts={"ok": True, **POCO})
    r = asyncio.run(service(daemon, temps_getter=boom).report("SER"))
    assert r["ok"] and r["thermal"]["soc_c"] is None


def test_the_session_starts_over_with_a_different_phone():
    daemon = FakeDaemon(facts={"ok": True, **POCO})
    clock = Clock()
    svc = bh.BatteryHealthService(lambda: daemon, wall_clock=lambda: NOW_MS / 1000, clock=clock)
    asyncio.run(svc.report("A"))
    clock.t += 600
    assert asyncio.run(svc.report("A"))["session"] is not None
    assert asyncio.run(svc.report("B"))["session"] is None


# --------------------------------------------------------------------------- the endpoint

def test_the_endpoint_serves_the_report_and_needs_a_phone():
    client = TestClient(create_app())
    assert client.get("/api/device/battery/health").status_code == 409            # no phone bound
    ctx = client.app.state.ctx
    ctx.serial = "SER"
    ctx.battery_health = SimpleNamespace(report=AsyncMock(return_value={"ok": True, "level": 80}))
    res = client.get("/api/device/battery/health")
    assert res.status_code == 200 and res.json() == {"ok": True, "level": 80}
    ctx.battery_health.report.assert_awaited_once_with("SER")


def test_the_client_asks_only_a_phone_that_knows_the_command():
    from app.device.device_daemon_client import DeviceDaemonClient

    client = DeviceDaemonClient(MagicMock(), MagicMock())
    assert asyncio.run(client.battery_health()) is None                           # not connected / no capability: no RPC
