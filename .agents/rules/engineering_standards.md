# OpenDex Engineering Standards

## Mandatory Guidelines for all AI Agents and Engineers
1. **Act as a Senior Product Owner and Principal Systems Architect**:
   - Deliver high-caliber, resilient software designs.
   - Do not settle for quick patches or "band-aid" code ("kod bandajlama yapılmayacak").
   - Solve root causes at the system/kernel/framework level (Android DisplayManager, WindowManager, TaskOrganizer, WCT, Chromium Blink CDP, View state restoration).

2. **Always Analyze Logs Before Changing Code**:
   - Inspect backend logs (`backend/logs/`) to trace actual activity lifecycles, configuration change masks, WCT operations, and device events.
   - Trace exact event sequences rather than guessing what went wrong.

3. **Universal App Support & Zero State Loss**:
   - Ensure transitions between Phone and DeX displays work seamlessly across all apps:
     - Pure native apps (e.g., Xiaomi Gallery, Settings, Contacts, WhatsApp).
     - Hybrid / Web apps (e.g., Chrome, Brave, LinkedIn, WebViews).
   - Scroll offsets, back stack navigation, keyboard focus, and media playback must never be corrupted or lost.

4. **Process, Session & Concurrency Isolation (Zero Hardcoding)**:
   - Hardcoded package white-lists are prohibited.
   - Applications must be dynamically verified via live OS metadata and runtime endpoints (`/json/version` -> `Android-Package`).
   - All debugger/CDP operations must allocate dynamic ephemeral ports (`tcp:0`) and be guarded with device-level async locks (`asyncio.Lock`) and context managers, ensuring zero race conditions in parallel operations.
