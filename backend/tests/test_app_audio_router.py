"""AppAudioRouter: per-window capture lifecycle, handoff, failures, modes, preferences."""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.events import EventBus
from app.schemas import AppAudioPref
from app.streams.app_audio import AppAudioRouter, AudioWindow, audio_key
from app.streams.audio_stream import SessionAudio
from app.streams.broadcaster import BroadcasterRegistry
from app.windows.session_table import SessionTable


class _Daemon:
    def __init__(self, *, supported=True, caps=("audio_route", "audio_list"), sync=False, rtt_ms=20.0):
        self.is_connected = True
        self.daemon_capabilities = set(caps) | ({"audio_playout"} if sync else set())
        self.supports_audio_playout = sync
        self.supported = supported
        self.calls: list[tuple[str, str]] = []
        self.targets: list[int | None] = []           # the phone target each audio_route call carried (None: none)
        self.retunes: list[tuple[str, int]] = []      # audio_target calls
        self.fail: dict[str, str] = {}
        self.sync_works = True                        # False: the phone cannot build its playback track
        self.target_error: str | None = None
        self.rtt_ms = rtt_ms
        self._next_stream = 1

    async def ping(self):
        return self.rtt_ms

    async def audio_route(self, package, route, target_ms=None):
        self.calls.append((package, route))
        self.targets.append(target_ms)
        if package in self.fail:
            return {"ok": False, "error": self.fail[package]}
        if route == "phone":
            return {"ok": True, "route": "phone"}
        stream_id, self._next_stream = self._next_stream, self._next_stream + 1
        res = {"ok": True, "route": route, "stream_id": stream_id}
        if target_ms is not None:
            res["sync"] = self.sync_works
            if self.sync_works:
                res["target_ms"] = target_ms
        return res

    async def audio_target(self, package, target_ms):
        self.retunes.append((package, target_ms))
        if self.target_error:
            return {"ok": False, "error": self.target_error}
        return {"ok": True, "sync": True, "target_ms": target_ms}

    async def audio_list(self):
        return {"ok": True, "supported": self.supported, "sdk": 34 if self.supported else 32}

    supports_audio_probe = True
    probe_calls: list = []
    probe_error: str | None = None

    async def audio_probe(self, phone_target_ms, count, spacing_ms, lead_ms):
        self.probe_calls.append((phone_target_ms, count, spacing_ms, lead_ms))
        if self.probe_error:
            return {"ok": False, "error": self.probe_error}
        base = 5_000_000
        return {"ok": True, "pts_us": [base + i * spacing_ms * 1000 for i in range(count)],
                "target_ms": phone_target_ms, "spacing_ms": spacing_ms}


class _Bus(EventBus):
    def __init__(self):
        super().__init__()
        self.emitted: list[tuple[str, dict]] = []

    async def emit(self, type, **payload):
        self.emitted.append((type, payload))
        await super().emit(type, **payload)

    def states(self, package=None):
        return [p for t, p in self.emitted if t == "app_audio_state" and (package is None or p["package"] == package)]


class _Harness:
    def __init__(self, *, default_route="pc", daemon=None):
        self.daemon = daemon or _Daemon()
        self.sync_offset = 0                          # ProjectSettings.audio_sync_offset_ms
        self.bus = _Bus()
        self.broadcasters = BroadcasterRegistry()
        self.windows: dict[str, AudioWindow] = {}
        self.link = MagicMock(start=AsyncMock(), stop=AsyncMock())
        self.suppress = AsyncMock()
        self.resume = AsyncMock()
        self.router = AppAudioRouter(
            self.broadcasters,
            self.bus,
            daemon_getter=lambda: self.daemon,
            link=self.link,
            windows_getter=lambda: dict(self.windows),
            default_route_getter=AsyncMock(return_value=default_route),
            suppress_legacy=self.suppress,
            resume_legacy=self.resume,
            sync_offset_getter=self._sync_getter,
        )

    async def _sync_getter(self):
        return self.sync_offset

    async def per_app(self):
        """Bind an Android 14 device whose daemon is already connected → per-app mode."""
        await self.router.on_device_bound("SERIAL", 34)
        await settle(self.router)
        assert self.router.mode == "per_app"

    async def open(self, window_id, package, on_phone=False):
        self.windows[window_id] = AudioWindow(package=package, on_phone=on_phone)
        await self.router.sync()

    async def close(self, window_id):
        self.windows.pop(window_id, None)
        await self.router.sync()


async def settle(router):
    for _ in range(50):
        await asyncio.sleep(0)
        task = router._sync_task
        if task is None or task.done():
            return
    raise AssertionError("sync did not settle")


@pytest.fixture(autouse=True)
def _prefs(monkeypatch):
    from app.storage import settings_db

    saved: dict[str, AppAudioPref] = {}

    async def get(package):
        return saved.get(package)

    async def upsert(pref):
        saved[pref.package] = pref

    monkeypatch.setattr(settings_db, "get_app_audio_pref", get)
    monkeypatch.setattr(settings_db, "upsert_app_audio_pref", upsert)
    return saved


# ---------------------------------------------------------------- window lifecycle


async def test_open_routes_the_app_to_the_pc_and_close_gives_the_sound_back_to_the_phone():
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.google.android.youtube")
    assert h.daemon.calls == [("com.google.android.youtube", "pc")]
    assert h.broadcasters.get(audio_key("w1")) is not None
    assert h.router.list_apps()[0]["live_route"] == "pc"

    await h.close("w1")
    assert h.daemon.calls[-1] == ("com.google.android.youtube", "phone")
    assert h.broadcasters.get(audio_key("w1")) is None
    assert h.router.list_apps() == []
    # the frontend learns the window has no channel any more
    assert h.bus.states("com.google.android.youtube")[-1]["windows"] == []


async def test_frames_reach_only_their_own_window():
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    await h.open("w2", "com.b")
    mine, other = h.broadcasters.get(audio_key("w1")), h.broadcasters.get(audio_key("w2"))
    mine.broadcast, other.broadcast = AsyncMock(), AsyncMock()
    stream_a = h.router.list_apps()[0]["stream_id"]

    await h.router.on_frame(stream_a, b"x" * 16)
    await h.router.on_frame(999, b"unknown stream")

    mine.broadcast.assert_awaited_once_with(b"x" * 16)
    other.broadcast.assert_not_awaited()


async def test_internal_windows_never_get_a_capture():
    h = _Harness()
    await h.per_app()
    await h.open("mirror", "com.opendex.screen_mirror")
    await h.open("anchor", "com.opendex.eco_workspace")
    assert h.daemon.calls == []


async def test_the_default_route_phone_opens_no_capture_but_the_window_is_listed():
    h = _Harness(default_route="phone")
    await h.per_app()
    await h.open("w1", "com.a")
    assert h.daemon.calls == []
    assert h.router.list_apps()[0]["route"] == "phone"


# ---------------------------------------------------------------- handoff


async def test_handoff_sends_the_sound_to_the_phone_and_reclaim_brings_it_back():
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")

    h.windows["w1"] = AudioWindow("com.a", on_phone=True)       # HandoffManager sets the flag, then emits
    await h.bus.emit("app_handoff_to_phone", window_id="w1", package="com.a")
    await settle(h.router)
    assert h.daemon.calls[-1] == ("com.a", "phone")
    app = h.router.list_apps()[0]
    assert (app["route"], app["live_route"], app["on_phone"]) == ("pc", "phone", True)

    h.windows["w1"] = AudioWindow("com.a", on_phone=False)
    await h.bus.emit("app_handoff_resolved", window_id="w1", package="com.a")
    await settle(h.router)
    assert h.daemon.calls[-1] == ("com.a", "pc")


async def test_closing_a_handed_off_window_does_not_leave_the_package_stuck_on_the_phone():
    """Plan bug: a package-keyed `_handed_off` set outlived the window, so the app's NEXT window never got PC audio."""
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a", on_phone=True)
    await h.close("w1")
    await h.open("w2", "com.a")
    assert h.daemon.calls[-1] == ("com.a", "pc")


# ---------------------------------------------------------------- failures


async def test_a_failed_route_is_reported_not_raised():
    h = _Harness()
    h.daemon.fail["com.a"] = "uid_already_captured"
    await h.per_app()
    await h.open("w1", "com.a")
    app = h.router.list_apps()[0]
    assert (app["error"], app["live_route"], app["stream_id"]) == ("uid_already_captured", "phone", None)


async def test_the_end_of_a_stream_we_retired_is_not_a_lost_capture():
    """Data and control travel on different sockets: the replaced capture's FLAG_END can arrive BEFORE the
    audio_route reply that retired it."""
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    old = h.router.list_apps()[0]["stream_id"]
    route = h.daemon.audio_route

    async def end_arrives_first(package, target):
        await h.router.on_end(old)
        return await route(package, target)

    h.daemon.audio_route = end_arrives_first
    await h.router.set_prefs("com.a", route="both")

    app = h.router.list_apps()[0]
    assert (app["live_route"], app["error"]) == ("both", None)
    assert app["stream_id"] != old
    assert all(s["error"] != "capture_lost" for s in h.bus.states("com.a"))


async def test_a_capture_that_dies_on_its_own_is_restarted(monkeypatch):
    monkeypatch.setattr(AppAudioRouter, "RESTART_DELAY_S", 0.0)
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    stream = h.router.list_apps()[0]["stream_id"]

    await h.router.on_end(stream)       # audioserver restarted under the capture
    assert h.bus.states("com.a")[-1]["error"] == "capture_lost"

    for _ in range(5):
        await asyncio.sleep(0)
    await settle(h.router)
    app = h.router.list_apps()[0]
    assert (app["live_route"], app["error"]) == ("pc", None)
    assert h.daemon.calls.count(("com.a", "pc")) == 2


# ---------------------------------------------------------------- modes


async def test_android_12_uses_the_legacy_stream():
    h = _Harness()
    await h.router.on_device_bound("SERIAL", 32)
    assert h.router.mode == "legacy"
    h.resume.assert_awaited_once()
    h.suppress.assert_not_awaited()


async def test_legacy_is_suppressed_while_pending_and_per_app_starts_the_link():
    h = _Harness()
    h.daemon.is_connected = False
    await h.router.on_device_bound("SERIAL", 34)
    assert h.router.mode == "pending"
    h.suppress.assert_awaited_once()

    h.daemon.is_connected = True
    await h.bus.emit("device_daemon_connected", version="1.1", capabilities=["audio_route"])
    await settle(h.router)
    for _ in range(5):
        await asyncio.sleep(0)
    assert h.router.mode == "per_app"
    h.link.start.assert_awaited_with("SERIAL")
    assert ("app_audio_mode", {"mode": "per_app", "supported": True}) in h.bus.emitted
    h.router._cancel_background()


async def test_a_transport_switch_keeps_the_mode_and_moves_the_link():
    h = _Harness()
    await h.per_app()
    await h.router.on_device_bound("192.168.1.5:5555", 34)
    assert h.router.mode == "per_app"
    h.link.start.assert_awaited_with("192.168.1.5:5555")

    legacy = _Harness()
    await legacy.router.on_device_bound("USB", 32)
    await legacy.router.on_device_bound("192.168.1.5:5555", 32)
    legacy.resume.assert_awaited_once()          # the window migration moves the legacy stream, not a 2nd start


async def test_an_old_daemon_jar_falls_back_to_legacy():
    h = _Harness(daemon=_Daemon(caps=("ping", "exec")))
    await h.router.on_device_bound("SERIAL", 34)
    assert h.router.mode == "legacy"
    h.resume.assert_awaited_once()


async def test_no_daemon_within_the_grace_period_falls_back_to_legacy(monkeypatch):
    monkeypatch.setattr(AppAudioRouter, "PENDING_FALLBACK_S", 0.0)
    h = _Harness()
    h.daemon.is_connected = False
    await h.router.on_device_bound("SERIAL", 34)
    for _ in range(5):
        await asyncio.sleep(0)
    assert h.router.mode == "legacy"


async def test_a_daemon_reconnect_re_establishes_every_capture():
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    h.daemon = _Daemon()                 # a NEW daemon process: nothing registered
    await h.bus.emit("device_daemon_connected", version="1.1", capabilities=["audio_route"])
    for _ in range(5):
        await asyncio.sleep(0)
    await settle(h.router)
    assert h.daemon.calls == [("com.a", "pc")]


async def test_unbinding_forgets_everything():
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    await h.router.on_device_unbound()
    assert h.router.mode == "off"
    assert h.router.list_apps() == []
    assert h.broadcasters.get(audio_key("w1")) is None
    h.link.stop.assert_awaited()


# ---------------------------------------------------------------- preferences


async def test_preferences_are_saved_and_follow_the_package(_prefs):
    h = _Harness()
    await h.per_app()
    await h.open("w1", "com.a")
    await h.router.set_prefs("com.a", route="both", volume=0.4, muted=True)
    assert _prefs["com.a"] == AppAudioPref(package="com.a", route="both", volume=0.4, muted=True)
    assert h.daemon.calls[-1] == ("com.a", "both")

    await h.close("w1")
    await h.open("w2", "com.a")                  # a later window of the same app
    app = h.router.list_apps()[0]
    assert (app["route"], app["volume"], app["muted"], app["explicit"]) == ("both", 0.4, True, True)
    assert h.daemon.calls[-1] == ("com.a", "both")


async def test_a_bad_route_is_rejected():
    h = _Harness()
    with pytest.raises(ValueError):
        await h.router.set_prefs("com.a", route="speaker")


async def test_changing_the_default_moves_only_apps_without_their_own_preference():
    h = _Harness()
    route = {"value": "pc"}
    h.router._default_route = AsyncMock(side_effect=lambda: route["value"])
    await h.per_app()
    await h.open("w1", "com.a")
    await h.open("w2", "com.b")
    await h.router.set_prefs("com.b", route="pc")         # explicit

    route["value"] = "both"
    await h.router.on_default_route_changed()
    await settle(h.router)

    routes = {a["package"]: a["live_route"] for a in h.router.list_apps()}
    assert routes == {"com.a": "both", "com.b": "pc"}


# ---------------------------------------------------------------- plumbing


async def test_session_table_changes_request_one_coalesced_sync():
    table = SessionTable()
    calls = []
    unsubscribe = table.subscribe(lambda: calls.append(len(table)))
    table["w1"] = object()
    table.pop("w1")
    table.pop("missing", None)          # no change → no notification
    table.setdefault("w2", object())
    table.clear()
    assert calls == [1, 0, 1, 0]
    unsubscribe()
    table["w3"] = object()
    assert calls == [1, 0, 1, 0]
    assert isinstance(table, dict)


async def test_request_sync_outside_an_event_loop_is_a_no_op():
    h = _Harness()

    def outside():
        h.router.request_sync()

    await asyncio.get_running_loop().run_in_executor(None, outside)
    assert h.router._sync_task is None


async def test_legacy_session_audio_cannot_start_while_suppressed():
    audio = SessionAudio(adb=MagicMock(), settings=MagicMock(), broadcasters=BroadcasterRegistry())
    await audio.set_suppressed(True)
    await audio.start_session_audio("SERIAL", output_mode="pc")    # would spawn scrcpy if not gated
    assert audio.running is False
    assert audio.suppressed is True


# ---------------------------------------------------------------- Media Center transfer (app WITHOUT a window)

SPOTIFY = "com.spotify.music"
SPOTIFY_CHANNEL = "app:com.spotify.music"


async def test_a_windowless_app_can_be_transferred_to_the_pc_and_sent_back():
    h = _Harness()
    await h.per_app()
    res = await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)

    assert h.daemon.calls == [(SPOTIFY, "pc")]
    assert (res["live_route"], res["standalone"], res["windows"], res["error"]) == ("pc", True, [SPOTIFY_CHANNEL], None)
    assert h.broadcasters.get(audio_key(SPOTIFY_CHANNEL)) is not None       # the same per-channel plumbing as a window
    assert h.router.list_apps()[0]["package"] == SPOTIFY

    sent_back = await h.router.set_prefs(SPOTIFY, route="phone")             # "send it back" ends the transfer too
    assert h.daemon.calls[-1] == (SPOTIFY, "phone")
    assert (sent_back["windows"], sent_back["standalone"]) == ([], False)
    assert h.broadcasters.get(audio_key(SPOTIFY_CHANNEL)) is None
    assert h.router.list_apps() == []
    assert h.bus.states(SPOTIFY)[-1]["windows"] == []                        # the frontend learns the channel is gone


async def test_the_transferred_apps_pcm_reaches_its_channel():
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)
    channel = h.broadcasters.get(audio_key(SPOTIFY_CHANNEL))
    channel.broadcast = AsyncMock()
    await h.router.on_frame(h.router.list_apps()[0]["stream_id"], b"pcm")
    channel.broadcast.assert_awaited_once_with(b"pcm")


async def test_a_transfer_from_a_phone_only_preference_brings_the_app_to_the_pc(_prefs):
    _prefs[SPOTIFY] = AppAudioPref(package=SPOTIFY, route="phone", volume=0.5)
    h = _Harness()
    await h.per_app()
    res = await h.router.set_prefs(SPOTIFY, standalone=True)
    assert (res["route"], res["live_route"], res["volume"]) == ("pc", "pc", 0.5)


async def test_a_transfer_that_cannot_start_never_reaches_the_phone():
    from app.streams.app_audio import TransferRefused

    legacy = _Harness()
    await legacy.router.on_device_bound("SERIAL", 32)                        # Android 12: one session stream, no per-app
    with pytest.raises(TransferRefused) as refused:
        await legacy.router.set_prefs(SPOTIFY, standalone=True)
    assert refused.value.code == "not_supported"

    h = _Harness()
    await h.per_app()
    with pytest.raises(TransferRefused) as internal:
        await h.router.set_prefs("com.opendex.screen_mirror", standalone=True)
    assert internal.value.code == "internal_package"
    assert h.daemon.calls == []


async def test_a_transfer_the_phone_refuses_is_taken_back_with_its_reason():
    h = _Harness()
    h.daemon.fail[SPOTIFY] = "uid_already_captured"
    await h.per_app()
    res = await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)

    assert res["error"] == "uid_already_captured" and res["standalone"] is False
    assert h.router.list_apps() == []                                        # no leftover mixer row
    assert h.broadcasters.get(audio_key(SPOTIFY_CHANNEL)) is None
    calls = len(h.daemon.calls)
    await h.router.sync()
    assert len(h.daemon.calls) == calls                                      # and nothing keeps retrying it


async def test_a_window_of_its_own_takes_over_the_channel_without_a_gap_and_the_transfer_survives_its_closing():
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)
    stream = h.router.list_apps()[0]["stream_id"]

    await h.open("w1", SPOTIFY)
    app = h.router.list_apps()[0]
    assert (app["windows"], app["stream_id"]) == (["w1"], stream)            # same capture: not restarted
    assert h.broadcasters.get(audio_key(SPOTIFY_CHANNEL)) is None and h.broadcasters.get(audio_key("w1")) is not None
    assert h.daemon.calls == [(SPOTIFY, "pc")]

    await h.close("w1")                                                      # the user asked for the PC: it stays there
    app = h.router.list_apps()[0]
    assert (app["windows"], app["live_route"], app["standalone"]) == ([SPOTIFY_CHANNEL], "pc", True)
    assert h.daemon.calls == [(SPOTIFY, "pc")]


async def test_a_daemon_reconnect_re_establishes_the_transfer():
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)
    h.daemon = _Daemon()                                                     # a NEW daemon process: nothing registered
    await h.bus.emit("device_daemon_connected", version="1.1", capabilities=["audio_route"])
    for _ in range(5):
        await asyncio.sleep(0)
    await settle(h.router)
    assert h.daemon.calls == [(SPOTIFY, "pc")]


async def test_unbinding_ends_every_transfer():
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)
    await h.router.on_device_unbound()
    await h.router.on_device_bound("SERIAL", 34)
    await settle(h.router)
    assert h.router.mode == "per_app" and h.router.list_apps() == []


class _Clock:
    now = 1000.0

    def monotonic(self):
        return self.now


async def media_update(h, **payload):
    """The bus runs in-process listeners as background tasks: let this one finish before the clock moves."""
    await h.bus.emit("device_media_update", **payload)
    for _ in range(3):
        await asyncio.sleep(0)


@pytest.fixture
def clock(monkeypatch):
    from app.streams import app_audio

    fake = _Clock()
    monkeypatch.setattr(app_audio, "time", fake)         # only this module's clock — asyncio keeps the real one
    return fake


async def test_a_transfer_ends_when_the_phone_no_longer_has_the_apps_media_session(clock):
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)

    await media_update(h, sessions=[{"package": "com.other"}])
    clock.now += AppAudioRouter.TRANSFER_GRACE_S - 1
    await h.router.sync()
    assert h.router.list_apps() != []                                        # still inside the grace (track change…)

    clock.now += 2
    await h.router.sync()
    assert h.router.list_apps() == [] and h.daemon.calls[-1] == (SPOTIFY, "phone")
    h.router._cancel_background()


async def test_a_session_that_comes_back_or_a_snapshot_without_a_list_keeps_the_transfer(clock):
    h = _Harness()
    await h.per_app()
    await h.router.set_prefs(SPOTIFY, route="pc", standalone=True)

    await media_update(h, sessions=[])                                       # gone …
    clock.now += AppAudioRouter.TRANSFER_GRACE_S - 1
    await media_update(h, sessions=[{"package": SPOTIFY}])                   # … and back: the clock starts over
    await media_update(h, title="a notification-derived update")             # no list: no evidence either way
    clock.now += AppAudioRouter.TRANSFER_GRACE_S * 3
    await h.router.sync()
    assert h.router.list_apps()[0]["standalone"] is True
    h.router._cancel_background()


# ---------------------------------------------------------------- "İkisi": phone and DeX on one timeline

YT = "com.google.android.youtube"
# Defaults with a 20 ms ping (link one way 10 ms): output 30 + chunk 20 + link 10 + relay 6 + margin 60 = 126 ms.
COMMON = 126


async def test_both_gives_the_dex_and_the_phone_one_common_target_latency():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    assert (h.daemon.calls[-1], h.daemon.targets[-1]) == ((YT, "both"), COMMON)
    app = h.router.list_apps()[0]
    assert (app["synced"], app["target_ms"], app["phone_ms"], app["live_route"]) == (True, COMMON, COMMON, "both")


async def test_only_both_is_aligned_dex_and_phone_routes_carry_no_target():
    h = _Harness(daemon=_Daemon(sync=True))
    await h.per_app()
    await h.router.set_prefs(YT, route="pc", standalone=True)
    assert h.daemon.targets == [None]
    app = h.router.list_apps()[0]
    assert (app["synced"], app["target_ms"], app["phone_ms"]) == (False, None, None)


async def test_the_fine_tune_moves_the_phone_alone_and_the_target_never_leaves_its_range():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    h.sync_offset = 30
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    app = h.router.list_apps()[0]
    assert (h.daemon.targets[-1], app["target_ms"], app["phone_ms"]) == (COMMON + 30, COMMON, COMMON + 30)   # the DeX side is untouched

    h2 = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    h2.sync_offset = -300
    await h2.per_app()
    await h2.router.set_prefs(YT, route="both", standalone=True)
    assert h2.daemon.targets[-1] == 0                                  # earlier than the capture is not a thing: the phone's floor

    h3 = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    await h3.per_app()
    await h3.router.report_pc(2000)                                    # a very slow output device
    await h3.router.set_prefs(YT, route="both", standalone=True)
    assert h3.router.list_apps()[0]["target_ms"] == AppAudioRouter.MAX_TARGET_MS     # capped: nothing waits longer than this

    h4 = _Harness(daemon=_Daemon(sync=True, rtt_ms=0.0))
    h4.router.JITTER_MARGIN_MS = 0                                     # no headroom at all: the floor (26 ms) is below the minimum
    await h4.per_app()
    await h4.router.report_pc(0)
    await h4.router.set_prefs(YT, route="both", standalone=True)
    assert h4.router.list_apps()[0]["target_ms"] == AppAudioRouter.MIN_TARGET_MS     # and not shorter than a chunk can make it


async def test_an_older_jar_plays_the_app_natively_on_the_phone():
    old = _Harness(daemon=_Daemon(sync=False))
    await old.per_app()
    await old.router.set_prefs(YT, route="both", standalone=True)
    assert old.daemon.targets == [None] and old.router.list_apps()[0]["synced"] is False


async def test_a_phone_that_cannot_build_its_playback_track_is_reported_and_not_retried_forever():
    h = _Harness(daemon=_Daemon(sync=True))
    h.daemon.sync_works = False
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    app = h.router.list_apps()[0]
    assert (app["live_route"], app["synced"], app["target_ms"]) == ("both", False, None)    # the app still plays, natively

    calls = len(h.daemon.calls)
    h.sync_offset = 10                                                 # a fine tune change: nothing to retune
    await h.router.on_sync_changed()
    await h.router.report_pc(300)
    assert len(h.daemon.calls) == calls and h.daemon.retunes == []     # no capture storm


async def test_a_new_dex_output_latency_retunes_the_running_capture_in_place_and_jitter_is_ignored():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    stream = h.router.list_apps()[0]["stream_id"]

    await h.router.report_pc(40)                                       # +10 ms: output latency jitter
    assert h.daemon.retunes == []

    await h.router.report_pc(200)                                      # a Bluetooth headset on the PC
    assert h.daemon.retunes == [(YT, COMMON + 170)]                    # 200 instead of 30
    app = h.router.list_apps()[0]
    assert (app["target_ms"], app["phone_ms"], app["stream_id"]) == (COMMON + 170, COMMON + 170, stream)   # the same capture
    assert h.bus.states(YT)[-1]["target_ms"] == COMMON + 170           # and the page is told


async def test_the_fine_tune_slider_retunes_the_phone_without_a_new_capture():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    calls = len(h.daemon.calls)
    h.sync_offset = 40
    await h.router.on_sync_changed()
    assert h.daemon.retunes == [(YT, COMMON + 40)] and len(h.daemon.calls) == calls
    assert h.router.list_apps()[0]["target_ms"] == COMMON                # the DeX side did not move


async def test_chunks_that_reach_the_page_too_late_raise_the_margin_and_calm_gives_it_back():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)

    await h.router.report_pc(None, late_chunks=1)                      # one straggler is not a trend
    assert h.daemon.retunes == []

    await h.router.report_pc(None, late_chunks=AppAudioRouter.LATE_BUMP_AFTER)
    assert h.daemon.retunes[-1] == (YT, COMMON + AppAudioRouter.LATE_BUMP_MS)
    assert h.router.list_apps()[0]["target_ms"] == COMMON + AppAudioRouter.LATE_BUMP_MS

    for _ in range(AppAudioRouter.CALM_REPORTS_TO_RELAX):
        await h.router.report_pc(None, late_chunks=0)
    assert h.router.list_apps()[0]["target_ms"] == COMMON + AppAudioRouter.LATE_BUMP_MS - AppAudioRouter.RELAX_STEP_MS

    for _ in range(40):                                                # however many late reports there are, it stops at the cap
        await h.router.report_pc(None, late_chunks=9)
    assert h.router.list_apps()[0]["target_ms"] == COMMON + AppAudioRouter.LATE_BUMP_MAX_MS


async def test_a_capture_the_daemon_no_longer_syncs_is_established_again():
    h = _Harness(daemon=_Daemon(sync=True))
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    h.daemon.target_error = "not_syncing"
    calls = len(h.daemon.calls)
    h.sync_offset = 50
    await h.router.on_sync_changed()
    assert len(h.daemon.calls) == calls + 1 and h.daemon.targets[-1] is not None


async def test_the_alignment_settings_read_what_is_assumed():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    h.sync_offset = 15
    await h.per_app()
    await h.router.set_prefs(YT, route="both", standalone=True)
    assert await h.router.sync_info() == {
        "supported": True, "offset_ms": 15, "pc_output_ms": 30, "link_ms": 10.0, "target_ms": COMMON, "late_extra_ms": 0,
    }
    legacy = _Harness(daemon=_Daemon(sync=False))
    info = await legacy.router.sync_info()
    assert (info["supported"], info["target_ms"]) == (False, None)


# ---------------------------------------------------------------- calibration probe (the phone's half)


async def test_the_probe_plays_at_the_phones_current_target_and_tells_the_page_what_it_needs():
    h = _Harness(daemon=_Daemon(sync=True, rtt_ms=20.0))
    h.daemon.probe_calls = []
    h.sync_offset = 25
    await h.per_app()
    res = await h.router.probe()
    assert res["ok"] is True
    assert (res["common_target_ms"], res["phone_target_ms"], res["offset_ms"]) == (COMMON, COMMON + 25, 25)
    assert h.daemon.probe_calls == [(COMMON + 25, AppAudioRouter.PROBE_COUNT, AppAudioRouter.PROBE_SPACING_MS, AppAudioRouter.PROBE_LEAD_MS)]
    assert len(res["pts_us"]) == AppAudioRouter.PROBE_COUNT
    assert res["spacing_ms"] == AppAudioRouter.PROBE_SPACING_MS


async def test_the_probe_is_refused_without_per_app_audio_or_a_jar_that_can_play_it():
    h = _Harness(daemon=_Daemon(sync=True))
    assert (await h.router.probe()) == {"ok": False, "error": "not_supported"}        # mode "off": no device bound yet
    await h.per_app()
    h.daemon.supports_audio_probe = False
    assert (await h.router.probe()) == {"ok": False, "error": "not_supported"}        # a jar from before audio_probe


async def test_a_probe_the_phone_cannot_play_reports_its_own_reason():
    h = _Harness(daemon=_Daemon(sync=True))
    await h.per_app()
    h.daemon.probe_error = "probe_unavailable: IllegalStateException"
    res = await h.router.probe()
    assert res == {"ok": False, "error": "probe_unavailable: IllegalStateException"}
