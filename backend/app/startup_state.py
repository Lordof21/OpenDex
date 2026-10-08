"""Where the backend is in bringing the phone up — the one source the boot screen reads (GET /api/startup), so what the
user sees during startup is what is actually happening, step by step. (The boot screen polls it: the event stream only
connects once the desktop is up.)

    device:   searching → waiting (no phone: the UI offers pairing) | binding → bound
    daemon:   idle → checking (attempt n of N, Docker-style health check) → healthy | unavailable (adb fallback)
    services: idle → starting → ready

Nothing here touches the phone: it is written by AppContext.bind_device / device_bootstrap and read for free.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any, Awaitable, Callable, Literal

DevicePhase = Literal["searching", "waiting", "binding", "bound"]
DaemonPhase = Literal["idle", "checking", "healthy", "unavailable"]
ServicesPhase = Literal["idle", "starting", "ready"]


@dataclass(frozen=True)
class StartupSnapshot:
    device: DevicePhase = "searching"
    transport: Literal["usb", "wireless"] | None = None
    model: str | None = None
    daemon: DaemonPhase = "idle"
    daemon_attempt: int = 0
    daemon_attempts: int = 0
    daemon_rtt_ms: float | None = None
    services: ServicesPhase = "idle"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class StartupState:
    """The current snapshot; `publish(**snapshot)` (optional) is told about every change — the startup log line."""

    publish: Callable[..., Awaitable[None]] | None = None
    current: StartupSnapshot = field(default_factory=StartupSnapshot)

    async def update(self, **changes: Any) -> None:
        snapshot = replace(self.current, **changes)
        if snapshot == self.current:
            return
        self.current = snapshot
        if self.publish is not None:
            await self.publish(**snapshot.as_dict())

    async def reset(self, device: DevicePhase) -> None:
        """A new device binding starts over (unbind, transport switch): nothing about the previous one still holds."""
        await self.update(**StartupSnapshot(device=device).as_dict())
