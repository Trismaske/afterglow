# Tester feedback — desktop, answered by v0.6

*Feedback from the v0.5 soak test on home-pc. Each item states the verified current behavior and where the answer lands.*

## 0. "Screensaver doesn't start automatically" (soak tester, 2026-07-26) — resolved, not an Afterglow bug

Environmental: the known Windows 10 stuck-idle-trigger condition after long uptime; a reboot restored it, verified end-to-end on 2026-07-26 (auto-start on idle, exit on input, re-trigger on next idle). The durable diagnostic notes live in [DEVELOPMENT.md](DEVELOPMENT.md) § Windows screensaver diagnostics.

## 1. "No way to access and address and work on queues" (soak tester, 2026-07-25)

**Verified current behavior:** the flag-queue window opens only via the `Q` hotkey *while the slideshow is running* (`renderer/index.ts` `handleHotkey` returns early unless the show is active), advertised only in the shortcut legend. From the windowed settings screen — the default launch since v0.5 — there is no button or hotkey to reach the queue. Inside the queue window the only actions are reveal-in-file-manager, open-with-default-app, and remove-from-queue; flags cannot be acted on (no trash/move/rename/date-fix).

**Answer, split by release:**
- **v0.6 (ridealong): make the queue accessible.** A visible "Flag queue" button on the settings screen, and accept `Q` on the settings screen too. Requires new IPC surface, not just a button: a queue-count query plus change notifications for the settings renderer (today `queueList` rejects every caller except the queue window, and no count/change API exists), wired through `shared/api.ts` → main → preload per the repo pattern, with tests. Because v0.6 also auto-flags every JPEG export as organizer inventory, the button counts **manual** flags with automatic entries as a secondary figure, and the queue window gains source/category filtering — otherwise the tester's own flags drown in thousands of machine entries (scope in `docs/Plan_v0.6.md` P5).
- **v0.7 (planned): make the queue workable.** Organizer mode is exactly this — acting on D/E/M/R/N/T flags (OS trash, move, open in editor, rename, date-fix) plus the burst-culling UI. Already on the roadmap (PLAN.md v0.7); scope decided in `docs/Investigation_v0.6.md` Part B.
