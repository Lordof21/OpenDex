# Product ideas

Candidates for what OpenDeX could add, looked at from the seat of different users. **Ideas, not promises** — [ROADMAP.md](ROADMAP.md) is the list of intentions; an idea moves there once it has an owner and a specification.

Already planned elsewhere and not repeated here: game mode ([design/GAME_MODE.md](design/GAME_MODE.md)), more than one phone, Opus audio, restoring the phone settings OpenDeX changes.

## By user

### Developer / tester

* **Per-window recording and screenshots.** The selected window as MP4 (with the phone's audio) and PNG. The best evidence for a bug report, and it reuses the capture path that already exists.
* **Drag-and-drop APK install and an adb connection panel.** No separate tool to install an app on the phone.
* **Logcat panel.** The log of the app in a window, next to the window.

### Student / office worker

* **Clipboard sync.** Text and images between the PC and the phone, with a history. Used every day by everyone; the largest daily difference for the smallest risk.
* **"Send to → OpenDeX" in the Windows menu.** Shares a file or a link straight into an app on the phone. The file manager exists; this completes it.
* **Open a PC link in the phone's app.** One click from the browser to "open in the app on the phone".

### Content creator / streamer

* **A window as an OBS source.** Virtual camera or a separate capture, with each window's audio as its own channel. The per-app audio routing is already there for it.
* **PC microphone into a phone app.** The PC's microphone for voice chat in an app that runs on the phone.

### Social media / e-commerce manager

* **Several accounts of one app side by side**, through the work profile or a cloned user. The lightweight form of "more than one phone" without a second phone.
* **Notification rules.** Highlight or mute by keyword, scheduled do-not-disturb, quick-reply templates.

### Privacy-minded user

* **Privacy mode.** When Windows locks, or on a shortcut, the windows blur or shrink and the sound mutes. A "panic key".
* **Working with the phone's screen off.** For battery and privacy. The daemon already has a display-power command; the lock / USB side effects have to stay solved for continuous use.

### Everyone: trust in the everyday behaviour

* **Auto-healing.** After a drop and reconnect every window is exactly where it was.
* **A handoff safety net.** A small picture of the window is kept before a handoff; if the app lost its page, a notice offers "go back".
* **A first-run wizard and a "why does it not work" diagnosis.** Turns the checks of [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) into the product. The biggest cut in support work.

### Layout and navigation

* **Scenes.** "Work", "Stream", "Play": which app in which window, at which position, with which audio output. Workspace already remembers a placement per app; this makes it a named, user-facing feature.
* **A command palette everywhere (Ctrl+K).** Apps, notifications, files and window actions in one search. Settings already has it.

## Order

| # | Idea | Why |
|---|---|---|
| 1 | Clipboard sync | Every user, every day; medium effort, low risk. |
| 2 | First-run wizard + diagnosis | Onboarding and support load; built on an existing document. |
| 3 | Scenes | Turns the existing placement memory into something a user can name and sell. |
| 4 | Per-window recording and screenshots | Streamers and developers; built on the solved capture path. |
| 5 | Auto-healing | Trust in everyday use; already the next planned topic. |

**Not yet:** the OBS integration, several accounts and the PC microphone. Each needs its own infrastructure (a driver, user profiles) and should wait until the first three have paid back in trust and speed.

## Next step for an idea

A short specification: the user story, acceptance criteria and the risks. The structure of [design/GAME_MODE.md](design/GAME_MODE.md) is a good model.
