// Which graphics card draws the desktop interface — the Settings side of src-tauri/src/gpu.rs.
//
// The choice is a Tauri-side file read before the webview exists, so it applies at the NEXT start: `readGpuPreference()` returns what is
// saved and what this run was started with, and the page says "restart to apply" while they differ. `describeRenderer()` turns what the
// engine reports (WebGL's unmasked renderer, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 …)") into
// the card's name — the one honest answer to "which GPU am I on right now". Outside Tauri (a browser, tests) the reads return null.

import { logger } from './logger.js';

export const GPU_MODES = ['auto', 'high_performance', 'software'];

const isTauri = () => typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

async function invokeNative(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

/** `{ supported, saved, active }` from the shell, or null outside the desktop app / when the shell predates the command. */
export async function readGpuPreference() {
  if (!isTauri()) return null;
  try {
    const pref = await invokeNative('gpu_preference');
    if (!pref || typeof pref !== 'object') return null;
    const known = (mode) => (GPU_MODES.includes(mode) ? mode : 'auto');
    return { supported: Boolean(pref.supported), saved: known(pref.saved), active: known(pref.active) };
  } catch (err) {
    logger.debug('webview', 'gpu preference not readable', err);
    return null;
  }
}

/** Saves the choice (applies at the next start). Throws when the shell refuses, so the page can say so. */
export async function saveGpuPreference(mode) {
  if (!GPU_MODES.includes(mode)) throw new Error(`unknown GPU mode: ${mode}`);
  await invokeNative('set_gpu_preference', { mode });
}

/** Closes OpenDeX (and the backend it started) and opens it again, so a saved choice applies now. Does not return when it works. */
export async function restartApp() {
  await invokeNative('restart_app');
}

/**
 * The card's name from the engine's renderer string; '' when there is nothing readable.
 *   "ANGLE (AMD, AMD Radeon(TM) Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.32015.7029)" → "AMD Radeon(TM) Graphics"
 *   "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"                      → "SwiftShader (software)"
 */
export function describeRenderer(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/swiftshader|llvmpipe|basic render/i.test(text)) return 'SwiftShader (software)';
  const angle = text.match(/^ANGLE \([^,]*,\s*(.+?)\s*\((?:0x[0-9a-f]+|[^()]*)\)\s*(?:Direct3D|OpenGL|Vulkan|Metal)/i);
  if (angle) return angle[1];
  return text.replace(/^ANGLE \(|\)$/g, '').slice(0, 80);
}

/** What this webview renders with right now (a throw-away WebGL context); '' when the engine will not say. */
export function activeRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return describeRenderer(raw);
  } catch {
    return '';
  }
}
