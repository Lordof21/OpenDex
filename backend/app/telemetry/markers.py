"""Events on the load timeline — what OpenDeX DID, so a temperature or CPU rise can be read against its cause.

`record()` is called at the few places that change how hard the phone works (an app restart, a DPI change, a window
opening). A bounded in-memory ring; the load monitor ships new markers with each sample.
"""
from __future__ import annotations

import itertools
import time
from collections import deque
from typing import Any

# kind -> human label (the frontend keys icons on `kind`)
KINDS: dict[str, str] = {
    "app_restart": "Uygulama yeniden başlatıldı",
    "app_relaunch": "Uygulama yerinde yeniden kuruldu",
    "dpi_change": "DPI değişti",
    "window_open": "Pencere açıldı",
    "window_close": "Pencere kapandı",
    "handoff": "Telefona aktarıldı",
    "reclaim": "PC'ye geri alındı",
    "thermal": "Termal seviye değişti",
}

_seq = itertools.count(1)
_ring: deque[dict[str, Any]] = deque(maxlen=2000)


def record(kind: str, *, package: str | None = None, detail: str | None = None, wallclock=time.time, **attrs: Any) -> None:
    """Never raises: telemetry must not break the operation it describes."""
    try:
        _ring.append({
            "id": next(_seq), "t": round(wallclock(), 3), "kind": kind, "label": KINDS.get(kind, kind),
            "package": package, "detail": detail, **{k: v for k, v in attrs.items() if v is not None},
        })
    except Exception:  # noqa: BLE001
        pass


def since(marker_id: int) -> list[dict[str, Any]]:
    return [m for m in _ring if m["id"] > marker_id]


def window(start_t: float) -> list[dict[str, Any]]:
    return [m for m in _ring if m["t"] >= start_t]


def last_id() -> int:
    return _ring[-1]["id"] if _ring else 0


def clear() -> None:
    _ring.clear()
