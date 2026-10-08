"""mDNS discovery for Android Wireless Debugging.

Android advertises three service types; which Wi-Fi node is the AP (router, phone
hotspot, laptop hotspot) is irrelevant — same L2 network ⇒ same discovery path,
which is why one mechanism covers all three topologies.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from ..events import cancel_and_wait


log = logging.getLogger(__name__)

ADB_TLS_CONNECT = "_adb-tls-connect._tcp.local."
ADB_TLS_PAIRING = "_adb-tls-pairing._tcp.local."


@dataclass(frozen=True)
class PairingEndpoint:
    name: str
    ip: str
    port: int


class MdnsDiscovery:
    def __init__(self) -> None:
        self._live_connect_endpoints: dict[str, PairingEndpoint] = {}
        self._persistent_task: asyncio.Task | None = None

    def get_live_connect_endpoints(self) -> list[PairingEndpoint]:
        """Currently-visible `_adb-tls-connect._tcp` adverts (Cihaz Geçiş Planı
        §3.2/§7.1) — PURELY passive bookkeeping from multicast packets already
        being broadcast on the network. Never triggers an `adb connect`; the
        actual connection is always a separate, explicit, user-triggered call."""
        return list(self._live_connect_endpoints.values())

    async def start_persistent_connect_listener(self) -> None:
        """Runs for the application's lifetime, tracking which devices are
        currently reachable via Wireless Debugging so Device Center can show a
        'found on network' hint for known devices — see get_live_connect_endpoints.
        Safe to call once at startup; a second call is a no-op."""
        if self._persistent_task and not self._persistent_task.done():
            return
        self._persistent_task = asyncio.create_task(
            self._track_persistent(ADB_TLS_CONNECT), name="mdns-persistent-connect"
        )

    async def stop_persistent_connect_listener(self) -> None:
        await cancel_and_wait(self._persistent_task)
        self._persistent_task = None
        self._live_connect_endpoints.clear()

    async def _track_persistent(self, service_type: str) -> None:
        loop = asyncio.get_running_loop()
        try:
            aiozc = AsyncZeroconf()
        except OSError as exc:
            log.warning(
                "[mDNS] Persistent connect-listener could not open a socket (%s) — "
                "'Ağda bulundu' hints will be unavailable; manual reconnect still works.",
                exc,
            )
            return

        def _on_change(
            zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange
        ) -> None:
            if state_change is ServiceStateChange.Removed:
                self._live_connect_endpoints.pop(name, None)
                return
            asyncio.run_coroutine_threadsafe(_resolve_and_store(name), loop)

        async def _resolve_and_store(name: str) -> None:
            info = AsyncServiceInfo(service_type, name)
            if not await info.async_request(aiozc.zeroconf, timeout=3000):
                return
            addresses = info.parsed_addresses()
            if not addresses or not info.port:
                return
            self._live_connect_endpoints[name] = PairingEndpoint(
                name=name, ip=addresses[0], port=info.port
            )

        browser = AsyncServiceBrowser(aiozc.zeroconf, service_type, handlers=[_on_change])
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            await browser.async_cancel()
            await aiozc.async_close()

    async def listen_for_devices(
        self, on_found: Callable[[PairingEndpoint], Awaitable[None]]
    ) -> None:
        """Watches ``_adb-tls-connect._tcp`` adverts (equivalent of `adb mdns
        services`); the caller decides whether/how to connect."""
        await self._browse(ADB_TLS_CONNECT, on_found)

    async def listen_for_pairing(
        self, on_found: Callable[[PairingEndpoint], Awaitable[None]]
    ) -> None:
        await self._browse(ADB_TLS_PAIRING, on_found)

    async def _browse(
        self, service_type: str, on_found: Callable[[PairingEndpoint], Awaitable[None]]
    ) -> None:
        loop = asyncio.get_running_loop()
        try:
            import socket
            # Explicitly bind to all local IPv4 interfaces (Wi-Fi, Laptop Hotspot 192.168.137.1, etc.)
            host_ips: list[str] = []
            try:
                for item in socket.getaddrinfo(socket.gethostname(), None):
                    cand = item[4][0]
                    if ":" not in cand and not cand.startswith("127."):
                        if cand not in host_ips:
                            host_ips.append(cand)
            except Exception:
                pass
            if host_ips:
                log.info("[mDNS] Initializing AsyncZeroconf on all active host interfaces: %s", host_ips)
                aiozc = AsyncZeroconf(interfaces=host_ips)
            else:
                aiozc = AsyncZeroconf()
        except OSError as exc:
            log.warning(
                "[Windows Firewall / mDNS Hatası ⚠️] Zeroconf (UDP 5353) soketi açılamadı: %s. "
                "Windows Güvenlik Duvarı mDNS paketlerini engelliyor olabilir. 'Kod ile Eşleştir' yöntemini kullanın.",
                exc
            )
            return

        def _on_change(
            zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange
        ) -> None:
            if state_change is not ServiceStateChange.Added:
                return
            asyncio.run_coroutine_threadsafe(
                _resolve_and_report(name), loop
            )

        async def _resolve_and_report(name: str) -> None:
            info = AsyncServiceInfo(service_type, name)
            if not await info.async_request(aiozc.zeroconf, timeout=3000):
                log.debug("[mDNS] Resolution timed out for: %s", name)
                return
            addresses = info.parsed_addresses()
            if not addresses or not info.port:
                log.debug("[mDNS] No parsed address/port for: %s", name)
                return
            endpoint = PairingEndpoint(name=name, ip=addresses[0], port=info.port)
            log.info("[mDNS] Discovered %s advert: %s -> %s:%d", service_type.split('.')[0], name, endpoint.ip, endpoint.port)
            await on_found(endpoint)

        browser = AsyncServiceBrowser(
            aiozc.zeroconf, service_type, handlers=[_on_change]
        )
        try:
            while True:  # runs until the surrounding task is cancelled
                await asyncio.sleep(3600)
        finally:
            await browser.async_cancel()
            await aiozc.async_close()
