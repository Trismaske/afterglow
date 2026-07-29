# Tester feedback — m0.8.2 backlog

Received 2026-07-28, relayed by Tristan.
This backlog is the m0.8.2 release gate: the release is held until every item below is resolved in [Plan_m0.8.2.md](Plan_m0.8.2.md) — fixed, deliberately deferred with a recorded reason, or rejected with one.
Item numbers are the tester's own and are stable; the plan cross-references them as F1…F16.
Delete this file when m0.8.2 ships.

## Navigation & startup

**F1 — Back button exits through the Edit queue.**
"Clicking the back button repeatedly goes back to my previous screens (okay) but then it goes to the edit queue before closing. The Home screen should be the last place before closing."

**F2 — Chaotic redraw on cold start.**
"Opening the app after a full close (not background) causes the UI to redraw itself chaotically. Is it possible to use ghost placeholders of sorts?"

**F8 — "Continue reviewing" takes two taps.**
"Continue reviewing should maybe take you directly to reviewing. Maybe we have a toggle for this in settings? I currently need two taps to start reviewing, and the second one seems redundant. However this means there is no way to get to the review page…"

## Scan visibility

**F3 — Scan percentage is gone.**
"Scanning % on the home page is gone. Can it show % again, as well as on the Library scan in settings?"

**F4 — Daily Goal numbers disagree with the running scan.**
"While a full scan is running, the numbers under Daily Goal do not match the numbers being shown in the scan."

## Organize & share

**F5 — Organize tap should toggle.**
"When a photo is queued for organising, clicking it again should un-queue instead of asking for album again."

**F6 — Choose the album in the queue, not the deck.**
"Organise location should be decided in the organise queue to make flow faster when reviewing, and so that multiple can be organised together, similar to sharing."

**F7 — Organize and Share screens should look the same.**
"Organise screen and share screen should look the same; technically a lot is the same between these two. How much duplication is there between them? How much code can we get them to share?"

## Review flow & ordering

**F9 — Review in capture order; singles interleaved with groups.**
"Review screen has singles way at the bottom — need to get through over 1000 groups to get to the most recent singles. The review screen should be organised by time, singles between groups, so users can get through their most recent photos. Same for completing a group: if there were singles between items within a group, or between groups, I should review that group of singles before advancing to the next group. This way I review all photos in the order they were taken, with the exception of groups, which is fine. With the current behaviour I never get to review recent singles unless I go into the cards for today."

**F10 — Keep in singles advances but should not remove.**
"After hitting keep in singles, the photo should advance, but not be removed — no easy way for me to go back and click share or do some other action."

**F11 — Compare against the photo I just kept.**
"I should have the ability to compare with a photo I just kept, to see which of the two I want to actually keep."

**F12 — Deck counters are frozen and capped.**
"Singles is always 0 of 500 reviewed. Why does the number not go up? Why is the cap at 500? The app tells me how many singles I have in other places, why not here? Same in Group Review — it always says Group 1 of 100, even when I move to the next group."

## Compare screen

**F15 — "Keep both" confirmation doesn't keep.**
"When I select best in a compare, I get a dialog to keep both. When the dialog closes and I am back in group review, I need to still select Keep for both when I already just confirmed I want to keep both."

**F16 — Compare action buttons are inconsistent.**
"On the compare screen there are buttons for edit (with text), for favourite (without text), but no buttons for share and organise. Can this be made consistent please?"

## Goal & stats

**F13 — More stats ideas.**
"Longest streak, most photos reviewed in a day, anti-streaks ('it's been X days since you last hit your goal :(') — maybe too negative?"

**F14 — Celebrate the goal where it happens.**
"When I reach the goal while reviewing, I don't see it — I only see it when I get back to the home page. Can there be a celebration as I am reviewing, just after I finish reviewing the photo that reaches my daily goal?"
