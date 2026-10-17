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


# ---------------------------------------------------------------- holds_media_session (the media guard's question)

def _connected_client(monkeypatch, live):
    """A client whose socket looks open; `live` is what the phone answers to media_get (None: the read failed)."""
    client = DeviceDaemonClient(adb=None, events=_Bus())
    monkeypatch.setattr(DeviceDaemonClient, "is_connected", property(lambda self: True))

    async def fake_refresh(package=None):
        return live

    client.refresh_media = fake_refresh
    return client


def _sessions(*pairs):
    return {"active": True, "sessions": [{"package": p, "is_playing": playing, "state": "PLAYING" if playing else "PAUSED"}
                                         for p, playing in pairs]}


@pytest.mark.asyncio
async def test_holds_media_session_is_per_package_not_the_primary_session(monkeypatch):
    client = _connected_client(monkeypatch, _sessions(("com.spotify.music", False), ("com.google.android.apps.youtube.music", True)))

    assert await client.holds_media_session("com.google.android.apps.youtube.music") is True
    assert await client.holds_media_session("com.spotify.music") is True        # paused is still a session
    assert await client.holds_media_session("com.never.heard") is False


@pytest.mark.asyncio
async def test_a_paused_video_still_holds_a_session(monkeypatch):
    client = _connected_client(monkeypatch, _sessions(("a.b", False)))

    assert await client.holds_media_session("a.b") is True


@pytest.mark.asyncio
async def test_buffering_counts_as_a_session(monkeypatch):
    client = _connected_client(monkeypatch, {"active": True, "sessions": [{"package": "a.b", "is_playing": False, "state": "BUFFERING"}]})

    assert await client.holds_media_session("a.b") is True


@pytest.mark.asyncio
async def test_a_stopped_or_empty_session_is_not_held(monkeypatch):
    client = _connected_client(monkeypatch, {"active": True, "sessions": [{"package": "a.b", "is_playing": False, "state": "STOPPED"}]})

    assert await client.holds_media_session("a.b") is False


@pytest.mark.asyncio
async def test_unreadable_sessions_are_unknown_not_silence(monkeypatch):
    client = _connected_client(monkeypatch, {"active": False, "error": "sessions_unavailable"})

    assert await client.holds_media_session("a.b") is None


@pytest.mark.asyncio
async def test_no_sessions_at_all_is_a_definite_no(monkeypatch):
    client = _connected_client(monkeypatch, {"active": False})

    assert await client.holds_media_session("a.b") is False


@pytest.mark.asyncio
async def test_falls_back_to_the_pushed_cache_when_the_live_read_fails(monkeypatch):
    client = _connected_client(monkeypatch, None)
    client.last_media_state = _sessions(("a.b", False))

    assert await client.holds_media_session("a.b") is True


@pytest.mark.asyncio
async def test_without_a_daemon_it_is_unknown():
    client = DeviceDaemonClient(adb=None, events=_Bus())

    assert await client.holds_media_session("a.b") is None


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
