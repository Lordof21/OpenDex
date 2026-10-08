"""Eco Workspace — GERÇEK (dumpsys) bounds'un kaydedilip yayınlandığının
kanıtı (Değişmez I5).

Android, `--activity-launch-bounds` / `am task resize` ile İSTENEN kutuyu
aynen vermek zorunda değildir (min genişlik, insets, aspect kısıtları).
Eskiden kod dumpsys'ten gerçek kutuyu okuyup SADECE logluyor, sonra
İSTENEN kutuyu kaydediyordu — bu, React çerçevesinin videodaki gerçek
pencereyi tutmamasının ikinci bağımsız sebebiydi.

Bu dosyadaki her test, düzeltme öncesi kodda BAŞARISIZ olur.
"""
import pytest

from app.windows.eco_workspace import (
    EcoWorkspaceManager,
    android_to_visible_bounds,
    visible_to_android_bounds,
)


class _FakeVideoMeta:
    width = 1600
    height = 900


class _FakeSockets:
    video_meta = _FakeVideoMeta()
    control = object()  # a real server always opens its control socket


class _FakeScrcpyServer:
    def __init__(self, *_a, **_kw):
        self.display_id = "9"
        self.is_alive = True
        self.sockets = _FakeSockets()
        self.stopped = False

    async def push_server(self): ...
    async def start_forward(self): ...
    async def spawn(self, **_kw): ...

    async def connect_sockets(self, **_kw):
        return self.sockets

    async def stop(self, **_kw):
        self.stopped = True


class _FakeAdb:
    """`dumpsys activity activities` çağrısına, Android'in GERÇEKTEN verdiği
    (istenenden FARKLI) bir kutu döndürür — asıl senaryonun ta kendisi."""

    def __init__(self, dumpsys_bounds="80, 80 - 700, 500"):
        self.shell_calls = []
        self._dumpsys_bounds = dumpsys_bounds

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.shell_calls.append(cmd)
        if cmd.startswith("dumpsys activity activities"):
            if self._dumpsys_bounds is None:
                return ""  # okunamadı senaryosu
            return f"mBounds=Rect({self._dumpsys_bounds})"
        return ""

    async def run(self, *_a, **_kw):
        return ""


class _FakeEvents:
    def __init__(self):
        self.emitted = []

    async def emit(self, type, **payload):
        self.emitted.append((type, payload))

    def payload_of(self, event_type):
        for t, p in self.emitted:
            if t == event_type:
                return p
        return None


class _FakePump:
    def __call__(self, session):
        import asyncio
        session.pump_task = asyncio.ensure_future(asyncio.sleep(3600))


class _FakeSettings:
    ECO_WORKSPACE_DISPLAY_W = 1920
    ECO_WORKSPACE_DISPLAY_H = 1080
    ECO_WORKSPACE_DPI = 160
    DEFAULT_VIDEO_BIT_RATE = 8_000_000
    DEFAULT_MAX_FPS = 60


@pytest.fixture(autouse=True)
def _patch_scrcpy(monkeypatch):
    import app.windows.eco_workspace as mod
    monkeypatch.setattr(mod, "ScrcpyServer", _FakeScrcpyServer)


@pytest.fixture(autouse=True)
def _patch_navigator(monkeypatch):
    import app.device.deep_navigator as nav

    async def _find(adb, pkg, display_id=None, serial=None):
        return "task-1"

    async def _resolve(adb, serial, pkg):
        return f"{pkg}/.MainActivity"

    monkeypatch.setattr(nav, "find_task_id_for_package", _find)
    monkeypatch.setattr(nav, "_resolve_default_launcher_activity", _resolve)


def _mgr(adb, events, profile=None, daemon=None):
    return EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions={},
        serial_getter=lambda: "SER1", profile_getter=lambda: profile,
        start_video_pump=_FakePump(), daemon_client_getter=lambda: daemon,
    )


# ------------------------------------------------------------------ open

@pytest.mark.asyncio
async def test_open_kaydedilen_bounds_dumpsysteki_GERCEK_kutudur():
    """I5: Android 700x500 verdiyse, istenen 880x680 DEĞİL o kaydedilmeli."""
    adb = _FakeAdb(dumpsys_bounds="80, 80 - 700, 500")
    events = _FakeEvents()
    mgr = _mgr(adb, events)

    _, _, _, effective = await mgr.open_in_workspace("com.app.a", "win-1")

    assert effective == (80, 80, 700, 500), "istenen kutu değil, GERÇEK kutu dönmeli"
    assert mgr.get_task("win-1").bounds == (80, 80, 700, 500)


@pytest.mark.asyncio
async def test_open_workspace_task_added_eventi_GERCEK_bounds_tasir():
    """I5: Frontend çerçeveyi bu event'ten çiziyor — istenen kutu gönderilirse
    çerçeve gerçek pencereden büyük kalır."""
    adb = _FakeAdb(dumpsys_bounds="80, 80 - 700, 500")
    events = _FakeEvents()
    mgr = _mgr(adb, events)

    await mgr.open_in_workspace("com.app.a", "win-1")

    payload = events.payload_of("workspace_task_added")
    assert payload["bounds"] == [80, 80, 700, 500]


@pytest.mark.asyncio
async def test_open_dumpsys_okunamazsa_istenen_bounds_a_duser():
    """Zarif düşüş: gerçek kutu okunamıyorsa hiç kutu olmamasındansa
    istenen kutu kullanılır."""
    adb = _FakeAdb(dumpsys_bounds=None)
    events = _FakeEvents()
    mgr = _mgr(adb, events)

    _, _, _, effective = await mgr.open_in_workspace("com.app.a", "win-1")

    assert effective == mgr.DEFAULT_BOUNDS


@pytest.mark.asyncio
async def test_open_cok_kucuk_dumpsys_kutusu_yok_sayilir():
    """`_get_task_actual_bounds` 100px altı kutuları (sistem insets / status
    bar artıkları) filtreler — bunlar gerçek pencere değildir."""
    adb = _FakeAdb(dumpsys_bounds="0, 0 - 60, 40")
    events = _FakeEvents()
    mgr = _mgr(adb, events)

    _, _, _, effective = await mgr.open_in_workspace("com.app.a", "win-1")

    assert effective == mgr.DEFAULT_BOUNDS


# ------------------------------------------------------------------ resize

@pytest.mark.asyncio
async def test_resize_sonrasi_task_bounds_GERCEK_kutuya_snap_eder():
    """I5: Sürükleme bitince çerçeve, Android'in verdiği kutuya oturmalı."""
    adb = _FakeAdb(dumpsys_bounds="10, 20 - 480, 390")
    events = _FakeEvents()
    mgr = _mgr(adb, events)
    await mgr.open_in_workspace("com.app.a", "win-1")

    effective = await mgr.resize_task("win-1", (10, 20, 500, 400))  # istenen

    assert mgr.get_task("win-1").bounds == (10, 20, 480, 390), "gerçek kutuya snap etmeli"
    assert effective == (10, 20, 480, 390), "çağıran (kırpma penceresi) kendini verilen kutuya uydurur"
    assert await mgr.resize_task("yok", (0, 0, 10, 10)) is None


@pytest.mark.asyncio
async def test_resize_task_applies_density_before_reading_effective_bounds(monkeypatch):
    """Regression ("300x300 yapıyorum, commit gidiyor, sonra pencere kendini
    400x400 gibi büyütüyor"): density (WCT setDensityDpi) must land BEFORE
    the resize shell commands and the effective-bounds readback. Applying it
    AFTER (the old order) meant Android's own minimum-resizable-task-size
    enforcement — evaluated in dp, so a higher density shrinks how many
    pixels satisfy it — could grow the task a SECOND time once the density
    change landed a beat later, with no event ever telling the frontend
    about that second resize."""
    call_log = []

    class _RecordingAdb(_FakeAdb):
        async def shell(self, cmd, *, serial, timeout_s=3.0):
            call_log.append(("adb_shell", cmd))
            return await super().shell(cmd, serial=serial, timeout_s=timeout_s)

    class _FakeDaemonForDensity:
        is_connected = True

        async def set_task_density(self, task_id, density):
            call_log.append(("daemon_set_density", density))
            return True

    adb = _RecordingAdb(dumpsys_bounds="10, 20 - 480, 390")
    events = _FakeEvents()
    mgr = _mgr(adb, events, daemon=_FakeDaemonForDensity())
    await mgr.open_in_workspace("com.app.a", "win-1")
    call_log.clear()

    await mgr.resize_task("win-1", (10, 20, 500, 400), density=300)

    density_idx = next(i for i, (kind, _) in enumerate(call_log) if kind == "daemon_set_density")
    resize_idx = next(i for i, (kind, val) in enumerate(call_log) if kind == "adb_shell" and "task resize" in val)
    assert density_idx < resize_idx, (
        f"density must be applied before the resize/bounds-readback shell commands, got order: {call_log}"
    )
    assert mgr.get_task("win-1").density == 300


@pytest.mark.asyncio
async def test_resize_bounds_changed_eventi_GERCEK_kutuyu_yayinlar():
    adb = _FakeAdb(dumpsys_bounds="10, 20 - 480, 390")
    events = _FakeEvents()
    mgr = _mgr(adb, events)
    await mgr.open_in_workspace("com.app.a", "win-1")
    events.emitted.clear()

    await mgr.resize_task("win-1", (10, 20, 500, 400))

    payload = events.payload_of("workspace_task_bounds_changed")
    assert payload["bounds"] == [10, 20, 480, 390]


# ------------------------------------------------------------------ yoğunluk KİPİ

class _DensityDaemon:
    is_connected = True

    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    async def set_task_density(self, task_id, density):
        self.calls.append((str(task_id), int(density)))
        return self.ok


@pytest.mark.asyncio
async def test_density_kipi_varsayilan_auto(monkeypatch):
    mgr = _mgr(_FakeAdb(), _FakeEvents())
    await mgr.open_in_workspace("com.app.a", "win-1")

    assert mgr.get_task("win-1").density_mode == "auto"


@pytest.mark.asyncio
async def test_resize_task_density_kipini_sunucuda_saklar(monkeypatch):
    """Sub-PiP ayrı bir JS dünyasında yaşar; görevin yoğunluğunu kullanıcı sabitlediyse (manual) yeniden
    boyutlandırma bunu ezmemeli. Bu karar ön yüz belleğinde değil, SUNUCUDA tutulur."""
    daemon = _DensityDaemon()
    events = _FakeEvents()
    mgr = _mgr(_FakeAdb(dumpsys_bounds="10, 20 - 480, 390"), events, daemon=daemon)
    await mgr.open_in_workspace("com.app.a", "win-1")
    task = mgr.get_task("win-1")

    await mgr.resize_task("win-1", (10, 20, 500, 400), density=300, density_mode="manual")
    assert (task.density, task.density_mode) == (300, "manual")
    assert events.payload_of("workspace_task_density_changed")["density_mode"] == "manual"

    # yoğunluk değişmeden yalnız kip değişebilir ("Auto" hazır ayarı hesaplanan değeri aynen seçtiğinde)
    daemon.calls.clear()
    await mgr.resize_task("win-1", (10, 20, 500, 400), density=300, density_mode="auto")
    assert (task.density, task.density_mode) == (300, "auto")
    assert daemon.calls == []  # aynı yoğunluk için daemon'a gereksiz RPC gitmez

    # yoğunluk/kip verilmeyen boyutlandırma kipi DEĞİŞTİRMEZ
    await mgr.resize_task("win-1", (10, 20, 500, 400))
    assert (task.density, task.density_mode) == (300, "auto")


@pytest.mark.asyncio
async def test_yogunluk_uygulanamazsa_kip_de_degismez(monkeypatch):
    mgr = _mgr(_FakeAdb(dumpsys_bounds="10, 20 - 480, 390"), _FakeEvents(), daemon=_DensityDaemon(ok=False))
    await mgr.open_in_workspace("com.app.a", "win-1")
    task = mgr.get_task("win-1")

    await mgr.resize_task("win-1", (10, 20, 500, 400), density=300, density_mode="manual")
    assert task.density is None
    assert task.density_mode == "auto"  # uygulanmayan bir "manual" kaydedilmez


@pytest.mark.asyncio
async def test_set_task_density_kip_parametresi(monkeypatch):
    mgr = _mgr(_FakeAdb(), _FakeEvents(), daemon=_DensityDaemon())
    await mgr.open_in_workspace("com.app.a", "win-1")

    assert await mgr.set_task_density("win-1", 240) is True  # açık kullanıcı seçimi: varsayılan manual
    assert mgr.get_task("win-1").density_mode == "manual"

    assert await mgr.set_task_density("win-1", 200, mode="auto") is True
    assert mgr.get_task("win-1").density_mode == "auto"

    await mgr.set_task_density("win-1", 210, mode="saçma")  # geçersiz kip yok sayılır
    assert mgr.get_task("win-1").density_mode == "auto"


# ------------------------------------------------------------------ dock

@pytest.mark.asyncio
async def test_attach_existing_task_da_GERCEK_bounds_kullanir():
    """I5: Dock yolu da aynı sözleşmeye uymalı — tek yerde düzeltip
    diğerini unutmak, hatanın yarısının yaşamaya devam etmesi demek."""
    adb = _FakeAdb(dumpsys_bounds="20, 20 - 520, 420")
    events = _FakeEvents()
    mgr = _mgr(adb, events)

    _, _, _, effective = await mgr.attach_existing_task(
        "com.app.b", "win-b", "task-42", bounds=(20, 20, 600, 500),
    )

    assert effective == (20, 20, 520, 420)
    assert mgr.get_task("win-b").bounds == (20, 20, 520, 420)
    assert events.payload_of("workspace_task_added")["bounds"] == [20, 20, 520, 420]


@pytest.mark.asyncio
async def test_attach_waits_until_android_has_placed_the_task():
    """Phone -> Workspace: the first readings still show the phone's full screen; the box is the one two readings agree on."""
    readings = iter(["0, 0 - 1220, 2712"] * 2 + ["20, 20 - 520, 420"] * 10)

    class _MovingAdb(_FakeAdb):
        async def shell(self, cmd, *, serial, timeout_s=3.0):
            return f"mBounds=Rect({next(readings)})" if cmd.startswith("dumpsys activity activities") else ""

    _, _, _, effective = await _mgr(_MovingAdb(), _FakeEvents()).attach_existing_task("com.app.b", "win-b", "task-42", bounds=(20, 20, 520, 420))
    assert effective == (20, 20, 520, 420)


@pytest.mark.asyncio
async def test_unpark_restores_the_workspace_density_before_the_bounds_are_read():
    order = []

    class _Daemon:
        is_connected = True

        async def set_task_density(self, task_id, density):
            order.append("density")
            return True

        async def get_task_geometry(self, task_id):
            order.append("geometry")
            return {"ok": True, "bounds": [20, 20, 520, 420]}

    events = _FakeEvents()
    mgr = _mgr(_FakeAdb(), events, daemon=_Daemon())
    await mgr.open_in_workspace("com.app.a", "win-1")
    await mgr.set_task_density("win-1", 300)
    mgr._tasks["win-1"].parked = True
    order.clear()
    await mgr.unpark_task("win-1", "task-9")
    assert order.index("density") < order.index("geometry") and mgr.get_task("win-1").density == 300


# ------------------------------------------------------------------ VD boyutu sözleşmesi

@pytest.mark.asyncio
async def test_donen_stream_boyutu_VD_boyutundan_FARKLI_olabilir():
    """I1/I2'nin backend ayağı: stream (1600x900) ile VD (1920x1080) iki
    AYRI büyüklük. Bu testin varlığı, ikisinin aynı sanılmasını engeller."""
    adb = _FakeAdb()
    mgr = _mgr(adb, _FakeEvents())

    _, stream_w, stream_h, _ = await mgr.open_in_workspace("com.app.a", "win-1")

    assert (stream_w, stream_h) == (1600, 900)
    assert (stream_w, stream_h) != (
        _FakeSettings.ECO_WORKSPACE_DISPLAY_W,
        _FakeSettings.ECO_WORKSPACE_DISPLAY_H,
    ), "stream ile VD kasıtlı olarak farklı — testin anlamı buna dayanıyor"


# ------------------------------------------------------------------ Xiaomi HyperOS / Freeform Scale Bridge

def test_visible_and_android_bounds_scaling_math():
    """Xiaomi 0.70x ve standart 1.0x ölçekleme matematiği testi."""
    # 1.0x (standart AOSP)
    assert visible_to_android_bounds((100, 100, 900, 700), 1.0) == (100, 100, 900, 700)
    assert android_to_visible_bounds((100, 100, 900, 700), 1.0) == (100, 100, 900, 700)

    # 0.70x (Xiaomi HyperOS / MIUI)
    # UI: 800x600 -> Android: round(800 / 0.7) = 1143, round(600 / 0.7) = 857
    android_box = visible_to_android_bounds((100, 100, 900, 700), 0.7)
    assert android_box == (100, 100, 1243, 957)

    # Android: 1143x857 -> UI: round(1143 * 0.7) = 800, round(857 * 0.7) = 600
    visible_box = android_to_visible_bounds(android_box, 0.7)
    assert visible_box == (100, 100, 900, 700)


@pytest.mark.asyncio
async def test_xiaomi_hyperos_freeform_scale_resizes_task_and_emits_visible_bounds():
    """Xiaomi HyperOS cihazlarda (scale=0.7) UI visible bounds Android'e
    genişletilerek (1/0.7) gönderilmeli, dumpsys'ten okunan ise UI görünür bounds'una
    çevrilerek emit edilmelidir."""
    class _FakeProfile:
        android_id = "XIAOMI_1"
        supports_launch_bounds = True
        freeform_scale = 0.7

    adb = _FakeAdb(dumpsys_bounds="100, 100 - 1243, 957")
    events = _FakeEvents()
    profile = _FakeProfile()
    mgr = _mgr(adb, events, profile=profile)

    await mgr.open_in_workspace("com.app.a", "win-1", bounds=(100, 100, 900, 700))
    events.emitted.clear()

    await mgr.resize_task("win-1", (100, 100, 900, 700))

    # Android'e giden am task resize komutu 1143x857 (100 100 1243 957) boyutunda olmalı
    resize_cmds = [c for c in adb.shell_calls if "task resize" in c]
    assert any("100 100 1243 957" in c for c in resize_cmds), f"Android'e ölçeklenmiş bounds gitmeli: {resize_cmds}"

    # Dumpsys'ten okunan 1143x857, UI'a 800x600 visible bounds olarak dönmeli
    payload = events.payload_of("workspace_task_bounds_changed")
    assert payload["bounds"] == [100, 100, 900, 700], "UI'a visible bounds gitmeli, Android raw bounds değil"
    assert mgr.get_task("win-1").bounds == (100, 100, 900, 700)


def test_subpixel_rounding_rule():
    """Bölüm 1.2: Başlangıç ofsetlerinde floor, boyutlarda round kuralı doğrulanmalıdır."""
    # Float ofsetler ve boyutlar:
    # left=100.8 -> floor=100, top=50.9 -> floor=50, w=800.4 -> round=800, h=600.2 -> round=600
    res = visible_to_android_bounds((100.8, 50.9, 901.2, 651.1), scale=1.0)
    assert res == (100, 50, 900, 650)

    # 0.70x leashing ile subpixel:
    # w=800.4, h=600.2 -> w/0.7 = 1143.4 -> round=1143, h/0.7 = 857.4 -> round=857
    res_scaled = visible_to_android_bounds((100.8, 50.9, 901.2, 651.1), scale=0.7)
    assert res_scaled == (100, 50, 100 + 1143, 50 + 857)

    # Ters dönüşüm (android_to_visible_bounds)
    vis = android_to_visible_bounds((100.8, 50.9, 100.8 + 1143, 50.9 + 857), scale=0.7)
    assert vis == (100, 50, 100 + 800, 50 + 600)


@pytest.mark.asyncio
async def test_daemon_first_geometry_skips_dumpsys(monkeypatch):
    """Daemon bağlı ve geçerli geometri veriyorsa dumpsys çağrısı yapılmamalı (0ms overhead)."""
    class _FakeDaemon:
        is_connected = True

        async def get_task_geometry(self, task_id):
            return {
                "ok": True,
                "task_id": 42,
                "bounds": [120, 120, 820, 620],
            }

    adb = _FakeAdb(dumpsys_bounds=None)
    events = _FakeEvents()
    mgr = _mgr(adb, events, daemon=_FakeDaemon())

    _, _, _, effective = await mgr.open_in_workspace("com.app.fast", "win-fast", bounds=(100, 100, 800, 600))

    assert effective == (120, 120, 820, 620)
    task = mgr.get_task("win-fast")
    assert task is not None
    assert task.bounds == (120, 120, 820, 620)
    # Workspace görevleri kırpılmaz: caption/bottom-inset alanları HİÇ taşınmaz.
    assert not hasattr(task, "caption_height") and not hasattr(task, "bottom_inset")
    # dumpsys activity activities çağrısı yapılmadığından emin ol
    dumpsys_calls = [c for c in adb.shell_calls if "dumpsys activity activities" in c]
    assert len(dumpsys_calls) == 0, f"Daemon varken dumpsys çağrılmamalı: {dumpsys_calls}"


@pytest.mark.asyncio
async def test_daemon_geometry_fallback_to_dumpsys_on_error(monkeypatch):
    """Daemon hata verirse veya bağlanamazsa zarifçe dumpsys'e düşmeli."""
    class _FailingDaemon:
        is_connected = True

        async def get_task_geometry(self, task_id):
            return None

    adb = _FakeAdb(dumpsys_bounds="150, 150 - 750, 550")
    events = _FakeEvents()
    mgr = _mgr(adb, events, daemon=_FailingDaemon())

    _, _, _, effective = await mgr.open_in_workspace("com.app.fb", "win-fb", bounds=(100, 100, 800, 600))

    assert effective == (150, 150, 750, 550)
    task = mgr.get_task("win-fb")
    assert task is not None
    assert task.bounds == (150, 150, 750, 550)
    dumpsys_calls = [c for c in adb.shell_calls if "dumpsys activity activities" in c]
    assert len(dumpsys_calls) > 0, "Daemon başarısız olduğunda dumpsys çağrılmalı"


def test_freeform_start_command_with_and_without_launch_bounds():
    from app.windows.eco_workspace import freeform_start_command

    assert freeform_start_command("7", "com.x/.Main", (10, 20, 500, 400)) == (
        "am start --display 7 --windowingMode 5 --activity-launch-bounds 10,20,500,400 "
        "-f 0x10000000 --activity-reorder-to-front -n com.x/.Main"
    )
    assert freeform_start_command("7", "com.x") == (
        "am start --display 7 --windowingMode 5 -f 0x10000000 --activity-reorder-to-front -n com.x"
    )


@pytest.mark.parametrize(
    "bounds, density, label",
    [((0, 0, 1440, 960), 160, "Masaüstü (≥720dp)"), ((0, 0, 1200, 640), 160, "Tablet (≥600dp)"), ((0, 0, 900, 900), 320, "Telefon (<600dp)")],
)
def test_layout_class(bounds, density, label):
    from app.windows.eco_workspace import layout_class

    w_dp, h_dp, sw_dp, got = layout_class(bounds, density)
    assert sw_dp == min(w_dp, h_dp) and got == label
