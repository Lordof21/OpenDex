"""The Battery page's real numbers: what the phone's battery IS (health, capacity, cycles), what it is DOING (who charges
it, how fast, how long until full), and how it feels (temperature, protection) — from the daemon's `battery_health` facts.

Rules this module keeps (the page used to show invented placeholders — "68 %", "4.12 V", "48 dakika"):

* A figure is shown only when the phone reported it or it follows by arithmetic from what it reported. Missing → the key is
  absent/None and the page shows "—". Nothing is defaulted.
* A figure that is DERIVED rather than reported says so (`estimated`), and says from what (`source`).
* A reading that looks like a driver constant is not trusted: a fuel gauge that reports "full == design" to the unit is
  repeating the rating, not measuring the cell (MediaTek's MT6375 does) — the health is then estimated from the charge
  counter instead, or left out.

The daemon returns FACTS with units (see Battery.health on the phone); this file decides what they mean. It is pure
(`build_report`) except for `BatteryHealthService`, which reads the daemon, remembers the session's starting point and smooths
the current.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

# --- thresholds (documented where they are used) ---
SLOW_PORT_W = 7.5          # a port that can supply less than this charges a phone slowly (a PC's USB 2.0: 2.5 W, USB 3.x: 4.5 W)
BATTERY_WARM_C = 40.0      # chargers start to back off here (the platform's own charging-throttle region)
BATTERY_HOT_C = 45.0       # Android stops charging around here
SOC_WARM_C = 70.0
SOC_HOT_C = 85.0
MIN_ETA_CURRENT_MA = 50.0  # below this the quotient is noise (a topped-up battery trickles; a ten-hour "ETA" helps nobody)
MAX_ETA_MIN = 48 * 60
CURRENT_EMA_ALPHA = 0.3    # the current jumps with every DeX frame; the ETA must not
MIN_SESSION_MIN = 1.0
HEALTH_PLAUSIBLE = (0.30, 1.20)   # full ÷ design outside this is a unit mix-up, not a worn battery
LIMIT_EXCEEDED_RATIO = 1.3        # measured charge above port limit x this: the limit is a default, not the charger's
FAST_CHARGE_W = 15.0              # the battery takes at least this much: a fast charger, whatever it calls itself
DESIGN_IMPOSSIBLE_RATIO = 1.1    # charge now ÷ design above this cannot be a real rating (a cell is never fuller than ~full)
ESTIMATE_LEVEL_RANGE = (15, 98)  # the charge counter ÷ level estimate is only as good as the level's rounding allows

_STATUS = {2: "charging", 3: "discharging", 4: "not_charging", 5: "full"}
# BatteryManager.CHARGING_POLICY_*: 1 default, 2 adaptive (always-on), 3 adaptive (AC), 4 adaptive (long life)
_ANDROID_POLICY = {2: "adaptive", 3: "adaptive", 4: "long_life"}
_VENDOR_PROTECT_KEYS = ("battery.health.optimise", "battery.health", "night.charge")


def _pos(facts: dict[str, Any], key: str) -> float | None:
    value = facts.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None


def _level(facts: dict[str, Any]) -> float | None:
    value = facts.get("level")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 100 else None


def current_ua(raw: Any) -> float | None:
    """BatteryManager's CURRENT_NOW is µA by contract, but some vendors report mA: a magnitude below 20 000 can only be mA for
    a battery that is charging or being used (20 000 µA = 20 mA — a phone mirroring a screen never draws that little)."""
    if not isinstance(raw, (int, float)) or isinstance(raw, bool) or raw == 0:
        return None
    return float(raw) * 1000 if abs(raw) < 20_000 else float(raw)


def status_name(code: Any) -> str:
    return _STATUS.get(code, "unknown") if isinstance(code, int) else "unknown"


def charge_source(plugged: str | None, usb_type: str | None) -> str | None:
    """Who is charging: pc_port (a computer's port: SDP/CDP), adapter (a wall charger: AC/DCP), pd (negotiated fast charger),
    wireless, usb (a USB source of unknown class), None (nothing plugged)."""
    plugged = (plugged or "NONE").upper()
    usb = (usb_type or "").upper()
    if plugged == "NONE":
        return None
    if plugged == "WIRELESS":
        return "wireless"
    if usb in ("SDP", "CDP"):
        return "pc_port"
    if usb == "DCP":
        return "adapter"
    if usb.startswith("PD") or usb in ("PPS", "BRICK_ID", "FLOAT"):
        return "pd"
    if plugged == "AC":
        return "adapter"
    return "usb"


def capacity_block(facts: dict[str, Any]) -> dict[str, Any]:
    """{now_mah, full_mah, design_mah, full_source} — each None when unknown. `full_source`: gauge (the phone's own
    measurement of what the cell holds now) | estimate (charge counter ÷ level) | None."""
    level = _level(facts)
    counter = _pos(facts, "charge_counter_uah")
    now_mah = counter / 1000 if counter else None
    design = _pos(facts, "design_mah")
    if design is None:
        design_uah = _pos(facts, "charge_full_design_uah")
        design = design_uah / 1000 if design_uah else None
    if design and now_mah and now_mah > design * DESIGN_IMPOSSIBLE_RATIO:
        design = None            # the cell holds more than its "rating": the rating is a placeholder (Xiaomi's power profile says 1000 mAh)

    full, source = None, None
    gauge_full = _pos(facts, "charge_full_uah")
    if gauge_full and gauge_full == _pos(facts, "charge_full_design_uah"):
        gauge_full = None        # full == rating to the unit: the driver repeats the rating, it did not measure the cell
    if gauge_full:
        candidate = gauge_full / 1000
        if design is None or HEALTH_PLAUSIBLE[0] <= candidate / design <= HEALTH_PLAUSIBLE[1]:
            full, source = candidate, "gauge"
    if full is None and now_mah and level and ESTIMATE_LEVEL_RANGE[0] <= level <= ESTIMATE_LEVEL_RANGE[1]:
        candidate = now_mah / (level / 100)
        if design is None or HEALTH_PLAUSIBLE[0] <= candidate / design <= HEALTH_PLAUSIBLE[1]:
            full, source = candidate, "estimate"
    return {
        "now_mah": round(now_mah) if now_mah else None,
        "full_mah": round(full) if full else None,
        "design_mah": round(design) if design else None,
        "full_source": source,
    }


def health_block(facts: dict[str, Any], capacity: dict[str, Any]) -> dict[str, Any] | None:
    """{percent, source, estimated}: Android's own figure → the gauge's full/design pair → an estimate; None when nothing
    trustworthy exists. A pair that is equal to the unit is the driver repeating the rating, so it is skipped."""
    soh = _pos(facts, "soh_pct")
    if soh and soh <= 100:
        return {"percent": round(soh), "source": "android", "estimated": False}

    for full_key, design_key, source in (("charge_full_uah", "charge_full_design_uah", "gauge"), ("energy_full", "energy_full_design", "gauge")):
        full, design = _pos(facts, full_key), _pos(facts, design_key)
        if full and design and full != design and HEALTH_PLAUSIBLE[0] <= full / design <= HEALTH_PLAUSIBLE[1]:
            return {"percent": round(min(100.0, full / design * 100)), "source": source, "estimated": False}

    full, design = capacity["full_mah"], capacity["design_mah"]
    if capacity["full_source"] == "estimate" and full and design:
        return {"percent": round(min(100.0, full / design * 100)), "source": "estimate", "estimated": True}
    return None


def first_use_block(facts: dict[str, Any], now_ms: float) -> dict[str, Any] | None:
    at = _pos(facts, "first_use_ms")
    if not at or at > now_ms:
        return None
    return {"at_ms": int(at), "age_days": int((now_ms - at) // 86_400_000)}


def protection_block(facts: dict[str, Any]) -> dict[str, Any] | None:
    """What the phone says about charge protection. Reported as the SETTING (on/off), never as proof the limit is biting right
    now. Android 14+'s charging policy first (every vendor's own implementation answers it), then Xiaomi's flags."""
    policy = facts.get("charging_policy")
    if isinstance(policy, int) and policy in _ANDROID_POLICY:
        return {"on": True, "kind": "android", "policy": _ANDROID_POLICY[policy]}
    vendor = facts.get("vendor")
    if isinstance(vendor, dict) and any(k in vendor for k in _VENDOR_PROTECT_KEYS):
        on = vendor.get("battery.health.optimise") is True or vendor.get("battery.health") is True
        return {"on": on, "kind": "xiaomi", "night_charge": vendor.get("night.charge") is True}
    if isinstance(policy, int) and policy == 1:
        return {"on": False, "kind": "android", "policy": "default"}
    return None


def thermal_block(battery_c: float | None, soc_c: float | None, android_level: str | None, charging: bool) -> dict[str, Any]:
    """The battery and the SoC with the state each is in, and whether charging is probably being throttled."""
    def state(c: float | None, warm: float, hot: float) -> str | None:
        if c is None:
            return None
        return "hot" if c >= hot else "warm" if c >= warm else "ok"

    return {
        "battery_c": round(battery_c, 1) if battery_c is not None else None,
        "battery_state": state(battery_c, BATTERY_WARM_C, BATTERY_HOT_C),
        "soc_c": round(soc_c, 1) if soc_c is not None else None,
        "soc_state": state(soc_c, SOC_WARM_C, SOC_HOT_C),
        "android_level": android_level,       # the platform's own thermal status: none | light | moderate | severe | critical
        "charge_throttle_likely": bool(charging and battery_c is not None and battery_c >= BATTERY_WARM_C),
    }


def eta_block(direction: str | None, current_ma: float | None, capacity: dict[str, Any], level: float | None) -> dict[str, Any] | None:
    """Minutes until full (charging) / empty (discharging) at the CURRENT current — plain arithmetic, honestly approximate:
    charging slows near the top (the constant-voltage phase), so `tapers` says when the real time will run longer."""
    if direction is None or current_ma is None or current_ma < MIN_ETA_CURRENT_MA or level is None:
        return None
    now = capacity["now_mah"]
    full = capacity["full_mah"] or capacity["design_mah"]
    if direction == "in":
        if not now or not full or now >= full:
            return None
        minutes = (full - now) / current_ma * 60
        kind = "full"
    else:
        if not now:
            return None
        minutes = now / current_ma * 60
        kind = "empty"
    if minutes <= 0 or minutes > MAX_ETA_MIN:
        return None
    return {"minutes": int(round(minutes)), "kind": kind, "tapers": direction == "in" and level >= 80}


class BatteryJournal:
    """The session's starting point (what the battery gave/took since this phone was connected) and the smoothed current."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.reset()

    def reset(self) -> None:
        self._baseline: tuple[float, float, float | None] | None = None   # (t, level, charge counter µAh)
        self._ema_ua: float | None = None
        self._ema_direction: str | None = None

    def observe(self, level: float | None, counter_uah: float | None, direction: str | None, current_ua: float | None) -> None:
        if self._baseline is None and level is not None:
            self._baseline = (self._clock(), level, counter_uah)
        if direction != self._ema_direction:
            self._ema_ua, self._ema_direction = None, direction           # a flip charge↔discharge starts the average over
        if direction is not None and current_ua is not None:
            mag = abs(current_ua)
            self._ema_ua = mag if self._ema_ua is None else self._ema_ua + CURRENT_EMA_ALPHA * (mag - self._ema_ua)

    @property
    def current_ma(self) -> float | None:
        return self._ema_ua / 1000 if self._ema_ua is not None else None

    def session(self, level: float | None, counter_uah: float | None) -> dict[str, Any] | None:
        if self._baseline is None or level is None:
            return None
        t0, level0, counter0 = self._baseline
        minutes = (self._clock() - t0) / 60
        if minutes < MIN_SESSION_MIN:
            return None
        delta_mah = (counter_uah - counter0) / 1000 if counter_uah is not None and counter0 is not None else None
        return {"minutes": int(minutes), "delta_pct": int(round(level - level0)),
                "delta_mah": int(round(delta_mah)) if delta_mah is not None else None}


def build_report(
    facts: dict[str, Any],
    *,
    journal: BatteryJournal,
    now_ms: float,
    soc_c: float | None = None,
    android_thermal: str | None = None,
    limited: bool = False,
) -> dict[str, Any]:
    """The Battery page's whole state from the phone's facts. `limited`: the facts came from the old `battery_update` only."""
    level = _level(facts)
    status = status_name(facts.get("status"))
    plugged = str(facts.get("plugged") or "NONE").upper()
    voltage_v = (_pos(facts, "voltage_mv") or 0) / 1000 or None
    counter = _pos(facts, "charge_counter_uah")

    # Direction comes from the phone's status — vendors disagree on the sign of the current, not on whether it is charging.
    direction = "in" if status == "charging" else "out" if status == "discharging" else None
    journal.observe(level, counter, direction, current_ua(facts.get("current_ua")))
    current_ma = journal.current_ma

    capacity = capacity_block(facts)
    health = health_block(facts, capacity)
    source = charge_source(plugged, facts.get("usb_type"))
    limit_ma = (_pos(facts, "max_current_ua") or 0) / 1000 or None
    limit_v = (_pos(facts, "max_voltage_uv") or 0) / 1_000_000 or None
    limit_w = round(limit_ma / 1000 * limit_v, 1) if limit_ma and limit_v else None
    battery_w = round(current_ma / 1000 * voltage_v, 1) if current_ma is not None and voltage_v else None
    charging = status == "charging"
    usb_type = facts.get("usb_type")
    if direction == "in" and source is not None and current_ma is not None and (
        (limit_ma and current_ma > limit_ma * LIMIT_EXCEEDED_RATIO)
        or (limit_w and battery_w and battery_w > limit_w * LIMIT_EXCEEDED_RATIO)
    ):
        # The battery is taking more than the port's reported limit: the limit (and the USB class that came with it) is the
        # platform's default for a plain USB port - a vendor fast charger (Xiaomi HyperCharge, ...) never updates it. What was
        # measured wins over what was assumed, and the "slow port" verdict must not be drawn from a stale limit.
        limit_ma = limit_v = limit_w = None
        usb_type = None
        source = "fast" if battery_w is not None and battery_w >= FAST_CHARGE_W else "adapter"

    thermal = thermal_block(facts.get("temp_c"), soc_c, android_thermal, charging)
    protection = protection_block(facts)

    diagnoses: list[str] = []
    if source in ("pc_port", "usb", "adapter", "pd") and limit_w is not None and limit_w < SLOW_PORT_W and status != "full":
        diagnoses.append("slow_port" if source in ("pc_port", "usb") else "slow_adapter")
    if plugged != "NONE" and status == "discharging":
        diagnoses.append("draining_while_plugged")        # the charger gives less than the phone (mirroring + CPU) takes
    held_by_protection = bool(
        protection and protection["on"] and plugged != "NONE" and status == "not_charging" and level is not None and 80 <= level < 100
    )
    if held_by_protection:
        diagnoses.append("protection_holding")            # the phone stops here on purpose (battery-care limit)
    elif plugged != "NONE" and status == "not_charging" and level is not None and level < 100:
        diagnoses.append("charge_paused")                 # something else holds the charge (heat, the charger)
    if thermal["charge_throttle_likely"]:
        diagnoses.append("charge_throttled_hot")

    return {
        "ok": True,
        "limited": limited,                   # True: only the 5-second battery push was available (an old phone helper)
        "level": int(level) if level is not None else None,
        "status": status,
        "plugged": plugged.lower(),
        "technology": facts.get("technology"),
        "voltage_v": round(voltage_v, 2) if voltage_v else None,
        "capacity": capacity,
        "health": health,
        "cycles": int(facts["cycle_count"]) if _pos(facts, "cycle_count") else None,
        "first_use": first_use_block(facts, now_ms),
        "charging": {
            "source": source,
            "usb_type": usb_type,
            "direction": direction,
            "current_ma": round(current_ma) if current_ma is not None else None,
            "battery_w": battery_w,
            "limit_ma": round(limit_ma) if limit_ma else None,
            "limit_v": round(limit_v, 1) if limit_v else None,
            "limit_w": limit_w,
            "eta": eta_block(direction, current_ma, capacity, level),
        },
        "thermal": thermal,
        "protection": protection,
        "session": journal.session(level, counter),
        "diagnoses": diagnoses,
    }


def facts_from_battery_update(state: dict[str, Any]) -> dict[str, Any]:
    """The 5-second push (`battery_update`) in the facts' shape — for a phone helper that does not know `battery_health`."""
    facts: dict[str, Any] = {}
    if not isinstance(state, dict) or not state.get("ok", True):
        return facts
    for src, dst in (("level", "level"), ("status", "status"), ("voltage_mv", "voltage_mv"), ("technology", "technology")):
        if state.get(src) is not None:
            facts[dst] = state[src]
    facts["plugged"] = str(state.get("charging_type") or "NONE")
    temp = state.get("temperature_c")
    if isinstance(temp, (int, float)) and temp > 0:
        facts["temp_c"] = float(temp)
    return facts


class BatteryHealthService:
    """GET /api/device/battery/health: asks the daemon for the facts, adds the SoC's temperature and Android's thermal state,
    keeps the session ledger. One instance per backend; the ledger restarts when the phone changes."""

    def __init__(
        self,
        daemon_getter: Callable[[], Any],
        temps_getter: Callable[[], dict[str, float]] | None = None,
        thermal_level_getter: Callable[[], str | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._daemon_getter = daemon_getter
        self._temps = temps_getter or (lambda: {})
        self._thermal_level = thermal_level_getter or (lambda: None)
        self._wall = wall_clock
        self._journal = BatteryJournal(clock)
        self._serial: str | None = None

    def reset(self) -> None:
        self._journal.reset()
        self._serial = None

    async def report(self, serial: str | None = None) -> dict[str, Any]:
        if serial != self._serial:
            self._journal.reset()
            self._serial = serial
        daemon = self._daemon_getter()
        if daemon is None or not daemon.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}

        facts: dict[str, Any] = {}
        limited = True
        if daemon.supports("battery_health"):
            res = await daemon.battery_health()
            if isinstance(res, dict) and res.get("ok"):
                facts = {k: v for k, v in res.items() if k not in ("type", "ok")}
                limited = False
        if limited:
            facts = facts_from_battery_update(daemon.last_battery_state)
        if not facts:
            return {"ok": False, "error": "battery_unavailable"}

        temps = {}
        try:
            temps = self._temps() or {}
        except Exception:  # noqa: BLE001 — a missing SoC reading must not take the battery page down
            temps = {}
        soc = temps.get("soc")
        return build_report(
            facts, journal=self._journal, now_ms=self._wall() * 1000,
            soc_c=soc if isinstance(soc, (int, float)) else None,
            android_thermal=self._thermal_level(), limited=limited,
        )
