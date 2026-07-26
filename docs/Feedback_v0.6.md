# Tester feedback — desktop, answered by v0.6

*Feedback from the v0.5 soak test on home-pc. Each item states the verified current behavior and where the answer lands.*

## 0. "Screensaver doesn't start automatically" (soak tester, 2026-07-26) — resolved, not an Afterglow bug

Environmental: after 19 days of uptime Windows had stopped firing the screensaver trigger entirely (verified: registration, timeout, runtime state, and manual `.scr` launches all healthy; even stock savers wouldn't auto-start — the known Windows 10 stuck-trigger condition). A reboot restored it; verified end-to-end on 2026-07-26: auto-start on idle, exit on input, re-trigger on the next idle. Diagnostic notes for the future: the OS-launched process is named `Afterglow.scr` (not `Afterglow`), and remote GDI screen captures of the running saver can be black while the monitor shows photos (fullscreen output promoted to a hardware overlay plane) — neither is a defect.

## 1. "No way to access and address and work on queues" (soak tester, 2026-07-25)

**Verified current behavior:** the flag-queue window opens only via the `Q` hotkey *while the slideshow is running* (`renderer/index.ts` `handleHotkey` returns early unless the show is active), advertised only in the shortcut legend. From the windowed settings screen — the default launch since v0.5 — there is no button or hotkey to reach the queue. Inside the queue window the only actions are reveal-in-file-manager, open-with-default-app, and remove-from-queue; flags cannot be acted on (no trash/move/rename/date-fix).

**Answer, split by release:**
- **v0.6 (ridealong): make the queue accessible.** A visible "Flag queue" button on the settings screen (with its count), and accept `Q` on the settings screen too. Requires new IPC surface, not just a button: a queue-count query plus change notifications for the settings renderer (today `queueList` rejects every caller except the queue window, and no count/change API exists), wired through `shared/api.ts` → main → preload per the repo pattern, with tests.
- **v0.7 (planned): make the queue workable.** Organizer mode is exactly this — acting on D/E/M/R/N/T flags (OS trash, move, open in editor, rename, date-fix) plus the burst-culling UI. Already on the roadmap (PLAN.md v0.7); scope decided in `docs/Investigation_v0.6.md` Part B.
