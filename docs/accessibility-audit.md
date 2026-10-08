# Accessibility audit — m0.9.1 phase 1

A release artifact of [Plan_m0.9.1.md](Plan_m0.9.1.md): every Text site in the mobile app, its container class, the first OS font scale at which its screen breaks (measured by `scripts/accessibility-walk.mjs` and read by `scripts/accessibility-report.mjs`), and the lever that fixes it.
Deleted with the plan once the levers land in code and the policy in docs/STATE_MODEL.md.

Container classes (`scripts/text-audit.mjs`): **free** grows with its text; **ellipsized** cuts at `numberOfLines`; **fixed** sits in a fixed-height style; **capped** carries `maxFontSizeMultiplier` or `allowFontScaling={false}`.
Levers: **grow** (drop the fixed height or let the row wrap), **reflow** (stack what sat side by side), **ellipsize** (keep, when the full text is one tap away), **cap** (last resort, with the reason).

## Measured breaks per screen

The walk ran on the S10e (Android 12, 360 dp), the S23 (411 dp at its 560 dpi display-size override) and the Android 16 emulator (411 dp) at font scales 0.8 to 2.0 and at the default and large display sizes; the full per-signal table is `node scripts/accessibility-report.mjs <report-dir> --md` over the walk's report directory.
What broke, by the first scale it broke at (360 dp; the S23 and the emulator break one step later, which `lib/textScale.ts` captures as the scale relative to the width):

| Surface | First break (360 dp) | What broke | Lever landed |
|---|---|---|---|
| Home title row | 1.3 | "Afterglow" broke mid-word beside its three action buttons | The row wraps the actions under the brand (`flexWrap`) |
| Home goal card | 1.3 | The ring's text column wrapped every line to three | The row stacks past the large-text threshold (`useLargeText`) |
| Stats Today card | 1.3 | Same pairing of a ring and a column | Stacks |
| Settings Playback and Overlay rows | 1.0 (S23) | Row titles cut at a fixed 118 dp width | The fixed width is the row layout's only; stacked rows past the threshold |
| Timeline unit cards | 1.5 | The 20 dp header row clipped its title mid-glyph | The header's height is a function of the font scale (`unitCardHeight`), still exact for `getItemLayout` |
| Timeline filter chips | 1.8 | The third chip left the screen | The row wraps |
| Deck chip row | 1.5 | "Favourite" and "Organize" broke mid-word in four columns | Two chips per row past the threshold |
| Progress histogram axis | 1.3 | The month and year ticks collided at fixed offsets | The axis rows' offsets and the column height follow the font |
| Progress chips | 2.0 | "Unreviewed", "Favourite", "Organize" broke mid-word in 3- and 4-column grids | Two per row past the huge-text threshold (1.6) |
| Tab bar | 1.8 | "Favourite" and "Organize" broke mid-word in a fifth of the bar; badges overflowed their 16 dp disc | Labels drop past the huge-text threshold; the badge disc grows with the font |
| Native stack header title | every scale | The title does not scale with the font at all (React Navigation's native header) | Observed, not ours to fix in this release; parked in docs/TODO.md |
| Free text everywhere else | — | Wraps as designed at every scale | None |

How to read the report: its signals come from node bounds alone, so a CLAMPED row also fires for any text that fills a fixed-width parent (a button's label, a tile's caption), which is the parent's width, not a cut; a WRAPPED row is free text doing what free text should; OVERLAP and CLIPPED are the rows to open the screenshot for, and INCOMPLETE rows are missing evidence, never a pass.
The table above is what the screenshots showed; the report is where to look.

Walk gaps: at 1.8 and 2.0 on the S10e the walk could not reach the Progress page or the deck (Home's rows grew past its scroll search), so those two screens have screenshots only up to 1.5 there; the S23 and the emulator cover them to 2.0.

## The static inventory

| File | Line | Style | Size | Container | Height |
|---|---|---|---|---|---|
| components/ActionChip.tsx | 95 | text | 13 | free |  |
| components/AlbumPicker.tsx | 118 | title | 17 | free |  |
| components/AlbumPicker.tsx | 127 | albumName | 15 | free |  |
| components/AlbumPicker.tsx | 129 | albumPath | 12 | ellipsized |  |
| components/AlbumPicker.tsx | 134 | albumCount | 13 | free |  |
| components/AlbumPicker.tsx | 142 | albumEmpty | 14 | free |  |
| components/AlbumPicker.tsx | 144 | buttonText | 13 | free |  |
| components/AlbumPicker.tsx | 148 | albumEmpty | 14 | free |  |
| components/AlbumPicker.tsx | 150 | albumEmpty | 14 | free |  |
| components/AlbumPicker.tsx | 171 | buttonText | 13 | free |  |
| components/AlbumPicker.tsx | 175 | buttonText | 13 | free |  |
| components/BigButton.tsx | 37 | label | 18 | ellipsized |  |
| components/DecisionBadge.tsx | 178 | pillText | ? | ellipsized |  |
| components/DeckDetailsOverlay.tsx | 259 | header | 15 | free |  |
| components/DeckDetailsOverlay.tsx | 263 | stateText | 14 | fixed | 12 |
| components/DeckDetailsOverlay.tsx | 269 | lineText+staleText | 13 | free |  |
| components/DeckDetailsOverlay.tsx | 277 | quietText | 13 | free |  |
| components/DeckDetailsOverlay.tsx | 280 | quietText | 13 | free |  |
| components/DeckDetailsOverlay.tsx | 284 | quietText | 13 | free |  |
| components/DeckDetailsOverlay.tsx | 287 | retryText | 13 | free |  |
| components/EditDiagnosticsSheet.tsx | 151 | title | 18 | free |  |
| components/EditDiagnosticsSheet.tsx | 152 | hint | 13 | free |  |
| components/EditDiagnosticsSheet.tsx | 157 | report | 12 | free |  |
| components/EditDiagnosticsSheet.tsx | 163 | observePrompt | 15 | free |  |
| components/EditDiagnosticsSheet.tsx | 168 | buttonText | 14 | free |  |
| components/EditDiagnosticsSheet.tsx | 174 | buttonText | 14 | free |  |
| components/EditDiagnosticsSheet.tsx | 185 | buttonText | 14 | free |  |
| components/EditDiagnosticsSheet.tsx | 192 | buttonText | 14 | free |  |
| components/EditDiagnosticsSheet.tsx | 196 | buttonText | 14 | free |  |
| components/GoalRing.tsx | 59 | centerTitle | 26 | free |  |
| components/GoalRing.tsx | 61 | centerSubtitle | 12 | free |  |
| components/MainTabBar.tsx | 108 | badgeText | 10 | fixed | 16 |
| components/MainTabBar.tsx | 112 | label+labelFocused | 11 | fixed | 16 |
| components/MediaStage.tsx | 647 | zoomNoticeText | 12 | free |  |
| components/progress/PhotoStateGrid.tsx | 445 | empty | 14 | free |  |
| components/progress/PhotoStateGrid.tsx | 462 | empty | 14 | free |  |
| components/progress/ProgressView.tsx | 276 | histogramTick | 10 | ellipsized |  |
| components/progress/ProgressView.tsx | 279 | histogramYear | 11 | ellipsized |  |
| components/progress/ProgressView.tsx | 644 | title | 24 | free |  |
| components/progress/ProgressView.tsx | 645 | subtitle | 15 | free |  |
| components/progress/ProgressView.tsx | 687 | chipCount | 17 | fixed | 4 |
| components/progress/ProgressView.tsx | 688 | chipLabel | 10 | ellipsized | 4 |
| components/progress/ProgressView.tsx | 711 | chipCount | 17 | fixed | 4 |
| components/progress/ProgressView.tsx | 712 | chipLabel | 10 | ellipsized | 4 |
| components/progress/ProgressView.tsx | 719 | footnote | 12 | free |  |
| components/progress/ProgressView.tsx | 721 | insightLine | 13 | free |  |
| components/progress/ProgressView.tsx | 743 | insightLine | 13 | free |  |
| components/progress/ProgressView.tsx | 746 | insightLine | 13 | free |  |
| components/progress/ProgressView.tsx | 748 | insightLine | 13 | free |  |
| components/progress/ProgressView.tsx | 755 | gridLabel | 13 | free |  |
| components/progress/ProgressView.tsx | 771 | monthPillText | 12 | free |  |
| components/progress/ProgressView.tsx | 787 | loadingText | 15 | free |  |
| components/QueueGrid.tsx | 110 | chipText+chipTextDestructive | 13 | free |  |
| components/ReDecideSheet.tsx | 98 | stateLabel | 16 | fixed | 72 |
| components/ReDecideSheet.tsx | 99 | when | 13 | fixed | 72 |
| components/ReDecideSheet.tsx | 100 | hint | 12 | fixed | 72 |
| components/ReDecideSheet.tsx | 127 | chipText | 15 | free |  |
| components/ReDecideSheet.tsx | 130 | chipCurrent | 11 | free |  |
| components/ReDecideSheet.tsx | 138 | closeText | 15 | free |  |
| components/SegmentedControl.tsx | 40 | label | 14 | free |  |
| components/UnitCard.tsx | 94 | title | 15 | ellipsized |  |
| components/UnitCard.tsx | 97 | status+statusDone | 13 | ellipsized |  |
| components/UnitCard.tsx | 120 | thumbMoreText | ? | free |  |
| screens/CompareScreen.tsx | 618 | loadFailedText | 14 | free |  |
| screens/CompareScreen.tsx | 627 | retryText | 15 | free |  |
| screens/CompareScreen.tsx | 664 | headerTitle | 16 | free |  |
| screens/CompareScreen.tsx | 667 | headerHint | 12 | free |  |
| screens/CompareScreen.tsx | 735 | abBadgeText | 13 | free |  |
| screens/CompareScreen.tsx | 774 | abChipText | 15 | free |  |
| screens/CompareScreen.tsx | 781 | actingOn | 12 | free |  |
| screens/CompareScreen.tsx | 864 | actionText | 17 | free |  |
| screens/CompareScreen.tsx | 875 | actionText | 17 | free |  |
| screens/CompareScreen.tsx | 879 | closeText | 14 | free |  |
| screens/CompareScreen.tsx | 895 | offerTitle | 18 | free |  |
| screens/CompareScreen.tsx | 898 | offerText | 14 | free |  |
| screens/CompareScreen.tsx | 918 | offerCheckLabel | 13 | free |  |
| screens/CompareScreen.tsx | 922 | offerButtonText | 15 | free |  |
| screens/CompareScreen.tsx | 931 | offerButtonText | 15 | free |  |
| screens/CullListScreen.tsx | 267 | tileBadgeText | 10 | free |  |
| screens/CullListScreen.tsx | 277 | subtitle | 14 | free |  |
| screens/CullListScreen.tsx | 296 | emptyText | 15 | free |  |
| screens/DayProgressScreen.tsx | 179 | groupsFailed | 13 | free |  |
| screens/DayProgressScreen.tsx | 185 | groupsLabel | 13 | free |  |
| screens/DeckScreen.tsx | 2373 | loadFailedText | 14 | free |  |
| screens/DeckScreen.tsx | 2382 | retryText | 15 | free |  |
| screens/DeckScreen.tsx | 2666 | headerTitle | 16 | free |  |
| screens/DeckScreen.tsx | 2667 | headerHint | 12 | free |  |
| screens/DeckScreen.tsx | 2715 | posBadgeText | 13 | free |  |
| screens/DeckScreen.tsx | 2720 | partBadgeText | 12 | free |  |
| screens/DeckScreen.tsx | 2739 | timeBadgeText | 13 | free |  |
| screens/DeckScreen.tsx | 2965 | actionText | 16 | free |  |
| screens/DeckScreen.tsx | 2982 | middleText+actionTextDisabled | 12 | ellipsized |  |
| screens/DeckScreen.tsx | 3035 | middleText | 12 | ellipsized |  |
| screens/DeckScreen.tsx | 3052 | actionText | 16 | free |  |
| screens/DeckScreen.tsx | 3156 | pickerTitle | 17 | free |  |
| screens/DeckScreen.tsx | 3157 | pickerHint | 13 | free |  |
| screens/DeckScreen.tsx | 3181 | pickerIndexText | 11 | fixed | 20 |
| screens/DeckScreen.tsx | 3191 | pickerCloseText | 14 | free |  |
| screens/EditQueueScreen.tsx | 231 | rowTitle | 15 | fixed | 84 |
| screens/EditQueueScreen.tsx | 241 | rowButtonText | 14 | free |  |
| screens/EditQueueScreen.tsx | 251 | rowButtonText | 14 | free |  |
| screens/EditQueueScreen.tsx | 259 | rowButtonText | 14 | free |  |
| screens/EditQueueScreen.tsx | 281 | heading | 24 | free |  |
| screens/EditQueueScreen.tsx | 282 | subtitle | 14 | free |  |
| screens/EditQueueScreen.tsx | 307 | refreshFailed | 13 | free |  |
| screens/EditQueueScreen.tsx | 317 | emptyText | 15 | free |  |
| screens/FavouritesQueueScreen.tsx | 328 | heading | 24 | free |  |
| screens/FavouritesQueueScreen.tsx | 329 | intro | 14 | free |  |
| screens/FavouritesQueueScreen.tsx | 348 | refreshFailed | 13 | free |  |
| screens/FavouritesQueueScreen.tsx | 357 | empty | 14 | free |  |
| screens/FavouritesQueueScreen.tsx | 361 | empty | 14 | free |  |
| screens/FavouritesQueueScreen.tsx | 390 | rowTitle | ? | free |  |
| screens/FavouritesQueueScreen.tsx | 393 | rowMeta+rowMetaError | 12 | free |  |
| screens/FavouritesQueueScreen.tsx | 415 | removeText | ? | free |  |
| screens/HistoryScreen.tsx | 364 | rowTitle | 14 | free |  |
| screens/HistoryScreen.tsx | 368 | rowTime | 13 | free |  |
| screens/HistoryScreen.tsx | 413 | rowTime | 13 | free |  |
| screens/HistoryScreen.tsx | 459 | chipText+chipTextActive | 13 | free |  |
| screens/HistoryScreen.tsx | 477 | empty | 14 | free |  |
| screens/HistoryScreen.tsx | 481 | empty | 14 | free |  |
| screens/HistoryScreen.tsx | 491 | empty | 14 | free |  |
| screens/HomeScreen.tsx | 789 | dayRowTitle | 15 | free |  |
| screens/HomeScreen.tsx | 790 | dayRowPct | 13 | free |  |
| screens/HomeScreen.tsx | 804 | dayRowHint | 12 | free |  |
| screens/HomeScreen.tsx | 833 | title | 28 | free |  |
| screens/HomeScreen.tsx | 865 | noticeText | 14 | free |  |
| screens/HomeScreen.tsx | 866 | noticeDismiss | 12 | free |  |
| screens/HomeScreen.tsx | 885 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 922 | cardTitle | 18 | free |  |
| screens/HomeScreen.tsx | 930 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 942 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 954 | unreachableLine | 14 | free |  |
| screens/HomeScreen.tsx | 969 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 975 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 988 | cardText | 15 | free |  |
| screens/HomeScreen.tsx | 990 | queueBreakdown | 13 | free |  |
| screens/HomeScreen.tsx | 995 | queueBreakdown | 13 | free |  |
| screens/HomeScreen.tsx | 1010 | streakText | 14 | free |  |
| screens/HomeScreen.tsx | 1066 | scanStatus | 12 | free |  |
| screens/HomeScreen.tsx | 1088 | editQueueTitle | 16 | free |  |
| screens/HomeScreen.tsx | 1092 | editQueueHint | 13 | free |  |
| screens/HomeScreen.tsx | 1098 | badgeText | 14 | fixed | 28 |
| screens/HomeScreen.tsx | 1109 | coverageTitle | 18 | free |  |
| screens/HomeScreen.tsx | 1110 | coverageScope | 13 | free |  |
| screens/HomeScreen.tsx | 1132 | coverageText | 14 | free |  |
| screens/HomeScreen.tsx | 1153 | streakText | 14 | free |  |
| screens/HomeScreen.tsx | 1162 | progressIcon | 22 | free |  |
| screens/HomeScreen.tsx | 1164 | progressTitle | 16 | free |  |
| screens/HomeScreen.tsx | 1169 | progressHint | 13 | free |  |
| screens/HomeScreen.tsx | 1175 | progressChevron | 22 | free |  |
| screens/HomeScreen.tsx | 1184 | sectionLabel | 13 | free |  |
| screens/HomeScreen.tsx | 1191 | sectionLabel | 13 | free |  |
| screens/HomeScreen.tsx | 1198 | sectionLabel | 13 | free |  |
| screens/HomeScreen.tsx | 1205 | olderRowText | 14 | free |  |
| screens/HomeScreen.tsx | 1208 | progressChevron | 22 | free |  |
| screens/OrganizeQueueScreen.tsx | 469 | targetTagText | 10 | ellipsized |  |
| screens/OrganizeQueueScreen.tsx | 490 | heading | 24 | free |  |
| screens/OrganizeQueueScreen.tsx | 491 | subtitle | 14 | free |  |
| screens/OrganizeQueueScreen.tsx | 530 | refreshFailed | 13 | free |  |
| screens/OrganizeQueueScreen.tsx | 549 | assignText | 14 | free |  |
| screens/OrganizeQueueScreen.tsx | 561 | applyText | 16 | free |  |
| screens/SettingsScreen.tsx | 781 | applyingText | 15 | free |  |
| screens/SettingsScreen.tsx | 792 | dialogTitle | 18 | free |  |
| screens/SettingsScreen.tsx | 808 | dialogError | 13 | free |  |
| screens/SettingsScreen.tsx | 815 | dialogButtonText | 15 | free |  |
| screens/SettingsScreen.tsx | 818 | dialogButtonText | 15 | free |  |
| screens/SettingsScreen.tsx | 828 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 831 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 832 | rowHint | 13 | ellipsized |  |
| screens/SettingsScreen.tsx | 836 | chevron | 22 | free |  |
| screens/SettingsScreen.tsx | 847 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 848 | rowHint | 13 | ellipsized |  |
| screens/SettingsScreen.tsx | 852 | chevron | 22 | free |  |
| screens/SettingsScreen.tsx | 856 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 857 | hint | 13 | free |  |
| screens/SettingsScreen.tsx | 873 | chipText | 14 | free |  |
| screens/SettingsScreen.tsx | 886 | chipText | 14 | free |  |
| screens/SettingsScreen.tsx | 892 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 893 | hint | 13 | free |  |
| screens/SettingsScreen.tsx | 909 | chipText | 14 | free |  |
| screens/SettingsScreen.tsx | 917 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 918 | hint | 13 | free |  |
| screens/SettingsScreen.tsx | 934 | chipText | 14 | free |  |
| screens/SettingsScreen.tsx | 942 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 944 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 947 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 953 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 961 | playbackRowTitle | 15 | free |  |
| screens/SettingsScreen.tsx | 975 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 980 | playbackRowTitle | 15 | free |  |
| screens/SettingsScreen.tsx | 995 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 997 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 1004 | playbackRowTitle | 15 | free |  |
| screens/SettingsScreen.tsx | 1005 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 1018 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 1020 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 1021 | explainer | 13 | free |  |
| screens/SettingsScreen.tsx | 1041 | accentLabel+accentLabelActive | 14 | fixed | 18 |
| screens/SettingsScreen.tsx | 1056 | accentLabel+accentLabelActive | 14 | fixed | 18 |
| screens/SettingsScreen.tsx | 1064 | stepHint | 12 | free |  |
| screens/SettingsScreen.tsx | 1070 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 1073 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 1082 | rowHint | 13 | free |  |
| screens/SettingsScreen.tsx | 1103 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 1113 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 1116 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 1117 | rowHint | 13 | free |  |
| screens/SettingsScreen.tsx | 1123 | sectionLabel | 13 | free |  |
| screens/SettingsScreen.tsx | 1126 | rowTitle | 16 | free |  |
| screens/SettingsScreen.tsx | 1127 | rowHint | 13 | free |  |
| screens/ShareQueueScreen.tsx | 456 | passBadgeText | 10 | free |  |
| screens/ShareQueueScreen.tsx | 468 | heading | 24 | free |  |
| screens/ShareQueueScreen.tsx | 469 | subtitle | 14 | free |  |
| screens/ShareQueueScreen.tsx | 510 | refreshFailed | 13 | free |  |
| screens/ShareQueueScreen.tsx | 529 | shareText | 16 | free |  |
| screens/ShareQueueScreen.tsx | 543 | labelTitle | 17 | free |  |
| screens/ShareQueueScreen.tsx | 544 | labelHint | 13 | free |  |
| screens/SourcePickerScreen.tsx | 348 | applyingText | 15 | free |  |
| screens/SourcePickerScreen.tsx | 355 | hint | 14 | free |  |
| screens/SourcePickerScreen.tsx | 367 | loading | 14 | free |  |
| screens/SourcePickerScreen.tsx | 377 | rowTitle | 15 | free |  |
| screens/SourcePickerScreen.tsx | 378 | rowHint | 12 | free |  |
| screens/SourcePickerScreen.tsx | 380 | rowCount | 13 | free |  |
| screens/SourcePickerScreen.tsx | 388 | loading | 14 | free |  |
| screens/SourcePickerScreen.tsx | 393 | retryText | 15 | free |  |
| screens/SourcePickerScreen.tsx | 398 | loading | 14 | free |  |
| screens/SourcePickerScreen.tsx | 417 | rowTitle+rowTitleUnmounted | 15 | free |  |
| screens/SourcePickerScreen.tsx | 420 | rowTag | 11 | free |  |
| screens/SourcePickerScreen.tsx | 423 | rowHint | 12 | free |  |
| screens/SourcePickerScreen.tsx | 425 | rowHint | 12 | free |  |
| screens/SourcePickerScreen.tsx | 427 | rowIncluded | 12 | free |  |
| screens/SourcePickerScreen.tsx | 432 | rowCount | 13 | free |  |
| screens/StatsScreen.tsx | 248 | tabLabel | 15 | free |  |
| screens/StatsScreen.tsx | 282 | loading | 15 | free |  |
| screens/StatsScreen.tsx | 317 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 320 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 329 | streakText | 14 | free |  |
| screens/StatsScreen.tsx | 338 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 345 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 358 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 361 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 364 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 366 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 371 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 381 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 384 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 387 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 389 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 397 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 405 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 408 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 411 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 413 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 445 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 446 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 453 | loading | 15 | free |  |
| screens/StatsScreen.tsx | 464 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 467 | headline | 20 | free |  |
| screens/StatsScreen.tsx | 468 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 476 | headline | 20 | free |  |
| screens/StatsScreen.tsx | 477 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 479 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 486 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 494 | timeLine | 15 | free |  |
| screens/StatsScreen.tsx | 499 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 531 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 540 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 541 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 547 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 548 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 553 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 589 | projectionText+projectionTextEmpty | 15 | free |  |
| screens/StatsScreen.tsx | 649 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 650 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 657 | loading | 15 | free |  |
| screens/StatsScreen.tsx | 675 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 677 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 680 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 684 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 718 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 719 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 726 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 733 | cardTitle | 18 | free |  |
| screens/StatsScreen.tsx | 737 | milestoneLabel | 14 | free |  |
| screens/StatsScreen.tsx | 755 | cardText | 15 | free |  |
| screens/StatsScreen.tsx | 766 | cardHint | 13 | free |  |
| screens/StatsScreen.tsx | 785 | heatDay | 10 | free |  |
| screens/StatsScreen.tsx | 807 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 808 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 809 | axisLabel | 12 | free |  |
| screens/StatsScreen.tsx | 934 | tileValue | 24 | free |  |
| screens/StatsScreen.tsx | 935 | tileLabel | 12 | free |  |
| screens/StatsScreen.tsx | 944 | legendLabel | 14 | fixed | 12 |
| screens/StatsScreen.tsx | 945 | legendValue | 14 | fixed | 12 |
| screens/StatsScreen.tsx | 969 | queueLabel | 15 | free |  |
| screens/StatsScreen.tsx | 970 | queueHint | 12 | free |  |
| screens/StatsScreen.tsx | 972 | queueCount | 18 | free |  |
| screens/SummaryScreen.tsx | 89 | title | 28 | free |  |
| screens/SummaryScreen.tsx | 91 | subtitle | 16 | free |  |
| screens/SummaryScreen.tsx | 103 | lifetimeTitle | 18 | free |  |
| screens/SummaryScreen.tsx | 112 | reclaimedAllTime | 13 | free |  |
| screens/SummaryScreen.tsx | 118 | warning | 14 | free |  |
| screens/SummaryScreen.tsx | 139 | statValue | 30 | free |  |
| screens/SummaryScreen.tsx | 140 | statLabel | 13 | free |  |
| screens/SummaryScreen.tsx | 148 | lifetimeValue | 21 | free |  |
| screens/SummaryScreen.tsx | 149 | lifetimeLabel | 11 | free |  |
| screens/TimelineScreen.tsx | 932 | subtitle | 14 | free |  |
| screens/TimelineScreen.tsx | 949 | filterLabel+filterLabelActive | 13 | free |  |
| screens/TimelineScreen.tsx | 1013 | emptyText | 14 | free |  |
| screens/TimelineScreen.tsx | 1029 | footerNoteText | 14 | ellipsized |  |
