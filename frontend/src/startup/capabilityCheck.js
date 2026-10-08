// Runtime capability discovery.
//
// Tauri uses the OS webview: WebView2 (Chromium) on Windows, WKWebView on macOS,
// WebKitGTK on Linux (out of scope). WebCodecs support differs per engine, so we
// detect and adapt instead of assuming.

export async function detectWebviewEngine() {
  const ua = navigator.userAgent;
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    if (ua.includes('Edg/') || ua.includes('Chrome/')) return 'WebView2';
    if (ua.includes('AppleWebKit') && !ua.includes('Chrome/')) return 'WKWebView';
    return 'WebKitGTK';
  }
  // Plain browser during development behaves like WebView2 (both Chromium).
  return 'WebView2';
}

export async function checkWebCodecsSupport() {
  const support = { h264: false, hevc: false, av1: false, video: false, audio: false };
  if (typeof VideoDecoder !== 'undefined') {
    try {
      const { supported } = await VideoDecoder.isConfigSupported({
        codec: 'avc1.42E01E',
      });
      support.h264 = Boolean(supported);
    } catch {
      support.h264 = false;
    }
    try {
      const { supported } = await VideoDecoder.isConfigSupported({
        codec: 'hvc1.1.6.L93.B0',
      });
      support.hevc = Boolean(supported);
    } catch {
      support.hevc = false;
    }
    try {
      const { supported } = await VideoDecoder.isConfigSupported({
        codec: 'av01.0.08M.08',
      });
      support.av1 = Boolean(supported);
    } catch {
      support.av1 = false;
    }
  }
  support.video = support.h264 || support.hevc || support.av1;
  // AudioDecoder existence check — missing on WKWebView before Safari 26.
  support.audio = typeof AudioDecoder !== 'undefined';
  return support;
}

/**
 * Mirrors the backend's own "auto" resolution (scrcpy_launcher.py
 * _build_command(): effective_codec = video_codec or DEFAULT_VIDEO_CODEC;
 * "auto" -> "h265") so callers probe/report on the SAME codec the server
 * will actually spawn with, not a hardcoded guess.
 */
export function resolveEffectiveVideoCodec(projectVideoCodec) {
  if (!projectVideoCodec || projectVideoCodec === 'auto') return 'h265';
  return projectVideoCodec;
}

/**
 * Adaptive codec selection: raw PCM is the default everywhere (zero
 * decoder dependency); Opus only where AudioDecoder exists AND bandwidth is
 * constrained (wireless) — the backend makes the final call via settings.
 */
export function chooseAudioCodec(support) {
  return support.audio ? 'opus-capable' : 'raw';
}

export async function runStartupChecks() {
  const engine = await detectWebviewEngine();
  const codecs = await checkWebCodecsSupport();
  if (engine === 'WebKitGTK' && !codecs.video) {
    console.warn(
      'WebCodecs desteklenmiyor (WebKitGTK) — Linux kapsam dışı, native decode fallback planlanmadı.',
    );
  }
  return { engine, codecs, audioCodec: chooseAudioCodec(codecs) };
}
