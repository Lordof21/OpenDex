"""Per-app audio routing: where one app's sound plays, and how loud on the PC."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AudioRoute = Literal["pc", "both", "phone"]
AUDIO_ROUTES: tuple[str, ...] = ("pc", "both", "phone")


def default_route_for(audio_output_mode: str, enable_audio: bool = True) -> AudioRoute:
    """ProjectSettings.audio_output_mode ("Ses çıkışı") is a route in the same words (pc = DeX): the one an app without its
    own preference follows."""
    if not enable_audio:
        return "phone"
    return audio_output_mode if audio_output_mode in AUDIO_ROUTES else "pc"  # type: ignore[return-value]


class AppAudioPref(BaseModel):
    """A user's explicit choice for one package (persisted per package, device-independent)."""

    package: str
    route: AudioRoute = "pc"
    volume: float = Field(1.0, ge=0.0, le=1.0)
    muted: bool = False


class AppAudioPatch(BaseModel):
    """PUT /api/audio/apps/{package}: only the fields present change."""

    route: AudioRoute | None = None
    volume: float | None = Field(None, ge=0.0, le=1.0)
    muted: bool | None = None
    # Media Center "transfer": play this app's sound on the PC although it has NO window (it plays on the phone). True
    # starts the transfer (the route defaults to "pc"), False ends it; choosing route "phone" ends it too.
    standalone: bool | None = None


class AudioSyncReport(BaseModel):
    """PUT /api/audio/sync: what the DeX page measures about its own audio — both optional, the page sends what changed."""

    pc_output_ms: int | None = Field(None, ge=0, le=2000)      # output device latency (AudioContext base + output latency)
    late_chunks: int = Field(0, ge=0, le=10_000)               # chunks of the last window that reached it too late
