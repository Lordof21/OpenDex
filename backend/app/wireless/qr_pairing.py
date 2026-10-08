"""Wireless Debugging pairing.

First-time pairing renders an AOSP/Android Studio-compatible QR payload; the phone
scans it under Settings → Developer options → Wireless debugging → "Pair with QR".
After TLS pairing completes the host key is durably trusted — the same mental model
as the one-time USB RSA prompt. Manual IP entry stays as the safety net for hotspot
setups where mDNS multicast is unreliable.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import string
from typing import Awaitable, Callable

from pydantic import BaseModel

from ..schemas import DeviceInfo
from ..device.adb import Adb
from ..device.device_manager import DeviceManager
from .mdns_discovery import MdnsDiscovery, PairingEndpoint

log = logging.getLogger(__name__)

_SERVICE_PREFIX = "opendex"


class QrPayload(BaseModel):
    service_name: str
    password: str
    text: str  # rendered into a QR code by frontend QrPairing.jsx


def generate_pairing_qr() -> QrPayload:
    """AOSP format: WIFI:T:ADB;S:<service>;P:<password>;;  (studio uses the same)."""
    suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    service = f"{_SERVICE_PREFIX}-{suffix}"
    password = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(12))
    return QrPayload(
        service_name=service,
        password=password,
        text=f"WIFI:T:ADB;S:{service};P:{password};;",
    )


class PairingListener:
    def __init__(self, adb: Adb, mdns: MdnsDiscovery, devices: DeviceManager) -> None:
        self._adb = adb
        self._mdns = mdns
        self._devices = devices

    async def start_pairing_listener(
        self,
        payload: QrPayload,
        on_paired: Callable[[DeviceInfo], Awaitable[None]],
        timeout_s: float = 120.0,
    ) -> None:
        """Waits for the phone's ``_adb-tls-pairing._tcp`` advert that matches the
        QR service name, completes `adb pair`, then auto-connects."""
        log.info("[Wireless Pairing] Started mDNS listener for QR service '%s' (timeout: %.0fs)", payload.service_name, timeout_s)

        async def _on_pairing_endpoint(ep: PairingEndpoint) -> None:
            if payload.service_name not in ep.name:
                return
            log.info("[Wireless Pairing] Phone scanned QR! mDNS advert matched: %s @ %s:%d -> pairing with ADB...", ep.name, ep.ip, ep.port)
            await self._adb.pair(ep.ip, ep.port, payload.password)
            log.info("[Wireless Pairing] ADB pair command executed for %s:%d", ep.ip, ep.port)

        pairing_task = asyncio.create_task(
            self._mdns.listen_for_pairing(_on_pairing_endpoint), name="mdns-pairing"
        )
        try:
            try:
                device = await self._wait_for_wireless_device(timeout_s)
            except asyncio.TimeoutError:
                log.warning(
                    "[Windows Firewall / mDNS Uyarısı ⚠️] QR eşleştirme zaman aşımına uğradı (%.0fs). "
                    "Eğer telefonla QR kodu tarattıysanız ve bağlantı başlamadıysa: Windows Güvenlik Duvarı "
                    "veya modeminiz mDNS (UDP 5353) paketlerini engelliyor olabilir. "
                    "Çözüm: Telefonda 'Cihazı eşleme koduyla eşle' seçeneğini kullanın (mDNS gerektirmez).",
                    timeout_s
                )
                return
            log.info("[Wireless Pairing] Device successfully paired and bound: %s", device.serial)
            await on_paired(device)
        finally:
            pairing_task.cancel()

    async def _wait_for_wireless_device(self, timeout_s: float) -> DeviceInfo:
        """After pairing, the phone advertises ``_adb-tls-connect._tcp``; the first
        successful `adb connect` ends the wait."""
        connected: asyncio.Future[DeviceInfo] = asyncio.get_running_loop().create_future()

        async def _on_connect_endpoint(ep: PairingEndpoint) -> None:
            if connected.done():
                return
            try:
                log.info("[Wireless Pairing] Connect advert seen: %s:%d -> running adb connect...", ep.ip, ep.port)
                await self._adb.connect(ep.ip, ep.port)
                device = await self._devices.wait_for_device(
                    serial=f"{ep.ip}:{ep.port}", timeout_s=10
                )
                if not connected.done():
                    connected.set_result(device)
            except Exception as exc:  # keep listening for further adverts
                log.debug("[Wireless Pairing] connect attempt to %s:%d failed: %s", ep.ip, ep.port, exc)

        listen_task = asyncio.create_task(
            self._mdns.listen_for_devices(_on_connect_endpoint), name="mdns-connect"
        )
        try:
            return await asyncio.wait_for(connected, timeout=timeout_s)
        finally:
            listen_task.cancel()

    async def connect_manual(self, ip: str, port: int) -> DeviceInfo:
        """Safety net when mDNS discovery fails."""
        log.info("[Wireless Pairing] Manual connect requested to %s:%d", ip, port)
        await self._adb.connect(ip, port)
        device = await self._devices.wait_for_device(serial=f"{ip}:{port}", timeout_s=15)
        log.info("[Wireless Pairing] Manual connect successful: %s", device.serial)
        return device

    async def pair_with_code(self, ip: str, port: int, pairing_code: str) -> None:
        """mDNS-independent pairing fallback — mirrors Android Studio's own "Pair
        using pairing code" dialog (`adb pair ip:port code`) exactly.

        Use when mDNS discovery of ``_adb-tls-pairing._tcp`` never completes
        (unreliable multicast on some networks/hotspots/VPNs/firewalls), so the QR
        flow silently stalls. This talks to the phone's PAIRING port directly and
        does not depend on any network discovery. After it succeeds, the phone is
        durably trusted and `connect_manual` (with the CONNECT port, not this one)
        completes the session.
        """
        log.info("[Wireless Pairing] Pairing with 6-digit code requested for %s:%d", ip, port)
        await self._adb.pair(ip, port, pairing_code)
        log.info("[Wireless Pairing] adb pair completed for %s:%d", ip, port)
