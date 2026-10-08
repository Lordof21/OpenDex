"""Tests for MdnsDiscovery's persistent, passive `_adb-tls-connect._tcp`
tracker (Cihaz Geçiş Planı §3.2/§7.1) — the background listener that lets
Device Center show a 'found on network' hint for known devices WITHOUT ever
calling `adb connect` itself.

Real zeroconf sockets aren't exercised here (no network in CI) — instead we
verify the pieces that don't require one: idempotent start/stop, endpoint
bookkeeping, and graceful degradation when the OS refuses the multicast socket.
"""
import asyncio

import pytest

from app.wireless import mdns_discovery as mdns_mod
from app.wireless.mdns_discovery import MdnsDiscovery, PairingEndpoint


async def test_no_endpoints_before_listener_starts():
    discovery = MdnsDiscovery()
    assert discovery.get_live_connect_endpoints() == []


async def test_stop_without_start_is_a_safe_noop():
    discovery = MdnsDiscovery()
    await discovery.stop_persistent_connect_listener()  # must not raise
    assert discovery.get_live_connect_endpoints() == []


async def test_start_degrades_gracefully_when_socket_unavailable(monkeypatch):
    """Some environments (locked-down firewall, sandboxed CI) refuse the
    multicast socket — this must log and return, never crash the app startup."""

    class _RefusingAsyncZeroconf:
        def __init__(self, *a, **kw):
            raise OSError("socket refused")

    monkeypatch.setattr(mdns_mod, "AsyncZeroconf", _RefusingAsyncZeroconf)

    discovery = MdnsDiscovery()
    await discovery.start_persistent_connect_listener()
    # Give the background task a tick to run and hit the OSError branch.
    await asyncio.sleep(0.05)

    assert discovery.get_live_connect_endpoints() == []
    await discovery.stop_persistent_connect_listener()


async def test_start_is_idempotent(monkeypatch):
    """Calling start twice while already running must not spawn a second task."""

    class _HangingAsyncZeroconf:
        def __init__(self, *a, **kw):
            pass

        @property
        def zeroconf(self):
            return object()

        async def async_close(self):
            pass

    class _StubBrowser:
        def __init__(self, *a, **kw):
            pass

        async def async_cancel(self):
            pass

    monkeypatch.setattr(mdns_mod, "AsyncZeroconf", _HangingAsyncZeroconf)
    monkeypatch.setattr(mdns_mod, "AsyncServiceBrowser", _StubBrowser)

    discovery = MdnsDiscovery()
    await discovery.start_persistent_connect_listener()
    first_task = discovery._persistent_task
    await discovery.start_persistent_connect_listener()

    assert discovery._persistent_task is first_task
    await discovery.stop_persistent_connect_listener()
    assert discovery._persistent_task is None


async def test_endpoint_bookkeeping_add_and_remove():
    """Exercises the same add/remove dict semantics _on_change relies on,
    without going through real zeroconf callbacks."""
    discovery = MdnsDiscovery()
    ep = PairingEndpoint(name="adb-abc123._adb-tls-connect._tcp.local.", ip="192.168.1.50", port=37021)

    discovery._live_connect_endpoints[ep.name] = ep
    assert discovery.get_live_connect_endpoints() == [ep]

    discovery._live_connect_endpoints.pop(ep.name, None)
    assert discovery.get_live_connect_endpoints() == []
