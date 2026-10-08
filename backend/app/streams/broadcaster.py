"""Frame fan-out to WebSocket clients.

Per-window video broadcasters + ONE shared audio broadcaster (audio is
session-wide). Each client owns a queue.

VİDEO — GOP BÜTÜNLÜĞÜ (değişmez): H.264/H.265'te bir delta kare kendinden önceki
karelere bağlıdır. Bu yüzden bir istemciye giden akışın ORTASINDAN kare atılmaz —
atılırsa sonraki kareler bozuk ("kirli arka plan", kayan/eski içerik) çizilir ya da
istemci bir sonraki keyframe'e (yamalı sunucuda ~60 sn, upstream'de ~10 sn) kadar donar. Uygulanan politika:

  * Normal durum: her kare sırayla teslim edilir (istemci decoder'ı hepsini çözer,
    eski olanları EKRANA basmadan atlar — bkz. frontend framePacer.js).
  * Keyframe geldiğinde istemci gecikmeliyse (kuyruk ``queue_size`` üstünde): keyframe
    güvenli bir sınırdır — eski yığın silinir, istemci doğrudan yeni keyframe'e atlar.
  * Kuyruk ``HARD_QUEUE_CAP``'i aşarsa (istemci gerçekten tıkalı): zincir kırılmadan
    devam edilemez — kuyruk silinir ve istemci bir SONRAKİ keyframe'e kadar delta
    almaz (bozuk resim yerine son geçerli resimde kalır).
  * Geç bağlanan istemci (Workspace açılışı, arayüz yeniden bağlanması): config +
    son keyframe + o keyframe'den beri gelen tüm delta'lar tek parça yeniden
    oynatılır ve BU PARÇALAR canlı kareler tarafından asla kırpılmaz.

SES (kodek bağımlılığı yok, ``gop_aware=False``): en eski parça atılır — canlı
yayında tazelik eksiksizlikten önemlidir.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

log = logging.getLogger(__name__)

AUDIO_KEY = "__session_audio__"

# Pushed into every client queue on teardown; real chunks are never empty
# (12-byte header minimum), so the empty bytes value is an unambiguous sentinel.
CLOSE_SENTINEL = b""


class _ClientState:
    """Bir istemcinin video akışındaki konumu."""

    __slots__ = ("needs_key", "grace")

    def __init__(self, *, needs_key: bool, grace: int) -> None:
        # True ⇒ zincir kopuk / henüz başlamadı: bir sonraki keyframe'e kadar delta gitmez.
        self.needs_key = needs_key
        # Yeniden-oynatma uzunluğu kadar ek pay — yeni istemcinin GOP'u "taşma" sayılmasın.
        self.grace = grace


class FrameBroadcaster:
    # Gecikme eşiği: kuyruk bunun üstündeyken keyframe gelirse eski yığın atlanır.
    QUEUE_SIZE = 4
    # Bunun ÜSTÜNDE tıkalı istemcinin zinciri kırılmadan devam edilemez (yaklaşık
    # 2 sn @60fps). Ortadan kare atmak yerine kuyruk silinir ve keyframe beklenir.
    HARD_QUEUE_CAP = 120
    # Cap of the keyframe-anchored replay cache: ~12 s of chunks at 60 fps. With the patched server's 60 s keyframe
    # interval a GOP is far longer than that — replaying 30+ s of deltas to a client that joins (tens of MB, seconds of
    # decoding) is worse than asking the encoder for a keyframe, which is now a frame away. Aşılırsa önbellek GEÇERSİZ
    # kılınır (boşluklu GOP asla yeniden oynatılmaz); yeni istemciler anahtar kare ister (register()).
    GOP_CACHE_LIMIT = 720
    # A client that waits for a keyframe asks again this often until one arrives. The request made when it registered can
    # be dropped (the requester rate-limits, and holds back while a resize waits for its session packet): without a retry
    # the client would stare at black until the encoder's own periodic keyframe — 60 s on the patched server.
    # Just above the requester's own minimum interval (KEYFRAME_REQUEST_MIN_INTERVAL_S, 1.5 s): a retry sooner would be
    # dropped there.
    KEYFRAME_RETRY_S = 1.6

    def __init__(
        self, name: str, queue_size: int = 4, *, gop_aware: bool = True, clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._name = name
        self._clock = clock
        self._last_wait_request = float("-inf")
        self.queue_size = queue_size
        self._gop_aware = gop_aware
        self._queues: dict[int, asyncio.Queue[bytes]] = {}
        self._queue_capacities: dict[int, int] = {}
        self._states: dict[int, _ClientState] = {}
        self._next_id = 0
        self._config: bytes | None = None  # last SPS/PPS config packet exposed to new subscribers
        self._pending_config: bytes | None = None  # config packet awaiting its paired keyframe
        self._gop: list[bytes] = []  # last keyframe + the deltas after it
        # Teşhis sayaçları (telemetri/log için).
        self.resync_count = 0      # tıkalı istemci: kuyruk silindi, keyframe beklendi
        self.skip_ahead_count = 0  # gecikmeli istemci: keyframe'e atlandı
        # Yayın hızı sayaçları: telefonun kodlayıcısından GELEN akış (istemci sayısından, tıkanıklıktan, atlanan
        # kareden bağımsız — hangi istemci/HUD açık olursa olsun). Telemetri iki okuma arasındaki farktan fps/Mbps
        # hesaplar (telemetry.py); tek başına anlamlı değildir, yalnızca monoton artar.
        self.frames_total = 0  # config paketleri HARİÇ kare sayısı
        self.packets_total = 0 # alias for telemetry / Telefon Yükü
        self.bytes_total = 0   # config dahil tüm baytlar
        # Keyframe on demand: the video pump of the window wires this to its scrcpy server (RESET_VIDEO). Without it a
        # client that needs a keyframe waits for the encoder's own — up to 60 s away (10 s upstream).
        self.keyframe_requester: Callable[[str], None] | None = None
        self.keyframe_requests = 0  # teşhis: kaç kez istendi (hız sınırından önce)
        self.key_frames_total = 0   # keyframes seen — a request's fallback checks whether one arrived

    def request_keyframe(self, reason: str) -> None:
        """A client of this stream cannot continue without a keyframe (chain broken, or nothing to replay): asks the
        encoder for one. Cheap and safe to call from the frame path — the requester rate-limits and never raises."""
        self.keyframe_requests += 1
        requester = self.keyframe_requester
        if requester is None:
            return
        try:
            requester(reason)
        except Exception:  # noqa: BLE001 — a failing request must never break frame delivery
            log.exception("[Broadcaster:%s] keyframe isteği başarısız", self._name)

    def register(self, queue_capacity: int | None = None) -> tuple[int, asyncio.Queue[bytes]]:
        client_id = self._next_id
        self._next_id += 1
        # Unbounded: the GOP replay may exceed the live cap; live broadcasts
        # never trim it (bkz. broadcast()).
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        # Replay: a decoder needs SPS/PPS AND a keyframe before any delta.
        # Without this, a client subscribing after the stream started (the
        # normal case: /api/windows/open returns before the WS connects) would
        # stare at black until the encoder's next keyframe — which on a static
        # screen may simply never come.
        config = self._config if self._config is not None else self._pending_config
        if config is not None:
            queue.put_nowait(config)
        for chunk in self._gop:
            queue.put_nowait(chunk)
        self._queues[client_id] = queue
        # Keyframe'li bir GOP yeniden oynatıldıysa istemci senkron; yoksa (henüz keyframe
        # yok ya da önbellek geçersiz) ilk keyframe'e kadar delta göndermenin anlamı yok.
        self._states[client_id] = _ClientState(needs_key=not self._gop, grace=len(self._gop))
        if not self._gop:
            self._last_wait_request = self._clock()  # the request below is this client's first; retries follow it
        if queue_capacity is not None:
            self._queue_capacities[client_id] = queue_capacity
        if self._gop_aware and not self._gop and self.frames_total > 0:
            # The stream is live but there is no keyframe to replay (the cache was invalidated): this client would
            # stare at the last picture until the encoder's next keyframe. (Right after a window opens nothing has
            # been produced yet — frames_total is 0 — and the first keyframe is already on its way: no request.)
            self.request_keyframe("late client, no keyframe cached")
        return client_id, queue

    def unregister(self, client_id: int) -> None:
        self._queues.pop(client_id, None)
        self._queue_capacities.pop(client_id, None)
        self._states.pop(client_id, None)

    def remember_config(self, chunk: bytes) -> None:
        """Buffers the codec config packet; NOT exposed to new subscribers yet —
        promoted to ``_config`` only once its paired keyframe actually lands (see
        ``broadcast()``). A config packet and its keyframe are separate wire
        chunks that can arrive an await-point apart (e.g. across a flex resize —
        see session_reconfigure.py's ``_on_session`` note). Promoting immediately
        would let a client's register() land in that gap and receive a NEW
        config paired with the OLD (pre-resize) GOP cache — two different
        encoder generations handed to one decoder init."""
        self._pending_config = chunk

    @staticmethod
    def _wipe(queue: asyncio.Queue[bytes]) -> None:
        while not queue.empty():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def broadcast(
        self, chunk: bytes, *, is_key_frame: bool = False, is_config: bool = False
    ) -> None:
        self.bytes_total += len(chunk)
        if not is_config:
            self.frames_total += 1
            self.packets_total += 1
        if not self._gop_aware:
            self._broadcast_lossy(chunk)
            return

        if is_key_frame:
            self.key_frames_total += 1
            if self._pending_config is not None:
                self._config = self._pending_config
                self._pending_config = None
            self._gop = [chunk]  # new GOP anchor
        elif not is_config and self._gop:
            if len(self._gop) < self.GOP_CACHE_LIMIT:
                self._gop.append(chunk)
            else:
                # Boşluklu GOP asla yeniden oynatılmaz: önbelleği düşür, yeni istemciler
                # bir sonraki keyframe'i beklesin.
                self._gop = []

        waiting = False
        for client_id, queue in list(self._queues.items()):
            state = self._states.get(client_id)
            if state is None:
                continue
            cap = self._queue_capacities.get(client_id, self.queue_size)
            depth = queue.qsize()
            if depth <= self.HARD_QUEUE_CAP:
                state.grace = 0

            if is_key_frame:
                if state.needs_key or depth >= cap:
                    # Keyframe = güvenli sınır: eski yığını at, doğrudan buraya atla.
                    if not state.needs_key:
                        self.skip_ahead_count += 1
                    self._wipe(queue)
                    if self._config is not None:
                        queue.put_nowait(self._config)
                    state.needs_key = False
                    state.grace = 0
                queue.put_nowait(chunk)
                continue

            if state.needs_key:
                waiting = True
                continue  # zincir kopuk: keyframe gelene kadar delta'nın anlamı yok

            if not is_config and depth >= self.HARD_QUEUE_CAP + state.grace:
                # İstemci gerçekten tıkalı. Ortadan kare atmak zinciri bozar; bunun yerine
                # yığını sil ve bir sonraki keyframe'e kadar bekle.
                self._wipe(queue)
                state.needs_key = True
                self.resync_count += 1
                log.warning(
                    "[Broadcaster:%s] istemci %d tıkalı (kuyruk=%d) — yığın silindi, sonraki keyframe bekleniyor (toplam resync=%d)",
                    self._name, client_id, depth, self.resync_count,
                )
                self.request_keyframe("client queue overflow")
                continue

            queue.put_nowait(chunk)

        if waiting and not is_key_frame and not is_config:
            self._retry_keyframe_for_waiting()

    def _retry_keyframe_for_waiting(self) -> None:
        now = self._clock()
        if now - self._last_wait_request >= self.KEYFRAME_RETRY_S:
            self._last_wait_request = now
            self.request_keyframe("client still waiting for a keyframe")

    def _broadcast_lossy(self, chunk: bytes) -> None:
        """Kodek bağımlılığı olmayan akış (ses): en eski parça atılır — tazelik önce."""
        for client_id, queue in list(self._queues.items()):
            cap = self._queue_capacities.get(client_id, self.queue_size)
            while queue.qsize() >= cap:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            queue.put_nowait(chunk)

    def close(self) -> None:
        """Signals every subscribed WS endpoint to shut down (close_window order:
        clients are notified BEFORE resource teardown)."""
        for queue in self._queues.values():
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(CLOSE_SENTINEL)

    @property
    def client_count(self) -> int:
        return len(self._queues)

    def stats(self) -> dict[str, Any]:
        """Teşhis anlık görüntüsü: istemci başına kuyruk derinliği + zincir-koruma sayaçları."""
        depths = [q.qsize() for q in self._queues.values()]
        return {
            "name": self._name,
            "kind": "video" if self._gop_aware else "audio",
            "clients": len(depths),
            "depths": depths,
            "max_depth": max(depths, default=0),
            "resync_count": self.resync_count,
            "skip_ahead_count": self.skip_ahead_count,
            "gop_chunks": len(self._gop),
            "frames_total": self.frames_total,
            "packets_total": self.packets_total,
            "bytes_total": self.bytes_total,
            "keyframe_requests": self.keyframe_requests,
        }


class BroadcasterRegistry:
    def __init__(self) -> None:
        self._broadcasters: dict[str, FrameBroadcaster] = {}

    def get_or_create(self, window_id: str, queue_size: int = 4, *, gop_aware: bool = True) -> FrameBroadcaster:
        if window_id not in self._broadcasters:
            self._broadcasters[window_id] = FrameBroadcaster(window_id, queue_size=queue_size, gop_aware=gop_aware)
        return self._broadcasters[window_id]

    def get_audio_broadcaster(self) -> FrameBroadcaster:
        """The single shared audio fan-out — all window clients subscribe here."""
        return self.get_or_create(AUDIO_KEY, queue_size=32, gop_aware=False)

    def remove(self, window_id: str) -> None:
        broadcaster = self._broadcasters.pop(window_id, None)
        if broadcaster is not None:
            broadcaster.close()

    def get(self, window_id: str) -> FrameBroadcaster | None:
        return self._broadcasters.get(window_id)

    def stats(self) -> dict[str, dict[str, Any]]:
        return {name: b.stats() for name, b in self._broadcasters.items()}


def stream_health_lines(
    registry: BroadcasterRegistry, last: dict[str, tuple[int, int]]
) -> list[tuple[int, str]]:
    """Video yayınlarının sağlık satırları. Sayaç DEĞİŞTİYSE ya da kuyruk gecikme eşiğinin 2 katını aştıysa
    INFO (gerçek bir bozulma dönemi), aksi halde yalnızca DEBUG (dosyada iz kalır, terminal susar)."""
    lines: list[tuple[int, str]] = []
    seen: set[str] = set()
    for name, s in registry.stats().items():
        if s["kind"] != "video":
            continue
        seen.add(name)
        counters = (s["resync_count"], s["skip_ahead_count"])
        changed = last.get(name, (0, 0)) != counters
        last[name] = counters
        if s["clients"] == 0 and not changed:
            continue
        deep = s["max_depth"] > 2 * FrameBroadcaster.QUEUE_SIZE
        level = logging.INFO if (changed or deep) else logging.DEBUG
        lines.append((
            level,
            "[Broadcaster:%s] istemci=%d derinlik=%s resync=%d skip_ahead=%d gop=%d" % (
                name, s["clients"], s["depths"], s["resync_count"], s["skip_ahead_count"], s["gop_chunks"],
            ),
        ))
    for gone in [n for n in last if n not in seen]:
        del last[gone]
    return lines


async def report_stream_health(registry: BroadcasterRegistry, interval_s: float = 10.0) -> None:
    """Arka plan görevi: her ``interval_s`` saniyede yayın sağlığı satırlarını yazar (bozuk resim dönemlerinin kanıtı)."""
    last: dict[str, tuple[int, int]] = {}
    while True:
        await asyncio.sleep(interval_s)
        try:
            for level, message in stream_health_lines(registry, last):
                log.log(level, message)
        except Exception:
            log.exception("[Broadcaster] sağlık raporu başarısız")
