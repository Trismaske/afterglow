# Assumptions — review shortlist

The autonomous calls most worth Tristan's attention, **kept current**:
items are removed once resolved or approved. Full per-version rationale
(append-only, historical) lives in [assumptions-core.md](assumptions-core.md),
[assumptions-desktop.md](assumptions-desktop.md) and
[assumptions-mobile.md](assumptions-mobile.md).

## Open — needs your action

1. **m0.6's editor-launch fix must be verified on the Samsung device.**
   The 2026-07-18 round confirmed neither `ACTION_EDIT` nor the
   `ACTION_VIEW` fallback opens anything there; the planned fix
   (explicit MIME + preserved diagnostics first; native chooser only if
   needed — see [Plan_20260718.md](Plan_20260718.md) #1) is only provable
   on that phone.
2. **m0.6 MediaStore acceptance needs the Samsung device:** confirm a cull
   appears in Gallery trash and restores, and confirm a batched favourite /
   unfavourite is actually surfaced by Samsung Gallery.
3. **Windows screensaver: first live test passed** (idle timeout fires,
   saver starts) — longer-term soak is underway with testers; watch for
   reports before calling it done.
4. **Branch hygiene:** `initial` (pushed) is still unmerged — `main` holds
   only the initial commit; merge via PR when ready. Deleting the approved
   `copilot/add-raw-file-support` branch needs your shell:
   `git push origin --delete copilot/add-raw-file-support`.

## Deferred by decision (2026-07-18): revisit before 1.0

- **Code signing** (Windows cert / macOS notarization) — SmartScreen
  "More info → Run anyway" stays the documented tester path until then.
- **The standing policy calls below** — approved to ride as-is until the
  pre-1.0 review.
- **iOS evaluation — deferred post-1.0 until further notice** (not just
  pre-1.0): no iOS users or testers today. Revisit only when one appears.
- **GitLab releases — deferred until further notice.** GitHub Releases is
  the sole delivery path; do not add GitLab CI/remotes without a new decision.

## Standing policy decisions (riding until the pre-1.0 review)

- **Trash-path conservatism (mobile):** both removal affordances use the local
  Android 11+ `MediaStore.createTrashRequest` boundary. API < 30 and a missing
  native module have no permanent-delete fallback. Cancellation is distinct
  from operational failure; SQLite remains staged unless Android approved.
- **One public m0.6:** internal safety/feature/device gates are not separate
  versions. Testers receive only the final `mobile-m0.6` GitHub Release.
- **Review verdict reset:** tapping active Keep, To edit or Cull clears to
  `unreviewed` everywhere; no hidden previous-verdict stack is retained.
- **Group completion stays in the primary flow:** any group that becomes
  complete advances directly to the next unfinished group. The m0.5 automatic
  Reconsider screen is removed; reopening a group that was already complete
  remains the explicit way to browse or change its decisions.
- **Session replace never discards decisions, but staged culls are not
  carried:** replacing an unfinished session banks kept→done first; a
  delete list must be re-earned in a live session. The dialog says so.
- **"Don't split groups" extends the session cap along the time-gap cluster
  boundary** (refinement only splits, so no final group is ever cut),
  bounded at +200 photos.
- **Similarity values re-map without migration:** stored 0–64 ints stay
  valid across scale changes. (The m0.5 scale itself is field-verified —
  2026-07-18 round.)
- **APK signing uses the standard shared debug keystore** — changing
  signing breaks testers' in-place upgrades.

## Known limits (revisit triggers)

- Desktop `indexReady` pushes the whole library over IPC — revisit at
  100k+ photos.
- Mobile Home does one MediaStore count query per recent day on focus —
  revisit if it feels laggy on-device.
- Deck pinch-zoom seam **confirmed on device** ("janky" hand-over from
  scroll to zoom, then works) — m0.6 attempts activation smoothing,
  timeboxed.
- Desktop startup: v0.5's warm-start-from-index is the first pass; if
  still slow, a profiling pass rides with v0.6 (RAW pre-render queue
  touches the same path).
