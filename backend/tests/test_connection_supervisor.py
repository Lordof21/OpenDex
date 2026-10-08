"""ConnectionSupervisor unit tests: 3-second disconnect grace period & reconnection debouncing."""
import asyncio
import pytest

from app.config import Settings
from app.device.connection_supervisor import MAX_HEAL_ATTEMPTS, ConnectionSupervisor
from app.events import EventBus
from app.schemas import DeviceInfo, DeviceState


class _FakeDeviceManager:
    def __init__(self, devices: list[DeviceInfo] | None = None):
        self.devices = devices or []
        self.get_android_id_calls = []
        self.silent_phone = False

    async def list_devices(self) -> list[DeviceInfo]:
        return self.devices

    async def get_android_id(self, serial: str) -> str:
        self.get_android_id_calls.append(serial)
        if self.silent_phone:
            await asyncio.sleep(10)  # a stalled link: the question is never answered
        return f"ANDROID_{serial}"


class _FakeEvents(EventBus):
    def __init__(self):
        super().__init__()
        self.emitted: list[tuple[str, dict]] = []

    async def emit(self, type: str, **payload):
        self.emitted.append((type, payload))

    def has_event(self, type: str) -> bool:
        return any(t == type for t, _ in self.emitted)


@pytest.mark.asyncio
async def test_momentary_disconnect_within_grace_period_does_not_emit_device_lost():
    """Anlık kesinti (< 3s): Cihaz kısa süre çevrimdışı olup geri döndüğünde
    oturum korunmalı, device_lost YAYINLANMAMALIDIR."""
    serial = "DEV_TEST_1"
    dev_online = DeviceInfo(serial=serial, state=DeviceState.DEVICE)
    dev_mgr = _FakeDeviceManager([dev_online])
    events = _FakeEvents()
    settings = Settings()
    settings.DEVICE_DISCONNECT_GRACE_S = 1.0  # test hızlandırmak için 1s
    settings.DEVICE_POLL_INTERVAL_S = 0.1

    supervisor = ConnectionSupervisor(dev_mgr, events, settings)
    await supervisor.start(serial, "ANDROID_ID_1")
    assert supervisor.connected

    # Cihaz anlık olarak offline olsun (örn. 0.3s)
    dev_mgr.devices = [DeviceInfo(serial=serial, state=DeviceState.OFFLINE)]
    await asyncio.sleep(0.3)

    # Hala tolerans süresi içinde olmalı, bağlantı kopmuş sayılmamalı
    assert supervisor.connected
    assert not events.has_event("device_lost")
    assert supervisor._unreachable_since is not None

    # Cihaz geri geldi!
    dev_mgr.devices = [dev_online]
    await asyncio.sleep(0.5)

    # Oturum sapasağlam devam etmeli
    assert supervisor.connected
    assert not events.has_event("device_lost")
    assert supervisor._unreachable_since is None

    await supervisor.stop()


@pytest.mark.asyncio
async def test_prolonged_disconnect_exceeding_grace_period_triggers_device_lost():
    """Uzun süreli kesinti (> 3s): Cihaz tolerans süresi boyunca geri gelmezse
    bağlantı kopması ilan edilmeli ve device_lost yayınlanmalıdır."""
    serial = "DEV_TEST_2"
    dev_online = DeviceInfo(serial=serial, state=DeviceState.DEVICE)
    dev_mgr = _FakeDeviceManager([dev_online])
    events = _FakeEvents()
    settings = Settings()
    settings.DEVICE_DISCONNECT_GRACE_S = 0.5  # test için 0.5s tolerans
    settings.DEVICE_POLL_INTERVAL_S = 0.1

    supervisor = ConnectionSupervisor(dev_mgr, events, settings)
    await supervisor.start(serial, "ANDROID_ID_2")
    assert supervisor.connected

    # Cihaz offline oldu ve geri dönmedi
    dev_mgr.devices = [DeviceInfo(serial=serial, state=DeviceState.OFFLINE)]
    await asyncio.sleep(0.8)  # 0.5s toleransı aştı

    # Tolerans doldu -> device_lost yayınlanmalı ve connected = False olmalı
    assert not supervisor.connected
    assert events.has_event("device_lost")

    await supervisor.stop()


# ----------------------------------------------------------------- tek-uçuşlu yeniden bağlanma
class _SlowWindowManager:
    """heal_links yavaş: ikinci bir tetikleyici bu sırada içeri girebilsin."""

    def __init__(self, fail: bool = False):
        self.restore_calls = 0
        self.close_all_calls = 0
        self.fail = fail
        self.gate = asyncio.Event()

    async def heal_links(self):
        self.restore_calls += 1
        await self.gate.wait()
        if self.fail:
            raise RuntimeError("onarım patladı")
        return 0

    async def close_all(self):
        self.close_all_calls += 1


def _lost_supervisor(wm, serial="DEV_R"):
    dev_mgr = _FakeDeviceManager([DeviceInfo(serial=serial, state=DeviceState.DEVICE)])
    events = _FakeEvents()
    settings = Settings()
    settings.DEVICE_POLL_INTERVAL_S = 0.05
    sup = ConnectionSupervisor(dev_mgr, events, settings, wm)
    sup._serial = serial
    sup._android_id = f"ANDROID_{serial}"
    sup._connected = False
    return sup, events


@pytest.mark.asyncio
async def test_concurrent_reconnect_triggers_run_a_single_restore():
    """REGRESYON (B3): izleme döngüsü + backoff görevi cihazı aynı anda görünce İKİ heal
    (pencereleri birbirinin altından kapat/aç → yetim scrcpy sunucusu, telefon tekrar tekrar uyanır)."""
    wm = _SlowWindowManager()
    sup, events = _lost_supervisor(wm)

    first = asyncio.create_task(sup._try_reidentify())
    await asyncio.sleep(0.05)              # ilk restore sürüyor (kapıda bekliyor)
    second = asyncio.create_task(sup._try_reidentify())
    await asyncio.sleep(0.05)
    assert wm.restore_calls == 1           # ikinci çağrı restore BAŞLATMADI
    assert second.done()                   # yok sayıldı, bekleyip kuyruğa girmedi

    wm.gate.set()
    await first
    assert sup.connected
    assert [t for t, _ in events.emitted].count("device_reconnected") == 1


@pytest.mark.asyncio
async def test_reidentify_after_the_other_path_already_reconnected_does_nothing():
    wm = _SlowWindowManager()
    wm.gate.set()
    sup, events = _lost_supervisor(wm)
    sup._connected = True                  # öteki yol bağlantıyı bu arada tamamladı
    await sup._try_reidentify()
    assert wm.restore_calls == 0
    assert not events.has_event("device_reconnected")


@pytest.mark.asyncio
async def test_failed_heal_still_marks_the_device_connected():
    """REGRESYON (B4): onarım istisnası bağlantıyı 'kopuk' bırakırsa döngü her yoklamada yeniden dener."""
    wm = _SlowWindowManager(fail=True)
    wm.gate.set()
    sup, events = _lost_supervisor(wm)
    await sup._try_reidentify()
    assert wm.restore_calls == 1
    assert sup.connected
    assert events.has_event("device_reconnected")


@pytest.mark.asyncio
async def test_watch_loop_survives_a_failing_tick():
    """REGRESYON (B4): bir turdaki istisna denetçi görevini SESSİZCE öldürmemeli."""
    wm = _SlowWindowManager()
    sup, _ = _lost_supervisor(wm)
    sup._connected = True
    ticks = {"n": 0}

    async def flaky_tick():
        ticks["n"] += 1
        if ticks["n"] == 1:
            raise RuntimeError("ilk tur patladı")

    sup._watch_tick = flaky_tick
    task = asyncio.create_task(sup._watch_loop())
    await asyncio.sleep(0.4)
    assert not task.done(), "denetçi görevi öldü"
    assert ticks["n"] >= 2
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ----------------------------------------------------------------- bağlantı döngüsü: yerinde onarım
class _HealWindowManager:
    """heal_links'in sıradaki sonuçları: kaç pencere HÂLÂ ölü (0 = bitti)."""

    def __init__(self, *results: int):
        self.results = list(results)
        self.calls = 0
        self.packets: int | None = None  # the link's pulse (WindowManager.video_packets)

    def video_packets(self):
        return self.packets

    async def heal_links(self):
        self.calls += 1
        return self.results.pop(0) if self.results else 0


def _link(transport_id, state=DeviceState.DEVICE):
    return [DeviceInfo(serial="DEV_L", state=state, transport_id=transport_id)]


async def _running(wm):
    settings = Settings(DEVICE_POLL_INTERVAL_S=0.05, DEVICE_DISCONNECT_GRACE_S=1.0, RECONNECT_BACKOFF_MS=[20])
    dev_mgr, events = _FakeDeviceManager(_link(1)), _FakeEvents()
    sup = ConnectionSupervisor(dev_mgr, events, settings, wm)
    await sup.start("DEV_L", "ANDROID_ID_L")
    return sup, dev_mgr, events


@pytest.mark.asyncio
@pytest.mark.parametrize("offline_first", [False, True], ids=["between-polls", "within-grace"])
async def test_a_link_cycle_is_healed_in_place_without_device_lost(offline_first):
    """USB'yi 1 sn söken kablo oynaması iki yoklama arasında bitebilir (cihaz hiç 'yok' görünmez ama adb'nin bağlantı
    kimliği değişmiştir) ya da tolerans içinde döner; ikisinde de scrcpy sunucuları ölmüştür → pencereler yerinde kurulur."""
    wm = _HealWindowManager()
    sup, dev_mgr, events = await _running(wm)
    if offline_first:
        dev_mgr.devices = _link(None, DeviceState.OFFLINE)
        await asyncio.sleep(0.2)
    dev_mgr.devices = _link(2)
    await asyncio.sleep(0.3)
    await sup.stop()

    assert wm.calls == 1 and sup._transport_id == 2 and not events.has_event("device_lost")


@pytest.mark.asyncio
async def test_a_stable_link_never_heals():
    wm = _HealWindowManager()
    sup, _, _ = await _running(wm)
    await asyncio.sleep(0.3)
    await sup.stop()
    assert wm.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(("results", "calls"), [((2, 1, 0), 3), ((1,) * 20, MAX_HEAL_ATTEMPTS)], ids=["until-healed", "attempt-limit"])
async def test_heal_retries_until_nothing_is_dead_or_the_attempt_limit(results, calls):
    wm = _HealWindowManager(*results)
    sup, dev_mgr, _ = await _running(wm)
    dev_mgr.devices = _link(2)
    await asyncio.sleep(0.8)
    await sup.stop()

    assert wm.calls == calls and not sup._heal_pending


@pytest.mark.asyncio
async def test_link_dropped_reports_an_unhealed_drop_and_only_that():
    """Pencerenin sunucusu öldüğünde sorulur: bağlantı koptuysa pencere yerinde onarılır (telefona devir / hayalet çapa
    sayılmaz); uygulama kendi başına kapandıysa bağlantı sağlamdır → eski davranış."""
    sup, dev_mgr, _ = await _running(_HealWindowManager())
    sup._task.cancel()  # döngü karışmasın: yalnız soruyu sınıyoruz
    assert await sup.link_dropped() is False
    dev_mgr.devices = _link(2)  # bağlantı döndü ama kimlik değişti
    assert await sup.link_dropped() is True
    dev_mgr.devices = _link(None, DeviceState.OFFLINE)
    assert await sup.link_dropped() is True
    sup._task = None  # denetçi çalışmıyor (bilinçli taşıyıcı geçişi): hiçbir şeyi bağlantı kopması saymaz
    assert await sup.link_dropped() is False


@pytest.mark.asyncio
async def test_a_silent_video_stream_raises_weak_only_when_the_phone_stops_answering(monkeypatch):
    """Statik ekran kare göndermez: sessizlik tek başına sorun değil. Telefona yalnız video sessizken sorulur;
    yanıt gelmezse 'zayıf' (bir kez), video yeniden akınca kalkar."""
    for name, value in (("STALL_S", 0.15), ("PROBE_TIMEOUT_S", 0.1), ("PROBE_WEAK_S", 0.1), ("PROBE_IDLE_S", 0.1)):
        monkeypatch.setattr(f"app.device.connection_supervisor.{name}", value)
    wm = _HealWindowManager()
    wm.packets = 10
    sup, dev_mgr, events = await _running(wm)
    weak = lambda: [p["weak"] for t, p in events.emitted if t == "link_quality"]  # noqa: E731

    for _ in range(4):  # video akıyor: telefona hiçbir şey sorulmaz
        wm.packets += 1
        await asyncio.sleep(0.06)
    assert dev_mgr.get_android_id_calls == [] and weak() == []

    await asyncio.sleep(0.4)  # sessiz ama telefon yanıt veriyor (statik ekran): soruldu, zayıf DEĞİL
    assert dev_mgr.get_android_id_calls and weak() == []

    dev_mgr.silent_phone = True
    await asyncio.sleep(0.6)
    assert weak() == [True]

    wm.packets += 1  # video yeniden aktı
    await asyncio.sleep(0.2)
    await sup.stop()
    assert weak() == [True, False]
