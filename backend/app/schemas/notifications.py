"""Notification domain schemas and action models."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


class NotificationCategory(StrEnum):
    MESSAGE = "msg"       # WhatsApp, Telegram, SMS
    EMAIL = "email"       # Gmail, Outlook
    CALL = "call"         # Incoming / missed call
    MEDIA = "media"       # Spotify, YouTube Music
    SYSTEM = "sys"        # Battery, Wi-Fi, USB, Android core
    SOCIAL = "social"     # Instagram, Twitter/X
    GENERIC = "generic"   # All other apps


class NotificationImportance(StrEnum):
    URGENT = "urgent"     # High urgency (Calls, alarms)
    DEFAULT = "default"   # Standard notification
    # Note: Under strict LIFO rules, no notifications are suppressed from display.


@dataclass
class NotificationAction:
    """Action button on notification (e.g., 'Reply', 'Mark as Read')."""
    action_id: int
    title: str
    action_type: Literal["reply", "button"] = "button"
    reply_placeholder: str | None = None
    key_remote_input: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "title": self.title,
            "action_type": self.action_type,
            "reply_placeholder": self.reply_placeholder,
            "key_remote_input": self.key_remote_input,
        }


@dataclass
class RichNotificationItem:
    """Rich metadata for Android notifications."""
    id: str                               # Unique ID / hash
    android_key: str                      # Android native NotificationRecord key
    package: str                          # Package name (e.g., com.whatsapp)
    app_name: str                         # Display name (e.g., WhatsApp)
    title: str                            # Sender or title
    text: str                             # Message body or preview
    big_text: str | None = None           # Expanded text
    sub_text: str | None = None           # Subtitle
    post_time: str = ""                   # "19:42"
    timestamp: float = 0.0                # Epoch timestamp
    category: NotificationCategory = NotificationCategory.GENERIC
    importance: NotificationImportance = NotificationImportance.DEFAULT
    active_window_id: str | None = None   # If package is already running in a window
    is_ongoing: bool = False              # True for persistent/ongoing system tasks (Hotspot, Calls, etc.)
    read: bool = False                    # True if marked as read by user
    shortcut: str | None = None           # Android shortcut ID (e.g. jid for WhatsApp chat)
    content_intent_id: str | None = None  # PendingIntentRecord id for deep intent resolution (dumpsys source)
    # The launch Intent itself (`Intent.toShortString` form) — the daemon's listener reads it, so opening the target
    # needs no `dumpsys activity intents`. Backend-only: not part of to_dict (the UI never needs it).
    content_intent: str | None = None
    lines: list[str] = field(default_factory=list) # Android InboxStyle / multi-line message previews
    actions: list[NotificationAction] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "android_key": self.android_key,
            "package": self.package,
            "app_name": self.app_name,
            "title": self.title,
            "text": self.text,
            "big_text": self.big_text,
            "sub_text": self.sub_text,
            "lines": self.lines,
            "post_time": self.post_time,
            "timestamp": self.timestamp,
            "category": str(self.category),
            "importance": str(self.importance),
            "active_window_id": self.active_window_id,
            "is_ongoing": self.is_ongoing,
            "read": self.read,
            "shortcut": self.shortcut,
            "content_intent_id": self.content_intent_id,
            "actions": [a.to_dict() for a in self.actions],
        }
