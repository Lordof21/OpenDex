"""find_request_intent: a notification's PendingIntent → its requestIntent, never another record's."""
from app.device.intent_utils import find_request_intent

DUMP = """
  * com.whatsapp: 2 items
    #0: PendingIntentRecord{aaaa111 com.whatsapp startActivity}
      uid=10200 packageName=com.whatsapp
    #1: PendingIntentRecord{bbbb222 com.whatsapp startActivity}
      requestIntent=act=android.intent.action.VIEW dat=content://chat/2 cmp=com.whatsapp/.Conversation
"""


def test_request_intent_on_a_following_line():
    assert find_request_intent(DUMP, "bbbb222").startswith("act=android.intent.action.VIEW dat=content://chat/2")


def test_request_intent_on_the_same_line():
    raw = "PendingIntentRecord{cccc333 com.x requestIntent=act=a.b.C cmp=com.x/.Main"
    assert find_request_intent(raw, "cccc333") == "act=a.b.C cmp=com.x/.Main"


def test_a_record_without_request_intent_never_borrows_the_next_ones():
    """deep_navigator used a DOTALL `.*?` that ran past record aaaa111 into bbbb222's intent — opening the wrong chat."""
    assert find_request_intent(DUMP, "aaaa111") is None


def test_unknown_record_and_empty_dump():
    assert find_request_intent(DUMP, "ffff999") is None
    assert find_request_intent("", "aaaa111") is None
