"""The window-session table (window_id → WindowSession) that reports membership changes.

WindowManager, EcoWorkspaceManager, TaskTeleporter, HandoffManager and SessionReconfigurer all share ONE of these by
reference and add/drop sessions directly (open, close, Eco member registration, Workspace anchor death, …). Anything
that must follow the set of open windows — per-window audio — subscribes here instead of being called from each of
those paths, so a new path can never forget to notify it.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger(__name__)

Listener = Callable[[], None]


class SessionTable(dict):
    """A plain dict (every existing reader keeps working) whose mutators notify listeners synchronously. Listeners
    must be cheap and non-blocking (schedule work, don't do it)."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._listeners: list[Listener] = []

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def _changed(self) -> None:
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001 — a listener bug must never break a window lifecycle operation
                log.exception("session table listener failed")

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self._changed()

    def __delitem__(self, key: Any) -> None:
        super().__delitem__(key)
        self._changed()

    def pop(self, key: Any, *default: Any) -> Any:
        present = key in self
        value = super().pop(key, *default)
        if present:
            self._changed()
        return value

    def popitem(self) -> tuple[Any, Any]:
        item = super().popitem()
        self._changed()
        return item

    def clear(self) -> None:
        present = bool(self)
        super().clear()
        if present:
            self._changed()

    def setdefault(self, key: Any, default: Any = None) -> Any:
        if key in self:
            return self[key]
        self[key] = default
        return default

    def update(self, *args: Any, **kwargs: Any) -> None:
        super().update(*args, **kwargs)
        self._changed()
