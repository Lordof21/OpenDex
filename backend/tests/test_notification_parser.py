"""Tests for parse_dumpsys_notifications and RichNotificationItem.
Validates multiline text preservation, InboxStyle textLines parsing,
and rich payload generation without artificial truncation.
"""
import pytest
from app.device.notification_parser import parse_dumpsys_notifications
from app.schemas.notifications import RichNotificationItem, NotificationCategory


def test_parse_dumpsys_multiline_text():
    raw_dumpsys = """
  NotificationRecord(0x1234 uid=10234 userId=0 pkg=org.telegram.messenger id=101 tag=null flags=0x10)
    uid=10234 userId=0 pkg=org.telegram.messenger id=101
    key=0|org.telegram.messenger|101|null|10234
    when=1726580000000
    extras={
      android.title=String (Ahmet)
      android.text=String (Merhaba dostum,
Toplantı 15:30'da başlayacak.
Gerekli dökümanları ekte bulabilirsin.)
      android.subText=null
    }
    """
    items = parse_dumpsys_notifications(raw_dumpsys)
    assert len(items) == 1
    item = list(items.values())[0]

    assert item.title == "Ahmet"
    assert "Merhaba dostum," in item.text
    assert "Toplantı 15:30'da başlayacak." in item.text
    assert "Gerekli dökümanları ekte bulabilirsin." in item.text
    assert item.package == "org.telegram.messenger"
    assert item.category == NotificationCategory.MESSAGE


def test_parse_dumpsys_big_text_multiline():
    raw_dumpsys = """
  NotificationRecord(0x5678 uid=10190 userId=0 pkg=com.google.android.gm id=202 tag=null flags=0x10)
    uid=10190 userId=0 pkg=com.google.android.gm id=202
    key=0|com.google.android.gm|202|null|10190
    when=1726580000000
    extras={
      android.title=String (Ekip Güncellemesi)
      android.text=String (Yeni sürüm yayınlandı)
      android.bigText=CharSequence (Değerli ekip arkadaşları,
Bugün itibariyle 2.0 sürümünü başarıyla yayına aldık.
Tüm katkılarınız ve özverili çalışmalarınız için teşekkürler!)
      android.subText=String (Şirket Bülteni)
    }
    """
    items = parse_dumpsys_notifications(raw_dumpsys)
    assert len(items) == 1
    item = list(items.values())[0]

    assert item.title == "Ekip Güncellemesi"
    assert item.big_text is not None
    assert "Değerli ekip arkadaşları," in item.big_text
    assert "2.0 sürümünü başarıyla yayına aldık." in item.big_text
    assert item.sub_text == "Şirket Bülteni"
    # Prioritized body text resolves to big_text
    assert "2.0 sürümünü başarıyla yayına aldık." in item.text


def test_parse_dumpsys_inbox_style_text_lines():
    raw_dumpsys = """
  NotificationRecord(0x9999 uid=10080 userId=0 pkg=com.whatsapp id=303 tag=null flags=0x10)
    uid=10080 userId=0 pkg=com.whatsapp id=303
    key=0|com.whatsapp|303|null|10080
    when=1726580000000
    extras={
      android.title=String (WhatsApp Grubu (3 mesaj))
      android.text=String (3 yeni mesaj)
      android.textLines=[
        CharSequence (Ali: Proje teslim edildi mi?)
        CharSequence (Veli: Evet, kontrol edildi.)
        CharSequence (Ayşe: Harika, elinize sağlık!)
      ]
    }
    """
    items = parse_dumpsys_notifications(raw_dumpsys)
    assert len(items) == 1
    item = list(items.values())[0]

    assert item.title == "WhatsApp Grubu (3 mesaj)"
    assert len(item.lines) == 3
    assert item.lines[0] == "Ali: Proje teslim edildi mi?"
    assert item.lines[1] == "Veli: Evet, kontrol edildi."
    assert item.lines[2] == "Ayşe: Harika, elinize sağlık!"

    # to_dict verification
    data = item.to_dict()
    assert "lines" in data
    assert data["lines"] == item.lines


def _record(nid: int, flags: str, title: str, text: str) -> str:
    return f"""
  NotificationRecord(0x{nid:x} uid=10080 userId=0 pkg=com.whatsapp id={nid} tag=null flags={flags})
    uid=10080 userId=0 pkg=com.whatsapp id={nid}
    key=0|com.whatsapp|{nid}|null|10080
    when=1726580000000
    extras={{
      android.title=String ({title})
      android.text=String ({text})
    }}
    """


@pytest.mark.parametrize("summary_flags", ["0x210", "0x610"])  # FLAG_GROUP_SUMMARY (0x200) / + AUTOGROUP (0x400)
def test_group_summary_is_dropped_when_the_app_has_real_items(summary_flags):
    """dumpsys prints flags as HEX; the old `"GROUP_SUMMARY" in flags` text check never matched, so the summary
    ("2 yeni mesaj") showed up as an extra card next to the messages it summarises."""
    raw = _record(1, summary_flags, "WhatsApp", "2 yeni mesaj") + _record(2, "0x10", "Ali", "Merhaba")
    items = parse_dumpsys_notifications(raw)
    assert [i.title for i in items.values()] == ["Ali"]


def test_group_summary_is_kept_when_it_is_the_only_item():
    items = parse_dumpsys_notifications(_record(1, "0x210", "WhatsApp", "2 yeni mesaj"))
    assert [i.title for i in items.values()] == ["WhatsApp"]


@pytest.mark.parametrize("flags, ongoing", [("0x10", False), ("0x12", True), ("0x30", True)])
def test_ongoing_is_read_from_the_numeric_flags(flags, ongoing):
    (item,) = parse_dumpsys_notifications(_record(1, flags, "Navigasyon", "Sağa dönün")).values()
    assert item.is_ongoing is ongoing
