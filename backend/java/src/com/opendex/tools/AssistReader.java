package com.opendex.tools;

import android.app.IAssistDataReceiver;
import android.graphics.Bitmap;
import android.os.Bundle;

import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * What an app says it is showing, without touching its UI: {@code IActivityTaskManager.requestAssistDataForTask} — the call
 * the system assistant ("Circle to Search", "what's on my screen") makes. The app answers from {@code onProvideAssistContent}
 * with an {@code AssistContent}: the page it is on ({@code webUri}) and, for apps that fill it in, schema.org-style
 * structured data. The shell identity holds GET_TOP_ACTIVITY_INFO and MANAGE_ACTIVITY_TASKS, so no root, no accessibility
 * service and no tapping through a share sheet.
 *
 * YouTube (21.x) answers {@code webUri = https://www.youtube.com/watch?v=<id>} and
 * {@code structuredData = {"@videoId", "@videoTimeStamp":"PT6M39.7S", "@videoDuration", "@isPlayerVisible",
 * "@isPlayerFullscreen", "@isPlayerMinimized"}} — exactly the video, the second and whether the player is the full page.
 * That is what a deep link (`am start -a VIEW -d <watch url>&t=<sec>`) needs to put the app back on the same page.
 *
 *   assist_content <task_id>  → {type:"assist_content", ok, task_id, web_uri, structured, intent}
 *
 * The task may live on any display (a virtual display's included). The reply is the app's own words, untouched: parsing
 * stays in the backend.
 */
final class AssistReader {

    private static final long TIMEOUT_MS = 1500;
    private static final int MAX_FIELD = 8192;

    private AssistReader() {}

    /** Receives the Bundle the system server delivers: {taskId, receiverExtras, data, structure, content, activityId}. */
    static final class Receiver extends IAssistDataReceiver.Stub {
        final CountDownLatch done = new CountDownLatch(1);
        volatile Bundle data;

        @Override
        public void onHandleAssistData(Bundle resultData) {
            data = resultData;
            done.countDown();
        }

        @Override
        public void onHandleAssistScreenshot(Bitmap screenshot) {
            // never asked for (fetchScreenshot=false)
        }
    }

    static JSONObject read(int taskId) {
        JSONObject res = Json.obj("type", "assist_content", "task_id", taskId);
        if (taskId <= 0) return Json.put(Json.put(res, "ok", false), "error", "bad_task");
        Object atm = Binders.activityTaskManager();
        if (atm == null) return Json.put(Json.put(res, "ok", false), "error", "atm_unavailable");
        try {
            Method call = null;
            for (Method m : atm.getClass().getMethods()) {
                if (m.getName().equals("requestAssistDataForTask")) call = m;
            }
            if (call == null) return Json.put(Json.put(res, "ok", false), "error", "api_missing");
            Receiver receiver = new Receiver();
            int arity = call.getParameterTypes().length;
            Object accepted;
            // Android 14/15: (receiver, taskId, callingPackage, attributionTag); Android 16 added `boolean fetchScreenshot`.
            if (arity == 5) accepted = call.invoke(atm, receiver, taskId, "com.android.shell", null, false);
            else if (arity == 4) accepted = call.invoke(atm, receiver, taskId, "com.android.shell", null);
            else if (arity == 3) accepted = call.invoke(atm, receiver, taskId, "com.android.shell");
            else return Json.put(Json.put(res, "ok", false), "error", "api_shape");
            if (!(accepted instanceof Boolean) || !((Boolean) accepted)) {
                return Json.put(Json.put(res, "ok", false), "error", "request_refused");
            }
            if (!receiver.done.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                return Json.put(Json.put(res, "ok", false), "error", "app_did_not_answer");
            }
            Bundle bundle = receiver.data;
            Object content = bundle == null ? null : bundle.get("content");
            if (content == null) return Json.put(Json.put(res, "ok", false), "error", "no_content");
            Class<?> c = content.getClass();
            Json.put(res, "web_uri", clip(String.valueOf(c.getMethod("getWebUri").invoke(content)), "null"));
            Json.put(res, "structured", clip(String.valueOf(c.getMethod("getStructuredData").invoke(content)), "null"));
            Json.put(res, "intent", clip(String.valueOf(c.getMethod("getIntent").invoke(content)), "null"));
            return Json.put(res, "ok", true);
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null ? t.getCause() : t;
            return Json.put(Json.put(res, "ok", false), "error", Json.reason(cause));
        }
    }

    /** null when the app left the field empty ("null" is what String.valueOf gives); bounded otherwise. */
    private static String clip(String value, String emptyMarker) {
        if (value == null || value.equals(emptyMarker) || value.isEmpty()) return null;
        return value.length() > MAX_FIELD ? value.substring(0, MAX_FIELD) : value;
    }
}
