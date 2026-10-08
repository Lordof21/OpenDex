"""Turns the phone's notifications into rich notification items — from either source:

  * the daemon's notification listener (``notifications_from_daemon``: structured JSON, pushed — the normal path);
  * ``adb shell dumpsys notification --noredact`` (``parse_dumpsys_notifications``: the fallback while no v1.2 daemon
    is connected).

Both first reduce a notification to a ``RawNotification`` and then go through the SAME rules (``_build_item``: junk and
USB-noise filters, title/body reconciliation, category, ongoing, importance, actions, group-summary dedup), so an item
looks the same whichever source produced it. Pure functions — no device I/O, unit-tested against captured fixtures.
"""
from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..schemas.notifications import (
    NotificationAction,
    NotificationCategory,
    NotificationImportance,
    RichNotificationItem,
)

# Filter internal mirroring noise and persistent vendor background daemons.
_JUNK_PACKAGES = {
    "com.android.mtp",
    "com.xiaomi.mirror",
    "com.xiaomi.mi_connect_service",
    "com.miui.misound",
    "com.xiaomi.aicr",
    "com.miui.securitycenter",
    "com.xiaomi.barrage",
}

# Filters out USB physical cable connection noise caused by the OpenDeX
# connection itself.
_USB_NOISE_KEYWORDS = (
    "usb debugging", "usb-hata ayıklama",
    "ptp via usb", "charging this device via usb",
    "cihaz usb üzerinden şarj ediliyor",
    "accessing files from",
)

_APP_TITLE_MAP = {
    "com.whatsapp": "WhatsApp",
    "com.instagram.android": "Instagram",
    "com.instagram.lite": "Instagram Lite",
    "com.google.android.youtube": "YouTube",
    "com.google.android.apps.youtube.music": "YouTube Music",
    "com.spotify.music": "Spotify",
    "com.google.android.apps.messaging": "Mesajlar",
    "com.google.android.gm": "Gmail",
    "com.google.android.googlequicksearchbox": "Google",
    "com.supercell.clashofclans": "Clash of Clans",
    "com.amazon.mShop.android.shopping": "Amazon",
    "com.linkedin.android": "LinkedIn",
    "ai.x.grok": "Grok",
    "com.android.settings": "Ayarlar",
    "com.miui.player": "Müzik",
    "android": "Android Sistemi",
}


# android.app.Notification flags — dumpsys prints the field as HEX (`flags=0x10`), never as names, so every check
# must be numeric (the former `"GROUP_SUMMARY" in flags` text checks could never match).
_FLAG_ONGOING_EVENT = 0x02
_FLAG_NO_CLEAR = 0x20
_FLAG_GROUP_SUMMARY = 0x200
_FLAG_AUTOGROUP_SUMMARY = 0x400

# Extras are `android.<name>=<Type> (<value>)`; a value may span lines, so it ends at the next property / block close.
_PROP_BOUNDARY = r"\)(?=\r?\n\s*(?:android\.|[a-zA-Z0-9_.]+=|\}))"

_MEDIA_PACKAGE_HINTS = ("spotify", "deezer", "soundcloud", "music", "player")


@dataclass
class RawNotification:
    """One notification as either source reports it, before OpenDeX's rules."""

    package: str
    raw_id: str
    android_key: str
    tag: str = ""
    flags: int = 0
    title: str = ""
    text: str = ""
    big_text: str = ""
    lines: list[str] = field(default_factory=list)
    summary_text: str = ""
    info_text: str = ""
    sub_text: str = ""
    ticker: str = ""
    media: bool = False                    # MediaStyle / transport category (package hints are added by the rules)
    importance: int | None = None          # NotificationManager importance (4+ = urgent)
    actions: list[str] = field(default_factory=list)
    when_ms: int = 0                       # Notification.when (ms, or s on odd apps)
    shortcut: str | None = None
    content_intent_id: str | None = None   # dumpsys only: PendingIntentRecord id (resolved via `dumpsys activity intents`)
    content_intent: str | None = None      # daemon only: the launch Intent itself, `Intent.toShortString` form


def _parse_flags(raw: str) -> int:
    try:
        return int(raw, 16) if raw.lower().startswith("0x") else int(raw)
    except ValueError:
        return 0


def _extra(block: str, name: str) -> str | None:
    """Raw value of `android.<name>=…` (multi-line aware, falls back to the single-line form)."""
    m = (
        re.search(rf"android\.{name}=(?:String|CharSequence|SpannableString)?\s*\(([\s\S]*?){_PROP_BOUNDARY}", block)
        or re.search(rf"android\.{name}=(?:String|CharSequence|SpannableString)?\s*\((.*?)\)", block)
    )
    return m.group(1) if m else None


def _clean_str(val: str | None) -> str:
    if not val:
        return ""
    v = val.strip()
    if v.lower() in ("null", "none", "string (null)", "charsequence (null)"):
        return ""
    return v


# ---------------------------------------------------------------- the shared rules


def post_time_label(when_ts: float, now_ts: float | None = None) -> str:
    """"şimdi" / "5 dk önce" / "14:02" / "03.10 14:02" — recomputed whenever the list is read (a pushed item is not
    re-parsed every few seconds any more, so a label frozen at post time would say "şimdi" forever)."""
    diff_sec = max(0.0, (time.time() if now_ts is None else now_ts) - when_ts)
    if diff_sec < 60:
        return "şimdi"
    if diff_sec < 3600:
        return f"{int(diff_sec / 60)} dk önce"
    if diff_sec < 86400:
        return time.strftime("%H:%M", time.localtime(when_ts))
    return time.strftime("%d.%m %H:%M", time.localtime(when_ts))


def _build_item(raw: RawNotification, now_ts: float) -> tuple[RichNotificationItem, bool] | None:
    """(item, is_group_summary), or None when OpenDeX does not show it (junk, noise, empty)."""
    pkg = raw.package
    if pkg in _JUNK_PACKAGES:
        return None

    tag = raw.tag or ""
    is_hotspot = "hotspot" in tag.lower()
    clean_app_name = _APP_TITLE_MAP.get(pkg, pkg.split(".")[-1].capitalize())
    if is_hotspot:
        clean_app_name = "Kişisel Erişim Noktası"
    is_media = raw.media or any(k in pkg.lower() for k in _MEDIA_PACKAGE_HINTS)

    title = _clean_str(raw.title)
    big_text = _clean_str(raw.big_text)
    text = _clean_str(raw.text)
    lines = [ln for ln in (_clean_str(x) for x in raw.lines) if ln]
    summary_text = _clean_str(raw.summary_text)
    info_text = _clean_str(raw.info_text)
    sub_text = _clean_str(raw.sub_text)
    ticker = _clean_str(raw.ticker)

    # Prioritized body text resolution (Never slice or drop text prematurely)
    body_text = big_text or text or ("\n".join(lines) if lines else "") or summary_text or info_text or sub_text or ticker

    # Smart title/body reconciliation
    if not title and ticker:
        title = ticker
        body_text = ""
    elif not body_text and ticker and ticker != title:
        body_text = ticker

    if not title:
        title = f"{clean_app_name} Bildirimi"

    # Drop completely empty blocks or persistent background prompts
    if not body_text and title == f"{clean_app_name} Bildirimi":
        return None

    combined_lower = f"{title} {body_text}".lower()
    if any(junk in combined_lower for junk in ("tap for more information", "stop the app", "device interconnectivity", "arka planda çalışıyor", "cihaz bağlantı servisi")):
        return None

    # Filter out USB physical cable connection noise caused by the OpenDeX connection itself
    if any(noise in combined_lower for noise in _USB_NOISE_KEYWORDS):
        return None

    # Category resolution
    category = NotificationCategory.GENERIC
    pkg_lower = pkg.lower()
    if any(k in pkg_lower for k in ("whatsapp", "telegram", "messaging", "viber", "signal")):
        category = NotificationCategory.MESSAGE
    elif is_media:
        category = NotificationCategory.MEDIA
    elif any(k in pkg_lower for k in ("mail", "gmail", "outlook")):
        category = NotificationCategory.EMAIL
    elif any(k in pkg_lower for k in ("instagram", "twitter", "facebook", "tiktok")):
        category = NotificationCategory.SOCIAL
    elif pkg in ("android", "com.android.settings", "com.android.systemui") or is_hotspot:
        category = NotificationCategory.SYSTEM

    # Ongoing / Persistent Notification Detection (Hotspot, Tethering, Foreground services)
    is_ongoing = (
        bool(raw.flags & (_FLAG_ONGOING_EVENT | _FLAG_NO_CLEAR))
        or is_hotspot
        or "tethering" in tag.lower()
        or any(k in combined_lower for k in ("hotspot is on", "device is connected", "etkin nokta"))
    )

    importance = NotificationImportance.URGENT if (raw.importance or 0) >= 4 else NotificationImportance.DEFAULT

    actions: list[NotificationAction] = []
    for action_title in raw.actions:
        raw_title = _clean_str(action_title)
        if not raw_title or raw_title.startswith("String [") or raw_title.startswith("SpannableString ["):
            continue
        if any(w in raw_title.lower() for w in ("yanıtla", "reply", "cevap", "respond")):
            continue  # Remove unusable reply action
        actions.append(NotificationAction(action_id=len(actions), title=raw_title[:30], action_type="button"))

    nid = hashlib.md5(f"{pkg}:{raw.android_key}".encode("utf-8")).hexdigest()[:12]

    when_raw = raw.when_ms
    if when_raw > 1000000000000:
        when_ts = when_raw / 1000.0
    elif when_raw > 0:
        when_ts = float(when_raw)
    else:
        when_ts = now_ts

    item = RichNotificationItem(
        id=nid,
        android_key=raw.android_key,
        package=pkg,
        app_name=clean_app_name,
        title=title[:250],
        text=body_text[:2500] if body_text else "Görüntülemek için dokunun",
        big_text=big_text[:5000] if big_text else None,
        sub_text=sub_text,
        lines=lines,
        post_time=post_time_label(when_ts, now_ts),
        timestamp=when_ts,
        category=category,
        importance=importance,
        is_ongoing=is_ongoing,
        shortcut=raw.shortcut,
        content_intent_id=raw.content_intent_id,
        content_intent=raw.content_intent,
        actions=actions[:4],
    )
    return item, bool(raw.flags & (_FLAG_GROUP_SUMMARY | _FLAG_AUTOGROUP_SUMMARY))


def _finalize(raws: Iterable[RawNotification]) -> dict[str, RichNotificationItem]:
    """The shared rules over a whole list, then group-summary dedup: an app with individual items drops its summary."""
    now_ts = time.time()
    candidates = [built for built in (_build_item(raw, now_ts) for raw in raws) if built is not None]
    apps_with_real_items = {item.package for item, is_summary in candidates if not is_summary}
    items: dict[str, RichNotificationItem] = {}
    for item, is_summary in candidates:
        if is_summary and item.package in apps_with_real_items:
            continue
        items[item.id] = item
    return items


# ---------------------------------------------------------------- source 1: the daemon's listener


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def raw_from_daemon(d: dict[str, Any]) -> RawNotification | None:
    """The daemon's `item` (NotificationEvents.itemJson) → RawNotification; None without package/key."""
    pkg, key = _str(d.get("package")), _str(d.get("key"))
    if not pkg or not key:
        return None
    flags = d.get("flags")
    importance = d.get("importance")
    when = d.get("when")
    return RawNotification(
        package=pkg,
        raw_id=str(d.get("id", "")),
        android_key=key,
        tag=_str(d.get("tag")),
        flags=flags if isinstance(flags, int) else 0,
        title=_str(d.get("title")),
        text=_str(d.get("text")),
        big_text=_str(d.get("big_text")),
        lines=[x for x in (d.get("lines") or []) if isinstance(x, str)],
        summary_text=_str(d.get("summary_text")),
        info_text=_str(d.get("info_text")),
        sub_text=_str(d.get("sub_text")),
        ticker=_str(d.get("ticker")),
        media=bool(d.get("media")),
        importance=importance if isinstance(importance, int) else None,
        actions=[x if isinstance(x, str) else "" for x in (d.get("actions") or [])],
        when_ms=when if isinstance(when, int) else 0,
        shortcut=_str(d.get("shortcut")) or None,
        content_intent=_str(d.get("content_intent")) or None,
    )


def notifications_from_daemon(items: Iterable[dict[str, Any]]) -> dict[str, RichNotificationItem]:
    """The listener's active notifications → {id: item}, by the same rules as the dumpsys path."""
    return _finalize(raw for raw in (raw_from_daemon(d) for d in items if isinstance(d, dict)) if raw is not None)


# ---------------------------------------------------------------- source 2: `dumpsys notification --noredact`


def _raw_from_dumpsys_block(block: str) -> RawNotification | None:
    pkg_match = re.search(r"pkg=([a-zA-Z0-9_.]+)", block)
    id_match = re.search(r"id=(-?\d+)", block)
    if not pkg_match or not id_match:
        return None
    pkg = pkg_match.group(1)
    raw_id = id_match.group(1)
    flags_match = re.search(r"flags=([^\s\)]+)", block)
    tag_match = re.search(r"tag=([^\s\)]+)", block)
    tag = tag_match.group(1) if tag_match else ""
    shortcut_match = re.search(r"shortcut=([^\s\)]+)", block)

    ci_match = (
        re.search(r"contentIntent=PendingIntent\{[^:]*:\s*PendingIntentRecord\{([a-fA-F0-9]+)", block)
        or re.search(r"contentIntent=PendingIntent\{PendingIntentRecord\{([a-fA-F0-9]+)", block)
        or re.search(r"contentIntent=PendingIntent\{([a-fA-F0-9]+)", block)
    )

    # Strict key extraction: Android keys are formatted as <user_id>|<pkg>|<id>|<tag>|<uid> (5 parts)
    uid_match = re.search(r"uid=(\d+)", block)
    user_match = re.search(r"userId=(\d+)", block)
    uid_val = uid_match.group(1) if uid_match else ""
    user_val = user_match.group(1) if user_match else "0"
    constructed_key = f"{user_val}|{pkg}|{raw_id}|{tag or 'null'}|{uid_val}" if uid_val else ""

    key_match = re.search(r"key=([^\s,:\)\r\n]+(?:\s*\|\d+)?)", block)
    if key_match:
        raw_key = re.sub(r"\s+", "", key_match.group(1))
        android_key = raw_key if raw_key.count("|") >= 4 else (constructed_key or raw_key)
    else:
        android_key = constructed_key or raw_id

    # Android InboxStyle lines extraction (e.g. Gmail / WhatsApp message list preview)
    lines: list[str] = []
    text_lines_m = re.search(r"android\.textLines=\[([\s\S]*?)\](?=\r?\n\s*(?:android\.|[a-zA-Z0-9_.]+=|\}))", block)
    if text_lines_m:
        lines = [lm.group(1) for lm in re.finditer(r"(?:String|CharSequence|SpannableString)?\s*\((.*?)\)", text_lines_m.group(1))]

    actions: list[str] = []
    actions_block_m = re.search(r"actions=\{(.*?)\n\s*\}", block, re.DOTALL)
    if actions_block_m:
        actions = [am.group(1) for am in re.finditer(r'\[\d+\]\s*"([^"]+)"', actions_block_m.group(1))]

    imp_match = re.search(r"importance=(\d+)", block)
    when_match = re.search(r"when=(\d+)", block)
    ticker_match = re.search(r"tickerText=(.*?)$", block, re.MULTILINE)
    return RawNotification(
        package=pkg,
        raw_id=raw_id,
        android_key=android_key,
        tag=tag,
        flags=_parse_flags(flags_match.group(1) if flags_match else ""),
        title=_extra(block, "title") or "",
        text=_extra(block, "text") or "",
        big_text=_extra(block, "bigText") or "",
        lines=lines,
        summary_text=_extra(block, "summaryText") or "",
        info_text=_extra(block, "infoText") or "",
        sub_text=_extra(block, "subText") or "",
        ticker=ticker_match.group(1) if ticker_match else "",
        media="category=transport" in block or "MediaStyle" in block,
        importance=int(imp_match.group(1)) if imp_match else None,
        actions=actions,
        when_ms=int(when_match.group(1)) if when_match else 0,
        shortcut=shortcut_match.group(1) if shortcut_match else None,
        content_intent_id=ci_match.group(1) if ci_match else None,
    )


def parse_dumpsys_notifications(dumpsys_out: str) -> dict[str, RichNotificationItem]:
    """Parses active NotificationRecord entries from ADB dumpsys notification --noredact output."""
    if not dumpsys_out:
        return {}
    blocks = dumpsys_out.split("NotificationRecord(")[1:]
    return _finalize(raw for raw in (_raw_from_dumpsys_block(b) for b in blocks) if raw is not None)
