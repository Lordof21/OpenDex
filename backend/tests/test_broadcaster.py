"""FrameBroadcaster — video akışında GOP (keyframe zinciri) bütünlüğü.

H.264/H.265'te bir delta kare kendinden ÖNCEKİ karelere bağlıdır. Zincirin
ortasından herhangi bir kareyi atmak, sonraki karelerin bozuk (kirli/kaymış)
çizilmesine ya da istemcinin bir sonraki keyframe'e kadar (scrcpy'de ~10 sn)
donmasına yol açar. Bu testler şu değişmezleri (invariant) doğrular:

  1. Bir istemciye teslim edilen video parçalarında, ilk delta'dan önce MUTLAKA
     config + keyframe gelir ve delta'lar keyframe'den sonra KESİNTİSİZ ilerler.
  2. Geç bağlanan istemci (Workspace açılışı / arayüz yeniden bağlanması) tam
     yeniden-oynatmayı (config + keyframe + GOP) canlı kareler gelirken bile korur.
  3. Aşırı yavaş istemci zinciri kırmadan çözülür: kuyruk silinir ve istemci bir
     SONRAKİ keyframe'e kadar delta almaz.
  4. Ses (kodek bağımlılığı yok) eski "en eskiyi at" davranışını korur.
"""
from __future__ import annotations

import asyncio

from app.streams.broadcaster import CLOSE_SENTINEL, BroadcasterRegistry, FrameBroadcaster


def key(n: int) -> bytes:
    return f"K{n}".encode()


def delta(n: int) -> bytes:
    return f"D{n}".encode()


def drain(queue: asyncio.Queue) -> list[str]:
    out = []
    while not queue.empty():
        item = queue.get_nowait()
        out.append(item.decode() if item != CLOSE_SENTINEL else "<close>")
    return out


def assert_chain_intact(delivered: list[str]) -> None:
    """Teslim edilen dizide zincir kırığı olmamalı: delta'lar, en son teslim edilen
    keyframe'in numarasından itibaren ardışık artmalı ve keyframe olmadan hiç delta
    gelmemeli."""
    have_key = False
    last = None
    for item in delivered:
        if item == "CFG":
            continue
        kind, n = item[0], int(item[1:])
        if kind == "K":
            have_key, last = True, n
        else:
            assert have_key, f"keyframe'siz delta teslim edildi: {item} (dizi={delivered[:12]}…)"
            assert n == last + 1, f"delta zincirinde boşluk: {last} → {n} (dizi={delivered[:12]}…)"
            last = n


def make_video(queue_size: int = 4) -> FrameBroadcaster:
    b = FrameBroadcaster("video", queue_size=queue_size)
    b.remember_config(b"CFG")
    return b


async def feed_gop(b: FrameBroadcaster, key_no: int, n_deltas: int) -> int:
    await b.broadcast(key(key_no), is_key_frame=True)
    for i in range(1, n_deltas + 1):
        await b.broadcast(delta(key_no + i))
    return key_no + n_deltas


# ---------------------------------------------------------------- geç bağlanan istemci

async def test_late_joiner_keeps_config_and_keyframe_while_live_frames_keep_arriving():
    """Canlı hatada yeniden üretilen hata: istemci 31 parçalık yeniden-oynatmayı
    okumadan önce 3 canlı kare gelince eski kod en eski parçaları (config+keyframe)
    atıyor, istemci yalnızca delta alıyor, decoder bir sonraki keyframe'e kadar
    kara/bozuk kalıyordu."""
    b = make_video()
    last = await feed_gop(b, 0, 29)
    _, q = b.register()

    for n in range(last + 1, last + 4):        # istemci henüz yazmadı, canlı kareler geliyor
        await b.broadcast(delta(n))

    got = drain(q)
    assert got[0] == "CFG" and got[1] == "K0"
    assert_chain_intact(got)
    assert got[-1] == f"D{last + 3}"           # ve canlı kareler de kayıpsız ulaştı


async def test_late_joiner_with_no_keyframe_yet_gets_nothing_until_the_next_keyframe():
    b = make_video()
    _, q = b.register()                        # henüz keyframe yok
    await b.broadcast(delta(1))
    await b.broadcast(delta(2))
    assert drain(q) == ["CFG"]                 # yalnızca config; boş delta'lar gönderilmez
    await b.broadcast(key(10), is_key_frame=True)
    await b.broadcast(delta(11))
    assert drain(q) == ["CFG", "K10", "D11"]


async def test_oversized_gop_cache_is_not_replayed_with_a_gap():
    """GOP önbelleği sınırı aşılırsa sonraki delta'lar önbelleğe girmiyordu: yeni istemciye
    boşluklu (bozuk) bir GOP yeniden oynatılırdı. Artık önbellek geçersiz kılınır ve yeni
    istemci bir sonraki keyframe'i bekler."""
    b = make_video()
    b.GOP_CACHE_LIMIT = 8
    await feed_gop(b, 0, 20)                   # 8'i aşıyor
    _, q = b.register()
    assert drain(q) == ["CFG"]                 # boşluklu GOP yerine yalnızca config; keyframe beklenir
    await b.broadcast(key(30), is_key_frame=True)
    assert drain(q) == ["CFG", "K30"]


# ---------------------------------------------------------------- yavaş istemci

async def test_slow_client_is_never_given_a_broken_chain():
    """İstemci hiç okumasa bile (WS tıkanması), aldığı her şey çözülebilir olmalı."""
    b = make_video()
    _, q = b.register()
    n = 0
    for gop in range(6):                       # 6 GOP × 60 kare, kuyruk hiç boşalmıyor
        n = await feed_gop(b, n + 1, 60)

    got = drain(q)
    assert got, "kuyruk boş kalmamalı"
    assert_chain_intact(got)
    assert got[-1] == f"D{n}", "istemci en son kareye yetişmiş olmalı"


async def test_overflow_wipes_the_backlog_and_resyncs_only_on_the_next_keyframe():
    b = make_video()
    b.HARD_QUEUE_CAP = 10
    _, q = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    for i in range(1, 30):                     # eşiği aşan delta yığını
        await b.broadcast(delta(i))
    assert q.qsize() <= b.HARD_QUEUE_CAP, "kuyruk sınırsız büyümemeli"
    assert b.resync_count >= 1

    before = drain(q)
    assert_chain_intact(before)
    await b.broadcast(delta(30))               # resync bekleyen istemciye delta GİTMEZ
    assert drain(q) == []
    await b.broadcast(key(31), is_key_frame=True)
    await b.broadcast(delta(32))
    after = drain(q)
    assert after == ["CFG", "K31", "D32"]
    assert_chain_intact(after)


async def test_keyframe_skips_ahead_over_a_stale_backlog_safely():
    """Kuyruk gecikme eşiğini aşmışken gelen keyframe her zaman güvenli bir atlama noktasıdır."""
    b = make_video(queue_size=4)
    _, q = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    for i in range(1, 8):
        await b.broadcast(delta(i))
    await b.broadcast(key(8), is_key_frame=True)

    got = drain(q)
    assert got == ["CFG", "K8"], f"eski yığın atlanmalı, yalnızca yeni keyframe kalmalı: {got}"
    assert b.skip_ahead_count == 1


async def test_healthy_client_receives_every_frame_in_order():
    b = make_video()
    _, q = b.register()
    sent = []
    n = 0
    for _ in range(3):
        n = await feed_gop(b, n + 1, 5)
        sent += drain(q)                       # istemci hep yetişiyor
    assert_chain_intact(sent)
    assert sum(1 for s in sent if s.startswith("D")) == 15
    assert b.resync_count == 0 and b.skip_ahead_count == 0


async def test_each_client_is_tracked_independently():
    b = make_video()
    b.HARD_QUEUE_CAP = 5
    _, slow = b.register()
    _, fast = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    fast_seen = []
    for i in range(1, 20):
        await b.broadcast(delta(i))
        fast_seen += drain(fast)               # hızlı istemci sürekli boşaltıyor
    assert_chain_intact([s for s in fast_seen if s != "CFG"] or ["K0"])
    assert fast_seen[-1] == "D19"              # yavaş istemcinin durumu hızlıyı etkilemedi
    assert slow.qsize() <= b.HARD_QUEUE_CAP


# ---------------------------------------------------------------- ses

async def test_audio_keeps_drop_oldest_and_never_waits_for_keyframes():
    reg = BroadcasterRegistry()
    audio = reg.get_audio_broadcaster()
    _, q = audio.register()
    for i in range(200):                       # 32'lik kapasitenin çok üstünde
        await audio.broadcast(f"A{i}".encode())
    got = drain(q)
    assert len(got) <= 32
    assert got[-1] == "A199"                   # en yeni ses korunur
    assert audio.resync_count == 0             # ses için keyframe/resync kavramı yok


async def test_close_still_signals_every_client():
    b = make_video()
    _, q1 = b.register()
    _, q2 = b.register()
    b.close()
    assert drain(q1)[-1] == "<close>" and drain(q2)[-1] == "<close>"


# ---------------------------------------------------------------- kısa takılma regresyonu
async def test_short_stall_never_drops_mid_gop_frames():
    """REGRESYON: eski QUEUE_SIZE=4 "en eskiyi at" politikası, ~90 ms'lik (≈6 kare @60fps) bir
    istemci takılmasında GOP ORTASINDAN kare atıp sonraki keyframe'e (~10 sn) kadar bozuk resim üretiyordu.
    Takılma bitince istemci HER kareyi sırayla, zincir kırılmadan almalı."""
    b = make_video(queue_size=4)
    _, q = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    got = drain(q)                                  # istemci hazır ve yetişmiş
    for i in range(1, 7):                           # ~90 ms: istemci hiç okumuyor, kodlayıcı 6 kare üretti
        await b.broadcast(delta(i))
    got += drain(q)                                 # takılma bitti
    assert_chain_intact(got)
    assert [g for g in got if g.startswith("D")] == [f"D{i}" for i in range(1, 7)]
    assert b.skip_ahead_count == 0 and b.resync_count == 0


async def test_stats_expose_counters_and_per_client_depth():
    b = make_video(queue_size=4)
    _, q = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    for i in range(1, 8):
        await b.broadcast(delta(i))
    await b.broadcast(key(8), is_key_frame=True)    # gecikmeli istemci → keyframe'e atlama
    s = b.stats()
    assert s["kind"] == "video" and s["clients"] == 1
    assert s["skip_ahead_count"] == 1 and s["resync_count"] == 0
    assert s["depths"] == [q.qsize()] and s["max_depth"] == q.qsize()
    assert s["gop_chunks"] == 1


async def test_rate_counters_count_frames_and_bytes_whoever_is_listening():
    """Telemetry derives fps/Mbps from these: they follow the ENCODER's output, not any client's queue."""
    b = make_video(queue_size=4)
    b.remember_config(b"CFG")
    await b.broadcast(b"CFG", is_config=True)       # no client registered, nobody reading
    await b.broadcast(key(0), is_key_frame=True)
    for i in range(1, 6):
        await b.broadcast(delta(i))

    assert b.frames_total == 6                      # the config packet is not a frame
    assert b.bytes_total == len(b"CFG") + len(key(0)) + sum(len(delta(i)) for i in range(1, 6))
    s = b.stats()
    assert (s["frames_total"], s["bytes_total"]) == (b.frames_total, b.bytes_total)


async def test_rate_counters_are_monotonic_across_a_client_resync():
    b = make_video(queue_size=4)
    _, q = b.register()
    await b.broadcast(key(0), is_key_frame=True)
    for i in range(1, 400):                         # a stuck client: the queue is wiped, the encoder kept delivering
        await b.broadcast(delta(i))

    assert b.resync_count >= 1 and b.frames_total == 400


async def test_health_lines_are_debug_when_calm_and_info_when_a_counter_moves():
    import logging

    from app.streams.broadcaster import stream_health_lines

    reg = BroadcasterRegistry()
    b = reg.get_or_create("w1", queue_size=4)
    b.remember_config(b"CFG")
    _, q = b.register()
    reg.get_audio_broadcaster()                     # ses satırı üretilmez
    last: dict = {}

    await b.broadcast(key(0), is_key_frame=True)
    drain(q)
    calm = stream_health_lines(reg, last)
    assert [lvl for lvl, _ in calm] == [logging.DEBUG]

    for i in range(1, 8):
        await b.broadcast(delta(i))
    await b.broadcast(key(8), is_key_frame=True)    # skip_ahead sayacı arttı
    moved = stream_health_lines(reg, last)
    assert [lvl for lvl, _ in moved] == [logging.INFO]
    assert "skip_ahead=1" in moved[0][1] and "[Broadcaster:w1]" in moved[0][1]

    again = stream_health_lines(reg, last)          # sayaç değişmedi → tekrar INFO değil
    assert [lvl for lvl, _ in again] == [logging.DEBUG]

    reg.remove("w1")
    assert stream_health_lines(reg, last) == [] and "w1" not in last


async def test_the_replay_cache_is_capped_at_about_twelve_seconds_so_a_long_gop_is_not_replayed():
    """The patched server's keyframe interval is 60 s: a client joining mid-GOP must get a keyframe REQUEST (cheap), not
    tens of MB of deltas replayed (and decoded) first."""
    b = FrameBroadcaster("t")
    assert FrameBroadcaster.GOP_CACHE_LIMIT <= 12 * 60
    asked: list[str] = []
    b.keyframe_requester = asked.append
    await b.broadcast(b"K", is_key_frame=True)
    for _ in range(FrameBroadcaster.GOP_CACHE_LIMIT + 5):
        await b.broadcast(b"d")
    assert b._gop == []  # invalidated, never replayed with a hole in it

    _, queue = b.register()
    assert queue.qsize() <= 1                       # at most the config — no 700-chunk replay
    assert asked == ["late client, no keyframe cached"]


# ------------------------------------------------------------------ a waiting client keeps asking for its keyframe

class _Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


async def test_a_client_waiting_for_a_keyframe_asks_again_until_one_arrives():
    """The request made at registration can be dropped (the requester rate-limits and holds back during a resize). The
    client then waited for the encoder's own periodic keyframe — 60 s on the patched server: black after e.g. a
    notification click re-attached the window's stream."""
    clock = _Clock()
    b = FrameBroadcaster("t", clock=clock)
    asked: list[str] = []
    b.keyframe_requester = asked.append
    await b.broadcast(b"CFG", is_config=True)
    await b.broadcast(b"K1", is_key_frame=True)
    for _ in range(FrameBroadcaster.GOP_CACHE_LIMIT + 5):   # the replay cache lapses: nothing to give a new client
        await b.broadcast(b"d")
    assert b._gop == []

    _, queue = b.register()
    assert asked == ["late client, no keyframe cached"]    # the registration's own (first) request — assume it was dropped

    for _ in range(10):                                      # deltas keep coming, no keyframe
        await b.broadcast(b"d")
    assert len(asked) == 1                                   # not before the retry interval

    clock.now += FrameBroadcaster.KEYFRAME_RETRY_S + 0.1
    await b.broadcast(b"d")
    assert asked[1:] == ["client still waiting for a keyframe"]
    await b.broadcast(b"d")
    assert len(asked) == 2                                   # once per interval, not per frame

    clock.now += FrameBroadcaster.KEYFRAME_RETRY_S + 0.1
    await b.broadcast(b"d")
    assert len(asked) == 3

    await b.broadcast(b"K2", is_key_frame=True)             # it arrived: the client is served and nobody asks again
    clock.now += 10
    for _ in range(5):
        await b.broadcast(b"d")
    assert len(asked) == 3
    assert queue.qsize() > 0


async def test_a_window_that_has_not_produced_anything_yet_is_not_nagged():
    clock = _Clock()
    b = FrameBroadcaster("t", clock=clock)
    asked: list[str] = []
    b.keyframe_requester = asked.append

    b.register()                                  # connected before the first frame
    await b.broadcast(b"CFG", is_config=True)
    clock.now += 10
    await b.broadcast(b"CFG2", is_config=True)    # config packets never trigger a request

    assert asked == []
