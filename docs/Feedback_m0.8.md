# Tester feedback → m0.8 (from 0.7.x rounds)

*Each item's answer lives in `Plan_m0.8.md`; this file records what testers asked for and its disposition. Delete with the plan when m0.8 ships.*

1. **Bottom nav bar** (Home · Edit · Favourite · Share · Organize, count-badged) — already planned (Gate 4); re-confirmed by this round.
2. **"Start culling" button undersells the flow** (review is keep/edit/favourite/share/organize, not just culling) — **resolved by design**: sessions and the start button disappear in m0.8; the Home CTA becomes continue-reviewing. Gate 4 carries the copy rule: review-flow copy says *review*, never just *cull*.
3. **"Everything reviewed is a keeper" still requires End-session click** — **resolved by design**: banking and "End session & apply" no longer exist; keeps converge at swipe time, nothing to finish.
4. **Align names in preparation for desktop alignment** — clarified by Tristan: both apps become just **"Afterglow"** (mobile display-name rename in m0.8, application id unchanged), and organize/queue UI-UX starts converging across the two surfaces. Recorded as a PLAN.md decision; rename + terminology audit in Gate 4, deeper convergence rides later releases.
5. **"Clear your photos down to the keepers." tagline** — remove (tester leaning + Tristan leaning); Gate 4. The live corpus stats and daily goal carry the "what this app does" message instead.
6. **Edit-queue buttons (✎ Edit vs Gallery) confuse even informed users** — Gate 4: make the distinction self-explanatory (descriptive labels/subtitles — editor-that-can-save vs view-only — exact copy at implementation; a first-use hint only if copy alone can't carry it).
