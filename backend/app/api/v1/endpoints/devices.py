"""Device lifecycle, status, and connection control endpoints."""
from __future__ import annotations

import contextlib
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Path
from pydantic import BaseModel, Field

from app.api.deps import ActiveSerialDep, AppContextDep, RequireDevice
from app.device import android_shell, bluetooth, wifi
from app.schemas import DeviceInfo, DeviceProfile, EncoderStressTestResult, KnownDeviceInfo
from app.storage import settings_db
from app.windows.window_manager import StressTestBusyError

log = logging.getLogger(__name__)
router = APIRouter()


class BindDeviceRequest(BaseModel):
    serial: str


@router.get("/devices", response_model=list[DeviceInfo])
async def get_devices(ctx: AppContextDep):
    """Lists currently detected ADB devices (USB and Wireless)."""
    if not ctx.serial:
        await ctx.ensure_device()
    try:
        return ctx.with_active(await ctx.device_manager.list_devices())
    except Exception as exc:
        log.warning("list_devices failed (adb missing or error): %s", exc)
        return []


@router.get("/devices/state")
async def get_device_state(ctx: AppContextDep):
    """The device list and the bound phone — the same payload every `devices_changed` event carries. The UI reads it
    once when its event stream (re)connects and follows the events from there (no polling). In memory: no adb run."""
    return ctx.device_state()


@router.get("/startup")
async def get_startup_state(ctx: AppContextDep):
    """Where bringing the phone up stands — device, the daemon's health check (attempt n of N), services — for the boot
    screen. In-memory: it asks neither adb nor the phone (startup_state.py)."""
    return ctx.startup.current.as_dict()


@router.get("/device/profile", response_model=DeviceProfile)
async def get_device_profile(ctx: AppContextDep):
    """Returns the bound device profile and encoder capabilities."""
    profile = ctx.window_manager.profile
    if profile is None:
        raise HTTPException(status_code=409, detail="Henüz bağlı bir cihaz yok.")
    return profile


@router.post("/device/encoder-stress-test", response_model=EncoderStressTestResult)
async def run_encoder_stress_test(ctx: AppContextDep):
    """Opt-in, manually-triggered empirical measurement of how many
    concurrent virtual-display/encoder sessions this device really supports
    (see WindowManager.run_encoder_stress_test's docstring)."""
    if ctx.serial is None or not ctx.window_manager.profile:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    try:
        return await ctx.window_manager.run_encoder_stress_test()
    except StressTestBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/device/unlock", dependencies=[RequireDevice])
async def unlock_device(ctx: AppContextDep):
    """Wakes the phone panel (through the display-power controller) and dismisses the keyguard."""
    await ctx.display_power.set(True, source="http:unlock")
    with contextlib.suppress(Exception):
        await ctx.adb.shell("wm dismiss-keyguard", serial=ctx.serial)
        await ctx.adb.shell("input keyevent 82", serial=ctx.serial)
    return {"ok": True}


@router.post("/device/disconnect")
async def disconnect_device(ctx: AppContextDep):
    """Disconnects the currently bound device and unbinds the session."""
    if ctx.serial is None:
        raise HTTPException(status_code=409, detail="Bağlı cihaz yok.")
    await ctx.unbind_device(disconnect_adb=True)
    return {"ok": True}


@router.post("/device/tcpip")
async def switch_device_tcpip(ctx: AppContextDep, port: int = 5555):
    """USB -> Wi-Fi (`adb tcpip`) with the open windows. `ok` only once the wireless link is VERIFIED and the session
    moved onto it; otherwise 502 and the session stays on USB (see AppContext.switch_to_tcpip)."""
    if ctx.serial is None:
        raise HTTPException(status_code=409, detail="Bağlı cihaz yok.")
    try:
        serial = await ctx.switch_to_tcpip(port)
    except Exception as exc:
        log.warning("[ADB Wireless] TCP/IP switch failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc) or "Kablosuz geçiş başarısız — USB kablosunu çıkarmayın.") from exc
    ip, _, port_str = serial.rpartition(":")
    return {
        "ok": True, "ip": ip, "port": int(port_str), "serial": serial,
        "message": f"🎉 Kablosuz bağlantı doğrulandı ({serial}) — USB kablosunu artık güvenle çıkarabilirsiniz.",
    }


@router.post("/device/bind")
async def bind_specific_device(body: BindDeviceRequest, ctx: AppContextDep):
    """Switches active OpenDeX connection to the specified device serial (USB or Wireless)."""
    if ctx.serial == body.serial:
        return {"ok": True, "serial": body.serial, "message": "Zaten bu bağlantı aktif."}
    await ctx.switch_transport(body.serial)
    return {"ok": True, "serial": body.serial, "message": f"Aktif bağlantı {body.serial} olarak değiştirildi."}


@router.get("/devices/known", response_model=list[KnownDeviceInfo])
async def get_known_devices(ctx: AppContextDep):
    """Remembered devices for one-click reconnect (Cihaz Geçiş Planı §3), most
    recently seen first. ``discovered`` is computed fresh on every call from the
    passive mDNS listener — never a live probe, and never attributed unless
    there is exactly one paired candidate and at least one live advert (an
    mDNS advert does not carry android_id, so a real match can't be proven
    without connecting — see mdns_discovery.py and §3.2)."""
    known = await settings_db.get_known_devices()
    live_endpoints = ctx.mdns.get_live_connect_endpoints()
    paired = [d for d in known if d.wireless_debugging_paired]
    attribute_to = paired[0].android_id if (len(paired) == 1 and live_endpoints) else None

    result: list[KnownDeviceInfo] = []
    for device in known:
        info = KnownDeviceInfo(**device.model_dump())
        if attribute_to == device.android_id:
            ep = live_endpoints[0]
            info.discovered = True
            info.discovered_ip = ep.ip
            info.discovered_port = ep.port
        result.append(info)
    return result


@router.post("/devices/known/{android_id}/connect", response_model=DeviceInfo)
async def connect_known_device(android_id: str, ctx: AppContextDep):
    """Explicit, user-clicked reconnect to a remembered device (Cihaz Geçiş
    Planı §7.1 — this endpoint is the ONLY place a known device's `adb connect`
    ever happens; nothing calls it automatically)."""
    known = await settings_db.get_known_device(android_id)
    if not known:
        raise HTTPException(status_code=404, detail="Kayıtlı cihaz bulunamadı.")
    if known.last_transport == "usb":
        raise HTTPException(status_code=409, detail="Bu cihaz USB üzerinden bağlanır — kabloyu takın.")

    ip, port = known.last_known_ip, known.last_known_port
    if known.wireless_debugging_paired:
        live_endpoints = ctx.mdns.get_live_connect_endpoints()
        paired = [d for d in await settings_db.get_known_devices() if d.wireless_debugging_paired]
        if len(paired) == 1 and len(live_endpoints) == 1:
            # Prefer the just-resolved live port — Wireless Debugging's connect
            # port changes on every toggle cycle (§3.1-B), so a cached one may
            # already be stale even though the device is right here.
            ip, port = live_endpoints[0].ip, live_endpoints[0].port

    if not ip or not port:
        raise HTTPException(status_code=409, detail="IP/port bilgisi yok — Manuel IP sekmesinden bağlanın.")

    try:
        return await ctx.connect_and_activate(ip, port)
    except Exception as exc:
        log.warning("[KnownDevices] reconnect to %s (%s:%s) failed: %s", android_id, ip, port, exc)
        raise HTTPException(status_code=502, detail=f"Bağlantı başarısız: {exc}") from exc


@router.delete("/devices/known/{android_id}")
async def forget_known_device(android_id: str):
    """Removes a device from the remembered list (does not touch an active session)."""
    await settings_db.delete_known_device(android_id)
    return {"ok": True, "android_id": android_id}


class SetVolumeRequest(BaseModel):
    stream_id: int
    value: int | None = None
    volume: int | None = None


class SetStateRequest(BaseModel):
    key: str
    value: bool


class SetDisplayPowerRequest(BaseModel):
    on: bool


@router.get("/device/battery/health", dependencies=[RequireDevice])
async def get_battery_health(ctx: AppContextDep) -> dict:
    """The Battery page: health (%, capacity, cycles, first use), the charger (class, limits, real current, ETA), the
    temperatures with their state, charge-protection and what this session gave/took. Every figure is reported by the phone
    or derived from what it reported (`estimated` says so); a missing one is null — nothing is invented. `ok: false` +
    `error` when the phone cannot be read at all."""
    return await ctx.battery_health.report(ctx.serial)


@router.get("/device/battery", dependencies=[RequireDevice])
async def get_battery_info(ctx: AppContextDep):
    """Returns real-time battery level, charging status, voltage, and temperature."""
    if ctx.daemon_client and ctx.daemon_client.is_connected:
        return await ctx.daemon_client.get_battery_info()
    try:
        out = await ctx.adb.shell("dumpsys battery", serial=ctx.serial)
        level = 100
        is_charging = False
        charging_type = "NONE"
        temp_c = 0.0
        voltage_mv = 0
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("level:"):
                level = int(line.split(":")[1].strip())
            elif line.startswith("status:"):
                st = int(line.split(":")[1].strip())
                is_charging = st in (2, 5)
            elif line.startswith("temperature:"):
                temp_c = int(line.split(":")[1].strip()) / 10.0
            elif line.startswith("voltage:"):
                voltage_mv = int(line.split(":")[1].strip())
            elif "USB powered: true" in line:
                charging_type = "USB"
            elif "AC powered: true" in line:
                charging_type = "AC"
            elif "Wireless powered: true" in line:
                charging_type = "WIRELESS"
        return {
            "ok": True,
            "level": level,
            "is_charging": is_charging,
            "charging_type": charging_type,
            "temperature_c": temp_c,
            "voltage_mv": voltage_mv,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "level": 100, "is_charging": False}


@router.get("/device/volumes", dependencies=[RequireDevice])
async def get_device_volumes(ctx: AppContextDep):
    """Returns volume levels across all audio streams (Music, Ring, Notification, Alarm)."""
    if ctx.daemon_client and ctx.daemon_client.is_connected:
        res = await ctx.daemon_client.get_volumes()
        if res and res.get("ok") and res.get("streams"):
            return res
    # Direct ADB fallback
    try:
        streams = []
        stream_defs = [
            (3, "MUSIC", "Medya", 30),
            (2, "RING", "Zil Sesi", 15),
            (5, "NOTIFICATION", "Bildirim", 15),
            (4, "ALARM", "Alarm", 15),
        ]
        for sid, name, label, default_max in stream_defs:
            out = await ctx.adb.shell(f"cmd audio get-stream-volume {sid}", serial=ctx.serial)
            cur = 10
            if "->" in out:
                with contextlib.suppress(Exception):
                    cur = int(out.split("->")[1].strip())
            streams.append({
                "id": sid,
                "name": name,
                "label": label,
                "current": cur,
                "max": default_max,
                "min": 0,
                "muted": cur == 0,
            })
        return {"ok": True, "type": "volumes_update", "streams": streams}
    except Exception as exc:
        return {"ok": False, "streams": [], "error": str(exc)}


@router.post("/device/volumes", dependencies=[RequireDevice])
async def set_device_volume(body: SetVolumeRequest, ctx: AppContextDep):
    """Sets volume for a specific audio stream."""
    val = body.value if body.value is not None else (body.volume if body.volume is not None else 0)
    if await android_shell.set_stream_volume(ctx.adb, ctx.serial, ctx.daemon_client, body.stream_id, val):
        return {"ok": True, "stream_id": body.stream_id, "value": val}
    return {"ok": False}


async def _with_real_screen_state(ctx: AppContextDep, payload: dict) -> dict:
    """The daemon's `states_get` has no screen power and the ADB fallback used to fabricate `true`.
    Merge the controller's real reading (`None` = unknown) into a COPY (payload may be a shared cache)."""
    screen = await ctx.display_power.state()
    states = {**(payload.get("states") or {}), "screen_on": screen["on"]}
    return {**payload, "states": states, "screen_on": screen["on"]}


# The daemon's `states_get` reads the toggles in-process. When it cannot (it answers {ok: false, error}), adb answers — and
# `settings get` is a whole `app_process` start on the phone per key, so the fallback reads every key it needs from ONE
# `settings list global` and remembers the answer for a few seconds (the panel, the event stream's reconnect and a tile click
# can all ask within the same moment).
_STATES_SCRIPT = "settings list global | grep -E '^(wifi_on|bluetooth_on|mobile_data|mode_ringer|airplane_mode_on)='; true"
_STATES_FALLBACK_TTL_S = 3.0
_states_fallback: dict[str, tuple[float, dict[str, bool]]] = {}      # serial → (read at, states)
_states_errors_logged: set[str] = set()


def _remember_daemon_states_failure(res: object) -> None:
    """The daemon's own words for why `states_get` failed, once per distinct message (it used to be thrown away, which made
    a daemon that never answers look like a daemon that is fine)."""
    error = str(res.get("error") or "unknown") if isinstance(res, dict) else "no_reply"
    if error in _states_errors_logged or len(_states_errors_logged) >= 8:
        return
    _states_errors_logged.add(error)
    log.warning("[Devices] daemon durum okuyamadı (states_get: %s) — adb yedek yolu kullanılıyor (tek komut, %.0f sn önbellekli)",
                error[:200], _STATES_FALLBACK_TTL_S)


def _parse_states(out: str) -> dict[str, bool]:
    values: dict[str, str] = {}
    for line in out.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip()
    return {
        "wifi": values.get("wifi_on") == "1",
        "bluetooth": values.get("bluetooth_on") == "1",
        "mobile_data": values.get("mobile_data") == "1",
        "mute": values.get("mode_ringer") == "0",
        "airplane_mode": values.get("airplane_mode_on") == "1",
        "rotation_lock": False,
        "torch": False,
    }


@router.get("/device/states", dependencies=[RequireDevice])
async def get_hardware_states(ctx: AppContextDep):
    """Returns quick hardware toggle states (wifi, bluetooth, mobile_data, torch, mute, etc.)."""
    if ctx.daemon_client and ctx.daemon_client.is_connected:
        res = await ctx.daemon_client.get_hardware_states()
        if res and res.get("ok"):
            return await _with_real_screen_state(ctx, res)
        _remember_daemon_states_failure(res)
    # Direct ADB fallback
    try:
        serial = ctx.serial or ""
        cached = _states_fallback.get(serial)
        now = time.monotonic()
        if cached is not None and now - cached[0] < _STATES_FALLBACK_TTL_S:
            states = cached[1]
        else:
            states = _parse_states(await ctx.adb.shell(_STATES_SCRIPT, serial=ctx.serial))
            _states_fallback[serial] = (now, states)
        return await _with_real_screen_state(ctx, {"ok": True, "type": "states_update", "states": dict(states), **states})
    except Exception as exc:
        return {"ok": False, "states": {}, "error": str(exc)}


@router.post("/device/states", dependencies=[RequireDevice])
async def set_hardware_state(body: SetStateRequest, ctx: AppContextDep):
    """Toggles a hardware state."""
    _states_fallback.pop(ctx.serial or "", None)         # what the next read shows must be the phone's, not a 3-second-old copy
    done = await android_shell.set_hardware_state(ctx.adb, ctx.serial, ctx.daemon_client, body.key, body.value)
    _states_fallback.pop(ctx.serial or "", None)         # … also a read that started while the toggle was being applied
    return {"ok": True, "key": body.key, "value": body.value} if done else {"ok": False}


@router.get("/device/display-power", dependencies=[RequireDevice])
async def get_display_power(ctx: AppContextDep):
    """Real physical screen state: `on` is true/false, or null when it cannot be read (never guessed)."""
    return {"ok": True, **await ctx.display_power.state(fresh=True)}


@router.post("/device/display-power", dependencies=[RequireDevice])
async def set_display_power(body: SetDisplayPowerRequest, ctx: AppContextDep):
    """Sets the physical screen on/off (idempotent, verified). `on` in the reply is the REAL resulting state."""
    return await ctx.display_power.set(body.on, source="http:display-power")


# ---------------------------------------------------------------------------------------------------------------------
# Wi-Fi & Bluetooth detail pages
# ---------------------------------------------------------------------------------------------------------------------


class WifiConnectRequest(BaseModel):
    ssid: str = Field(min_length=1, max_length=64)
    security: Literal["open", "owe", "wpa2", "wpa3"] = "wpa2"
    # Never logged: Adb redacts `connect-network` arguments (adb.redact_command).
    password: str | None = Field(None, max_length=63)


@router.get("/device/wifi")
async def get_wifi(ctx: AppContextDep, serial: ActiveSerialDep):
    """{status: {enabled, connected, ssid, rssi, bars, tx/rx_mbps, band, frequency, standard, security, ip, gateway,
    mac, mac_randomized, network_id, …}, saved: [{network_id, ssid, security, kind}]}."""
    try:
        return await wifi.wifi_overview(ctx.adb, serial)
    except wifi.WifiUnavailable as exc:
        raise HTTPException(status_code=502, detail=f"Wi-Fi durumu okunamadı: {exc}") from exc


@router.get("/device/wifi/networks")
async def get_wifi_networks(ctx: AppContextDep, serial: ActiveSerialDep):
    """Results of the LAST scan — instant, shown while a fresh scan runs."""
    try:
        return {"networks": await wifi.wifi_scan_results(ctx.adb, serial)}
    except Exception as exc:  # noqa: BLE001 — AdbError / timeout
        raise HTTPException(status_code=502, detail=f"Tarama sonuçları okunamadı: {exc}") from exc


@router.post("/device/wifi/scan")
async def scan_wifi(ctx: AppContextDep, serial: ActiveSerialDep):
    """Starts a scan and returns its results (~3 s)."""
    try:
        return {"networks": await wifi.wifi_scan(ctx.adb, serial)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Wi-Fi taraması başarısız: {exc}") from exc


@router.post("/device/wifi/connect")
async def connect_wifi(body: WifiConnectRequest, ctx: AppContextDep, serial: ActiveSerialDep):
    """Joins (and saves) a network with `cmd wifi connect-network`. `state`: initiated | pending | failed — the page
    re-reads the status to see the association complete."""
    try:
        return await wifi.wifi_connect(ctx.adb, serial, body.ssid, body.security, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — AdbError carries the command already redacted
        raise HTTPException(status_code=502, detail=f"Bağlantı başlatılamadı: {exc}") from exc


@router.post("/device/wifi/saved/{network_id}/connect", dependencies=[RequireDevice])
async def connect_saved_wifi(ctx: AppContextDep, network_id: int = Path(ge=0)):
    """Joins a saved network WITHOUT its passphrase (daemon: WifiManager.connect(netId) as the shell). `ok: false` +
    `error` (daemon_not_connected / daemon_too_old / permission_denied / failed / timeout) tells the page to ask for
    the password instead."""
    return await ctx.daemon_client.wifi_connect_saved(network_id)


@router.post("/device/wifi/disconnect")
async def disconnect_wifi(ctx: AppContextDep, serial: ActiveSerialDep):
    """Leaves the current Wi-Fi network and keeps it left (daemon: the saved network is disabled — a plain
    WifiManager.disconnect() is undone by the phone's auto-join within seconds). Answers `{ok, sticky}`; `sticky: false`
    (or absent: an older daemon jar) means the link was only dropped. Refused while OpenDeX itself runs over that network
    (adb over the phone's Wi-Fi address): it would cut this very session. Over the phone's hotspot or USB it is harmless."""
    host = serial.rpartition(":")[0] if ":" in serial else None
    network_id: int | None = None
    try:
        status = (await wifi.wifi_overview(ctx.adb, serial)).get("status") or {}
        network_id = status.get("network_id")
        phone_ip = status.get("ip")
    except Exception:  # noqa: BLE001 — can't tell which network carries the session: don't risk it
        phone_ip = host
    if host is not None and phone_ip == host:
        raise HTTPException(
            status_code=409,
            detail="OpenDeX bu Wi-Fi üzerinden bağlı — bağlantıyı kesmek oturumu da koparır. Önce USB'ye geçin.",
        )
    return await ctx.daemon_client.wifi_disconnect(network_id if isinstance(network_id, int) else None)


@router.post("/device/wifi/saved/{network_id}/forget")
async def forget_wifi(ctx: AppContextDep, serial: ActiveSerialDep, network_id: int = Path(ge=0)):
    """Forgets a saved Wi-Fi network by its id (the phone drops it and its saved passphrase). `ok: false` when the phone refused."""
    try:
        ok = await wifi.wifi_forget(ctx.adb, serial, network_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Ağ unutulamadı: {exc}") from exc
    return {"ok": ok}


@router.get("/device/bluetooth")
async def get_bluetooth(ctx: AppContextDep, serial: ActiveSerialDep):
    """{ok, enabled, name, devices: [{address, name, kind, connected, battery}], readonly, source, error?}. `readonly`
    (source "dumpsys"): the daemon could not answer — the paired list is shown, actions are not."""
    return await bluetooth.bluetooth_overview(ctx.daemon_client, ctx.adb, serial)


@router.post("/device/bluetooth/{address}/{verb}", dependencies=[RequireDevice])
async def bluetooth_action(
    ctx: AppContextDep,
    verb: Literal["connect", "disconnect", "forget"],
    address: str = Path(pattern=r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$"),
):
    """bt_result {ok, error?, status?} — `error: permission_denied` hides that action for the session."""
    return await ctx.daemon_client.bt_action(verb, address.upper())
