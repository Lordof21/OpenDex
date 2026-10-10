"""Eco Workspace / Task Teleportation — WindowManager INTEGRATION tests.

Bunlar test_eco_workspace.py / test_task_movement.py'nin (izole birim
testleri) TAMAMLAYICISI: burada gerçek `WindowManager`, gerçek
`EcoWorkspaceManager`, gerçek `TaskTeleporter` ve gerçek `SessionReconfigurer`
(dolayısıyla gerçek `start_video_pump`) `__init__`'te BİRBİRİNE
KABLOLANMIŞ haliyle çalıştırılıyor — amaç "her parça izole çalışıyor" değil,
"window_manager.py'deki kompozisyon doğru mu" sorusuna cevap vermek.
Özellikle şunları kanıtlar:

  * `open_window_in_workspace()` gerçekten `_active_encoder_count()`'u SADECE
    1 artırıyor, N değil (KPI #1 — bu sayı bugüne kadar hiç gerçek
    WindowManager üzerinden ölçülmedi, sadece EcoWorkspaceManager'ın kendi
    izole `member_count`'u üzerinden).
  * `list_windows()` anchor'ı asla sızdırmıyor.
  * `close_all()`'ın snapshot-iterasyonu, anchor'ın Eco üyelerinden ÖNCE
    `_sessions`'a eklenmiş olmasına rağmen paylaşımlı server'ı üyelerin
    altından çekmiyor (bu implementasyon turunda bulunup düzeltilen gerçek
    bir sıra hatasıydı).
  * Tomurcuklama/dock encoder bütçesini gerçekten (WindowManager'ın kendi
    `EncoderLimitError` kapısı üzerinden) değiştiriyor.
"""
from __future__ import annotations

import asyncio

import pytest
from unittest.mock import AsyncMock

from app.config import Settings
from app.events import EventBus
from app.schemas import DeviceProfile
from app.streams.broadcaster import BroadcasterRegistry
from app.windows import eco_workspace as eco_workspace_module
from app.windows import session_reconfigure as reconfigure_module
from app.windows import task_teleporter as task_teleporter_module
from app.windows import window_manager as wm_module
from app.windows.scrcpy_launcher import ScrcpySockets, VideoMeta
from app.windows.window_manager import EncoderLimitError, WindowManager


class _FakeControl:
    async def send(self, payload: bytes) -> None: ...
    async def close(self) -> None: ...


class _FakeScrcpyServer:
    """Aynı test_window_manager.py'deki _FakeScrcpyServer deseni — TEK fark:
    her instance kendi (sahte ama BİRBİRİNDEN FARKLI) display_id'sini alır,
    ki paylaşımlı Eco VD'si ile bir tomurcuklama sonrası dedicated VD'nin
    GERÇEKTEN ayrı display'ler olduğu doğrulanabilsin."""

    _next_display_id = 100
    call_log: list[str] = []

    def __init__(self, adb, settings, serial, *args, **kwargs):
        self.serial = serial
        self.stopped = False
        self.stop_kwargs = None
        self._sockets = None
        self.display_id = str(_FakeScrcpyServer._next_display_id)
        _FakeScrcpyServer._next_display_id += 1

    async def push_server(self, server_path=None): ...

    async def start_forward(self):
        self.local_port = 27199
        return self.local_port

    async def spawn(self, **kwargs):
        self.spawn_kwargs = kwargs

    async def connect_sockets(self, **kwargs):
        reader = asyncio.StreamReader()
        reader.feed_eof()  # pump task ends immediately, cleanly
        self._sockets = ScrcpySockets(
            device_name="fake-device",
            video=(reader, None),
            video_meta=VideoMeta(codec="h264", width=1920, height=1080),
            control=_FakeControl(),
        )
        return self._sockets

    @property
    def sockets(self):
        return self._sockets

    @property
    def is_alive(self):
        return not self.stopped

    async def stop(self, *, evacuate=None):
        self.stopped = True
        self.stop_kwargs = {"evacuate": evacuate}
        _FakeScrcpyServer.call_log.append(f"server.stop(display_id={self.display_id})")


import re

class _FakeAdb:
    """`am start`/`am task resize`/`am force-stop`/`dumpsys activity
    activities {task_id}` çağrılarını kaydeder; launch-bounds probe'unun
    HER ZAMAN "desteklendi" sonucuna varması için istenen bounds'u aynen
    yansıtan bir dumpsys yanıtı üretir (DEFAULT_BOUNDS ile eşleşir)."""

    def __init__(self):
        self.shell_calls: list[str] = []
        self._dumpsys_bounds = "120, 60 - 1560, 960"

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.shell_calls.append(cmd)
        m = re.search(r"task resize \S+ (\d+) (\d+) (\d+) (\d+)", cmd)
        if m:
            l, t, r, b = m.groups()
            self._dumpsys_bounds = f"{l}, {t} - {r}, {b}"
        m_launch = re.search(r"--activity-launch-bounds (\d+),(\d+),(\d+),(\d+)", cmd)
        if m_launch:
            l, t, r, b = m_launch.groups()
            self._dumpsys_bounds = f"{l}, {t} - {r}, {b}"
        if cmd.startswith("dumpsys activity activities"):
            return f"bounds=Rect({self._dumpsys_bounds})"
        return ""

    async def run(self, *_a, **_kw):
        return ""


class _StubProbe:
    def __init__(self, limit: int):
        self._limit = limit

    async def get_or_probe(self, serial, android_id) -> DeviceProfile:
        return DeviceProfile(android_id=android_id, encoder_limit=self._limit, android_api=34)


class _StubSessionAudio:
    active_server = None  # SessionAudio.active_server: no audio server running

    def __init__(self):
        self.started = 0
        self.stopped = 0

    @property
    def running(self):
        return self.started > self.stopped

    async def start_session_audio(self, serial, *args, **kwargs):
        self.started += 1

    async def stop_session_audio(self, *args, **kwargs):
        self.stopped += 1


@pytest.fixture(autouse=True)
def _patch_deep_navigator(monkeypatch):
    import app.device.deep_navigator as nav

    async def _fake_find_task(adb, pkg, display_id=None, serial=None):
        return f"task-{pkg}"

    async def _fake_resolve_activity(adb, serial, pkg):
        return f"{pkg}/.MainActivity"

    monkeypatch.setattr(nav, "find_task_id_for_package", _fake_find_task)
    monkeypatch.setattr(nav, "_resolve_default_launcher_activity", _fake_resolve_activity)


@pytest.fixture(autouse=True)
def _patch_settings_db_profile_save(monkeypatch):
    import app.storage.settings_db as db

    async def _noop_save(*_a, **_kw):
        pass

    monkeypatch.setattr(db, "save_device_profile", _noop_save)


@pytest.fixture
async def manager(monkeypatch, tmp_db):
    # Every module that captured its OWN `ScrcpyServer` binding at import
    # time needs patching independently — "patch where it's looked up, not
    # where it's defined" (this exact codebase's own established gotcha).
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FakeScrcpyServer)
    monkeypatch.setattr(eco_workspace_module, "ScrcpyServer", _FakeScrcpyServer)
    monkeypatch.setattr(task_teleporter_module, "ScrcpyServer", _FakeScrcpyServer)
    _FakeScrcpyServer.call_log = []
    _FakeScrcpyServer._next_display_id = 100

    events = EventBus()
    audio = _StubSessionAudio()
    registry = BroadcasterRegistry()
    mgr = WindowManager(
        adb=_FakeAdb(),
        settings=Settings(UNFREEZE_GRACE_DELAY_S=0),
        events=events,
        broadcasters=registry,
        session_audio=audio,
        capability_probe=_StubProbe(limit=2),
        device_manager=None,
    )
    mgr._test_events = events
    await mgr.bind_device("SER", "android-1")
    return mgr


async def _drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


# ---------------------------------------------------------------- açma / encoder bütçesi

async def test_open_window_in_workspace_creates_exactly_one_window_entry(manager):
    handle = await manager.open_window_in_workspace("com.app.a")

    assert handle.workspace_id == "eco"
    windows = manager.list_windows()
    assert len(windows) == 1
    assert windows[0].workspace_id == "eco"


async def test_two_eco_windows_share_one_encoder_slot_not_two(manager):
    """KPI #1'in gerçek WindowManager üzerinden doğrudan ölçümü — daha önce
    hiçbir testte bu SAYI (_active_encoder_count) gerçek manager'dan
    okunmamıştı, sadece EcoWorkspaceManager'ın izole member_count'undan."""
    await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")

    assert manager._active_encoder_count() == 1  # N üye, 1 encoder — 2 DEĞİL
    # Kanıt: limit=2 iken (1'i zaten anchor'da), TAM OLARAK 1 bağımsız
    # pencere daha açılabiliyor — eski (yanlış) tasarımda 2 eco üyesi zaten
    # limiti doldurmuş olurdu, hiç bağımsız pencere açılamazdı.
    await manager.open_window("com.app.c")
    assert manager._active_encoder_count() == 2
    with pytest.raises(EncoderLimitError):
        await manager.open_window("com.app.d")


async def test_eco_workspace_bypasses_encoder_limit_entirely(manager):
    """Eco Workspace'in TÜM amacı bu: limit=2 olsa bile paylaşımlı VD'ye
    istenildiği kadar uygulama eklenebilir — normal open_window() ile asla
    mümkün olmayacak bir şey."""
    for pkg in ("com.app.a", "com.app.b", "com.app.c", "com.app.d", "com.app.e"):
        await manager.open_window_in_workspace(pkg)

    assert manager._active_encoder_count() == 1
    assert len(manager.list_windows()) == 5


async def test_list_windows_never_leaks_the_anchor_session(manager):
    await manager.open_window_in_workspace("com.app.a")
    await manager.open_window("com.app.b")  # independent, for contrast

    packages = {w.package for w in manager.list_windows()}
    assert "com.opendex.eco_workspace" not in packages
    assert len(manager.list_windows()) == 2  # eco container + 1 independent, NOT +1 anchor


async def test_all_eco_members_share_the_same_ws_url_and_shared_display(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    b = await manager.open_window_in_workspace("com.app.b")

    assert a.ws_url == b.ws_url
    session_a = manager.get_session(a.window_id)
    session_b = manager.get_session(b.window_id)
    assert session_a.server is session_b.server  # LITERALLY the same ScrcpyServer object


# ---------------------------------------------------------------- tomurcuklama (pop-out)

async def test_popout_moves_task_off_the_shared_display_onto_its_own(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    shared_server = manager.get_session(a.window_id).server

    popped = await manager.popout_window_to_desktop(a.window_id)

    session = manager.get_session(popped.window_id)
    assert session.server is not shared_server
    assert session.server.display_id != shared_server.display_id
    assert session.state.workspace_id is None
    assert popped.ws_url == f"/ws/video/{a.window_id}"


async def test_popout_consumes_a_real_encoder_slot(manager):
    """Tomurcuklanan pencere artık PAYLAŞIMLI değil — kendi encoder'ını
    tüketir. limit=2 iken: 1 Eco üyesi (0 ekstra maliyet) + 1 tomurcuklanmış
    (1 maliyet) + 1 daha bağımsız pencere (1 maliyet) = tam limit; üçüncüsü
    reddedilir."""
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.popout_window_to_desktop(a.window_id)
    assert manager._active_encoder_count() == 1

    await manager.open_window("com.app.b")
    assert manager._active_encoder_count() == 2

    with pytest.raises(EncoderLimitError):
        await manager.open_window("com.app.c")


async def test_popout_last_member_tears_down_the_shared_display(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    shared_server = manager.get_session(a.window_id).server

    await manager.popout_window_to_desktop(a.window_id)

    assert shared_server.stopped is True
    # Anchor'ın kendi bookkeeping girdisi de gitmiş olmalı — list_windows()
    # zaten filtreliyordu ama burada asıl _sessions'ın kendisini kontrol
    # ediyoruz (list_windows() bir bug'ı maskeleyebilirdi).
    assert not any(s.workspace_id == "eco-anchor" for s in manager.list_windows())


async def test_popout_emits_task_popout_result_with_new_ws_url(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    queue = await manager._test_events.subscribe()

    popped = await manager.popout_window_to_desktop(a.window_id)

    events = await _drain(queue)
    result = next(e for e in events if e.type == "task_popout_result")
    assert result.payload["window_id"] == a.window_id
    assert result.payload["success"] is True
    assert result.payload["ws_url"] == popped.ws_url
    assert result.payload["display_w"] == 1920 and result.payload["display_h"] == 1080


# ---------------------------------------------------------------- dock (geri gönderme)

async def test_dock_moves_independent_window_into_the_shared_display(manager):
    b = await manager.open_window("com.app.b")
    dedicated_server = manager.get_session(b.window_id).server

    await manager.dock_window_to_workspace(b.window_id)

    session = manager.get_session(b.window_id)
    assert session.state.workspace_id == "eco"
    assert session.server is not dedicated_server
    assert dedicated_server.stopped is True  # eski dedicated VD imha edildi


async def test_docking_a_lone_window_does_not_itself_reduce_encoder_cost(manager):
    """Tek bir pencereyi dock etmenin NET bir kazancı yoktur — paylaşımlı
    VD'nin kendisi de tam olarak 1 encoder'a mal olur (1 bağımsız -> 1
    anchor, net değişim sıfır). Gerçek kazanç ancak İKİNCİ bir pencere AYNI
    workspace'e katılınca ortaya çıkar (bkz. bir sonraki test)."""
    b = await manager.open_window("com.app.b")
    assert manager._active_encoder_count() == 1

    await manager.dock_window_to_workspace(b.window_id)

    assert manager._active_encoder_count() == 1  # aynı net maliyet, sahibi değişti (b -> anchor)


async def test_docking_a_second_window_into_the_same_workspace_is_where_the_savings_appear(manager):
    """Dock'un asıl kazancı: iki bağımsız pencere limiti (2/2) doldurmuşken,
    ikisini de AYNI paylaşımlı VD'ye dock etmek toplam maliyeti 2'den 1'e
    düşürür — üçüncü bir bağımsız pencereye yer açar."""
    b = await manager.open_window("com.app.b")
    c = await manager.open_window("com.app.c")
    assert manager._active_encoder_count() == 2  # limit dolu, üçüncü bir pencere şu an reddedilirdi

    await manager.dock_window_to_workspace(b.window_id)
    await manager.dock_window_to_workspace(c.window_id)

    assert manager._active_encoder_count() == 1  # iki üye ARTIK tek anchor'ı paylaşıyor
    # Kanıt: şimdi bir bağımsız pencere daha açılabiliyor — dock etmeden
    # önce imkansızdı (limit zaten doluydu).
    await manager.open_window("com.app.d")
    assert manager._active_encoder_count() == 2
    with pytest.raises(EncoderLimitError):
        await manager.open_window("com.app.e")


async def test_dock_then_popout_round_trip_leaves_a_consistent_state(manager):
    """Dock->Popout->Dock zincirinin her adımda tutarlı kalması — özellikle
    session.server referansının HER seferinde doğru nesneye işaret etmesi
    (bu implementasyon turunda 'eski server'a bağlı kalma' gerçek bir hataydı)."""
    a = await manager.open_window_in_workspace("com.app.a")
    shared_server_1 = manager.get_session(a.window_id).server

    await manager.popout_window_to_desktop(a.window_id)
    dedicated_server = manager.get_session(a.window_id).server
    assert dedicated_server is not shared_server_1

    await manager.dock_window_to_workspace(a.window_id)
    shared_server_2 = manager.get_session(a.window_id).server
    assert shared_server_2 is not dedicated_server
    assert dedicated_server.stopped is True
    assert manager.get_session(a.window_id).state.workspace_id == "eco"


# ---------------------------------------------------------------- kapama / close_all sıralaması

async def test_closing_one_eco_member_keeps_the_shared_display_alive_for_the_other(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    b = await manager.open_window_in_workspace("com.app.b")
    shared_server = manager.get_session(b.window_id).server

    await manager.close_workspace_task(a.window_id)

    assert shared_server.stopped is False
    assert len(manager.list_windows()) == 1
    assert manager.get_session(b.window_id) is not None


async def test_closing_the_last_eco_member_tears_down_the_shared_display(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    shared_server = manager.get_session(a.window_id).server

    await manager.close_workspace_task(a.window_id)

    assert shared_server.stopped is True
    assert manager.list_windows() == []


async def test_close_all_does_not_tear_down_shared_display_out_from_under_live_members(manager):
    """Bu implementasyon turunda bulunup düzeltilen GERÇEK sıra hatasının
    regresyon testi: anchor, Eco üyelerinden ÖNCE `_sessions`'a ekleniyor
    (_ensure_shared_display üyeden önce çalışıyor), bu yüzden close_all()'ın
    list(self._sessions) anlık görüntüsü anchor'ı İLK sırada içerir. Eski
    (hatalı) davranışta bu, anchor'ı normal (Eco-farkında olmayan) kapama
    yoluna sokup paylaşımlı server'ı henüz canlı üyelerin altından çekerdi."""
    await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")
    await manager.open_window("com.app.c")  # independent, karışık senaryo için

    await manager.close_all()  # patlamamalı, hiçbir şeyi çift kapatmamalı

    assert manager.list_windows() == []
    assert manager._active_encoder_count() == 0


async def test_close_all_with_only_eco_windows_open_tears_down_cleanly(manager):
    await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")
    await manager.open_window_in_workspace("com.app.c")

    await manager.close_all()

    assert manager.list_windows() == []


# ---------------------------------------------------------------- görev yeniden boyutlandırma

async def test_resize_workspace_task_updates_bounds_and_emits_event(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    queue = await manager._test_events.subscribe()

    await manager.resize_workspace_task(a.window_id, (10, 20, 500, 400))

    events = await _drain(queue)
    result = next(e for e in events if e.type == "workspace_task_bounds_changed")
    assert result.payload["window_id"] == a.window_id
    assert result.payload["bounds"] == [10, 20, 500, 400]
    assert any(c.startswith("am task resize") for c in manager._adb.shell_calls)


# ---------------------------------------------------------------- VD koordinat uzayı sözleşmesi

async def test_workspace_handle_VD_boyutunu_dondurur_stream_boyutunu_degil(manager):
    """I1/I2: WindowHandle.display_w/h, task_bounds'un yaşadığı VD uzayını
    tanımlar. Buraya stream boyutu konursa frontend'in ölçeği bozulur
    (asıl hatanın backend ayağı)."""
    handle = await manager.open_window_in_workspace("com.app.a")

    assert handle.display_w == 1920
    assert handle.display_h == 1080


async def test_workspace_window_state_VD_boyutunu_tasir(manager):
    """I2: Reconnect/focus-regain sonrası frontend container'ı bu alanlardan
    yeniden kuruyor. Yoksa 0'a düşüp ilk video karesiyle stream boyutuna
    eziliyordu."""
    await manager.open_window_in_workspace("com.app.a")

    state = next(w for w in manager.list_windows() if w.workspace_id == "eco")
    assert state.workspace_vd_w == 1920
    assert state.workspace_vd_h == 1080


async def test_bagimsiz_pencerede_workspace_vd_alanlari_bostur(manager):
    """Bu alanlar Eco Workspace'e özgü — bağımsız pencerede anlamsız."""
    await manager.open_window("com.app.b")

    state = next(w for w in manager.list_windows() if w.workspace_id is None)
    assert state.workspace_vd_w is None
    assert state.workspace_vd_h is None


# ---------------------------------------------------------------- görev density (DPI) ayarı

async def test_set_workspace_task_density_with_daemon(manager, monkeypatch):
    """AOSP WindowContainerTransaction üzerinden görev DPI'ı ayarlandığında
    workspace_task_density_changed olayı yayılır ve task state'i güncellenir."""
    a = await manager.open_window_in_workspace("com.app.a")
    queue = await manager._test_events.subscribe()

    class _FakeDaemon:
        is_connected = True
        async def set_task_density(self, task_id, density):
            return True

    manager.set_daemon_client(_FakeDaemon())

    ok = await manager.set_workspace_task_density(a.window_id, 180)
    assert ok is True

    task = manager._eco_workspace.get_task(a.window_id)
    assert task.density == 180

    events = await _drain(queue)
    result = next(e for e in events if e.type == "workspace_task_density_changed")
    assert result.payload["window_id"] == a.window_id
    assert result.payload["density"] == 180




# ---------------------------------------------------------------- yoğunluk KİPİ → GET /api/windows

async def test_yogunluk_kipi_pencere_durumuna_yansir(manager, monkeypatch):
    """Sub-PiP başlangıç durumunu GET /api/windows'tan okur (ayrı JS dünyası): boyutlandırma ve yoğunluk
    değişimlerinden sonra bounds + yoğunluk + kip BAYAT kalmamalı."""

    class _Daemon:
        is_connected = True

        async def set_task_density(self, task_id, density):
            return True

    manager.set_daemon_client(_Daemon())

    a = await manager.open_window_in_workspace("com.app.a")
    assert a.task_density_mode == "auto"  # kayıt yanıtı da kipi taşır

    def state():
        return next(w for w in manager.list_windows() if w.window_id == a.window_id)

    assert state().task_density_mode == "auto"

    await manager.resize_workspace_task(a.window_id, (10, 20, 500, 400), density=300, density_mode="manual")
    assert (state().task_density, state().task_density_mode) == (300, "manual")
    task = manager._eco_workspace.get_task(a.window_id)
    assert state().task_bounds == list(task.bounds)

    assert await manager.set_workspace_task_density(a.window_id, 200, mode="auto") is True
    assert (state().task_density, state().task_density_mode) == (200, "auto")


def test_istek_semasi_gecersiz_yogunluk_kipini_reddeder():
    from pydantic import ValidationError

    from app.api.v1.endpoints.windows import ResizeWorkspaceTaskRequest, SetWorkspaceTaskDensityRequest

    assert ResizeWorkspaceTaskRequest(window_id="w", bounds=[0, 0, 10, 10]).density_mode is None
    assert ResizeWorkspaceTaskRequest(window_id="w", bounds=[0, 0, 10, 10], density_mode="manual").density_mode == "manual"
    assert SetWorkspaceTaskDensityRequest(window_id="w", density=200).mode == "manual"
    with pytest.raises(ValidationError):
        ResizeWorkspaceTaskRequest(window_id="w", bounds=[0, 0, 10, 10], density_mode="saçma")
    with pytest.raises(ValidationError):
        SetWorkspaceTaskDensityRequest(window_id="w", density=200, mode="saçma")


# ---------------------------------------------------------------- Workspace ⟷ telefon (Display 0)
# Eksik iki kenar: workspace→phone ve phone→workspace.

class _RecordingDaemon:
    """Görev-düzeyi Stealth DPI'ın (set_task_density) ve görev taşımanın kaydı."""

    is_connected = True

    def __init__(self):
        self.density_calls: list[tuple[str, int]] = []
        self.move_calls: list[tuple[str, str]] = []

    async def set_task_density(self, task_id, density):
        self.density_calls.append((str(task_id), int(density)))
        return True

    async def move_task_to_display(self, task_id, display_id):
        self.move_calls.append((str(task_id), str(display_id)))
        return True

    async def get_task_geometry(self, task_id):
        return None


def _shell_calls(manager):
    return manager._adb.shell_calls


async def test_handoff_of_a_workspace_member_parks_it_instead_of_orphaning_it(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    b = await manager.open_window_in_workspace("com.app.b")
    _phone_state(manager)
    q = await manager._test_events.subscribe()

    assert await manager.handoff_window_to_phone(a.window_id) is True

    session_a = manager.get_session(a.window_id)
    assert session_a.state.handoff_to_phone is True
    assert session_a.state.workspace_id == "eco"          # doğduğu yer HATIRLANIYOR
    assert session_a.state.locus == "phone"
    assert manager.get_session(b.window_id).state.locus == "workspace"

    eco = manager._eco_workspace
    assert eco.get_task(a.window_id).parked is True        # defterde YERİ duruyor
    assert eco.member_count == 1                            # ama canlı sayılmıyor
    assert eco.display_id is not None                       # b hâlâ yaşıyor → paylaşımlı VD ayakta

    calls = _shell_calls(manager)
    assert "am display move-stack task-com.app.a 0" in calls
    assert "WCT windowing task-com.app.a 1" in calls   # freeform → fullscreen (daemon'un işlemi)
    assert not any("force-stop" in c for c in calls)        # app ÖLDÜRÜLMEDİ, taşındı
    types = [e.type for e in await _drain(q)]
    assert "app_handoff_to_phone" in types


async def test_parking_the_last_live_member_releases_the_shared_display_and_encoder(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    anchor_id = a.ws_url.split("/")[-1]
    _, client_queue = manager._broadcasters.get(anchor_id).register()   # ör. bir Sub-PiP decoder'ı

    await manager.handoff_window_to_phone(a.window_id)

    assert manager._active_encoder_count() == 0
    assert manager._eco_workspace.display_id is None
    assert any(c.startswith("server.stop") for c in _FakeScrcpyServer.call_log)
    # Ölü anchor'a bağlı istemciler sessizce takılı KALMAZ: kapanış sinyali alırlar.
    assert manager._broadcasters.get(anchor_id) is None
    from app.streams.broadcaster import CLOSE_SENTINEL
    drained = []
    while not client_queue.empty():
        drained.append(client_queue.get_nowait())
    assert CLOSE_SENTINEL in drained


async def test_reclaim_returns_a_parked_member_to_its_workspace_slot(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    old_ws_url = a.ws_url
    await manager.handoff_window_to_phone(a.window_id)
    q = await manager._test_events.subscribe()

    assert await manager.reclaim_window(a.window_id) is True

    session = manager.get_session(a.window_id)
    eco = manager._eco_workspace
    assert session.state.handoff_to_phone is False
    assert session.state.locus == "workspace"
    assert session.server is eco.server and eco.server is not None      # ÖLÜ eski sunucuya değil
    assert eco.get_task(a.window_id).parked is False
    assert session.state.ws_url != old_ws_url                           # yeni anchor ⇒ yeni akış
    assert manager._active_encoder_count() == 1
    events = {e.type: e.payload for e in await _drain(q)}
    assert events["workspace_task_returned"]["ws_url"] == session.state.ws_url
    assert "app_handoff_resolved" in events


async def test_reclaim_honours_a_slot_the_user_dragged_while_parked(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)

    await manager.reclaim_window(a.window_id, (200, 100, 900, 700))

    assert any("--activity-launch-bounds 200,100,900,700" in c for c in _shell_calls(manager))


async def test_resize_and_density_are_noops_for_a_parked_member(manager):
    """Park edilmiş üyenin task_id'si artık Display 0'daki TAM EKRAN telefon
    uygulamasını gösterir — `am task resize` / WCT density onu bozardı (zombi kaydın
    asıl zararı)."""
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")
    await manager.handoff_window_to_phone(a.window_id)
    before = len(_shell_calls(manager))

    await manager.resize_workspace_task(a.window_id, (0, 0, 500, 500), density=300)
    assert await manager.set_workspace_task_density(a.window_id, 300) is False

    assert not any("task resize task-com.app.a" in c for c in _shell_calls(manager)[before:])


async def test_display0_focus_event_parks_an_eco_member_without_moving_it_again(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")

    await manager._test_events.emit("device_task_focused", display_id=0, package="com.app.a", task_id="77")
    # Park artık taşıma SONRASI pencereleme doğrulamasını (settle_s) da bekler: sabit bir uyku yerine yoklanır.
    for _ in range(150):
        if manager.get_session(a.window_id).state.locus == "phone":
            break
        await asyncio.sleep(0.02)

    assert manager.get_session(a.window_id).state.locus == "phone"
    assert manager._eco_workspace.get_task(a.window_id).parked is True
    assert not any(c.startswith("am display move-stack") and c.endswith(" 0") for c in _shell_calls(manager))
    # olay-tetikli ikinci çağrı idempotent: tekrar park girişimi yok
    await manager._test_events.emit("device_task_focused", display_id=0, package="com.app.a", task_id="77")
    for _ in range(5):
        await asyncio.sleep(0.01)
    assert manager._eco_workspace.get_task(a.window_id).parked is True


def _phone_reads(monkeypatch, density):
    """The phone's live density as android_shell.phone_density reports it (None: it could not be read)."""
    from unittest.mock import AsyncMock

    monkeypatch.setattr("app.device.android_shell.phone_density", AsyncMock(return_value=density))


async def test_task_level_stealth_dpi_is_applied_on_park_and_undone_on_return(manager, monkeypatch):
    _phone_reads(monkeypatch, 520)
    daemon = _RecordingDaemon()
    manager.set_daemon_client(daemon)  # EcoWorkspaceManager reads it through its injected getter
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.set_workspace_task_density(a.window_id, 240)     # kullanıcının manuel tercihi
    daemon.density_calls.clear()

    await manager.handoff_window_to_phone(a.window_id)
    # önce telefon DPI'ına sabitlenir (taşıma yoğunluk değiştirmesin), taşıma SONRASI sabitleme kalkar (görev artık
    # telefonun KENDİ yoğunluğunu izler: yazılan değer ile uygulanan değer arasında fark kalmaz)
    assert daemon.density_calls == [("task-com.app.a", 520), ("task-com.app.a", 0)]
    assert ("task-com.app.a", "0") in daemon.move_calls

    daemon.density_calls.clear()
    await manager.reclaim_window(a.window_id)
    # dönüşte 520 override'ı kalmaz: kullanıcının 240 tercihi geri yazılır
    assert daemon.density_calls[-1] == ("task-com.app.a", 240)
    assert manager._eco_workspace.get_task(a.window_id).density == 240


async def test_the_phone_density_pin_is_lifted_only_AFTER_the_move(manager, monkeypatch):
    """Sabitleme taşımadan ÖNCE yazılır (taşıma yoğunluk değiştirmesin), kaldırılışı taşımadan SONRA olur — sıra bozulursa
    uygulama taşıma anında iki yoğunluk değişimi yaşar."""
    _phone_reads(monkeypatch, 520)
    daemon = _RecordingDaemon()
    order: list[str] = []
    original_density, original_move = daemon.set_task_density, daemon.move_task_to_display

    async def density(task_id, value):
        order.append(f"density:{value}")
        return await original_density(task_id, value)

    async def move(task_id, display_id):
        order.append(f"move:{display_id}")
        return await original_move(task_id, display_id)

    daemon.set_task_density, daemon.move_task_to_display = density, move
    manager.set_daemon_client(daemon)
    a = await manager.open_window_in_workspace("com.app.a")
    order.clear()

    await manager.handoff_window_to_phone(a.window_id)

    assert order == ["density:520", "move:0", "density:0"]


async def test_an_unreadable_phone_density_is_never_pinned_but_the_task_still_moves(manager, monkeypatch):
    """The pin used to fall back to a made-up 520 when the phone's density could not be read — on a phone whose user picked
    another display size that put the app on the WRONG density. Unknown now means: no pin, the move still happens, and the
    pin's removal (which would be meaningless) is not sent either."""
    _phone_reads(monkeypatch, None)
    daemon = _RecordingDaemon()
    manager.set_daemon_client(daemon)
    a = await manager.open_window_in_workspace("com.app.a")
    daemon.density_calls.clear()

    await manager.handoff_window_to_phone(a.window_id)

    assert ("task-com.app.a", "0") in daemon.move_calls
    assert ("task-com.app.a", 520) not in daemon.density_calls
    assert all(value == 0 for _, value in daemon.density_calls)  # at most the "follow the display" release


async def test_a_popped_out_window_does_not_keep_the_workspace_density_override(manager):
    """Bağımsız pencereye çıkan görev, Workspace'teki görev-düzeyi yoğunluğunu TAŞIMAZ: o sabitleme kalırsa uygulama yeni
    ekranın yoğunluğuna geçmez ve sonraki canlı DPI yazımları (yeniden boyutlandırma) onun altında kalırdı."""
    daemon = _RecordingDaemon()
    manager.set_daemon_client(daemon)
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.set_workspace_task_density(a.window_id, 260)
    daemon.density_calls.clear()

    settles = []
    manager._density.schedule_settle = lambda *args, **kw: settles.append(kw["reason"])

    await manager.popout_window_to_desktop(a.window_id)

    assert daemon.density_calls == [("task-com.app.a", 0)]
    assert settles == ["popout"]            # 260 (Workspace) → the dedicated display's density: the reconciler settles the app
    assert manager.get_session(a.window_id).state.workspace_id is None


async def test_focus_never_pulls_a_parked_member_back_with_start_app(manager, monkeypatch):
    sent = []

    async def _record(self, payload):
        sent.append(payload)

    monkeypatch.setattr(_FakeControl, "send", _record)
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")        # paylaşımlı sunucu ayakta kalsın
    await manager.handoff_window_to_phone(a.window_id)
    sent.clear()

    await manager.focus_window(a.window_id)

    assert sent == []          # START_APP yok: geri dönüş yalnız phone_to_workspace ile


async def _record_control_sends(monkeypatch):
    sent = []

    async def _record(self, payload):
        sent.append(payload)

    monkeypatch.setattr(_FakeControl, "send", _record)
    return sent


async def test_focus_does_not_relaunch_an_app_that_is_already_on_its_display(manager, monkeypatch):
    """START_APP is the LAUNCHER intent: sent on every click it dropped a notification's deep-linked screen back onto the
    app's main page. Focus only starts an app that has no task on the window's display."""
    import app.device.deep_navigator as nav
    from app.windows.scrcpy_launcher import serialize_start_app

    sent = await _record_control_sends(monkeypatch)
    a = await manager.open_window_in_workspace("com.app.a")
    sent.clear()

    await manager.focus_window(a.window_id)                       # the autouse fake finds a task for every package
    assert sent == []

    async def _no_task(adb, pkg, display_id=None, serial=None):
        return None

    monkeypatch.setattr(nav, "find_task_id_for_package", _no_task)  # the user closed the app inside the window
    await manager.focus_window(a.window_id)
    assert sent == [serialize_start_app("com.app.a")]


async def test_a_held_launch_keeps_focus_from_starting_the_app_on_top_of_a_notification_target(manager, monkeypatch):
    """A tapped notification fires its own PendingIntent into the window; a focus landing first (no task on the display yet)
    must not start the app's LAUNCHER page — it arrived last and left Gmail on its inbox instead of the mail."""
    import app.device.deep_navigator as nav
    from app.windows.scrcpy_launcher import serialize_start_app

    sent = await _record_control_sends(monkeypatch)
    a = await manager.open_window_in_workspace("com.app.a")
    sent.clear()

    async def _no_task(adb, pkg, display_id=None, serial=None):
        return None

    monkeypatch.setattr(nav, "find_task_id_for_package", _no_task)       # nothing on the display yet: focus would launch
    manager.hold_launch("com.app.a", seconds=5.0)
    await manager.focus_window(a.window_id)
    assert sent == []                                                     # held: no START_APP

    manager._launch_held["com.app.a"] = 0.0                               # the hold ran out
    await manager.focus_window(a.window_id)
    assert sent == [serialize_start_app("com.app.a")]
    assert "com.app.a" not in manager._launch_held                        # and it was dropped, not kept for ever


async def test_start_app_in_window_launches_even_while_the_launch_is_held(manager, monkeypatch):
    """A notification that left the phone has no target to fire: its window gets the app's own page, hold or not."""
    from app.windows.scrcpy_launcher import serialize_start_app

    sent = await _record_control_sends(monkeypatch)
    a = await manager.open_window_in_workspace("com.app.a")
    sent.clear()
    manager.hold_launch("com.app.a")

    assert await manager.start_app_in_window("com.app.a") is True
    assert sent == [serialize_start_app("com.app.a")]
    assert await manager.start_app_in_window("com.app.unknown") is False


async def test_minimize_and_restore_leave_the_app_alone(manager, monkeypatch):
    from app.schemas import VisibilityState

    from app.windows import resource_budget

    # No budget pressure: nothing is frozen (a FROZEN window's display is gone and unfreeze relaunches the app on a new one).
    monkeypatch.setattr(resource_budget, "allocate_fps", lambda windows, *a, **k: {w.window_id: 60 for w in windows})
    sent = await _record_control_sends(monkeypatch)
    a = await manager.open_window_in_workspace("com.app.a")
    sent.clear()

    await manager.set_visibility(a.window_id, VisibilityState.MINIMIZED)    # no HOME key (it can send the PHONE home)
    await manager.set_visibility(a.window_id, VisibilityState.VISIBLE)      # no launcher intent (it resets the open screen)
    assert sent == []


async def test_opening_the_workspace_never_touches_the_phones_own_ui_settings(manager):
    await manager.open_window_in_workspace("com.app.a")
    written = " ".join(manager._adb.shell_calls)
    assert "hide_gesture_line" not in written and "settings delete" not in written   # the user's gesture-bar choice is theirs
    assert written.count("enable_freeform_support") == 1                             # written once, at bind


async def test_failed_return_keeps_the_member_parked_and_does_not_leak_a_display(manager, monkeypatch):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)

    async def _boom(self, **kwargs):
        raise RuntimeError("encoder yok")

    monkeypatch.setattr(_FakeScrcpyServer, "spawn", _boom)
    with pytest.raises(RuntimeError):
        await manager.reclaim_window(a.window_id)

    assert manager._eco_workspace.get_task(a.window_id).parked is True
    assert manager.get_session(a.window_id).state.locus == "phone"
    assert manager._eco_workspace.display_id is None


# ---------------------------------------------------------------- telefona / popout: temiz çıkış

def _window_block(task_id, mode, bounds):
    l, t, r, b = bounds
    return (
        f"  * Task{{6ae7b4f #{task_id} type=standard A=10:com.app.a U=0 visible=true mode={mode} translucent=false sz=1}}\n"
        f"    mFullConfiguration={{1.0 winConfig={{ mBounds=Rect({l}, {t} - {r}, {b}) mWindowingMode={mode} }}}}\n"
    )


class _WindowingDaemon:
    """The daemon's task-windowing primitive (WindowContainerTransaction): the ONLY way to set a task's windowing mode
    besides re-laying out its activity with `am start --windowingMode` (`am task` has no windowing-mode subcommand).
    Every call is written into the adb call list as `WCT windowing <task> <mode>` so ordering against `move-stack` can
    be asserted on one timeline."""

    is_connected = True
    daemon_capabilities = {"set_task_windowing_bounds"}

    def __init__(self, calls, state, stubborn):
        self.calls, self.state, self.stubborn = calls, state, stubborn

    def supports(self, capability):
        return capability in self.daemon_capabilities

    async def set_task_windowing(self, task_id, mode, clear_bounds=False, bounds=None):
        self.calls.append(f"WCT windowing {task_id} {mode}" + (f" {','.join(map(str, bounds))}" if bounds else ""))
        if not self.stubborn and self.state is not None:
            if mode == 1:
                self.state["mode"], self.state["bounds"] = "fullscreen", (0, 0, 1080, 2400)
            else:
                self.state["mode"], self.state["bounds"] = "freeform", tuple(bounds) if bounds else (108, 240, 972, 2160)
        return True


def _phone_state(manager, *, stubborn=False, initial="freeform", task="task-com.app.a"):
    """Sahte cihazı durumlu yapar: `initial` kipinde bir görev; kipi daemon'un WCT'si ya da `am start --windowingMode N`
    ile yeniden yerleşim değiştirir (gerçek cihazdaki gibi). `stubborn=True` → hiçbir şey kipi değiştirmez (son çare)."""
    adb = manager._adb
    state = {"mode": initial, "bounds": (0, 0, 1080, 2400) if initial == "fullscreen" else (80, 80, 700, 500)}
    original = adb.shell

    async def shell(cmd, *, serial, timeout_s=3.0):
        out = await original(cmd, serial=serial, timeout_s=timeout_s)
        if cmd.startswith("wm size"):
            return "Physical size: 1080x2400"
        if not stubborn and cmd.startswith("am start") and "--windowingMode" in cmd:
            if "--windowingMode 1" in cmd:
                state["mode"], state["bounds"] = "fullscreen", (0, 0, 1080, 2400)
            elif "--windowingMode 5" in cmd:
                state["mode"], state["bounds"] = "freeform", (108, 240, 972, 2160)
        if cmd.startswith(f"dumpsys activity activities {task}"):
            return out + _window_block(task, state["mode"], state["bounds"])
        return out

    adb.shell = shell
    manager.set_daemon_client(_WindowingDaemon(adb.shell_calls, state, stubborn))
    return state


async def test_workspace_to_phone_cleans_windowing_AFTER_the_move_and_verifies(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    state = _phone_state(manager)
    before = len(_shell_calls(manager))

    await manager.handoff_window_to_phone(a.window_id)

    calls = _shell_calls(manager)[before:]
    move = calls.index("am display move-stack task-com.app.a 0")
    cleanup = next(i for i, c in enumerate(calls) if c == "WCT windowing task-com.app.a 1")
    assert move < cleanup, "temizlik taşımadan SONRA olmalı (taşıma sırasında Android kipi yeniden çözer)"
    assert not any("WCT windowing" in c for c in calls[:move]), "taşıma ÖNCESİ kip komutu kalktı"
    assert state["mode"] == "fullscreen"
    assert not any("force-stop" in c for c in calls)  # düzeldi → uygulama öldürülmez


async def test_workspace_to_phone_last_resort_relaunches_when_freeform_residue_persists(manager, monkeypatch):
    monkeypatch.setattr(task_teleporter_module.TaskTeleporter, "_RELAUNCH_WAIT_S", 0)
    a = await manager.open_window_in_workspace("com.app.a")
    _phone_state(manager, stubborn=True)
    q = await manager._test_events.subscribe()
    before = len(_shell_calls(manager))

    await manager.handoff_window_to_phone(a.window_id)

    calls = _shell_calls(manager)[before:]
    assert "am force-stop com.app.a" in calls, "3 doğrulanmış deneme tükendi → son çare"
    assert calls.count("WCT windowing task-com.app.a 1") >= 3
    assert any(c.startswith("am start --display 0") and "--windowingMode 1" in c for c in calls)  # 2. denemeden itibaren yeniden yerleşim
    handoff = next(e for e in await _drain(q) if e.type == "app_handoff_to_phone")
    assert "yeniden başlatıldı" in handoff.payload["message"]  # kullanıcı bilgilendirilir
    assert manager.get_session(a.window_id).state.locus == "phone"  # yine de park edildi


async def test_workspace_to_phone_does_not_relaunch_when_state_cannot_be_read(manager):
    """dumpsys biçimi tanınmıyorsa (durum okunamaz) doğrulama 'unknown': yıkıcı adım YOK."""
    a = await manager.open_window_in_workspace("com.app.a")
    manager.set_daemon_client(_WindowingDaemon(manager._adb.shell_calls, None, stubborn=True))  # durum okunamıyor
    before = len(_shell_calls(manager))

    await manager.handoff_window_to_phone(a.window_id)

    calls = _shell_calls(manager)[before:]
    assert not any("force-stop" in c for c in calls)
    assert calls.count("WCT windowing task-com.app.a 1") == 1  # tek deneme


async def test_phone_handoff_freeform_setting_applies_mode_5_with_a_centered_box(manager):
    from app.storage import settings_db

    project = await settings_db.get_project_settings()
    project.phone_handoff_windowing = "freeform"
    await settings_db.save_project_settings(project)
    a = await manager.open_window_in_workspace("com.app.a")
    state = _phone_state(manager)
    before = len(_shell_calls(manager))

    await manager.handoff_window_to_phone(a.window_id)

    calls = _shell_calls(manager)[before:]
    assert "WCT windowing task-com.app.a 5 108,240,972,2160" in calls  # ekranın ~%80'i, ortalı — kip ile aynı işlemde
    assert not any(c == "WCT windowing task-com.app.a 1" for c in calls)
    assert state["mode"] == "freeform"


async def test_normal_window_handoff_leaves_a_correct_task_alone_but_fixes_a_wrong_one(manager):
    """Workspace'e hiç girmemiş normal pencere: görev zaten tam ekranda ise HİÇBİR pencereleme komutu gitmez
    (`skip_if_ok`); yanlış kipteyse düzeltilir; hiçbir durumda uygulama yeniden başlatılmaz."""
    w = await manager.open_window("com.app.c")
    _phone_state(manager, initial="fullscreen", task="task-com.app.c")
    before = len(_shell_calls(manager))
    await manager.handoff_window_to_phone(w.window_id)
    calls = _shell_calls(manager)[before:]
    assert not any("WCT windowing" in c or "--windowingMode" in c for c in calls)
    assert not any("force-stop" in c for c in calls)

    w2 = await manager.open_window("com.app.d")
    state = _phone_state(manager, initial="freeform", task="task-com.app.d")
    before = len(_shell_calls(manager))
    await manager.handoff_window_to_phone(w2.window_id)
    calls = _shell_calls(manager)[before:]
    assert "WCT windowing task-com.app.d 1" in calls
    assert state["mode"] == "fullscreen"
    assert not any("force-stop" in c for c in calls)


async def test_freeform_target_that_cannot_be_verified_is_only_logged_never_relaunched(manager):
    """Serbest kip deneysel: doğrulanamazsa uygulama ÖLDÜRÜLMEZ (yalnız tam ekran son çaresi yeniden başlatır)."""
    from app.storage import settings_db

    project = await settings_db.get_project_settings()
    project.phone_handoff_windowing = "freeform"
    await settings_db.save_project_settings(project)
    a = await manager.open_window_in_workspace("com.app.a")
    _phone_state(manager, stubborn=True, initial="fullscreen")  # hedef freeform ama kip hiç değişmiyor
    before = len(_shell_calls(manager))

    await manager.handoff_window_to_phone(a.window_id)

    calls = _shell_calls(manager)[before:]
    assert calls.count("WCT windowing task-com.app.a 5 108,240,972,2160") == 3
    assert not any("force-stop" in c for c in calls)
    assert manager.get_session(a.window_id).state.locus == "phone"


async def test_popout_settles_fullscreen_on_the_new_display_and_never_relaunches(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.open_window_in_workspace("com.app.b")
    _phone_state(manager, stubborn=True)
    before = len(_shell_calls(manager))

    await manager.popout_window_to_desktop(a.window_id)

    calls = _shell_calls(manager)[before:]
    move = next(i for i, c in enumerate(calls) if c.startswith("am display move-stack task-com.app.a"))
    cleanup = next(i for i, c in enumerate(calls) if c == "WCT windowing task-com.app.a 1")
    assert move < cleanup
    assert not any("force-stop" in c for c in calls)  # popout'ta yıkıcı adım yok (yalnız rapor)
    assert manager.get_session(a.window_id).state.workspace_id is None


def test_phone_handoff_windowing_setting_defaults_to_fullscreen_and_rejects_garbage():
    from pydantic import ValidationError

    from app.schemas.settings import ProjectSettings

    assert ProjectSettings().phone_handoff_windowing == "fullscreen"
    assert ProjectSettings(phone_handoff_windowing="freeform").phone_handoff_windowing == "freeform"
    with pytest.raises(ValidationError):
        ProjectSettings(phone_handoff_windowing="saçma")


# ---------------------------------------------------------------- heal_links: bağlantı koptu, ölen YERİNDE yeniden kurulur

def _kill(session):
    session.server.stopped = True  # _FakeScrcpyServer.is_alive → not stopped


async def test_heal_links_leaves_live_windows_completely_untouched(manager):
    """Canlı pencere kapanıp yeni kimlikle doğmamalı (her scrcpy açılışı telefonu da uyandırır)."""
    a = await manager.open_window("com.app.a")
    server_a = manager.get_session(a.window_id).server
    log_before = list(_FakeScrcpyServer.call_log)

    assert await manager.heal_links() == 0

    assert manager.get_session(a.window_id).server is server_a and not server_a.stopped
    assert _FakeScrcpyServer.call_log == log_before  # hiçbir sunucu durdurulmadı


async def test_heal_links_rebuilds_the_dead_window_in_place_and_skips_what_is_frozen_on_purpose(manager):
    from app.schemas import VisibilityState

    manager._profile.encoder_limit = 3
    a = await manager.open_window("com.app.a")
    minimized = await manager.open_window("com.app.c")
    await manager.set_visibility(minimized.window_id, VisibilityState.MINIMIZED)  # bilerek donuk
    parked = await manager.open_window("com.app.b")
    manager.get_session(parked.window_id).state.handoff_to_phone = True  # kullanıcı telefonda tutuyor
    for wid in (a.window_id, parked.window_id):
        _kill(manager.get_session(wid))
    queue = await manager._test_events.subscribe()

    assert await manager.heal_links() == 0

    assert {w.window_id for w in manager.list_windows()} == {a.window_id, parked.window_id, minimized.window_id}  # kimlikler AYNI
    healed = manager.get_session(a.window_id)
    assert healed.server.is_alive and healed.state.frozen is False
    assert not manager.get_session(parked.window_id).server.is_alive  # telefondakine dokunulmadı
    assert manager.get_session(minimized.window_id).state.minimized is True
    assert [e.type for e in await _drain(queue) if e.type.startswith("window_")] == ["window_frozen", "window_unfrozen"]


async def test_heal_links_keeps_a_window_whose_rebuild_failed_frozen_and_reports_it(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    _kill(manager.get_session(a.window_id))
    monkeypatch.setattr(manager._reconfigure, "unfreeze", AsyncMock(side_effect=RuntimeError("telefon hazır değil")))

    assert await manager.heal_links() == 1  # supervisor yeniden dener

    assert manager.get_session(a.window_id).state.frozen is True  # son kareyle donuk; pencere ve kimliği yerinde


async def test_heal_links_returns_the_workspace_members_with_their_ids_and_slots(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    slot = manager._eco_workspace.get_task(a.window_id).bounds
    assert await manager.heal_links() == 0  # çapa canlı → hiçbir şey

    manager._eco_workspace.server.stopped = True  # paylaşımlı VD bağlantıyla birlikte öldü
    assert await manager.heal_links() == 0

    assert manager.get_session(a.window_id) is not None  # üye kapanmadı, aynı kimlikle
    assert manager._eco_workspace.get_task(a.window_id).bounds == slot  # yeri korundu
    assert manager._eco_workspace.server.is_alive


async def test_heal_links_leaves_a_phone_parked_workspace_member_alone(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)  # telefona park: sunucusu BİLEREK yok
    before = len(_shell_calls(manager))

    assert await manager.heal_links() == 0

    assert manager.get_session(a.window_id).state.locus == "phone"
    assert not any("force-stop" in c for c in _shell_calls(manager)[before:])  # telefondaki uygulama öldürülmedi


async def test_video_packets_is_the_pulse_of_streaming_windows_only(manager):
    assert manager.video_packets() is None  # akan bir şey yok → takılacak bir şey de yok
    a = await manager.open_window("com.app.a")
    manager._broadcasters.get(a.window_id).packets_total = 7
    assert manager.video_packets() == 7

    manager.get_session(a.window_id).state.frozen = True  # donuk pencere akış değildir
    assert manager.video_packets() is None


async def _true():
    return True


async def _false():
    return False


async def _end_pump(manager, session):
    """Runs the session's video pump over a stream that has already ended (its server is killed by the caller)."""
    reader = asyncio.StreamReader()
    reader.feed_eof()
    session.server._sockets.video = (reader, None)
    manager._reconfigure.start_video_pump(session)
    await session.pump_task


@pytest.mark.parametrize("link_dropped", [True, False])
async def test_a_pump_that_ends_with_the_link_is_neither_a_handoff_nor_a_ghost_anchor(manager, monkeypatch, link_dropped):
    """Telefonun ölen sanal ekranın uygulamalarını kendi ekranına taşıması 'telefonda açıldı' değildir; bağlantı sağlamsa
    (VD gerçekten çöktüyse) eski davranış: devir kontrolü, hayalet çapa/üye temizliği."""
    a = await manager.open_window("com.app.a")
    member = await manager.open_window_in_workspace("com.app.b")
    handoff = AsyncMock()
    monkeypatch.setattr(manager._handoff, "on_pump_ended", handoff)
    manager.set_link_probe(_true if link_dropped else _false)

    for session in (manager.get_session(a.window_id), manager._eco_workspace._anchor):
        _kill(session)
        await _end_pump(manager, session)

    assert (handoff.await_count == 0) is link_dropped
    assert (manager._eco_workspace.get_task(member.window_id) is not None) is link_dropped  # üyeler korunur / hayalet düşer
    assert manager._handoff.paused is link_dropped  # devir algılaması, heal_links kaldırana dek tutulur
    assert await manager.heal_links() == 0 and manager._handoff.paused is False


async def test_adopt_routes_by_where_the_app_currently_lives(manager):
    # 1) hiçbir yerde açık değil, telefonda çalışıyor → Workspace'e alınır
    handle = await manager.adopt_phone_app_into_workspace("com.app.a")
    assert handle.workspace_id == "eco"
    assert manager.get_session(handle.window_id).state.locus == "workspace"
    # 2) zaten canlı bir Workspace üyesi → hata (sessizce ikinci kopya açılmaz)
    with pytest.raises(RuntimeError):
        await manager.adopt_phone_app_into_workspace("com.app.a")
    # 3) park edilmiş üye → phone_to_workspace
    await manager.handoff_window_to_phone(handle.window_id)
    again = await manager.adopt_phone_app_into_workspace("com.app.a")
    assert again.window_id == handle.window_id
    assert manager.get_session(handle.window_id).state.locus == "workspace"


async def test_vd_crash_drops_live_members_but_keeps_parked_ones(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    b = await manager.open_window_in_workspace("com.app.b")
    await manager.handoff_window_to_phone(a.window_id)
    anchor_id = b.ws_url.split("/")[-1]
    q = await manager._test_events.subscribe()

    manager._eco_workspace.notify_anchor_pump_terminated(anchor_id)
    await asyncio.sleep(0.01)

    assert manager.get_session(b.window_id) is None                       # canlı üye VD ile öldü
    assert manager.get_session(a.window_id) is not None                   # park edilmiş yaşıyor
    assert manager._eco_workspace.get_task(a.window_id).parked is True
    assert "workspace_task_removed" in [e.type for e in await _drain(q)]


async def test_popout_of_a_parked_member_is_refused_until_it_returns_to_the_workspace(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)

    with pytest.raises(RuntimeError):
        await manager.popout_window_to_desktop(a.window_id)

    await manager.reclaim_window(a.window_id)
    popped = await manager.popout_window_to_desktop(a.window_id)      # dönünce serbest
    assert manager.get_session(popped.window_id).state.locus == "desktop"


async def test_reopening_a_handed_off_window_does_not_deadlock_on_its_own_lock(manager):
    """Mevcut kodda (bu plandan bağımsız, ayrı bir hata): open_window() kilidi tutarken
    _reuse_existing_window_if_open() public reclaim_window()'u çağırıp AYNI kilidi tekrar
    alıyordu — asyncio.Lock reentrant değil, çağrı sonsuza dek asılıyordu."""
    a = await manager.open_window("com.app.a")
    manager.get_session(a.window_id).state.handoff_to_phone = True

    handle = await asyncio.wait_for(manager.open_window("com.app.a"), timeout=3)

    assert handle.window_id == a.window_id
    assert manager.get_session(a.window_id).state.handoff_to_phone is False


async def test_reopening_a_package_whose_workspace_member_is_parked_brings_it_back_not_kills_it(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)      # tek üye → paylaşımlı sunucu ölü

    handle = await asyncio.wait_for(manager.open_window("com.app.a"), timeout=3)

    assert handle.window_id == a.window_id                                   # kapatıp yeniden açmadı
    assert not any("force-stop" in c for c in manager._adb.shell_calls)      # telefondaki uygulama ÖLDÜRÜLMEDİ
    assert manager.get_session(a.window_id).state.locus == "workspace"
    assert handle.ws_url == manager.get_session(a.window_id).state.ws_url    # anchor akışı, /ws/video/{üye_id} DEĞİL


# ---------------------------------------------------------------- sahipsiz scrcpy sunucusu temizleyicisi
# Canlı cihazda görüldü: arayüzde tek pencere varken telefonda, backend'e bağlı ikinci bir scrcpy
# sunucusu (kendi sanal ekranı + encoder'ı ile) 6+ dk yaşıyordu.

class _TrackedServer:
    def __init__(self, scid="deadbeef", age_s=120.0, alive=True):
        import time as _t
        self.scid = scid
        self.display_id = "77"
        self.spawned_at = _t.monotonic() - age_s
        self.created_by = "test"
        self._alive = alive
        self.stopped = False

    @property
    def is_alive(self):
        return self._alive and not self.stopped

    async def stop(self, **_kw):
        self.stopped = True


def _track(server):
    from app.windows import scrcpy_launcher
    scrcpy_launcher._LIVE_SERVERS.add(server)
    return server


@pytest.fixture(autouse=True)
def _isolated_live_server_registry():
    """Modül düzeyi izleme kümesi testler arası sızmasın (önceki testlerin sahte sunucuları GC'lenmemiş olabilir)."""
    from app.windows import scrcpy_launcher
    scrcpy_launcher._LIVE_SERVERS.clear()
    yield
    scrcpy_launcher._LIVE_SERVERS.clear()


async def test_reaper_stops_a_live_server_that_nothing_owns(manager):
    a = await manager.open_window_in_workspace("com.app.a")
    orphan = _track(_TrackedServer("orphan01"))

    reaped = await manager.reap_orphan_servers()

    assert reaped == ["orphan01"] and orphan.stopped
    assert manager.get_session(a.window_id) is not None        # sahipli olanlara dokunulmadı
    assert manager._eco_workspace.server.is_alive


async def test_reaper_never_touches_servers_owned_by_sessions_workspace_or_audio(manager):
    independent = await manager.open_window("com.app.b")
    await manager.open_window_in_workspace("com.app.a")
    audio = _track(_TrackedServer("audio001"))
    manager._session_audio.active_server = audio
    owned = [
        _track(manager.get_session(independent.window_id).server),
        _track(manager._eco_workspace.server),
    ]

    reaped = await manager.reap_orphan_servers(min_age_s=0)

    assert reaped == []
    assert all(getattr(s, "stopped", False) is False for s in owned + [audio])


async def test_reaper_leaves_a_freshly_spawned_server_alone(manager):
    """open/dock/popout sırasında henüz oturuma bağlanmamış yeni bir sunucu 'sahipsiz' görünebilir."""
    young = _track(_TrackedServer("young001", age_s=1.0))

    assert await manager.reap_orphan_servers() == []
    assert not young.stopped


async def test_reaper_ignores_servers_that_are_already_dead(manager):
    dead = _track(_TrackedServer("dead0001", alive=False))

    assert await manager.reap_orphan_servers(min_age_s=0) == []
    assert not dead.stopped


async def test_real_scrcpy_server_registers_itself_on_spawn_and_leaves_the_registry_when_gone():
    from app.windows import scrcpy_launcher as sl

    class _Stdout:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class _Proc:
        returncode = None
        stdout = _Stdout()

        async def wait(self):
            return 0

        def terminate(self):
            self.returncode = 0

        def kill(self):
            self.returncode = -9

    class _Adb:
        async def spawn_shell(self, *_a, **_kw):
            return _Proc()

    srv = sl.ScrcpyServer(_Adb(), Settings(), "SER")
    assert srv not in sl.live_servers()

    await srv.spawn(control=True)

    assert srv in sl.live_servers()
    assert srv.spawned_at is not None and "test_real_scrcpy" in srv.created_by   # yaratan izlenebilir
    srv._process.returncode = 0                                # süreç öldü
    assert srv not in sl.live_servers()


# ---------------------------------------------------------------- DPI uzlaştırma (density_reconciler.py)

def _spy_on_density(manager, monkeypatch, package):
    """Records the reconciler calls the teleporter makes; the phone reports its 520 dpi so the Workspace's density
    (ECO_WORKSPACE_DPI) differs from it."""
    from unittest.mock import AsyncMock, MagicMock

    from app.windows.density_reconciler import ProcessIdentity, Snapshot

    monkeypatch.setattr("app.device.android_shell.phone_density", AsyncMock(return_value=520))
    manager._density.snapshot = AsyncMock(return_value=Snapshot(package, ProcessIdentity(4000, 1)))
    manager._density.schedule_settle = MagicMock()
    return manager._density


async def test_workspace_to_phone_settles_the_process_that_left_the_workspace_density(manager, monkeypatch):
    a = await manager.open_window_in_workspace("com.app.a")
    density = _spy_on_density(manager, monkeypatch, "com.app.a")

    await manager.handoff_window_to_phone(a.window_id)

    density.snapshot.assert_awaited_once_with("com.app.a")
    density.schedule_settle.assert_called_once()
    args, kwargs = density.schedule_settle.call_args
    assert args[0] == a.window_id and args[1] == "com.app.a"
    assert kwargs["display"] == "0" and kwargs["reason"] == "workspace_to_phone"


async def test_workspace_to_phone_last_resort_relaunch_needs_no_settle(manager, monkeypatch):
    """The last-resort path force-stops and relaunches the app on the phone: a brand-new process, born under the
    phone's density — restarting it again would be pure damage."""
    monkeypatch.setattr(task_teleporter_module.TaskTeleporter, "_RELAUNCH_WAIT_S", 0)
    a = await manager.open_window_in_workspace("com.app.a")
    _phone_state(manager, stubborn=True)
    density = _spy_on_density(manager, monkeypatch, "com.app.a")

    await manager.handoff_window_to_phone(a.window_id)

    density.schedule_settle.assert_not_called()


async def test_phone_to_workspace_settles_on_the_workspace_display(manager, monkeypatch):
    a = await manager.open_window_in_workspace("com.app.a")
    await manager.handoff_window_to_phone(a.window_id)
    density = _spy_on_density(manager, monkeypatch, "com.app.a")

    await manager.reclaim_window(a.window_id)

    density.schedule_settle.assert_called_once()
    args, kwargs = density.schedule_settle.call_args
    assert args[1] == "com.app.a" and kwargs["reason"] == "phone_to_workspace"
    assert callable(kwargs["display"])  # the Workspace VD may have been rebuilt: resolved when the decision is made


async def test_workspace_move_without_a_density_difference_takes_no_snapshot(manager, monkeypatch):
    from unittest.mock import AsyncMock

    a = await manager.open_window_in_workspace("com.app.a")
    density = _spy_on_density(manager, monkeypatch, "com.app.a")
    monkeypatch.setattr(
        "app.device.android_shell.phone_density",
        AsyncMock(return_value=manager._settings.ECO_WORKSPACE_DPI),  # phone and Workspace already agree
    )

    await manager.handoff_window_to_phone(a.window_id)

    density.snapshot.assert_not_awaited()
    density.schedule_settle.assert_not_called()


async def test_workspace_to_phone_and_back_returns_freeform_in_its_box_not_fullscreen(manager):
    """The field report end to end: a Workspace window (freeform) is sent to the phone (fullscreen) and brought back —
    it came back FULLSCREEN inside the Workspace. The phone pins the task's requested mode to fullscreen; the return
    path's only mode command (`cmd activity task windowing-mode … 5`) does not exist on Android, and `am start
    --windowingMode 5` does not change an existing task. Now the return sets freeform and the window's box in one
    transaction."""
    a = await manager.open_window_in_workspace("com.app.a")
    box = manager._eco_workspace.get_task(a.window_id).bounds
    state = _phone_state(manager)

    await manager.handoff_window_to_phone(a.window_id)
    assert state["mode"] == "fullscreen"                      # on the phone

    before = len(_shell_calls(manager))
    await manager.reclaim_window(a.window_id)
    calls = _shell_calls(manager)[before:]

    assert state["mode"] == "freeform"                        # back as a window
    wct = [c for c in calls if c.startswith("WCT windowing task-com.app.a 5 ")]
    assert wct, calls
    assert not any("task windowing-mode" in c for c in calls)  # the nonexistent shell command is gone
    assert manager.get_session(a.window_id).state.locus == "workspace"
    assert manager._eco_workspace.get_task(a.window_id).parked is False
    assert tuple(manager._eco_workspace.get_task(a.window_id).bounds) == tuple(box)
