# TODO — open questions (not yet planned work)

Parking lot for questions that need their own investigation before they
become plan items. Keep entries short; promote them into a release plan or
PLAN.md (roadmap / trigger-based backlog) once decided.

1. **Real volume identity at ingestion** (post-m0.7 review, 2026-07-23).
   `lib/media.ts` keys every asset as `external_primary` — an inline
   **(autonomous)** gate-1 assumption ("refined in gate 3") that gate 3
   only refined for the organize catalog, not for ingestion identity.
   With an SD card present, MediaStore's `external` query can return
   removable-volume assets: raw ids may collide across volumes, the
   organize cross-volume rejection never fires (every row claims
   primary), and the synthetic content-URI fallback can address the wrong
   volume. Needs its own investigation: derive per-asset volume natively
   (bucket→volume via `listImageAlbums`, or a native id lookup) vs.
   excluding non-primary volumes from ingestion until multi-volume
   support is designed.

2. **Proactive restore reconciliation** (Tristan, 2026-07-24).
   Gallery-restored photos currently reconcile only when a session draw
   pages over them (`lib/reviewLoader.ts`) — invisible until a draw
   covers their date range. Investigate a broader pass (e.g. alongside
   the throttled Home edit-detection scan) that checks `trashed` rows
   against MediaStore so restores surface without starting a session;
   weigh the extra per-visit query cost.

3. **In-app data reset (danger zone)** (Tristan, 2026-07-24; m0.8
   candidate). A persistently failing startup recovery currently
   escalates its error copy toward Android's Clear-data escape hatch
   after 3 consecutive failures. Decide whether Settings should gain an
   in-app "reset app data" row (typed/strong confirmation, photos
   untouched) so the remedy lives inside the app; a destructive flow
   like this deserves its own design pass.

4. **Restore CI audit gate to `--audit-level=high`** (2026-07-25).
   Temporarily at `critical` in `.github/workflows/ci.yml`: brace-expansion
   CVE-2026-14257 (GHSA-mh99-v99m-4gvg) flags the 1.x/2.x copies under
   eslint/electron-builder/expo (dev tooling only, our own patterns —
   no real exposure) and upstream has not yet backported the 5.0.8
   length-bound fix (verified: the advisory PoC crashes the installed
   1.1.16; upstream issue #131's "already patched" claim is wrong).
   When backports publish: `npm audit fix`, commit the lockfile, and
   revert the workflow to `high`.

5. **Documentation standards for shipped releases** (Tristan, 2026-07-23).
   Should there be a per-release document recording what actually shipped
   (a `docs/Release_*.md` or a curated CHANGELOG)? Unclear whether it adds
   value or just duplicates the GitHub Releases page, which already
   carries notes and artifacts per tag. Investigate separately: what the
   GitHub Release notes currently capture, what gets lost when
   Feedback/Plan docs are deleted after shipping, and whether a
   lightweight standard (or none) fits.
