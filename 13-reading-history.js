// =================================================================
// READING ACTIVITY HISTORY - RAW EVENT LOG + CALENDAR HEATMAP
// =================================================================
/*
 This module adds a per-day reading-activity calendar (like GitHub's
 contribution graph) to the stats view. It's built entirely on top of the
 existing real-session engine in 09-stats-and-context-menu.js
 (continueOrStartReadingSession/endReadingSession) rather than duplicating
 any of its activity/idle detection - this file only adds:

   1. A "segment" layer that records the raw chapter range touched during
      the currently open session (startHistorySegment/recordHistoryChapterVisited),
      periodically flushed to each book's new readingHistory[] array
      (persistHistorySegment/closeHistorySegment) via upsertReadingHistoryEntry()
      in 02-db.js.
   2. Pure aggregation helpers that turn that raw per-session data into
      per-local-day totals on demand (nothing derived is ever stored).
   3. The calendar heatmap renderer itself.

 readingHistory entry shape (see saveBookToDatabase() in 02-db.js):
   { startTimestamp, endTimestamp, secondsSpent, chapterStart, chapterEnd }

 Existing books that predate this feature simply have no readingHistory
 array; every function below treats that the same as an empty array and
 never attempts to fabricate historical entries for time before this
 feature existed.
*/

// -----------------------------------------------------------------
// SEGMENT TRACKING (one open segment -> one readingHistory entry)
// -----------------------------------------------------------------
let currentHistorySegment = null; // {bookId, startTimestamp, chapterStart, chapterEnd}

// Opens a new segment. Only one is ever open at a time, mirroring the
// single open reading session in 09-stats-and-context-menu.js - if one is
// already open this is a no-op (continueOrStartReadingSession() only calls
// this the first time a session actually starts).
function startHistorySegment(bookId, chapterPointer) {
    if (currentHistorySegment) return;
    currentHistorySegment = {
        bookId,
        startTimestamp: Date.now(),
        chapterStart: chapterPointer,
        chapterEnd: chapterPointer,
    };
}

// Widens the open segment's chapter range to include a newly-visited
// chapter. Called on every chapter change while a segment is open, so the
// eventual entry reflects the full range read during the session - not
// just whatever chapter it happened to start on. Uses min/max rather than
// first/last so jumping back a chapter (e.g. to re-read something) still
// counts as part of the same range instead of overwriting it.
function recordHistoryChapterVisited(chapterPointer) {
    if (!currentHistorySegment) return;
    if (chapterPointer < currentHistorySegment.chapterStart) currentHistorySegment.chapterStart = chapterPointer;
    if (chapterPointer > currentHistorySegment.chapterEnd) currentHistorySegment.chapterEnd = chapterPointer;
}

/*
 Flushes the currently open segment to IndexedDB as one readingHistory
 entry, without closing it out. Safe to call as often as needed - repeated
 calls all share the same startTimestamp, so upsertReadingHistoryEntry()
 in 02-db.js updates the same array entry in place rather than appending a
 new one each time. This is what keeps one long, continuous reading
 session as a single history entry instead of a pile of tiny fragments,
 while still making sure a crash or surprise tab close never loses more
 than one flush interval's worth of activity (see saveTimeToDB() in
 09-stats-and-context-menu.js, which calls this on its existing batched
 cadence).
*/
function persistHistorySegment() {
    if (!currentHistorySegment) return;
    const now = Date.now();
    const secondsSpent = Math.max(0, Math.round((now - currentHistorySegment.startTimestamp) / 1000));
    // Mirrors endReadingSession()'s own noise floor - a sub-3-second segment
    // is almost always this function firing twice in quick succession
    // (e.g. a chapter-change flush immediately followed by the periodic
    // one) rather than real activity worth recording.
    if (secondsSpent < 3) return;

    upsertReadingHistoryEntry(currentHistorySegment.bookId, {
        startTimestamp: currentHistorySegment.startTimestamp,
        endTimestamp: now,
        secondsSpent,
        chapterStart: currentHistorySegment.chapterStart,
        chapterEnd: currentHistorySegment.chapterEnd,
    });
}

// Finalizes and clears the open segment. Called from endReadingSession()
// alongside appendReadingSession(), so both the summary session log and
// this raw per-day history close out at exactly the same moments: reader
// close, tab hidden, the inactivity timeout, or switching books.
function closeHistorySegment() {
    if (!currentHistorySegment) return;
    persistHistorySegment();
    currentHistorySegment = null;
}

// -----------------------------------------------------------------
// AGGREGATION (raw sessions -> per local-day totals, computed on demand)
// -----------------------------------------------------------------
function formatLocalDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/*
 Splits one readingHistory entry's secondsSpent across the local calendar
 day(s) it overlaps, proportional to how much of the [startTimestamp,
 endTimestamp) interval falls in each day. In practice this is almost
 always a single day - real sessions are cut off well before the 5-minute
 inactivity timeout could span midnight - but a session that does straddle
 midnight is still attributed fairly to both days instead of being dumped
 entirely onto whichever day it started or ended on. Grouping uses the
 browser's local time zone throughout (via the Date constructor / getters
 below), never UTC.
*/
function splitHistoryEntryAcrossLocalDays(entry) {
    const slices = [];
    let cursor = entry.startTimestamp;
    const end = entry.endTimestamp;
    if (!(end > cursor)) return slices;
    const totalMs = end - cursor;

    while (cursor < end) {
        const cursorDate = new Date(cursor);
        const dayStart = new Date(cursorDate.getFullYear(), cursorDate.getMonth(), cursorDate.getDate());
        const nextDayStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
        const sliceEnd = Math.min(end, nextDayStart.getTime());
        const sliceMs = sliceEnd - cursor;

        slices.push({
            dayKey: formatLocalDateKey(dayStart),
            secondsSpent: Math.round(entry.secondsSpent * (sliceMs / totalMs)),
            chapterStart: entry.chapterStart,
            chapterEnd: entry.chapterEnd,
        });

        cursor = sliceEnd;
    }
    return slices;
}

// Rough page estimate for a chapter range, using the same
// chapters-advanced-as-a-fraction-of-the-book approach already used
// elsewhere for session-level estimates (see endReadingSession() in
// 09-stats-and-context-menu.js) - never stored, only ever computed here on
// demand from each book's existing cached totalPages/chapterCount.
function estimateHistoryPagesRead(book, chapterStart, chapterEnd) {
    const chapterCount = book.chapterCount || 0;
    const totalPages = book.totalPages || 0;
    if (!chapterCount || !totalPages) return null;
    const chaptersSpan = Math.max(1, (chapterEnd - chapterStart) + 1);
    return Math.round((chaptersSpan / chapterCount) * totalPages);
}

/*
 Builds a map of localDayKey ("YYYY-MM-DD") -> {
   totalSeconds, totalPagesEstimate,
   books: { [bookId]: { title, secondsSpent, chapterStart, chapterEnd, pagesEstimate } }
 }
 across every book's readingHistory. This is the single source of truth
 the calendar heatmap (and its hover popup) render from - Total reading
 time per day and Estimated pages read per day both fall straight out of
 it with no separate calculation path needed.
*/
function aggregateReadingHistoryByLocalDay(books) {
    const byDay = {};

    for (const book of books) {
        if (!Array.isArray(book.readingHistory) || book.readingHistory.length === 0) continue;

        for (const entry of book.readingHistory) {
            if (!entry || typeof entry.startTimestamp !== "number" || typeof entry.endTimestamp !== "number") continue;

            for (const slice of splitHistoryEntryAcrossLocalDays(entry)) {
                if (slice.secondsSpent <= 0) continue;

                if (!byDay[slice.dayKey]) {
                    byDay[slice.dayKey] = { totalSeconds: 0, totalPagesEstimate: 0, books: {} };
                }
                const dayBucket = byDay[slice.dayKey];

                if (!dayBucket.books[book.id]) {
                    dayBucket.books[book.id] = {
                        title: book.title,
                        secondsSpent: 0,
                        chapterStart: slice.chapterStart,
                        chapterEnd: slice.chapterEnd,
                    };
                }
                const bookBucket = dayBucket.books[book.id];
                bookBucket.secondsSpent += slice.secondsSpent;
                bookBucket.chapterStart = Math.min(bookBucket.chapterStart, slice.chapterStart);
                bookBucket.chapterEnd = Math.max(bookBucket.chapterEnd, slice.chapterEnd);

                dayBucket.totalSeconds += slice.secondsSpent;
            }
        }
    }

    // Pages-per-day is derived once per book/day after all of that book's
    // slices for the day have been merged, rather than per-slice, so a
    // session split across midnight doesn't double-count a partial chapter
    // on both sides.
    for (const dayKey of Object.keys(byDay)) {
        const dayBucket = byDay[dayKey];
        for (const bookId of Object.keys(dayBucket.books)) {
            const book = books.find((b) => String(b.id) === String(bookId));
            const bookBucket = dayBucket.books[bookId];
            const pagesEstimate = book
                ? estimateHistoryPagesRead(book, bookBucket.chapterStart, bookBucket.chapterEnd)
                : null;
            bookBucket.pagesEstimate = pagesEstimate;
            if (pagesEstimate) dayBucket.totalPagesEstimate += pagesEstimate;
        }
    }

    return byDay;
}

// -----------------------------------------------------------------
// CALENDAR HEATMAP RENDERING
// -----------------------------------------------------------------
const HEATMAP_WEEKS_TO_SHOW = 53; // ~a full year, same span GitHub's graph defaults to
const HEATMAP_LEVEL_THRESHOLDS = [0, 0.15, 0.4, 0.7, 1]; // fraction-of-max cutoffs for levels 0-4

function heatmapLevelForSeconds(seconds, maxSeconds) {
    if (!seconds || seconds <= 0 || maxSeconds <= 0) return 0;
    const fraction = seconds / maxSeconds;
    // Walk the thresholds low to high and keep the last one the fraction
    // clears, e.g. fraction=0.5 clears [0, 0.15, 0.4] but not [0.7, 1], so
    // it resolves to level 3 (index 2 + 1).
    let resolved = 1;
    for (let level = 1; level < HEATMAP_LEVEL_THRESHOLDS.length; level++) {
        if (fraction >= HEATMAP_LEVEL_THRESHOLDS[level]) resolved = level + 1;
    }
    return Math.min(4, resolved);
}

function formatHistoryDayLabel(dayKey) {
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    });
}

function renderReadingActivityCalendar() {
    const container = document.getElementById("reading-activity-calendar-container");
    if (!container) return;

    const byDay = aggregateReadingHistoryByLocalDay(loadedBooksMemory);
    const dayKeys = Object.keys(byDay);

    if (dayKeys.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No reading activity recorded yet. This calendar fills in as you read from now on.</div>`;
        return;
    }

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Grid starts on the Sunday on/before (today - HEATMAP_WEEKS_TO_SHOW weeks)
    // and always spans exactly HEATMAP_WEEKS_TO_SHOW complete weeks (Sun-Sat),
    // same as GitHub's - any days after today within the current week are
    // rendered too, just blanked out as "future", so the grid is always a
    // clean rectangle instead of an uneven last column.
    const gridStart = new Date(todayStart);
    gridStart.setDate(gridStart.getDate() - (HEATMAP_WEEKS_TO_SHOW * 7 - 1));
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const totalWeeks = HEATMAP_WEEKS_TO_SHOW;
    const totalDays = totalWeeks * 7;

    let maxSeconds = 0;
    for (const key of dayKeys) maxSeconds = Math.max(maxSeconds, byDay[key].totalSeconds);

    // Month labels: one per week-column whose first (Sunday) day falls in
    // the first seven days of a new month.
    const monthLabelCells = [];
    let dayCursor = new Date(gridStart);
    for (let week = 0; week < totalWeeks; week++) {
        if (dayCursor.getDate() <= 7) {
            monthLabelCells.push(
                `<div class="heatmap-month-label" style="grid-column:${week + 1};">${dayCursor.toLocaleDateString(undefined, { month: "short" })}</div>`
            );
        }
        dayCursor.setDate(dayCursor.getDate() + 7);
    }

    const dayCells = [];
    dayCursor = new Date(gridStart);
    for (let i = 0; i < totalDays; i++) {
        const dayKey = formatLocalDateKey(dayCursor);
        const isFuture = dayCursor > todayStart;
        const dayBucket = byDay[dayKey];
        const seconds = dayBucket ? dayBucket.totalSeconds : 0;
        const level = isFuture ? -1 : heatmapLevelForSeconds(seconds, maxSeconds);

        dayCells.push(
            `<div class="heatmap-day ${isFuture ? "heatmap-day-future" : `heatmap-level-${level}`}"
                  ${dayBucket ? `data-day-key="${dayKey}"` : ""}
                  ${!isFuture ? `onmouseenter="showHistoryDayTooltip(event, '${dayKey}')" onmouseleave="hideHistoryDayTooltip()"` : ""}>
             </div>`
        );

        dayCursor.setDate(dayCursor.getDate() + 1);
    }

    container.innerHTML = `
        <div class="heatmap-scroll-wrapper">
            <div class="heatmap-months-row" style="grid-template-columns:repeat(${totalWeeks}, var(--heatmap-cell-size));">
                ${monthLabelCells.join("")}
            </div>
            <div class="heatmap-grid" style="grid-template-columns:repeat(${totalWeeks}, var(--heatmap-cell-size)); grid-template-rows:repeat(7, var(--heatmap-cell-size));">
                ${dayCells.join("")}
            </div>
        </div>
        <div class="heatmap-legend">
            <span>Less</span>
            <div class="heatmap-day heatmap-level-0"></div>
            <div class="heatmap-day heatmap-level-1"></div>
            <div class="heatmap-day heatmap-level-2"></div>
            <div class="heatmap-day heatmap-level-3"></div>
            <div class="heatmap-day heatmap-level-4"></div>
            <span>More</span>
        </div>
    `;
}

/*
 Hover popup for a single calendar day - shows the books read that day,
 reading time per book, and chapter range per book (when the book has
 enough cached metadata to know one). Reuses positionFlyoutMenu() from
 10-utils.js (originally built for the 3-dots context menus) since a
 mouseenter event's currentTarget works exactly the same way a click
 event's does for that positioning logic.
*/
function showHistoryDayTooltip(event, dayKey) {
    const tooltip = document.getElementById("calendar-day-tooltip");
    if (!tooltip) return;

    const byDay = aggregateReadingHistoryByLocalDay(loadedBooksMemory);
    const dayBucket = byDay[dayKey];

    const bookRows = dayBucket
        ? Object.values(dayBucket.books)
              .sort((a, b) => b.secondsSpent - a.secondsSpent)
              .map((b) => {
                  const mins = formatMinutes(Math.round(b.secondsSpent / 60));
                  const chapterRange = b.chapterStart === b.chapterEnd
                      ? `Ch. ${b.chapterStart + 1}`
                      : `Ch. ${b.chapterStart + 1}–${b.chapterEnd + 1}`;
                  const pages = b.pagesEstimate ? ` · ~${b.pagesEstimate} pages` : "";
                  return `<div class="calendar-day-tooltip-row">
                        <div class="calendar-day-tooltip-book-title">${escapeHtml(b.title)}</div>
                        <div class="calendar-day-tooltip-book-meta">${mins} · ${escapeHtml(chapterRange)}${pages}</div>
                    </div>`;
              })
              .join("")
        : `<div class="calendar-day-tooltip-empty">No reading activity.</div>`;

    tooltip.innerHTML = `
        <div class="calendar-day-tooltip-heading">${escapeHtml(formatHistoryDayLabel(dayKey))}</div>
        ${dayBucket ? `<div class="calendar-day-tooltip-total">${formatMinutes(Math.round(dayBucket.totalSeconds / 60))} total${dayBucket.totalPagesEstimate ? ` · ~${dayBucket.totalPagesEstimate} pages` : ""}</div>` : ""}
        ${bookRows}
    `;

    positionFlyoutMenu(tooltip, event);
}

function hideHistoryDayTooltip() {
    const tooltip = document.getElementById("calendar-day-tooltip");
    if (tooltip) tooltip.style.display = "none";
}