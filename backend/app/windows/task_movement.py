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
    mode: int | None = None,
    clear_bounds: bool = False,
    bounds: tuple[int, int, int, int] | None = None,
) -> None:
    """Zaten çalışan bir task'ı başka bir display'e taşır. Task'ın önceden var
    olması gerekir (bkz. deep_navigator.find_task_id_for_package) — bu
    fonksiyon hiçbir şey başlatmaz, sadece taşır.

    Kademe Merdiveni (Tiered Ladder):
    1. Plan A (Tier 1): WindowContainerTransaction (WCT) atomik taşıma + pencereleme modu + sınırlar + Target DP sıfırlama.
    2. Plan B (Tier 2): ActivityTaskManager Binder (moveRootTaskToDisplay) alt-milisaniye taşıma + WCT windowing/density.
    3. Plan C (Tier 3): ADB Shell (am display move-stack) son çare fallback'i.
    """
    daemon_client = daemon
    if daemon_client is None:
        try:
            from ..device import daemon_registry
            daemon_client = daemon_registry.live("move_task_wct") or daemon_registry.live("move_task")
        except Exception:
            daemon_client = None

    if daemon_client and getattr(daemon_client, "is_connected", False):
        effective_mode = mode if mode is not None else 1
        # ── Plan A (Tier 1 & Tier 2 Daemon): WCT / ATM Binder Atomik Taşıma ────
        if hasattr(daemon_client, "move_task_wct"):
            try:
                ok = await daemon_client.move_task_wct(
                    task_id, target_display_id, mode=effective_mode, clear_bounds=clear_bounds, bounds=bounds
                )
                if ok:
                    log.info(
                        "⚡ [TASK MOVE:WCT] task=%s -> display=%s (mode=%s bounds=%s clear=%s)",
                        task_id, target_display_id, effective_mode, bounds, clear_bounds,
                    )
                    return
            except Exception as exc:
                log.debug("[TASK MOVE:WCT] WCT RPC hatası: %s; Plan B'ye geçiliyor", exc)

        # ── Plan B (Tier 2): ATM Binder moveRootTaskToDisplay ─────────────────
        if hasattr(daemon_client, "move_task_to_display"):
            try:
                ok = await daemon_client.move_task_to_display(task_id, target_display_id)
                if ok:
                    log.info("⚡ [TASK MOVE:DAEMON_BINDER] task=%s -> display=%s", task_id, target_display_id)
                    return
            except Exception as exc:
                log.debug("[TASK MOVE:DAEMON_BINDER] fallback to adb shell: %s", exc)

    # ── Plan C (Tier 3): ADB Shell am display move-stack ───────────────────────
    try:
        await adb.shell(
            f"am display move-stack {task_id} {target_display_id}",
            serial=serial,
            timeout_s=timeout_s,
        )
        log.info("[TASK MOVE:ADB_SHELL] task=%s -> display=%s", task_id, target_display_id)
    except Exception as exc:
        err_msg = str(exc)
        if "current taskDisplayArea" in err_msg or "to its current" in err_msg:
            log.info("[TASK MOVE:ALREADY_ON_DISPLAY ✨] Task %s zaten Display %s üzerinde (hedefte)", task_id, target_display_id)
            return
        raise
