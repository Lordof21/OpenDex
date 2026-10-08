"""Medya durumu için saf kurallar: şarkı kimliği, kapak taşıma ve eski olay tespiti.

Neden ayrı: kapak eskiden ŞARKIYA değil PAKETE bağlıydı (Java önbelleği, bu katman ve ön yüz aynı hatayı yapıyordu):
yeni şarkının kapağı henüz gelmemişken önceki şarkının kapağı gösteriliyordu. Kurallar burada tek yerde, tablo testli.
"""
from __future__ import annotations

from typing import Any


def track_identity(state: dict[str, Any] | None) -> tuple:
    """Şarkının kimliği. Yeni daemon `track_id` gönderir (paket + MEDIA_ID + başlık + sanatçı + süre); eski jar için
    (paket, başlık, sanatçı, süre) ile aynı işi görür."""
    if not state:
        return ("none",)
    track_id = state.get("track_id")
    if track_id:
        return ("id", str(track_id))
    return (
        "meta",
        state.get("package", ""),
        state.get("title", ""),
        state.get("artist", ""),
        state.get("duration", state.get("duration_ms", 0)),
    )


def same_track(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    return bool(a) and bool(b) and track_identity(a) == track_identity(b)


def carry_over_art(previous: dict[str, Any] | None, incoming: dict[str, Any]) -> None:
    """Gelen olayda kapak YOKSA, yalnızca AYNI şarkının önceki kapağı taşınır. Farklı şarkıda kapak boş kalır
    (`art_ready=false`): eski şarkının kapağını yeni şarkıya yapıştırmak "yanlış kapak" hatasıydı."""
    if not incoming.get("album_art") and previous and previous.get("album_art") and same_track(previous, incoming):
        incoming["album_art"] = previous["album_art"]
    # Oturum listesi de aynı kuralla (paket + şarkı eşleşmesi)
    prev_sessions = {s.get("package"): s for s in (previous or {}).get("sessions", []) if isinstance(s, dict)}
    for sess in incoming.get("sessions", []) or []:
        if not isinstance(sess, dict) or sess.get("album_art"):
            continue
        before = prev_sessions.get(sess.get("package"))
        if before and before.get("album_art") and same_track(before, sess):
            sess["album_art"] = before["album_art"]


def is_stale_media_event(previous: dict[str, Any] | None, incoming: dict[str, Any]) -> bool:
    """`seq` (aynı daemon sürecinde, `epoch` ile tanımlı) geriye giderse olay ESKİdir ve yenisini ezmemeli.
    Daemon yeniden başlarsa epoch değişir → eski sayaçla karşılaştırılmaz. `seq` yoksa (eski jar) hiçbir olay atılmaz."""
    if not previous:
        return False
    seq, epoch = incoming.get("seq"), incoming.get("epoch")
    prev_seq, prev_epoch = previous.get("seq"), previous.get("epoch")
    if seq is None or prev_seq is None or epoch != prev_epoch:
        return False
    return seq < prev_seq
