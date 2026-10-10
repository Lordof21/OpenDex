# OPENDEX MEMORY & ARCHITECTURAL PRINCIPLES

## 1. Role & Engineering Mindset
- **Role:** Senior Product Owner / Team Lead / Principal Systems Architect.
- **Standards:** All implementations, refactors, and bugfixes must meet the highest engineering standards.
- **Zero Code Bandaging ("Kod Bandajlama Kesinlikle Yasak"):**
  - Temporary hacks, heuristic delays, blind sleeping, and superficial patch-ups are strictly forbidden.
  - Every bug must be investigated down to its root cause (Android OS internals, Window Manager, Chromium Blink rendering engine, View hierarchies, input system, and display configs).
  - Every solution must be architecturally sound, resilient, and universally applicable across all applications (Chrome, Xiaomi Gallery, LinkedIn, WhatsApp, X, Google Apps, etc.).

## 2. Evidence-Based Development (Log Analysis First)
- Before writing or modifying any code for lifecycle, handoff, touch, or window management, backend log records (`backend/logs/`) must be rigorously analyzed.
- Hypotheses must be validated against real system logs and device outputs before committing changes.

## 3. Zero State Loss & Seamless Multi-Display Transitions
- Handoff between Phone (Display 0) and Desktop (Virtual Display) must preserve:
  - Scroll positions (anchored to document coordinate space / top-left 0,0).
  - Input focus and active edit states.
  - Activity stacks and back navigation gestures.
  - Render pipeline stability (no visual jumps, no cumulative drift).

## 4. Strict Process, Session & Concurrency Isolation (Zero-Hardcode)
- **Universal Application Isolation:**
  - No application (Chrome, Brave, Samsung Internet, Instagram, X, etc.) shall ever rely on hardcoded package lists (`_CHROME_PACKAGES` is prohibited).
  - Every application runtime must be verified dynamically via OS artifacts and identity endpoints (`/json/version` -> `Android-Package`).
  - Foreign sockets (e.g. background Chrome while transferring Xiaomi Gallery, Instagram, or Samsung Internet) must be rejected with mathematical certainty.
- **Concurrency & Resource Safety:**
  - Ephemeral ports (`adb forward tcp:0`) must be dynamically allocated for all CDP sessions, eliminating static port collisions across parallel tasks.
  - Asynchronous locks (`asyncio.Lock` per device serial) and context managers (`async with open_cdp_session`) must strictly serialize concurrent bridge requests and guarantee unconditional cleanup.

## 5. Chromium / Blink Page Scale Factor & Stale Cache Pipeline
- **Blink Page Scale Factor (1.2000x) Elimination:**
  - On tablet / DeX viewports (>600dp), Blink applies an internal accessibility scale factor (1.2000x).
  - When transitioning back to phone (Display 0), this cached factor must be explicitly cleared via CDP `Emulation.resetPageScaleFactor`.
- **Stale Text & Layout Cache Invalidation:**
  - Responsive single-page apps and server-side rendered layouts bake viewport decisions into the DOM/CSS at initial load. A synthetic `resize` event cannot flush cached desktop/tablet markup or force Blink TextAutosizer to re-evaluate from scratch.
  - For non-media tabs (`hasMedia: false`), `Network.clearBrowserCache` and `Page.reload(ignoreCache=True)` are executed.
  - Media tabs (`hasMedia: true`) bypass reloading to guarantee uninterrupted playback, falling back to in-place style invalidation.
- **Subpixel Zero-Drift Scroll Restoration:**
  - Scroll position (`scrollX`, `scrollY`, `isTop`) is captured before migration.
  - `overflowAnchor: 'none'` is engaged during layout reflow.
  - Scroll coordinates are strictly re-anchored: `(0, 0)` if `isTop`, or exact subpixel `(savedX, savedY)` with microtask confirmation, achieving proven 0.0px drift on live hardware.

## 6. Multi-Tab Dynamic Active Tab Resolution, Instant Scale Lock & Symmetrical Transition
- **Active Tab Targeting (`_find_active_page_target`):**
  - Android Chromium lists open tabs in `/json/list` in creation/discovery order, NOT active focus order.
  - Relying on `pages[0]` is strictly prohibited in multi-tab environments.
  - Active tab resolution queries `document.visibilityState === 'visible'` (and `document.hasFocus()`) across all open targets to dynamically lock onto the foreground visible tab.
- **Instant Scale Lock (1.0x) & Non-Destructive Cache Busting:**
  - Destructive network page reloads (`Page.reload`) cause execution context destruction, white-screen flashes, and post-load Blink compositor zoom re-invalidation (1.55x zoom oscillation).
  - Scale factor 1.0 is enforced instantly via CDP `Emulation.setPageScaleFactor(1.0)` and `Emulation.resetPageScaleFactor`.
  - HTTP and memory caches are flushed cleanly via `Network.clearBrowserCache` without tearing down the live DOM or disrupting audio/video playback.
- **Multi-Phase Transition Stabilizer across Android Config Settle Window:**
  - Android activity movement and `onConfigurationChanged` asynchronous lifecycle settle over a 100-300ms window.
  - `_build_nudge_script` executes a continuous multi-phase stabilizer (`0ms`, `80ms`, `250ms`, `600ms`) with `overflowAnchor: 'none'`, strictly maintaining `scale = 1.0` and exact subpixel scroll coordinates without allowing Blink to revert to tablet zoom.
- **Tablet 1.20x Magnification De-Zoom Neutralization:**
  - Chromium Blink bakes a `1.2000x` accessibility zoom factor into `visualViewport.zoom` on tablet/DeX viewports.
  - When transitioning to a phone screen (width <= 480dp), `_build_nudge_script` dynamically neutralizes this stale factor (`normZoom = 3.20625 / window.devicePixelRatio ≈ 0.833333`), returning computed font sizes and element widths to exact 1:1 physical dimensions (380.5 dp, 51.3 physical px for 16px font) with 0.0000px origin drift.
- **Display 0 Gesture Navigation & Touch Focus Synchronization:**
  - When transferring tasks from virtual displays (`FLAG_OWN_FOCUS`), Android's `InputDispatcher` and Xiaomi MIUI/HyperOS `GestureStub` retain focus on the previous display ID.
  - `sync_display0_focus` dispatches `input -d 0 keyevent 0` (targeting Display 0 input channel) and `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS` to dismiss ghost overlays/IME layers without sending destructive keys (such as ESC/back), unlocking edge swipe gestures immediately.
- **Bidirectional Symmetry (DeX ⟷ Phone):**
  - Identical subpixel coordinate preservation (0.0000px drift) and instant scale locking are enforced symmetrically across both Handoff (DeX ➔ Phone) and Reclaim (Phone ➔ DeX).

## 7. Automated Integration Test Suite (`tests/test_cdp_layout_integration.py`)
- **Coverage & Verified Invariants:**
  - Ephemeral port forward lifecycle and unconditional exception cleanup via `open_cdp_session`.
  - Multi-tab visibility probe across 16 open tabs simulating background/foreground tabs.
  - Non-destructive CDP command sequence verification (`Emulation.setPageScaleFactor`, `Emulation.resetPageScaleFactor`, `Network.clearBrowserCache`, `Runtime.evaluate`).
  - DOM Element-anchored adaptive scroll vs. origin `(0, 0)` anchor stability in generated JS nudge scripts.
  - End-to-end bidirectional ladder test with `HandoffManager` (Handoff to Phone and Reclaim to DeX) guaranteeing zero process restart for web runtimes.
