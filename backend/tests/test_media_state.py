"""Medya kapağı/şarkı kimliği ve eski olay tespiti.

Kapak eskiden ŞARKIYA değil PAKETE bağlıydı: yeni şarkının kapağı gelmeden önceki şarkının kapağı gösteriliyordu.
Bu dosya hem saf kuralları hem de daemon istemcisinin olay hattını (kapak taşıma, eski olay atma, canlı yenileme) sınar.
"""
import asyncio

import pytest

from app.device.device_daemon_client import DeviceDaemonClient
from app.device.media_control import get_media_status
from app.device.media_state import carry_over_art, is_stale_media_event, same_track, track_identity


def _state(**over):
    base = {
        "type": "media_update", "active": True, "package": "com.music", "track_id": "com.music::id1::Şarkı A::Sanatçı::200000",
        "title": "Şarkı A", "artist": "Sanatçı", "duration": 200000, "album_art": "ART_A", "art_ready": True,
        "epoch": 111, "seq": 10,
    }
    base.update(over)
    return base


class TestTrackIdentity:
    def test_track_id_varsa_onunla_karsilastirilir(self):
        assert same_track(_state(), _state(title="başka başlık"))  # aynı track_id → aynı şarkı (metadata farkı yok sayılır)
        assert not same_track(_state(), _state(track_id="com.music::id2::Şarkı B::Sanatçı::1"))

    def test_eski_jar_icin_meta_ile_karsilastirilir(self):
        old_a = {"package": "p", "title": "A", "artist": "X", "duration": 10}
        assert same_track(old_a, dict(old_a))
        assert not same_track(old_a, {**old_a, "title": "B"})
        assert not same_track(old_a, {**old_a, "package": "q"})
        assert not same_track(old_a, {**old_a, "duration": 11})

    def test_bos_durumlar_ayni_sayilmaz(self):
        assert not same_track(None, _state())
        assert not same_track({}, {})
        assert track_identity(None) == ("none",)


class TestCarryOverArt:
    def test_ayni_sarkida_kapak_tasinir(self):
        incoming = _state(album_art="", art_ready=False, seq=11)
        carry_over_art(_state(), incoming)
        assert incoming["album_art"] == "ART_A"

    def test_FARKLI_sarkida_eski_kapak_ASLA_tasinmaz(self):
        incoming = _state(track_id="com.music::id2::Şarkı B::Sanatçı::1", title="Şarkı B", album_art="", art_ready=False)
        carry_over_art(_state(), incoming)
        assert incoming["album_art"] == ""  # yeni şarkı, kapağı henüz gelmedi: boş kalır (art_ready=false)

    def test_gelen_kapak_ezilmez(self):
        incoming = _state(album_art="ART_NEW")
        carry_over_art(_state(), incoming)
        assert incoming["album_art"] == "ART_NEW"

    def test_onceki_durum_yoksa_dokunmaz(self):
        incoming = _state(album_art="")
        carry_over_art({"active": False}, incoming)
        carry_over_art(None, incoming)
        assert incoming["album_art"] == ""

    def test_oturum_listesinde_de_ayni_kural(self):
        prev = _state(sessions=[
            {"package": "com.music", "track_id": "t1", "album_art": "S1_ART"},
            {"package": "com.video", "track_id": "v1", "album_art": "V1_ART"},
        ])
        incoming = _state(album_art="X", sessions=[
            {"package": "com.music", "track_id": "t1", "album_art": ""},   # aynı şarkı → taşınır
            {"package": "com.video", "track_id": "v2", "album_art": ""},   # şarkı değişti → boş
            {"package": "com.new", "track_id": "n1", "album_art": ""},     # daha önce yok → boş
        ])
        carry_over_art(prev, incoming)
        arts = {s["package"]: s["album_art"] for s in incoming["sessions"]}
        assert arts == {"com.music": "S1_ART", "com.video": "", "com.new": ""}


class TestStaleEvents:
    def test_geriye_giden_seq_eskidir(self):
        assert is_stale_media_event(_state(seq=10), _state(seq=9))
        assert not is_stale_media_event(_state(seq=10), _state(seq=10))
        assert not is_stale_media_event(_state(seq=10), _state(seq=11))

    def test_daemon_yeniden_basladiysa_epoch_degisir_eski_sayilmaz(self):
        assert not is_stale_media_event(_state(epoch=111, seq=500), _state(epoch=222, seq=1))

    def test_seq_yoksa_eski_jar_hicbir_olay_atilmaz(self):
        assert not is_stale_media_event({"active": True}, _state(seq=1))
        assert not is_stale_media_event(_state(seq=10), {"active": True, "title": "x"})
        assert not is_stale_media_event(None, _state())


# ---------------------------------------------------------------- daemon istemcisi: olay hattı

class _Bus:
    def __init__(self):
        self.events = []

    async def emit(self, type, **payload):
        self.events.append((type, payload))


@pytest.mark.asyncio
async def test_hizli_gecis_yeni_baslikla_eski_kapak_yayinlanmaz():
    bus = _Bus()
    client = DeviceDaemonClient(adb=None, events=bus)
    await client._dispatch_event(_state(seq=1))
    # başlık geldi, kapak henüz yok (art_ready=false) → eski şarkının kapağı YAYINLANMAZ
    await client._dispatch_event(_state(
        seq=2, track_id="com.music::id2::Şarkı B::Sanatçı::1", title="Şarkı B", album_art="", art_ready=False,
    ))
    _, second = bus.events[-1]
    assert second["title"] == "Şarkı B" and second["album_art"] == "" and second["art_ready"] is False
    # kapak sonradan geldi → anında yayın
    await client._dispatch_event(_state(
        seq=3, track_id="com.music::id2::Şarkı B::Sanatçı::1", title="Şarkı B", album_art="ART_B", art_ready=True,
    ))
    assert bus.events[-1][1]["album_art"] == "ART_B"
    # aynı şarkıda kapaksız güncelleme (ör. pozisyon) kapağı KORUR
    await client._dispatch_event(_state(
        seq=4, track_id="com.music::id2::Şarkı B::Sanatçı::1", title="Şarkı B", album_art="", art_ready=False,
    ))
    assert bus.events[-1][1]["album_art"] == "ART_B"


@pytest.mark.asyncio
async def test_eski_olay_yenisini_ezmez_ve_yayinlanmaz():
    bus = _Bus()
    client = DeviceDaemonClient(adb=None, events=bus)
    await client._dispatch_event(_state(seq=5, title="yeni", track_id="t-new", album_art="N"))
    count = len(bus.events)

    await client._dispatch_event(_state(seq=4, title="eski", track_id="t-old", album_art="O"))

    assert len(bus.events) == count  # eski olay yayınlanmadı
    assert client.last_media_state["title"] == "yeni"


@pytest.mark.asyncio
async def test_eski_olay_atilsa_da_rpc_yaniti_cagirani_bekletmez():
    """`media_get` yanıtı (req_id'li) eski sayılsa bile bekleyen çağıran TAKILMAZ."""
    bus = _Bus()
    client = DeviceDaemonClient(adb=None, events=bus)
    await client._dispatch_event(_state(seq=9))
    fut = asyncio.get_event_loop().create_future()
    client._pending_responses["7"] = fut

    await client._dispatch_event(_state(seq=3, req_id="7"))

    assert fut.done() and fut.result()["seq"] == 3


@pytest.mark.asyncio
async def test_refresh_media_canli_anlik_goruntu_ister_ve_ayni_hattan_gecer():
    bus = _Bus()
    client = DeviceDaemonClient(adb=None, events=bus)
    sent = []

    async def fake_rpc(cmd_body, prefix, timeout=3.5):
        sent.append(cmd_body)
        reply = _state(seq=20, title="Canlı", track_id="t-live", album_art="LIVE")
        await client._dispatch_event(reply)  # gerçek daemon yanıtı da _dispatch_event'ten geçer
        return reply

    client._send_rpc_full = fake_rpc
    live = await client.refresh_media("com.music")

    assert sent == ["media_get com.music"]
    assert live["title"] == "Canlı"
    assert client.last_media_state["title"] == "Canlı"  # önbellek güncellendi
    assert bus.events[-1][0] == "device_media_update"   # tüm istemcilere yayıldı


@pytest.mark.asyncio
async def test_refresh_media_medya_olmayan_yanit_none_doner():
    client = DeviceDaemonClient(adb=None, events=_Bus())

    async def fake_rpc(cmd_body, prefix, timeout=3.5):
        return {"type": "media_get_result", "ok": False}

    client._send_rpc_full = fake_rpc
    assert await client.refresh_media() is None


# ---------------------------------------------------------------- get_media_status(fresh=...)

class _Ctx:
    def __init__(self, daemon):
        self.daemon_client = daemon
        self.serial = "SER"


class _FakeDaemon:
    is_connected = True

    def __init__(self, live=None, cached=None, boom=False):
        self.live, self.boom = live, boom
        self.last_media_state = cached or {"active": False}
        self.refresh_calls = []

    async def refresh_media(self, package=None):
        self.refresh_calls.append(package)
        if self.boom:
            raise RuntimeError("rpc koptu")
        return self.live


@pytest.mark.asyncio
async def test_fresh_canli_okumayi_onbellege_tercih_eder():
    daemon = _FakeDaemon(live=_state(title="canlı", req_id="9"), cached=_state(title="önbellek"))
    status = await get_media_status(_Ctx(daemon), "com.music", fresh=True)
    assert status["title"] == "canlı" and "req_id" not in status
    assert daemon.refresh_calls == ["com.music"]


@pytest.mark.asyncio
async def test_fresh_olmadan_onbellek_kullanilir_canli_okuma_yok():
    daemon = _FakeDaemon(live=_state(title="canlı"), cached=_state(title="önbellek"))
    status = await get_media_status(_Ctx(daemon), "com.music")
    assert status["title"] == "önbellek" and daemon.refresh_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["none", "raises"])
async def test_fresh_basarisizsa_onbellege_duser(failure):
    daemon = _FakeDaemon(live=None, cached=_state(title="önbellek"), boom=(failure == "raises"))
    status = await get_media_status(_Ctx(daemon), "com.music", fresh=True)
    assert status["title"] == "önbellek"
