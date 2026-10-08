"""Shared task↔display movement primitive (DRY — Karar: Hibrit Pencereleme
Faz 2). `am display move-stack {task_id} {disp_id}` PC⟷phone handoff
(handoff_manager.py) ile Eco Workspace⟷dedicated-VD teleportation
(task_teleporter.py) arasında ORTAK bir primitif — burada bir kez yazılır,
her iki çağıran da bunu import eder.
"""
from __future__ import annotations

import logging
from typing import Any

from ..device.adb import Adb

log = logging.getLogger(__name__)


async def move_task_to_display(
    adb: Adb,
    task_id: str | int,
    target_display_id: str | int,
    *,
    serial: str,
    timeout_s: float = 2.0,
    daemon: Any = None,
) -> None:
    """Zaten çalışan bir task'ı başka bir display'e taşır. Task'ın önceden var
    olması gerekir (bkz. deep_navigator.find_task_id_for_package) — bu
    fonksiyon hiçbir şey başlatmaz, sadece taşır.

    Daemon bağlıysa sub-millisecond Binder IPC (moveRootTaskToDisplay) kullanır,
    bağlı değilse veya hata verirse adb.shell("am display move-stack ...") fallback'ine geçer.
    """
    if daemon and getattr(daemon, "is_connected", False):
        try:
            ok = await daemon.move_task_to_display(task_id, target_display_id)
            if ok:
                log.debug("[TASK MOVE:DAEMON ⚡] task=%s -> display=%s", task_id, target_display_id)
                return
        except Exception as exc:
            log.debug("[TASK MOVE:DAEMON] fallback to adb shell: %s", exc)

    try:
        await adb.shell(
            f"am display move-stack {task_id} {target_display_id}",
            serial=serial,
            timeout_s=timeout_s,
        )
        log.debug("[TASK MOVE:ADB] task=%s -> display=%s", task_id, target_display_id)
    except Exception as exc:
        err_msg = str(exc)
        if "current taskDisplayArea" in err_msg or "to its current" in err_msg:
            log.info("[TASK MOVE:ALREADY_ON_DISPLAY ✨] Task %s zaten Display %s üzerinde (hedefte)", task_id, target_display_id)
            return
        raise
