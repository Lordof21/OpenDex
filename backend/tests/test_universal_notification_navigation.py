"""Comprehensive unit tests for the OpenDeX Universal Notification Navigation Engine.
Tests every single tier and edge-case (Tiers 1, 2 [Method A Freeform], 3 [Gmail Search], Fallbacks).
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.device.deep_navigator import (
    _resolve_intent_from_system,
    _execute_deep_navigation,
    _resolve_sms_thread_id,
    find_task_id_for_package,
)


class MockAdb:
    def __init__(self):
        self.shell_calls: list[str] = []
        self.exec_out_calls: list[str] = []
        self.responses: dict[str, str] = {}

    async def shell(self, cmd: str, serial: str | None = None, timeout_s: float = 3.0) -> str:
        self.shell_calls.append(cmd)
        for pattern, response in self.responses.items():
            if pattern in cmd:
                return response
        return ""

    async def exec_out(self, *args, serial: str | None = None, timeout_s: float = 3.0) -> bytes:
        cmd_str = " ".join(str(a) for a in args)
        self.exec_out_calls.append(cmd_str)
        return b'{"ok":true}'

    async def run_java_tool(self, jar_device_path, class_name, *args, serial=None, timeout_s=5.0, capture_bytes=False):
        cmd = f"CLASSPATH={jar_device_path} app_process / {class_name} " + " ".join(str(a) for a in args)
        if capture_bytes:
            return await self.exec_out("sh", "-c", cmd, serial=serial, timeout_s=timeout_s)
        return await self.shell(cmd, serial=serial, timeout_s=timeout_s)


class MockContext:
    def __init__(self, serial: str | None = "TEST_SERIAL_123"):
        self.serial = serial
        self.adb = MockAdb()
        self.window_manager = MagicMock()
        self.notifications = MagicMock()
        self.event_bus = AsyncMock()


@pytest.mark.asyncio
async def test_resolve_intent_from_system_success():
    """State 1: Verifies resolution from cmd notification get and dumpsys activity intents."""
    ctx = MockContext()
    key = "0|com.linkedin.android|12345|null|10310"

    raw_rec = """
    NotificationRecord(key=0|com.linkedin.android|12345|null|10310)
      notification=
        contentIntent=PendingIntent{3499f84: PendingIntentRecord{57d9946 com.linkedin.android startActivity}}
    """
    raw_intents = """
    * com.linkedin.android: 1 items
      #0: PendingIntentRecord{57d9946 com.linkedin.android startActivity}
        requestIntent=act=android.intent.action.VIEW dat=https://www.linkedin.com/feed cmp=com.linkedin.android/.urls.DeeplinkActivity flg=0x14000000
    """
    ctx.adb.responses["cmd notification get"] = raw_rec
    ctx.adb.responses["dumpsys activity intents com.linkedin.android"] = raw_intents

    resolved = await _resolve_intent_from_system(ctx, key, "com.linkedin.android")
    assert resolved is not None
    assert "-a android.intent.action.VIEW" in resolved
    assert "-d https://www.linkedin.com/feed" in resolved          # shlex-quoted: plain URIs need no quotes
    assert "-n com.linkedin.android/.urls.DeeplinkActivity" in resolved
    assert "-f 0x14000000" in resolved


@pytest.mark.asyncio
async def test_resolve_intent_from_system_missing_content_intent():
    """State 2: Returns None gracefully if notification has no contentIntent."""
    ctx = MockContext()
    key = "0|com.test.app|1|null|1000"
    ctx.adb.responses["cmd notification get"] = "NotificationRecord(without contentIntent)"

    resolved = await _resolve_intent_from_system(ctx, key, "com.test.app")
    assert resolved is None


@pytest.mark.asyncio
async def test_resolve_intent_from_system_missing_record_in_dumpsys():
    """State 3: Returns None gracefully if record ID cannot be matched in dumpsys."""
    ctx = MockContext()
    key = "0|com.test.app|1|null|1000"
    ctx.adb.responses["cmd notification get"] = "contentIntent=PendingIntent{123: PendingIntentRecord{9999999 com.test.app startActivity}}"
    ctx.adb.responses["dumpsys activity intents"] = "ACTIVITY MANAGER PENDING INTENTS (empty)"

    resolved = await _resolve_intent_from_system(ctx, key, "com.test.app")
    assert resolved is None


@pytest.mark.asyncio
async def test_execute_deep_navigation_tier1_direct_launch():
    """State 4: Tier 1 - Direct Virtual Display Launch succeeds and dismisses notification."""
    ctx = MockContext()
    key = "0|com.whatsapp|1|null|10200"

    raw_rec = "contentIntent=PendingIntent{1: PendingIntentRecord{aaaa111 com.whatsapp startActivity}}"
    raw_intents = "PendingIntentRecord{aaaa111 com.whatsapp requestIntent=act=android.intent.action.VIEW dat=content://com.whatsapp.provider.contact/contacts/42 cmp=com.whatsapp/.Conversation flg=0x14000000"
    ctx.adb.responses["cmd notification get"] = raw_rec
    ctx.adb.responses["dumpsys activity intents com.whatsapp"] = raw_intents
    ctx.adb.responses["am start --display 3"] = "Starting: Intent { act=android.intent.action.VIEW }"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg="com.whatsapp",
        disp_id="3",
        target_key=key,
        title="John Doe",
        text="Hello there",
    )

    assert result is True
    # Verify am start on virtual display 3 was called
    start_calls = [c for c in ctx.adb.shell_calls if "am start --display 3" in c]
    assert len(start_calls) >= 1
    assert "content://com.whatsapp.provider.contact/contacts/42" in start_calls[0]
    # Verify notification clear was called
    assert any("NotificationInvoker clear" in c for c in ctx.adb.exec_out_calls)


@pytest.mark.asyncio
async def test_execute_deep_navigation_tier2_method_a_freeform_task_migration():
    """State 5: Tier 2 (Method A) - When unexported component gives SecurityException, uses Freeform WindowingMode 5."""
    ctx = MockContext()
    pkg = "com.unexported.bank"
    disp_id = "2"
    intent_args = "-a android.intent.action.VIEW -n com.unexported.bank/.PrivateActivity"

    # Direct start fails with SecurityException
    ctx.adb.responses[f"am start --display {disp_id}"] = "java.lang.SecurityException: Permission Denial: starting Intent not exported"
    # Freeform start succeeds
    ctx.adb.responses["am start --windowingMode 5"] = "Starting: Intent in freeform"
    # Task list returns task id 789
    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0 (machine generated):
      ActivityRecord{123 u0 com.unexported.bank/.PrivateActivity t789}
    """
    ctx.adb.responses["am display move-stack 789 2"] = "Stack moved"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=intent_args,
    )

    assert result is True
    # Verify WindowingMode 5 (Freeform) was called without disturbing Display 0 full-screen
    assert any("am start --windowingMode 5" in c for c in ctx.adb.shell_calls)
    # Verify move-stack was executed
    assert any("am display move-stack 789 2" in c for c in ctx.adb.shell_calls)


@pytest.mark.asyncio
async def test_execute_deep_navigation_tier2_systemui_click_fallback():
    """State 6: When even am start is totally denied, falls back to invoke_notification_click."""
    ctx = MockContext()
    pkg = "com.strict.app"
    disp_id = "4"
    target_key = "0|com.strict.app|99|null|1000"

    ctx.adb.responses["am start --display 4"] = "Permission Denial"
    ctx.adb.responses["am start --windowingMode 5"] = "SecurityException: not exported"
    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0:
      ActivityRecord{abc u0 com.strict.app/.Main t456}
    """

    with patch("app.device.deep_navigator.invoke_notification_click", new_callable=AsyncMock) as mock_click:
        result = await _execute_deep_navigation(
            ctx=ctx,
            pkg=pkg,
            disp_id=disp_id,
            intent_args="-n com.strict.app/.Main",
            target_key=target_key,
        )

        assert result is True
        mock_click.assert_called_once_with(ctx.adb, ctx.serial, target_key)
        assert any("am display move-stack 456 4" in c for c in ctx.adb.shell_calls)


@pytest.mark.asyncio
async def test_execute_deep_navigation_tier3_gmail_safe_conversation_launch():
    """State 7: Tier 3 - Gmail safe conversation launch preventing black screen."""
    ctx = MockContext()
    pkg = "com.google.android.gm"
    disp_id = "5"
    title = "Sipariş Onayı - Trendyol"

    ctx.adb.responses["am start --display 5"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args="-n com.google.android.gm/.ui.MailActivityGmail",
        title=title,
    )

    assert result is True
    # Verify ConversationListActivityGmail was safely launched on display 5
    safe_calls = [c for c in ctx.adb.shell_calls if 'ConversationListActivityGmail' in c and '--display 5' in c]
    assert len(safe_calls) >= 1


@pytest.mark.asyncio
async def test_execute_deep_navigation_sms_content_provider_fallback():
    """State 8: SMS fallback queries content://sms and targets ComposeMessageRouterActivity."""
    ctx = MockContext()
    pkg = "com.android.mms"
    disp_id = "2"
    title = "Vodafone"
    text = "Faturanız hazır"

    ctx.adb.responses["content query --uri content://sms"] = """
    Row: 0 thread_id=77, address=Vodafone, body=Faturanız hazır
    """
    ctx.adb.responses["am start --display 2"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        title=title,
        text=text,
    )

    assert result is True
    sms_calls = [c for c in ctx.adb.shell_calls if "content://mms-sms/conversations/77" in c]
    assert len(sms_calls) >= 1
    assert "ComposeMessageRouterActivity" in sms_calls[0]


@pytest.mark.asyncio
async def test_execute_deep_navigation_no_serial_noop():
    """State 9: No connected device serial returns True safely without exceptions."""
    ctx = MockContext(serial=None)
    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg="com.any.app",
        disp_id="1",
    )
    assert result is True
    assert len(ctx.adb.shell_calls) == 0


@pytest.mark.asyncio
async def test_execute_deep_navigation_sms_unexported_activity_intercepted():
    """State 10: Verifies that an unexported SingleRecipientConversationActivity in intent_args
    is intercepted, thread_id resolved, and rewritten to ComposeMessageRouterActivity."""
    ctx = MockContext()
    pkg = "com.android.mms"
    disp_id = "539"
    unexported_args = "-n com.android.mms/.ui.activity.phone.activity.SingleRecipientConversationActivity -f 0x14000000"

    ctx.adb.responses["content query --uri content://sms"] = """
    Row: 0 thread_id=16, address=05392999221, body=Hasan Amedin numarasını bana atabilirmisin
    """
    ctx.adb.responses["am start --display 539"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=unexported_args,
        title="alice",
        text="hjll",
    )

    assert result is True
    sms_calls = [c for c in ctx.adb.shell_calls if "am start --display 539" in c]
    assert len(sms_calls) >= 1
    # Must NOT call the unexported SingleRecipientConversationActivity
    assert "SingleRecipientConversationActivity" not in sms_calls[0]
    # Must call ComposeMessageRouterActivity with resolved thread_id 16
    assert "ComposeMessageRouterActivity" in sms_calls[0]
    assert "content://mms-sms/conversations/16" in sms_calls[0]


def test_open_window_request_auto_start_app():
    """State 11: Verifies OpenWindowRequest model schema supports auto_start_app."""
    from app.api.v1.endpoints.windows import OpenWindowRequest
    req_default = OpenWindowRequest(package="com.whatsapp")
    assert req_default.auto_start_app is True

    req_disabled = OpenWindowRequest(package="com.whatsapp", auto_start_app=False)
    assert req_disabled.auto_start_app is False


@pytest.mark.asyncio
async def test_execute_deep_navigation_twitter_unexported_trampoline_step5_fallback():
    """State 12: Verifies that when Twitter's unexported SwapAccountActivity fails,
    and Tier 2 times out, Step 5 resolves com.x.android.main.MainActivity and launches on disp_id,
    preventing any 'screen waiting' deadlock."""
    ctx = MockContext()
    pkg = "com.twitter.android"
    disp_id = "541"
    swap_account_args = "-a com.x.account.SWAP_ACCOUNT_ACTION -n com.twitter.android/com.x.account.swapaccount.SwapAccountActivity -f 0x14000000"

    # Tier 1 fails with SecurityException
    ctx.adb.responses["am start --display 541"] = "java.lang.SecurityException: Permission Denial: starting Intent not exported"
    # Tier 2 Freeform start fails with SecurityException
    ctx.adb.responses["am start --windowingMode 5"] = "SecurityException: not exported"
    # Step 5 package resolve-activity returns MainActivity
    ctx.adb.responses["cmd package resolve-activity --brief com.twitter.android"] = """
    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
    com.twitter.android/com.x.android.main.MainActivity
    """
    ctx.adb.responses["am start --display 541 -n com.twitter.android/com.x.android.main.MainActivity"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=swap_account_args,
    )

    assert result is True
    # Verify Step 5 safely launched MainActivity on display 541
    main_calls = [c for c in ctx.adb.shell_calls if "com.x.android.main.MainActivity" in c and "--display 541" in c]
    assert len(main_calls) >= 1


@pytest.mark.asyncio
async def test_execute_deep_navigation_gmail_unexported_provider_invokes_click():
    """State 13: Verifies that Gmail notification with unexported SapiUiProvider URI
    triggers invoke_notification_click and migrates task from Display 0 to disp_id,
    bypassing the Shell permission denial."""
    ctx = MockContext()
    pkg = "com.google.android.gm"
    disp_id = "561"
    target_key = "0|com.google.android.gm|12345|null|10192"
    intent_args = (
        "-a android.intent.action.VIEW -d 'content://com.google.android.gm.sapi/test@gmail.com/notifications' "
        "-t 'application/gmail-ls' -n com.google.android.gm/.ui.MailActivityGmail -f 0x1000c000"
    )

    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0:
      Task{aabbcc #3850 type=standard A=10192:com.google.android.gm}
    Display #561:
      Task{aabbcc #3850 type=standard A=10192:com.google.android.gm}
    """
    ctx.adb.responses["am display move-stack 3850 561"] = "Stack moved"

    with patch("app.device.deep_navigator.invoke_notification_click", new_callable=AsyncMock) as mock_click:
        result = await _execute_deep_navigation(
            ctx=ctx,
            pkg=pkg,
            disp_id=disp_id,
            intent_args=intent_args,
            target_key=target_key,
            title="Amazon.com.tr",
        )

        assert result is True
        mock_click.assert_called_once_with(ctx.adb, ctx.serial, target_key)
        # Verify task was migrated from Display 0 to Display 561
        assert any("am display move-stack 3850 561" in c for c in ctx.adb.shell_calls)


@pytest.mark.asyncio
async def test_is_display_has_activity():
    """State 14: Verifies _is_display_has_activity correctly detects whether display has tasks."""
    from app.device.deep_navigator import _is_display_has_activity
    ctx = MockContext()

    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0:
      Task{11 #1 type=home}
    Display #560:
      Task{22 #3847 type=standard A=10310:com.linkedin.android}
    Display #561:
    """

    assert await _is_display_has_activity(ctx, "560") is True
    assert await _is_display_has_activity(ctx, "561") is False
    assert await _is_display_has_activity(ctx, "0") is True


@pytest.mark.asyncio
async def test_execute_deep_navigation_whatsapp_single_start_no_double_jump():
    """State 15: Verifies that WhatsApp is started exactly ONCE without duplicate _safety_settle re-triggers."""
    ctx = MockContext()
    pkg = "com.whatsapp"
    disp_id = "563"
    intent_args = "-a com.whatsapp.intent.action.OPEN -d content://com.whatsapp.provider.contact/contacts/146 -n com.whatsapp/.Conversation -f 0x14000000"

    ctx.adb.responses[f"am start --display {disp_id}"] = "Starting: Intent { act=com.whatsapp.intent.action.OPEN }"
    # Display 563 already has com.whatsapp running
    ctx.adb.responses["dumpsys activity activities"] = f"""
    Display #{disp_id}:
      Task{{123 #3852 type=standard A=10323:com.whatsapp}}
        ActivityRecord{{abc u0 com.whatsapp/.Conversation t3852}}
    Display #0:
      Task{{999 #3850 type=standard A=10323:com.whatsapp}}
    """

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=intent_args,
        target_key="0|com.whatsapp|1|abc|10323",
        title="Alice",
        text="Hello",
    )

    assert result is True
    # Verify am start for WhatsApp conversation was executed exactly once
    start_calls = [c for c in ctx.adb.shell_calls if "com.whatsapp/.Conversation" in c and f"--display {disp_id}" in c]
    assert len(start_calls) == 1
    # Verify no move-stack was executed from Display 0 because WhatsApp was already on Display 563
    move_calls = [c for c in ctx.adb.shell_calls if "am display move-stack" in c]
    assert len(move_calls) == 0


@pytest.mark.asyncio
async def test_execute_deep_navigation_instagram_notification_routing():
    """State 16: Verifies that Instagram Lite generic stale_badge notification
    is rewritten to the Notifications deep link instead of launching MainActivity/home."""
    ctx = MockContext()
    pkg = "com.instagram.lite"
    disp_id = "564"
    stale_args = "-a stale_badge -n com.instagram.lite/com.facebook.lite.MainActivity -f 0x24000000"

    ctx.adb.responses[f"am start --display {disp_id}"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=stale_args,
        target_key="0|com.instagram.lite|-839429361|null|10373",
        title="instagram lite",
        text="4 new notifications waiting for you",
    )

    assert result is True
    # Verify that the command was rewritten to https://www.instagram.com/notifications/
    ig_calls = [c for c in ctx.adb.shell_calls if "am start" in c and f"--display {disp_id}" in c]
    assert len(ig_calls) >= 1
    assert "https://www.instagram.com/notifications/" in ig_calls[0]
    assert "stale_badge" not in ig_calls[0]


@pytest.mark.asyncio
async def test_execute_deep_navigation_gmail_black_screen_prevention():
    """State 17: Verifies that if invoke_notification_click does not yield a task on Display 0,
    ConversationListActivityGmail is launched directly on disp_id, preventing an empty/black screen."""
    ctx = MockContext()
    pkg = "com.google.android.gm"
    disp_id = "567"
    target_key = "0|com.google.android.gm|1276606807|null|10192"
    intent_args = (
        "-a android.intent.action.VIEW -d 'content://com.google.android.gm.sapi/test@gmail.com/notifications' "
        "-t 'application/gmail-ls' -n com.google.android.gm/.ui.MailActivityGmail -f 0x1000c000"
    )

    # Display 0 has no task for Gmail (notification click didn't produce task)
    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0:
      Task{11 #1 type=home}
    Display #567:
    """
    ctx.adb.responses[f"am start --display {disp_id} -n com.google.android.gm/.ConversationListActivityGmail -f 0x10000000"] = "Starting: Intent"

    with patch("app.device.deep_navigator.invoke_notification_click", new_callable=AsyncMock) as mock_click:
        result = await _execute_deep_navigation(
            ctx=ctx,
            pkg=pkg,
            disp_id=disp_id,
            intent_args=intent_args,
            target_key=target_key,
            title="Alice",
            text="alice@example.com",
        )

        assert result is True
        mock_click.assert_called_once_with(ctx.adb, ctx.serial, target_key)
        # Verify safe direct launch on disp_id was executed
        safe_calls = [
            c for c in ctx.adb.shell_calls
            if "ConversationListActivityGmail" in c and f"--display {disp_id}" in c
        ]
        assert len(safe_calls) >= 1


@pytest.mark.asyncio
async def test_execute_deep_navigation_google_search_routing():
    """State 18: Verifies that a Google App weather/search notification with unexported
    InternalGoogleAppActivityEntrypoint is rewritten to WEB_SEARCH with the title query on disp_id."""
    ctx = MockContext()
    pkg = "com.google.android.googlequicksearchbox"
    disp_id = "571"
    unexported_args = (
        '-d "ga:/data?tab_type=2&ga_query_options=Cgd3ZWF0aGVy" '
        '-n com.google.android.googlequicksearchbox/.InternalGoogleAppActivityEntrypoint -f 0x10000000'
    )

    ctx.adb.responses[f"am start --display {disp_id}"] = "Starting: Intent"

    result = await _execute_deep_navigation(
        ctx=ctx,
        pkg=pkg,
        disp_id=disp_id,
        intent_args=unexported_args,
        target_key="0|com.google.android.googlequicksearchbox|0|1775372201::a:snotification|10175",
        title="36° in silvan",
        text="sunny · see full forecast",
    )

    assert result is True
    # Verify am start WEB_SEARCH with query '36° in silvan' was executed
    search_calls = [
        c for c in ctx.adb.shell_calls
        if "android.intent.action.WEB_SEARCH" in c and f"--display {disp_id}" in c
    ]
    assert len(search_calls) >= 1
    assert "36° in silvan" in search_calls[0]
    assert "InternalGoogleAppActivityEntrypoint" not in search_calls[0]


def _lock_session(win_id: str = "win-wa"):
    from types import SimpleNamespace

    return SimpleNamespace(
        state=SimpleNamespace(window_id=win_id, display_id="577"),
        server=SimpleNamespace(sockets=None, display_id="577"),
        dpi=520,
    )


@pytest.mark.asyncio
async def test_execute_deep_navigation_app_lock_is_handed_to_the_shared_waiter_then_opens_the_deep_link(monkeypatch):
    """State 19: AppLock blocks the start on the secondary display. Navigation hands over to the SAME waiter a window
    uses (window_lifecycle_coordinator.wait_for_app_lock_unlock — cancel detection, window_id in its events; its state
    machine is covered by test_applock_state_machine.py) and, once unlocked, opens the notification's own deep intent on
    the virtual display (WhatsApp with CLEAR_TOP so HomeActivity doesn't swallow the chat)."""
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    pkg, disp_id = "com.whatsapp", "577"
    session = _lock_session()
    ctx.window_manager.get_session_by_package.return_value = session
    ctx.window_manager.get_session.return_value = session
    intent_args = '-a com.whatsapp.intent.action.OPEN -d "content://com.whatsapp.provider.contact/contacts/146" -n com.whatsapp/.Conversation -f 0x10000000'
    ctx.adb.responses[f"am start --display {disp_id}"] = (
        "SecurityException: Permission Denial: starting Intent "
        "{ act=miui.intent.action.APPLOCK_ACCESS_CONTROL flg=0x8800000 "
        "pkg=com.miui.securitycenter cmp=com.miui.securitycenter/com.miui.applicationlock.AppLockActivity } "
        f"from null with launchDisplayId={disp_id}"
    )
    ctx.adb.responses["dumpsys activity activities"] = f"Display #{disp_id}\n  Task{{a1 #3879 A=10:com.whatsapp}}\n"
    waiter = AsyncMock(return_value=True)
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", waiter)

    result = await _execute_deep_navigation(
        ctx=ctx, pkg=pkg, disp_id=disp_id, intent_args=intent_args,
        target_key="0|com.whatsapp|1|key|10323", title="alice", text="test",
    )

    assert result is True
    kwargs = waiter.await_args.kwargs
    assert (kwargs["pkg_name"], kwargs["win_id"], kwargs["disp_id"]) == (pkg, "win-wa", disp_id)
    assert kwargs["is_alive"]() is True
    deep = [c for c in ctx.adb.shell_calls if c.startswith(f"am start --display {disp_id} -a com.whatsapp.intent.action.OPEN")]
    assert deep and deep[-1].endswith("-f 0x14000000")


@pytest.mark.asyncio
async def test_app_lock_not_opened_sends_no_deep_link(monkeypatch):
    """State 20: the waiter reports cancelled/timeout — no deep intent is fired at a still-locked app."""
    from app.device.deep_navigator import _Nav, _wait_for_app_lock_then_deep_link
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    ctx.window_manager.get_session_by_package.return_value = _lock_session()
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", AsyncMock(return_value=False))
    nav = _Nav(ctx=ctx, pkg="com.whatsapp", disp_id="577", target_key=None, title=None, text=None,
               final_args="-a android.intent.action.VIEW -d 'x://y'")

    assert await _wait_for_app_lock_then_deep_link(nav) is False
    assert not [c for c in ctx.adb.shell_calls if c.startswith("am start")]


@pytest.mark.asyncio
async def test_app_lock_without_a_window_session_does_not_wait(monkeypatch):
    from app.device.deep_navigator import _Nav, _wait_for_app_lock_then_deep_link
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    ctx.window_manager.get_session_by_package.return_value = None
    waiter = AsyncMock(return_value=True)
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", waiter)
    nav = _Nav(ctx=ctx, pkg="com.whatsapp", disp_id="577", target_key=None, title=None, text=None, final_args=None)

    assert await _wait_for_app_lock_then_deep_link(nav) is False
    waiter.assert_not_awaited()
