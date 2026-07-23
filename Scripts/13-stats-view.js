// =================================================================
// PER-BOOK "DELTA FROM AVERAGE" COMPARISONS
// =================================================================
function computeStatAveragesForGroup(groupMetrics) {
    const timeSpentValues = groupMetrics.filter(m => m.mins > 0).map(m => m.mins);
    const pagesPerHourValues = groupMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
    const completionDurationValues = groupMetrics.filter(m => m.completionDurationMs !== null).map(m => m.completionDurationMs);
    const pagesPerDayValues = groupMetrics.filter(m => m.pagesPerDay !== null).map(m => m.pagesPerDay);

    const mean = (arr) => arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;

    return {
        timeSpentMins: mean(timeSpentValues),
        pagesPerHour: mean(pagesPerHourValues),
        completionDurationMs: mean(completionDurationValues),
        pagesPerDay: mean(pagesPerDayValues),
        // Per-metric adaptive "≈ average" cutoffs - see computeApproxAverageCutoffPercent().
        // Kept alongside the plain means since both are derived from the
        // exact same filtered value arrays and both are needed together
        // wherever a delta gets built.
        cutoffs: {
            timeSpentMins: computeApproxAverageCutoffPercent(timeSpentValues),
            pagesPerHour: computeApproxAverageCutoffPercent(pagesPerHourValues),
            completionDurationMs: computeApproxAverageCutoffPercent(completionDurationValues),
            pagesPerDay: computeApproxAverageCutoffPercent(pagesPerDayValues),
        },
    };
}
/*
 Statuses that get their own "delta from average" group. Not Started is
 excluded because it has no meaningful reading activity.

 Add a new status here if it should compare only against books with the
 same status. The averaging logic stays generic.
*/
const DELTA_COMPARISON_STATUSES = [
    Config.Miscellaneous.READING_STATUS.COMPLETED,
    Config.Miscellaneous.READING_STATUS.IN_PROGRESS,
    Config.Miscellaneous.READING_STATUS.PAUSED,
];
/*
 Computes separate averages/cutoffs for each status in
 DELTA_COMPARISON_STATUSES, so books are compared only against others with
 the same status.

 Returns an object keyed by status (e.g. result.completed), where each
 value has the same shape as computeStatAveragesForGroup(), allowing
 existing delta code to work unchanged.

 Iterating DELTA_COMPARISON_STATUSES keeps this function generic—adding a
 new comparison status only requires updating that list.
*/
function computeStatAveragesByStatus(perBookMetrics) {
    const result = {};
    for (const status of DELTA_COMPARISON_STATUSES) {
        const groupMetrics = perBookMetrics.filter(m => m.status === status);
        result[status] = computeStatAveragesForGroup(groupMetrics);
    }
    return result;
}
/*
 Computes a dynamic "≈ average" cutoff instead of using a fixed percentage.

 The cutoff shrinks for small samples and tightly clustered data, making
 small but meaningful differences visible. It is based on coefficient of
 variation per sample and clamped to a sensible range.
*/
const APPROX_AVERAGE_CUTOFF_MIN_PERCENT = 1; // minimum cutoff
const APPROX_AVERAGE_CUTOFF_MAX_PERCENT = 8; // maximum cutoff
const APPROX_AVERAGE_CUTOFF_SCALE = 2.5; // scales CV-per-sample into a percent cutoff

function computeApproxAverageCutoffPercent(values) {
    if (values.length < 2) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT; // can't measure spread

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (!mean) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT;

    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / Math.abs(mean); // relative spread

    // Divide by sample count so smaller datasets use a stricter cutoff.
    const cvPerSample = coefficientOfVariation / values.length;

    const cutoff = cvPerSample * 100 * APPROX_AVERAGE_CUTOFF_SCALE;
    return Math.max(APPROX_AVERAGE_CUTOFF_MIN_PERCENT, Math.min(APPROX_AVERAGE_CUTOFF_MAX_PERCENT, cutoff));
}

/*
 Builds the "↑/↓ X than average (+Y%)" line beneath a stat, or "" if no
 valid comparison exists.

 higherIsBetter determines which direction is considered an improvement
 for the current metric.
*/
function buildStatDeltaHtml(value, average, formatFn, higherLabel, lowerLabel, higherIsBetter, approxCutoffPercent) {
    if (value === null || value === undefined || average === null || average === undefined || average === 0) {
        return "";
    }

    const absoluteDiff = value - average;
    const percentDiff = (absoluteDiff / average) * 100;
    const absPercent = Math.abs(percentDiff);

    // Within the dataset's own adaptive cutoff of average reads as
    // "approximately average" rather than forcing every book into a strict
    // above/below bucket. See computeApproxAverageCutoffPercent() for how
    // this is derived from the data itself (falls back to 5 if the caller
    // doesn't supply one, matching the old fixed behavior).
    const cutoff = typeof approxCutoffPercent === "number" ? approxCutoffPercent : 5;
    if (absPercent < cutoff) {
        return `<div class="stat-delta-row stat-delta-neutral">≈ average</div>`;
    }

    const isAboveAverage = absoluteDiff > 0;
    const isGood = isAboveAverage === higherIsBetter;
    const arrow = isAboveAverage ? "↑" : "↓";
    const directionLabel = isAboveAverage ? higherLabel : lowerLabel;
    const formattedAbsDiff = formatFn(Math.round(Math.abs(absoluteDiff)*10)/10);
    const sign = isAboveAverage ? "+" : "-";

    /*
     Saturation scales continuously with |percentDiff| rather than snapping
     between a few fixed shades, so the magnitude is visually obvious even
     between two books that are both merely "above average" but by very
     different amounts. Alpha is clamped to keep the text legible against
     every theme's background at the extreme end.
    */
    const alpha = Math.min(0.95, 0.35 + (absPercent / 100) * 0.6);
    const colorVar = isGood ? "--stat-good-rgb" : "--stat-bad-rgb";
    const color = `rgba(var(${colorVar}), ${alpha.toFixed(2)})`;

    // Very large deltas get a slightly bigger, glowing percentage figure so
    // an extreme outlier catches the eye without needing another color.
    const VERY_HIGH_THRESHOLD_PERCENT = 75;
    const emphasisClass = absPercent >= VERY_HIGH_THRESHOLD_PERCENT ? "stat-delta-emphasis" : "";

    return `
        <div class="stat-delta-row" style="color:${color};">
            ${arrow} ${escapeHtml(formattedAbsDiff)} ${escapeHtml(directionLabel)}
            (<span class="${emphasisClass}">${sign}${absPercent.toFixed(1)}%</span>)
        </div>
    `;
}

/*
 Single source of truth for the four comparable per-book metrics:
 Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

 Each metric keeps its value getter, formatter, and higher-is-better
 direction here, so code needing all four metrics can loop over this
 instead of maintaining separate lists. Adding another comparable metric
 only requires adding one entry.

 Formatters use arrow wrappers:
 `(v) => formatMinutes(v)` instead of `format: formatMinutes`.

 This defers the function lookup until formatting runs, because this file
 loads before the formatter functions are defined in 14-utils.js.
*/
const FOUR_METRIC_DEFINITIONS = [
    {
        key: "timeSpent",
        label: "Time Spent",
        averageKey: "timeSpentMins",
        cutoffKey: "timeSpentMins",
        getValue: (m) => (m.mins > 0 ? m.mins : null),
        format: (v) => formatMinutes(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerHour",
        label: "Pages per Hour",
        averageKey: "pagesPerHour",
        cutoffKey: "pagesPerHour",
        getValue: (m) => m.pagesPerHour,
        format: (v) => `${v.toFixed(1)} p/h`,
        higherIsBetter: true,
    },
    {
        key: "completionDuration",
        label: "Completion Duration",
        averageKey: "completionDurationMs",
        cutoffKey: "completionDurationMs",
        getValue: (m) => m.completionDurationMs,
        format: (v) => formatCompletionDuration(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerDay",
        label: "Pages per Day",
        averageKey: "pagesPerDay",
        cutoffKey: "pagesPerDay",
        getValue: (m) => m.pagesPerDay,
        format: (v) => `${v.toFixed(1)} pages/day`,
        higherIsBetter: true,
    },
];

/*
 Computes the four "delta from average" HTML snippets:
 Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

 Accepts any object shaped like a perBookMetrics entry, and is shared by
 buildStatsRowHtml and renderReadingSpeedProgression() so both views use
 the same comparison logic without duplication.

 Uses the book's own status to select averages from
 statAveragesByStatus:
 each delta compares only against books with the same status. Statuses
 without an averages group naturally return no delta through
 buildStatDeltaHtml() handling.

 Loops over FOUR_METRIC_DEFINITIONS instead of manually writing each
 metric, keeping this function synchronized with the metric definitions.
*/
function buildFourMetricDeltas(m, statAveragesByStatus) {
    const groupAverages = statAveragesByStatus[m.status];
    const result = {};
    for (const def of FOUR_METRIC_DEFINITIONS) {
        result[def.key] = groupAverages
            ? buildStatDeltaHtml(
                def.getValue(m), groupAverages[def.averageKey],
                def.format, "", "", def.higherIsBetter, groupAverages.cutoffs[def.cutoffKey],
            )
            : "";
    }
    return result;
}

/*
 Builds one <tr> for the per-book stats table, including the "delta from
 average" line under each of the four comparable stat cells (Time Spent,
 Pages per Hour, Completion Duration, Pages per Day). Split out from the
 main loop in showStatsViewState() since it needs statAveragesByStatus,
 which isn't known until every book has been visited once - see
 perBookMetrics there.
*/
function buildStatsRowHtml(m, statAveragesByStatus) {
    const pagesPerHourDisplay = m.pagesPerHour !== null ? `${m.pagesPerHour.toFixed(1)} p/h` : "—";
    const deltas = buildFourMetricDeltas(m, statAveragesByStatus);
    return `
        <tr style="border-bottom: 1px solid var(--border);">
            <td>${escapeHtml(m.book.title)}</td>
            <td style="color:var(--accent);">${READING_STATUS_LABELS[m.status]}</td>
            <td>${m.pagesRead} / ${m.totalPages || "—"} pages</td>
            <td>${formatMinutes(m.mins)}${deltas.timeSpent}</td>
            <td>${pagesPerHourDisplay}${deltas.pagesPerHour}</td>
            <td>${formatCompletionDuration(m.completionDurationMs)}${deltas.completionDuration}</td>
            <td>${m.pagesPerDay !== null ? `${m.pagesPerDay.toFixed(1)} p/day` : "—"}${deltas.pagesPerDay}</td>
        </tr>
    `;
}
// =================================================================
// LIBRARY DISTRIBUTION - DYNAMIC BUCKETING ENGINE
// =================================================================
/*
 Builds equal-width numeric buckets from the data's current range instead
 of fixed cutoffs, keeping distributions useful as library values change.

 Uses an IQR fence to determine the bucket range rather than raw min/max:
 extreme outliers cannot stretch all buckets and hide normal data. Values
 outside the fence are still included in the first or last bucket.

 Falls back to static buckets when there is not enough data or when the
 fenced range is degenerate, preventing zero-width buckets and invalid
 calculations.

 Returns {min, max, label} buckets. The first and last buckets use
 -Infinity/Infinity so every value is always included.
*/
const MIN_VALUES_FOR_DYNAMIC_BUCKETS = 5;
const IQR_FENCE_MULTIPLIER = 1.5; // standard "Tukey's fence" multiplier for mild-outlier trimming

// Linear-interpolation percentile over a sorted array (values must already be sorted ascending).
function percentile(sortedValues, p) {
    const idx = p * (sortedValues.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sortedValues[lower];
    const frac = idx - lower;
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * frac;
}

function buildDynamicBuckets(values, staticBuckets, bucketCount, unitLabel) {
    if (values.length < MIN_VALUES_FOR_DYNAMIC_BUCKETS) return staticBuckets;

    const sorted = [...values].sort((a, b) => a - b);

/*
 Bucket width is based on an IQR fence instead of raw min/max, preventing
 extreme outliers from stretching every bucket and hiding normal values.

 Uses Tukey's fence:
 values beyond 1.5 × (Q3 - Q1) outside the middle 50% are treated as
 outliers. The fence range is clamped to the actual data range when it
 extends beyond the available values.

 Uses quartiles instead of trimming a fixed percentage, so the behavior
 scales naturally with dataset size and distribution rather than removing
 an arbitrary amount of data.
*/
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const fenceMin = q1 - IQR_FENCE_MULTIPLIER * iqr;
    const fenceMax = q3 + IQR_FENCE_MULTIPLIER * iqr;
    const trimmedMin = Math.max(sorted[0], fenceMin);
    const trimmedMax = Math.min(sorted[sorted.length - 1], fenceMax);
    if (!(trimmedMax > trimmedMin)) return staticBuckets; // degenerate trimmed range

    const width = (trimmedMax - trimmedMin) / bucketCount;

    // Compute every bucket's true numeric edges first (edgeAt(i) is the
    // boundary between bucket i-1 and bucket i in "normal" trimmed-range
    // terms) before touching Infinity or labels at all - keeps the display
    // logic below simple since it only ever reads real numbers.
    const edgeAt = (i) => trimmedMin + i * width;

    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
        const isFirst = i === 0;
        const isLast = i === bucketCount - 1;
        // Real (finite) edges are what the label always shows; -Infinity/
        // Infinity are only used for the actual min/max used to tally
        // values, so outliers below/above the trimmed range still land in
        // the first/last bucket instead of being dropped.
        const min = isFirst ? -Infinity : edgeAt(i);
        const max = isLast ? Infinity : edgeAt(i + 1);
        const label = isLast
            ? `${Math.round(edgeAt(i))}+ ${unitLabel}`
            : `${Math.round(edgeAt(i))}\u2013${Math.round(edgeAt(i + 1))} ${unitLabel}`;
        buckets.push({ min, max, label });
    }
    return buckets;
}

// Places a single value into the matching bucket's count. Shared by every
// distribution below rather than each one writing its own find-and-increment.
function tallyIntoBuckets(values, buckets) {
    const counts = buckets.map(() => 0);
    for (const value of values) {
        for (let i = 0; i < buckets.length; i++) {
            // First bucket's min and last bucket's max can be -Infinity/
            // Infinity (see buildDynamicBuckets' outlier trimming), so this
            // condition is naturally always-true on whichever end is open;
            // every other bucket is a normal [min, max) range.
            if (value >= buckets[i].min && (value < buckets[i].max || buckets[i].max === Infinity)) {
                counts[i]++;
                break;
            }
        }
    }
    return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
}

/*
 Computes the three Library Distribution breakdowns, reusing perBookMetrics
 (already built by the main loop in showStatsViewState()) instead of
 re-deriving pagesRead/isRead/pagesPerHour a second time. Each distribution
 returns { entries: [{label, count}], eligibleCount } - eligibleCount is the
 denominator for that distribution's percentages, which differs per chart
 (all books for Length/Status, only books with a valid pages/hour for Speed).
*/
const BOOK_LENGTH_STATIC_BUCKETS = [
    { min: 0, max: 300, label: "0\u2013299 pages" },
    { min: 300, max: 500, label: "300\u2013499 pages" },
    { min: 500, max: 700, label: "500\u2013699 pages" },
    { min: 700, max: 900, label: "700\u2013899 pages" },
    { min: 900, max: Infinity, label: "900+ pages" },
];

const READING_SPEED_STATIC_BUCKETS = [
    { min: 0, max: 50, label: "<50 p/h" },
    { min: 50, max: 60, label: "50\u201360 p/h" },
    { min: 60, max: 70, label: "60\u201370 p/h" },
    { min: 70, max: 80, label: "70\u201380 p/h" },
    { min: 80, max: 100, label: "80\u2013100 p/h" },
    { min: 100, max: Infinity, label: "100+ p/h" },
];

function computeLibraryDistributions(perBookMetrics) {
    // --- 1. Book Length Distribution ---
    // Every book with a known page count qualifies, read or not - this is a
    // library-composition chart, not a reading-progress one.
    const pageCounts = perBookMetrics.filter(m => m.totalPages > 0).map(m => m.totalPages);
    const lengthBuckets = buildDynamicBuckets(pageCounts, BOOK_LENGTH_STATIC_BUCKETS, 5, "pages");
    const bookLength = {
        entries: tallyIntoBuckets(pageCounts, lengthBuckets),
        eligibleCount: pageCounts.length,
    };

    // --- 2. Reading Status Distribution ---
    // Three fixed, mutually-exclusive buckets straight off each book's own
    // isRead/isStarted flags (already computed in the main loop) - nothing
    // dynamic here, since "how many status categories exist" isn't a
    // function of the data the way page-count or speed ranges are.
    let completedCount = 0, inProgressCount = 0, notStartedCount = 0;
    for (const m of perBookMetrics) {
        if (m.isRead) completedCount++;
        else if (m.isStarted) inProgressCount++;
        else notStartedCount++;
    }
    const readingStatus = {
        entries: [
            { label: "Completed", count: completedCount },
            { label: "In Progress", count: inProgressCount },
            { label: "Not Started", count: notStartedCount },
        ],
        eligibleCount: perBookMetrics.length,
    };

    // --- 3. Reading Speed Distribution ---
    // Only books with a meaningful pages/hour figure qualify - same
    // eligibility already enforced when perBookMetrics.pagesPerHour was
    // computed (requires mins > 0), so no separate time-tracked threshold
    // needs to be redefined here.
    const speeds = perBookMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
    const speedBuckets = buildDynamicBuckets(speeds, READING_SPEED_STATIC_BUCKETS, 5, "p/h");
    const readingSpeed = {
        entries: tallyIntoBuckets(speeds, speedBuckets),
        eligibleCount: speeds.length,
    };

    return { bookLength, readingStatus, readingSpeed };
}

/*
 Renders a distribution bar chart into the given container. Shared by all
 Library Distribution charts, with only the provided data determining the
 displayed distribution.

 Bar height uses the same percentage shown in the label below each bar:
 percent of eligibleCount. This keeps the visual height consistent with the
 displayed count/percentage instead of scaling against only the largest
 bucket, which could make labels and bars disagree.
*/
function renderDistributionBarChart(containerId, distribution) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { entries, eligibleCount } = distribution;
    if (!eligibleCount || entries.every(e => e.count === 0)) {
        container.innerHTML = `<div style="color:var(--text-muted)">Not enough data yet.</div>`;
        return;
    }

    const bars = entries.map(e => {
        const percent = eligibleCount ? (e.count / eligibleCount) * 100 : 0;
        // Bar height matches this same percent, with a small floor so a
        // non-zero bucket is still visibly a bar rather than a sliver.
        const heightPercent = e.count > 0 ? Math.max(4, percent) : 0;
        return `
            <div class="dist-bar-column">
                <div class="dist-bar-track">
                    <div class="dist-bar-fill" style="height:${heightPercent}%;"></div>
                </div>
                <div class="dist-bar-count">${e.count} book${e.count === 1 ? "" : "s"} (${percent.toFixed(0)}%)</div>
                <div class="dist-bar-label">${escapeHtml(e.label)}</div>
            </div>
        `;
    }).join("");

    container.innerHTML = `<div class="dist-bar-chart">${bars}</div>`;
}

// =================================================================
// GLOBAL READING STATS VIEW LAYOUT ROUTER CONTROLLER
// =================================================================
async function showStatsViewState() {
    document.getElementById("library-view").style.display = "none";
    document.getElementById("reader-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";

    const statsPanel = document.getElementById("stats-view");
    statsPanel.style.display = "flex";

    const tbody = document.getElementById("stats-books-table-body");
    tbody.innerHTML = `<tr><td colspan="7" style="padding:12px; text-align:center; color:var(--text-muted)">Loading book metadata...</td></tr>`;

    /*
     Backfills totalPages/totalWords/chapterCount on any book that predates
     those cached fields (see 07-epub-parser.js, 08-epub-import.js, or 09-epub-reader.js). Books that already have
     them resolve instantly without touching their EPUB file, so awaiting
     this on every stats-view open is cheap after the first pass.
    */
    await migrateMissingBookMetadata();

    let totalBooksCount = loadedBooksMemory.length;
    let readBooksCount = 0;
    let combinedSecondsTracked = 0;
    let sessionTime = 0; // fallback accumulator, only used for books with no real session records yet

    // Core calculation metrics
    let globalTotalPagesRead = 0;
    let globalTotalWordsRead = 0;
    let timedPagesRead = 0;

    let longestBook = null;
    let shortestBook = null;
    const completedBooks = [];
    const completionsByMonth = {}; // "YYYY-MM" -> completed count
    let totalReadingSessions = 0; // sum of totalSessions, fallback denominator for avg session length
    /*
    Completion Duration is calendar time between firstOpened and completedDate,
    not reading time (timeSpentSeconds). It is calculated separately using
    the same running min/max approach used by the other book stats.
    */
    let completionDurationSumMs = 0;
    let completionDurationCount = 0;
    let fastestCompletion = null; // {book, durationMs}
    let slowestCompletion = null;

    /*
    Pages/day is based on calendar days between firstOpened and completedDate,
    unlike pages/hour which uses reading time. It uses the same completed-book
    requirements and running min/max tracking as Completion Duration.
    */
    let pagesPerDaySum = 0;
    let pagesPerDayCount = 0;
    let fastestPagesPerDay = null; // {book, pagesPerDay}
    let slowestPagesPerDay = null;

    /*
    "Reading Speed Over Lifetime" stores per-completed-book pages/hour entries
    as a list because the data must later be sorted by completedDate and
    displayed individually rather than reduced into one aggregate value.
    */
    const speedProgressionEntries = []; // {book, completedDate, pagesPerHour}

    /*
    Stores real reading session durations from each book's readingSessions log.
    This is the source of truth for average session length, while older books
    without session history fall back to the legacy totalSessions/sessionTime
    values.
    */
    const allRealSessionDurationsMins = [];

    /*
    Stores raw per-book metrics collected during the first pass. Averages are
    only available after all books are processed, so delta comparisons and row
    HTML are generated afterward using these already-calculated values.
    */
    const perBookMetrics = [];

    // Loop through memory records - all numbers below come straight off
    // each book's cached fields, no EPUB is opened here.
    for (const book of loadedBooksMemory) {
        combinedSecondsTracked += getMeaningfulTrackedSeconds(book.timeSpentSeconds);
        totalReadingSessions += (book.totalSessions || 0);

        if (Array.isArray(book.readingSessions) && book.readingSessions.length > 0) {
            for (const session of book.readingSessions) {
                if (typeof session.durationSeconds === "number") {
                    allRealSessionDurationsMins.push(session.durationSeconds / 60);
                }
            }
        } else if (book.totalSessions > 0) {
            // Fallback for books with no real session log: same approximation used before this feature existed
            sessionTime += getMeaningfulTrackedMinutes(book.timeSpentSeconds);
        }

        const totalPages = book.totalPages || 0;
        const totalWords = book.totalWords || 0;
        const chapterCount = book.chapterCount || 0;

        if (totalPages > 0) {
            if (!longestBook || totalPages > (longestBook.totalPages || 0)) longestBook = book;
            if (!shortestBook || totalPages < (shortestBook.totalPages || 0)) shortestBook = book;
        }

        const isRead = !!book.isRead;
        // Was never incremented before, so "BOOKS FULLY READ" always showed 0
        // regardless of how many books had actually been finished.
        if (isRead) {
            readBooksCount++;
            completedBooks.push(book);
            if (book.completedDate) {
                const d = new Date(book.completedDate);
                const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                completionsByMonth[monthKey] = (completionsByMonth[monthKey] || 0) + 1;
            }
        }

        /*
        Only books with both fields qualify. A book may have a completedDate
        without firstOpened, such as older records or manually edited completions.

        Uses the existing completionDurationMs value instead of recalculating it,
        and additionally requires isRead because Pages/day only applies to
        completed books. Calendar days are floored at 1 to avoid near-zero
        same-day completion divisions.
        */
        let completionDurationMs = null;
        let pagesPerDay = null;
        if (book.firstOpened && book.completedDate) {
            completionDurationMs = book.completedDate - book.firstOpened;
            completionDurationSumMs += completionDurationMs;
            completionDurationCount++;
            if (!fastestCompletion || completionDurationMs < fastestCompletion.durationMs) {
                fastestCompletion = { book, durationMs: completionDurationMs };
            }
            if (!slowestCompletion || completionDurationMs > slowestCompletion.durationMs) {
                slowestCompletion = { book, durationMs: completionDurationMs };
            }

            if (isRead && totalPages > 0) {
                const calendarDays = Math.max(1, completionDurationMs / (1000 * 60 * 60 * 24));
                pagesPerDay = totalPages / calendarDays;
                pagesPerDaySum += pagesPerDay;
                pagesPerDayCount++;
                if (!fastestPagesPerDay || pagesPerDay > fastestPagesPerDay.pagesPerDay) {
                    fastestPagesPerDay = { book, pagesPerDay };
                }
                if (!slowestPagesPerDay || pagesPerDay < slowestPagesPerDay.pagesPerDay) {
                    slowestPagesPerDay = { book, pagesPerDay };
                }
            }
        }

        let pagesRead, wordsRead;
        if (isRead) {
            pagesRead = totalPages;
            wordsRead = totalWords;
        } else if (book.currentChapter > 0 || book.scrollOffset > 100) {
            const progress = book.currentChapter / Math.max(1, chapterCount);
            pagesRead = Math.round(progress * totalPages);
            wordsRead = Math.round(progress * totalWords);
        } else {
            pagesRead = 0;
            wordsRead = 0;
        }

        globalTotalPagesRead += pagesRead;
        globalTotalWordsRead += wordsRead;

        const meaningfulTrackedSeconds = getMeaningfulTrackedSeconds(book.timeSpentSeconds);
        const mins = getMeaningfulTrackedMinutes(book.timeSpentSeconds);
        if (mins > 0) timedPagesRead += pagesRead;
        /*
        Reading Speed Over Lifetime uses completed books with a completedDate and
        meaningful tracked reading time. A raw timeSpentSeconds > 0 check allowed
        tiny values to create unrealistic pages/hour results.

        Uses getMeaningfulTrackedSeconds() as the shared validation gate, matching
        the main per-book table and preventing inconsistent calculations.
        */
        if (isRead && book.completedDate && totalPages > 0 && meaningfulTrackedSeconds > 0) {
            const trackedReadingHours = meaningfulTrackedSeconds / 3600;
            speedProgressionEntries.push({
                book,
                // Every entry here is a completed book by construction 
                // (see the isRead && book.completedDate gate above), so stamp the status explicitly
                // for buildFourMetricDeltas() to use the Completed averages group.
                status: READING_STATUS.COMPLETED,
                completedDate: book.completedDate,
                pagesPerHour: totalPages / trackedReadingHours,
                mins: getMeaningfulTrackedMinutes(book.timeSpentSeconds),
                completionDurationMs,
                pagesPerDay,
            });
        }

        // Stash this book's raw metric values instead of building its row string
        // immediately - see perBookMetrics comment above.
        perBookMetrics.push({
            book,
            isRead,
            // Same "has the user actually opened/progressed this book" check used
            // above for pagesRead, reused for the Reading Status distribution split.
            isStarted: book.currentChapter > 0 || book.scrollOffset > 100,
            // Adds "Paused" detection on top of Completed/In Progress/Not Started.
            // Uses getBookReadingStatus() as the shared source for status logic.
            status: getBookReadingStatus(book),
            pagesRead,
            totalPages,
            mins,
            pagesPerHour: mins > 0 ? (pagesRead / mins * 60) : null, // numeric, not the old formatted string
            completionDurationMs,
            pagesPerDay,
        });
    }
        /*
        Computes per-status averages for the per-book delta comparisons:
        Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

        Each book is compared only against others with the same status
        (Completed/In Progress/Paused). Uses perBookMetrics so the same metric
        validity rules from the main loop are reused instead of being duplicated.

        See computeStatAveragesByStatus().
        */
        const statAveragesByStatus = computeStatAveragesByStatus(perBookMetrics);

    // Flush table rows inside dashboard
    tbody.innerHTML = perBookMetrics.map(m => buildStatsRowHtml(m, statAveragesByStatus)).join("");

   /*
    Library Distribution charts (Book Length, Reading Status, and Reading
    Speed) reuse perBookMetrics instead of performing another pass over
    loadedBooksMemory, matching the approach used by statAveragesByStatus.
    */
    const libraryDistributions = computeLibraryDistributions(perBookMetrics);
    renderDistributionBarChart("dist-book-length", libraryDistributions.bookLength);
    renderDistributionBarChart("dist-reading-status", libraryDistributions.readingStatus);
    renderDistributionBarChart("dist-reading-speed", libraryDistributions.readingSpeed);

    // --- MATH COMPILATIONS & UI UPDATES ---
    const totalMins = Math.round(combinedSecondsTracked / 60);
    const booksWithTime = loadedBooksMemory.filter(b => getMeaningfulTrackedSeconds(b.timeSpentSeconds) > 0).length;
    const avgMins = booksWithTime ? Math.round(totalMins / booksWithTime) : 0;
    const avgPagesPerHour = totalMins ? (timedPagesRead / totalMins * 60).toFixed(1): "—";

    const booksWithPages = loadedBooksMemory.filter(b => (b.totalPages || 0) > 0);
    const avgBookLengthPages = booksWithPages.length
        ? Math.round(booksWithPages.reduce((sum, b) => sum + b.totalPages, 0) / booksWithPages.length)
        : 0;
    const avgCompletedLengthPages = completedBooks.length
        ? Math.round(completedBooks.reduce((sum, b) => sum + (b.totalPages || 0), 0) / completedBooks.length)
        : 0;

    /*
    Average reading session length prefers real recorded sessions from
    readingSessions over the old totalSessions/timeSpentSeconds estimate.

    Falls back to the old approximation only for books without session
    history, keeping older libraries from losing their average value.
    */
    const avgSessionMins = allRealSessionDurationsMins.length
        ? Math.round(allRealSessionDurationsMins.reduce((sum, m) => sum + m, 0) / allRealSessionDurationsMins.length)
        : (totalReadingSessions ? Math.round(sessionTime / totalReadingSessions) : 0);
    // Update standard interface element outputs values
    document.getElementById("stat-total-books").innerText = totalBooksCount;
    document.getElementById("stat-read-books").innerText = readBooksCount;
    document.getElementById("stat-total-time").innerText = formatMinutes(totalMins);
    document.getElementById("stat-avg-time").innerText = formatMinutes(avgMins);
    document.getElementById("stat-avg-pages-per-hour").innerText = avgPagesPerHour === "—" ? "—" : `${avgPagesPerHour} p/h`;

    const globalPagesElement = document.getElementById("stat-global-pages");
    if (globalPagesElement) {
        globalPagesElement.innerText = globalTotalPagesRead;
    }

    /*
     The stat elements below are new. Each is looked up defensively the
     same way stat-global-pages already was above, so this keeps working
     whether or not the matching element has been added to index.html yet.
    */
    const avgLengthElement = document.getElementById("stat-avg-book-length");
    if (avgLengthElement) 
        avgLengthElement.innerText = avgBookLengthPages ? `${avgBookLengthPages} pages` : "—";

    const avgCompletedLengthElement = document.getElementById("stat-avg-completed-length");
    if (avgCompletedLengthElement)
        avgCompletedLengthElement.innerText = avgCompletedLengthPages ? `${avgCompletedLengthPages} pages` : "—";

    const longestBookElement = document.getElementById("stat-longest-book");
    if (longestBookElement) 
        longestBookElement.innerText = longestBook ? `${escapeHtml(longestBook.title)} (${longestBook.totalPages} pages)` : "—";

    const shortestBookElement = document.getElementById("stat-shortest-book");
    if (shortestBookElement) 
        shortestBookElement.innerText = shortestBook ? `${escapeHtml(shortestBook.title)} (${shortestBook.totalPages} pages)` : "—";

    const totalWordsElement = document.getElementById("stat-total-words-read");
    if (totalWordsElement) 
        totalWordsElement.innerText = globalTotalWordsRead.toLocaleString();

    const avgSessionElement = document.getElementById("stat-avg-session-length");
    if (avgSessionElement) 
        avgSessionElement.innerText = avgSessionMins ? formatMinutes(avgSessionMins) : "—";

    /*
     Completion Duration stats - calendar time, not reading time (see the
     comment above completionDurationSumMs earlier in this function).
    */
    const avgCompletionDurationElement = document.getElementById("stat-avg-completion-duration");
    if (avgCompletionDurationElement) {
        avgCompletionDurationElement.innerText = completionDurationCount
            ? formatCompletionDuration(completionDurationSumMs / completionDurationCount)
            : "—";
    }

    const fastestCompletionElement = document.getElementById("stat-fastest-completion");
    if (fastestCompletionElement) {
        fastestCompletionElement.innerText = fastestCompletion
            ? `${escapeHtml(fastestCompletion.book.title)} (${formatCompletionDuration(fastestCompletion.durationMs)})`
            : "—";
    }

    const slowestCompletionElement = document.getElementById("stat-slowest-completion");
    if (slowestCompletionElement) {
        slowestCompletionElement.innerText = slowestCompletion
            ? `${escapeHtml(slowestCompletion.book.title)} (${formatCompletionDuration(slowestCompletion.durationMs)})`
            : "—";
    }

    const avgPagesPerDayElement = document.getElementById("stat-avg-pages-per-day");
    if (avgPagesPerDayElement) {
        avgPagesPerDayElement.innerText = pagesPerDayCount
            ? `${(pagesPerDaySum / pagesPerDayCount).toFixed(1)} p/day`
            : "—";
    }

    const fastestPagesPerDayElement = document.getElementById("stat-fastest-pages-per-day");
    if (fastestPagesPerDayElement) {
        fastestPagesPerDayElement.innerText = fastestPagesPerDay
            ? `${escapeHtml(fastestPagesPerDay.book.title)} (${fastestPagesPerDay.pagesPerDay.toFixed(1)} p/day)`
            : "—";
    }

    const slowestPagesPerDayElement = document.getElementById("stat-slowest-pages-per-day");
    if (slowestPagesPerDayElement) {
        slowestPagesPerDayElement.innerText = slowestPagesPerDay
            ? `${escapeHtml(slowestPagesPerDay.book.title)} (${slowestPagesPerDay.pagesPerDay.toFixed(1)} p/day)`
            : "—";
    }

   /*
    Completion Timeline is handled by 18-timeline.js as a modular
    multi-mode system through buildCompletionTimelineData().

    completionsByMonth still feeds the per-book stats table unchanged. The
    timeline data is stored on window so mode buttons and tooltip handlers can
    reuse it without rebuilding the data.
    */
    window.__completionTimelineData = buildCompletionTimelineData(loadedBooksMemory);
    renderCompletionTimeline(window.__completionTimelineData);
    renderReadingSpeedProgression(speedProgressionEntries, statAveragesByStatus);

    // See 17-reading-history.js. Guarded like other optional stats components,
    // so this still works if the script or container is not present.
    if (typeof renderReadingActivityCalendar === "function") {
        renderReadingActivityCalendar();
    }
}

/*
Handler for the "Backfill Completion Dates" button.

Runs the bulk migration, refreshes IndexedDB data, re-renders stats, and
reports how many books received completion dates.
*/
async function handleBackfillCompletionDatesClick() {
    const button = document.getElementById("btn-backfill-completion-dates");
    if (button) {
        button.disabled = true;
        button.innerText = "Backfilling...";
    }
    try {
        const updatedCount = await migrateMissingCompletionDates();
        fetchLocalLibrary();
        await showStatsViewState();
        alert(
            updatedCount > 0
                ? `Backfilled completion dates for ${updatedCount} book${updatedCount === 1 ? "" : "s"}.`
                : "No books needed a completion date backfill.",
        );
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = "🕓 Backfill Completion Dates";
        }
    }
}

/*
 Renders #stats-reading-speed-progression with the four per-book metrics:
 Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

 Shows completed books individually, grouped by completion month and sorted
 chronologically, so reading pace changes can be seen book by book instead
 of being hidden by monthly averages.

 Reuses buildFourMetricDeltas() from the per-book table instead of
 duplicating delta logic. Entries contain the same metric fields and always
 belong to the Completed averages group.
*/
function renderReadingSpeedProgression(entries, statAveragesByStatus) {
    const container = document.getElementById("stats-reading-speed-progression");
    if (!container) return;

    if (entries.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No completed books with tracked reading time yet.</div>`;
        return;
    }

    const sorted = [...entries].sort((a, b) => a.completedDate - b.completedDate);

    // Group into "YYYY-MM" buckets, same key format as completionsByMonth,
    // while preserving chronological order within (and across) months.
    const byMonth = {};
    const monthOrder = [];
    for (const entry of sorted) {
        const d = new Date(entry.completedDate);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[monthKey]) {
            byMonth[monthKey] = [];
            monthOrder.push(monthKey);
        }
        byMonth[monthKey].push(entry);
    }

    const monthSections = monthOrder.map((monthKey) => {
        const [year, month] = monthKey.split("-");
        const label = new Date(Number(year), Number(month) - 1, 1)
            .toLocaleDateString(undefined, { month: "long", year: "numeric" });

        const rows = byMonth[monthKey]
            .map((entry) => {
                const deltas = buildFourMetricDeltas(entry, statAveragesByStatus);
                return `
                    <div style="padding:6px 0 10px 16px; border-bottom:1px dashed var(--border);">
                        <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(entry.book.title)}</div>
                        <div class="speed-progression-metrics-grid">
                            <div>
                                <div class="speed-progression-metric-label">Time Spent</div>
                                <div class="speed-progression-metric-value-row"><span>${formatMinutes(entry.mins)}</span>${deltas.timeSpent}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Hour</div>
                                <div class="speed-progression-metric-value-row"><span>${entry.pagesPerHour.toFixed(1)} p/h</span>${deltas.pagesPerHour}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Completion Duration</div>
                                <div class="speed-progression-metric-value-row"><span>${formatCompletionDuration(entry.completionDurationMs)}</span>${deltas.completionDuration}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Day</div>
                                <div class="speed-progression-metric-value-row"><span>${entry.pagesPerDay !== null ? `${entry.pagesPerDay.toFixed(1)} p/day` : "—"}</span>${deltas.pagesPerDay}</div>
                            </div>
                        </div>
                    </div>
                `;
            })
            .join("");

        return `
            <div style="padding:6px 0;">
                <div style="font-weight:600; padding:4px 0;">${escapeHtml(label)}</div>
                ${rows}
            </div>
        `;
    });

    /*
    "Average" footer shows one line per comparable metric:
    Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

    Reads averages from the Completed group in statAveragesByStatus instead
    of recalculating them, since every entry here is a completed book.
    Loops over FOUR_METRIC_DEFINITIONS so future metrics are included
    automatically.

    Uses each metric's own format() function, keeping footer units consistent
    with individual book values. Metrics without qualifying books are skipped
    instead of showing an invalid zero-book average.
    */
    const completedAverages = statAveragesByStatus[READING_STATUS.COMPLETED];
    const averageRows = FOUR_METRIC_DEFINITIONS
        .map((def) => {
            const average = completedAverages[def.averageKey];
            if (average === null || average === undefined) return "";
            return `
                <div class="speed-progression-average-row">
                    <span class="speed-progression-average-label">${escapeHtml(def.label)}</span>
                    <span class="speed-progression-average-value">${escapeHtml(def.format(average))}</span>
                </div>
            `;
        })
        .join("");

    container.innerHTML = `
        ${monthSections.join("")}
        <div class="speed-progression-average-block">
            <div class="speed-progression-average-heading">Average</div>
            ${averageRows}
        </div>
    `;
}