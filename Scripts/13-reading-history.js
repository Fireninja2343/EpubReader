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
/*
 Responsive week-count sizing. All knobs live here so the behavior is easy
 to retune later without touching the layout logic itself:

   - HEATMAP_MAX_WEEKS is the ceiling - 2 years is shown whenever there's room for it,
     and we never show more than this even on ultra-wide screens.
   - HEATMAP_MIN_WEEKS is the floor - below this the grid stops shrinking
     and the scroll-wrapper's horizontal scroll takes over instead, so the
     calendar never becomes so compressed it's unreadable.
   - HEATMAP_CELL_PX/HEATMAP_GAP_PX mirror the actual rendered cell size
     and gap (--heatmap-cell-size in styles.css, and the grid `gap`), used
     as fallbacks if those can't be read live from CSS - see
     getHeatmapCellMetrics() below, which reads the real values first so a
     future change to --heatmap-cell-size doesn't silently desync this math.
*/
const HEATMAP_MAX_WEEKS = 106;
const HEATMAP_MIN_WEEKS = 8; // never shrink below ~2 months before handing off to horizontal scroll
const HEATMAP_CELL_PX = 12; // fallback if --heatmap-cell-size can't be read from CSS
const HEATMAP_GAP_PX = 3; // fallback if the grid gap can't be read from CSS
const HEATMAP_LEVEL_THRESHOLDS = [0, 0.15, 0.4, 0.7, 1]; // fraction-of-reference cutoffs for levels 0-4
/*
 What fraction-of-max scaling used to key everything off a single day's
 total is exactly the failure mode called out for the Book Length/Reading
 Speed distributions above (see buildDynamicBuckets' comment) - one
 unusually long reading day (a rainy Sunday marathon, a holiday) becomes
 the sole yardstick every other day is measured against, silently
 compressing a library's worth of genuinely solid reading days down into
 low heat levels because none of them come close to that one outlier.

 The fix mirrors the same Tukey's-fence-style approach already used there:
 instead of scaling against the true max, scale against a high percentile
 of the (non-zero) day totals - HEATMAP_REFERENCE_PERCENTILE below. A small
 number of extreme days above that percentile don't move the scale at all;
 they just land past fraction 1.0 and get clamped to the top level like
 any other day that clears it, the same way an outlier still gets tallied
 into a distribution's first/last bucket rather than stretching every
 bucket's width. This is percentile-based (data-driven) rather than a
 hardcoded seconds value, so it keeps working correctly regardless of
 whether someone reads 20 minutes or 5 hours on a typical day.
*/
const HEATMAP_REFERENCE_PERCENTILE = 0.9;
const HEATMAP_MIN_DAYS_FOR_PERCENTILE_REFERENCE = 5;
// below this, not enough days to make a percentile meaningful over the true max - see computeHeatmapReferenceSeconds()

/*
 Computes the "fully lit" reference value day totals are scaled against.
 Uses the same percentile() helper and small-sample fallback pattern as
 buildDynamicBuckets() in 09-stats-and-context-menu.js: with very few
 recorded days, a percentile isn't meaningfully different from (and can
 even sit below) the true max, so this just uses the max directly until
 there's enough data for the percentile to be doing real outlier-resistant
 work instead of arbitrarily discarding the only data available.
*/
function computeHeatmapReferenceSeconds(dayTotals) {
    const nonZero = dayTotals.filter((s) => s > 0).sort((a, b) => a - b);
    if (nonZero.length === 0) return 0;
    if (nonZero.length < HEATMAP_MIN_DAYS_FOR_PERCENTILE_REFERENCE) return nonZero[nonZero.length - 1];

    const reference = percentile(nonZero, HEATMAP_REFERENCE_PERCENTILE);
    // A percentile can legitimately land at/near 0 if the bulk of days are
    // very light with a handful of much heavier ones - guard against that
    // degenerate case the same way buildDynamicBuckets guards a
    // zero-width fenced range, by falling back to the true max instead of
    // producing a reference so small nearly everything clips to level 4.
    return reference > 0 ? reference : nonZero[nonZero.length - 1];
}

/*
 Reads the real cell size and gap from CSS custom properties/computed
 style where available, falling back to the constants above. Keeping this
 as its own function means the CSS is still the single source of truth for
 how a cell actually looks - this only asks "how wide is that, in px?".
*/
function getHeatmapCellMetrics(container) {
    let cellPx = HEATMAP_CELL_PX;
    let gapPx = HEATMAP_GAP_PX;
    try {
        const styles = getComputedStyle(container);
        const cellVar = styles.getPropertyValue("--heatmap-cell-size").trim();
        if (cellVar) {
            const parsed = parseFloat(cellVar);
            if (!Number.isNaN(parsed)) cellPx = parsed;
        }
        const grid = container.querySelector(".heatmap-grid");
        if (grid) {
            const gridStyles = getComputedStyle(grid);
            const gapVal = parseFloat(gridStyles.columnGap || gridStyles.gap);
            if (!Number.isNaN(gapVal)) gapPx = gapVal;
        }
    } catch (e) {
        // Fall through to defaults - a metrics read failure should never
        // block rendering the calendar itself.
    }
    return { cellPx, gapPx };
}

/*
 Figures out how many weeks to render given the container's current
 available width. Uses the container's own clientWidth (not the window's)
 so this keeps working correctly regardless of sidebars, padding, or
 whatever else is squeezing the stats view - it only ever asks "how much
 room do I actually have right here?".
*/
function computeResponsiveHeatmapWeeks(container) {
    const { cellPx, gapPx } = getHeatmapCellMetrics(container);
    const availableWidth = container.clientWidth || container.getBoundingClientRect().width || 0;
    if (availableWidth <= 0) return HEATMAP_MAX_WEEKS; // no measurement yet (e.g. hidden tab) - defaults to max

    const weeksThatFit = Math.floor(((availableWidth*0.95) + gapPx) / (cellPx + gapPx));

    return Math.max(HEATMAP_MIN_WEEKS, Math.min(HEATMAP_MAX_WEEKS, weeksThatFit));
}

// One shared observer that re-renders the calendar whenever its container
// is resized (window resize, sidebar collapse/expand, font-size zoom,
// etc.) - set up once and reused rather than recreated on every render.
let heatmapResizeObserver = null;

function ensureHeatmapResizeObserver(container) {
    if (heatmapResizeObserver) return;
    if (typeof ResizeObserver === "undefined") return; // very old browsers just keep the last computed week count
    heatmapResizeObserver = new ResizeObserver(() => {
        // Re-render on the next frame so rapid resize events collapse into
        // a single re-render instead of one per intermediate frame.
        requestAnimationFrame(renderReadingActivityCalendar);
    });
    heatmapResizeObserver.observe(container);
}

function heatmapLevelForSeconds(seconds, referenceSeconds) {
    if (!seconds || seconds <= 0 || referenceSeconds <= 0) return 0;
    const fraction = seconds / referenceSeconds;
    // Walk the thresholds low to high and keep the last one the fraction
    // clears, e.g. fraction=0.5 clears [0, 0.15, 0.4] but not [0.7, 1], so
    // it resolves to level 3 (index 2 + 1). A day whose seconds exceed
    // referenceSeconds (i.e. one of the very outliers this is designed to
    // be resistant to) simply clears every threshold and clamps to level 4
    // below, rather than needing its own case.
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

    ensureHeatmapResizeObserver(container);

    const byDay = aggregateReadingHistoryByLocalDay(loadedBooksMemory);
    const dayKeys = Object.keys(byDay);

    if (dayKeys.length === 0) {
        container.innerHTML = `<div class="empty-state-message">No reading activity recorded yet. This calendar fills in as you read from now on.</div>`;
        return;
    }

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // How many weeks fit in the container's current width - a full year
    // (HEATMAP_MAX_WEEKS) whenever there's room, fewer on narrow screens,
    // never below HEATMAP_MIN_WEEKS. Recomputed on every render so a
    // resize (see ensureHeatmapResizeObserver below) just calls this again.
    const totalWeeks = computeResponsiveHeatmapWeeks(container);

    // Grid starts on the Sunday on/before (today - totalWeeks weeks) and
    // always spans exactly totalWeeks complete weeks (Sun-Sat), same as
    // GitHub's - any days after today within the current week are rendered
    // too, just blanked out as "future", so the grid is always a clean
    // rectangle instead of an uneven last column.
    const gridStart = new Date(todayStart);
    gridStart.setDate(gridStart.getDate() - (totalWeeks * 7 - 1));
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const totalDays = totalWeeks * 7;

    // Robust "fully lit" reference value - see computeHeatmapReferenceSeconds()
    // above for why this is a high percentile of day totals rather than the
    // single highest day.
    const dayTotals = dayKeys.map((key) => byDay[key].totalSeconds);
    const referenceSeconds = computeHeatmapReferenceSeconds(dayTotals);

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
        const level = isFuture ? -1 : heatmapLevelForSeconds(seconds, referenceSeconds);

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