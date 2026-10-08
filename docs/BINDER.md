# Bot bar binder

The Checklist and Procedures tabs reproduce the venue material supplied on
8 October 2026. `binder-data.js` contains the readable transcription;
`binder-pages/` contains 15 compressed, rotated source photos for checking
procedure wording. These are reference documents, not executable instructions.

## Included material

| Supplied ZIP | Website content |
| --- | --- |
| Checklists | Opening (36 tasks), closing (53), weekly cleaning (26), monthly deep cleaning (14), glass cleaning (10) |
| Beer line clean | Preparation, trade-out, cleaning, coupling soak, finishing, checks and troubleshooting; four original pages |
| Incident policy | Incident response, reporting and follow-up; three original pages |
| Induction | Venue induction sections 1–13; five original pages |
| Trivia | Setup, operation and pack-down; three original pages |
| Training sign-offs | Pre-batching training requirements, reproduced as a reference template |

The 139 checklist tasks start unticked. Previous handwritten ticks are not
imported as current work. Handwritten additions and corrections to task wording
are identified in the text. Historical staff names, initials and signatures from
completed checklist and training forms are not published.

Opening and closing progress is stored per date; weekly cleaning and glass
cleaning use Monday-starting weeks; monthly cleaning uses calendar months.
The selected date uses the device's local calendar. Progress and notes are saved
in `bar-restock-checklists-v1` on that device and browser, without server sync.
Clearing ticks affects only the selected checklist and period, retaining notes.
Storage failures leave previously saved progress intact. Concurrent tabs merge
ticks; a stale notes edit is rejected rather than overwriting newer notes.

Both Admin and Bartender can use these pages. Procedure text and all source
photos are cached for offline use after a successful initial online load, and
bundled in the native iPad build. Training requirements do not constitute a new
staff approval or a completed sign-off.

## Pending sources

The Ordering & par levels, EOD report procedure, Products and AV system guide
ZIPs each exceed the attachment tool's 32 MiB transfer limit. Their content has
not been imported or replaced with invented procedures. Split those archives
into smaller uploads to finish those topics.

## Updating

Edit the transcription and source photos together, verify wording against the
supplied documents, then run `npm run version:web`. The release hash includes
both binder scripts and every source photo. Run the browser checks and native
sync/check before publishing. Do not commit the raw completed staff forms.
