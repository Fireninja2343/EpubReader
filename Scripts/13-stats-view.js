// =================================================================
// PER-BOOK "DELTA FROM AVERAGE" COMPARISONS
// =================================================================
/*
 Computes the four library-wide averages the per-book stats table compares
 each book against: Time Spent (minutes), Pages per Hour, Completion
 Duration (ms), Pages per Day. Each average is only calculated from books
 that actually have valid data for that particular metric - a book with no
 tracked reading time doesn't drag down the Time Spent average, a book
 that's never been completed doesn't count toward Completion Duration, etc.
 Returns null for any average that has no qualifying books at all, which
 buildStatDeltaHtml() below treats as "not enough data, don't show a
 comparison" rather than dividing by zero.
*/
function computeStatAverages(perBookMetrics) {
    const timeSpentValues = perBookMetrics.filter(m => m.mins > 0).map(m => m.mins);
    const pagesPerHourValues = perBookMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
    const completionDurationValues = perBookMetrics.filter(m => m.completionDurationMs !== null).map(m => m.completionDurationMs);
    const pagesPerDayValues = perBookMetrics.filter(m => m.pagesPerDay !== null).map(m => m.pagesPerDay);

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
 Decides, per metric, how large a percent-from-average difference has to be
 before a book stops reading as "≈ average" - replacing what used to be a
 single hardcoded APPROX_THRESHOLD_PERCENT (5%) shared by every metric and
 every library size.

 A fixed 5% cutoff has two failure modes this fixes:
   - Small datasets: with only 2-3 books, the "average" is really just
     those same 2-3 books, so almost any difference between them is
     meaningful - there's no larger population for a small gap to be noise
     against. The cutoff should shrink as the sample shrinks.
   - Tightly clustered datasets: a library where every book's pages/hour
     sits within a few percent of the mean (e.g. 68.4/67.8/64.2 p/h - total
     spread of just 4.2 p/h) has "5% of the mean" be a wide net relative to
     how little the data actually varies, so real, dataset-defining
     differences all get flattened into "average". The cutoff should
     shrink as the data's own relative spread (coefficient of variation)
     shrinks.

 Both effects are captured in one data-driven number: the coefficient of
 variation (stdDev / mean) scaled down by how many samples support it. CV
 alone captures "how spread out is the data, relative to its own size" -
 unitless, so it's comparable across metrics with very different scales
 (minutes vs p/h vs ms). Dividing by sample count on top of that captures
 "how much do I trust that spread is real dataset structure rather than
 just being all the data there is" - with only 2-3 books, the 'average' IS
 those books, so there's no larger population for a small gap to be noise
 against, and the cutoff needs to shrink sharply (dividing by n rather than
 the gentler sqrt(n) is what makes that shrink sharp enough to actually
 separate 68.4/67.8/64.2 instead of still lumping all three together).
 Clamped to a sensible band so it can never vanish to 0% (any nonzero gap
 would count) or blow up past a normal "meaningfully different" range on a
 huge, noisy library.
*/
const APPROX_AVERAGE_CUTOFF_MIN_PERCENT = 1; // floor - even maximally-clustered/small data still needs *some* gap to count as different
const APPROX_AVERAGE_CUTOFF_MAX_PERCENT = 8; // ceiling - never much stricter than the old fixed 5% would allow on a large, naturally spread-out library
const APPROX_AVERAGE_CUTOFF_SCALE = 2.5; // tunable multiplier translating CV-per-sample into a percent cutoff

function computeApproxAverageCutoffPercent(values) {
    if (values.length < 2) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT; // no spread is measurable at all with 0-1 points

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (!mean) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT;

    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / Math.abs(mean); // relative spread, unitless

    // Divides by the raw sample count (not sqrt(n)) so a small library's
    // cutoff shrinks sharply rather than gently - see comment above for why
    // the gentler sqrt(n) version wasn't sharp enough to split apart a
    // tightly-clustered 3-book dataset.
    const cvPerSample = coefficientOfVariation / values.length;

    const cutoff = cvPerSample * 100 * APPROX_AVERAGE_CUTOFF_SCALE;
    return Math.max(APPROX_AVERAGE_CUTOFF_MIN_PERCENT, Math.min(APPROX_AVERAGE_CUTOFF_MAX_PERCENT, cutoff));
}

/*
 Builds the small "↑/↓ X longer/faster/etc than average (+Y%)" line shown
 underneath a stat cell, or "" if there isn't a valid average to compare
 against (either this book lacks the data, or no book in the library does).

 higherIsBetter flips which direction (higher or lower than average) counts
 as "good" (green) vs "bad" (red) for this particular metric - e.g. a
 shorter Completion Duration is an improvement, and so is a shorter Time
 Spent (spending less time than average to get through a book reads as
 faster/better), whereas a higher Pages per Hour is the "faster/better"
 direction instead. Each metric only needs a single higher-is-good boolean
 because within that metric one direction is unambiguously the
 "faster/more efficient" one.
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
 Single source of truth for the four comparable per-book metrics (Time
 Spent, Pages per Hour, Completion Duration, Pages per Day) - value getter,
 formatter, and higher-is-better direction all live here once, so anything
 that needs "all four metrics" (buildFourMetricDeltas below, and the
 Reading Speed Over Lifetime average footer in renderReadingSpeedProgression)
 loops over this instead of re-listing the four metrics by hand. Adding a
 fifth comparable metric later is one more entry pushed onto this array -
 nothing that reads it needs to change.

 format: wrapped as `(v) => formatMinutes(v)` / `(v) => formatCompletionDuration(v)`
 rather than passed directly (`format: formatMinutes`) - this array literal
 is evaluated once, immediately, when this script file loads, and
 formatMinutes/formatCompletionDuration are only defined later in
 14-utils.js, which loads after this file. Referencing them directly here
 would look them up at array-creation time (before they exist) and throw;
 wrapping in an arrow function defers that lookup until the format
 function is actually called, by which point every script has loaded.
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
 Computes the same four "delta from average" HTML snippets (Time Spent,
 Pages per Hour, Completion Duration, Pages per Day) for any object shaped
 like a perBookMetrics entry - i.e. anything with .mins, .pagesPerHour,
 .completionDurationMs, .pagesPerDay. Pulled out of buildStatsRowHtml so
 renderReadingSpeedProgression() (the "Reading Speed Over Lifetime" list)
 can show the exact same four comparisons without re-deriving or
 duplicating any of this logic - both call sites just pass in an object
 with those four fields and the shared statAverages.

 Now just a thin loop over FOUR_METRIC_DEFINITIONS rather than four
 hand-written calls, so this and the definitions list can never drift out
 of sync with each other.
*/
function buildFourMetricDeltas(m, statAverages) {
    const result = {};
    for (const def of FOUR_METRIC_DEFINITIONS) {
        result[def.key] = buildStatDeltaHtml(
            def.getValue(m), statAverages[def.averageKey],
            def.format, "", "", def.higherIsBetter, statAverages.cutoffs[def.cutoffKey],
        );
    }
    return result;
}

/*
 Builds one <tr> for the per-book stats table, including the "delta from
 average" line under each of the four comparable stat cells (Time Spent,
 Pages per Hour, Completion Duration, Pages per Day). Split out from the
 main loop in showStatsViewState() since it needs statAverages, which isn't
 known until every book has been visited once - see perBookMetrics there.
*/
function buildStatsRowHtml(m, statAverages) {
    const pagesPerHourDisplay = m.pagesPerHour !== null ? `${m.pagesPerHour.toFixed(1)} p/h` : "—";
    const deltas = buildFourMetricDeltas(m, statAverages);
    return `
        <tr style="border-bottom: 1px solid var(--border);">
            <td  style="/* padding:12px; */">${escapeHtml(m.book.title)}</td>
            <td  style="/* padding:12px; */ color:var(--accent);">${READING_STATUS_LABELS[m.status]}</td>
            <td  style="/* padding:12px; */">${m.pagesRead} / ${m.totalPages || "—"} pages</td>
            <td  style="/* padding:12px; */">${formatMinutes(m.mins)}${deltas.timeSpent}</td>
            <td  style="/* padding:12px; */">${pagesPerHourDisplay}${deltas.pagesPerHour}</td>
            <td  style="/* padding:12px; */">${formatCompletionDuration(m.completionDurationMs)}${deltas.completionDuration}</td>
            <td  style="/* padding:12px; */">${m.pagesPerDay !== null ? `${m.pagesPerDay.toFixed(1)} p/day` : "—"}${deltas.pagesPerDay}</td>
        </tr>
    `;
}

// =================================================================
// LIBRARY DISTRIBUTION - DYNAMIC BUCKETING ENGINE
// =================================================================
/*
 Builds equal-width numeric buckets spanning the data's own range, instead
 of hardcoding fixed cutoffs (e.g. "0-299, 300-499, ..."). This is what
 keeps the Book Length / Reading Speed distributions informative as the
 library's numbers drift over time - e.g. if the average book length crept
 up to 1000+ pages, static 0-299/300-499/.../900+ buckets would dump almost
 everything into the last bucket. Recomputing the bucket edges from the
 live data every time this renders avoids that.

 The range used for bucket *width* is trimmed using an IQR ("interquartile
 range") fence rather than the raw min/max - a plain min/max range lets a
 single extreme outlier (e.g. one 4000-page book among a library of
 100-1000 page books) stretch every bucket so wide that almost all the
 "normal" books collapse into the first bucket and the chart stops being
 informative for anyone but the outlier. Fencing the range first means
 bucket width is set by where the bulk of the library actually sits;
 values outside the fence don't disappear - they still get tallied, just
 into the first or last bucket (whose edges are -Infinity/Infinity) rather
 than dictating how wide every bucket is. See buildDynamicBuckets() for the
 exact fence definition.

 Falls back to the caller-supplied static buckets whenever the dynamic
 approach "doesn't work" - defined here as: fewer than MIN_VALUES_FOR_DYNAMIC
 data points, or a degenerate fenced range (fencedMax === fencedMin, which
 would otherwise produce zero-width buckets and a division by zero - e.g. a
 library where almost every book is exactly the same length aside from one
 or two outliers).

 Returns an array of {min, max, label} - the first bucket's min and the
 last bucket's max are -Infinity/Infinity so every value, however extreme,
 always has a home.
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
     Bucket *width* is sized off an IQR ("interquartile range") fence
     rather than the raw min/max, so a single extreme outlier - e.g. one
     4000-page book sitting in an otherwise 100-1000 page library - can't
     stretch every bucket wide enough to crush all the "normal" books into
     the first one. This is the standard Tukey's-fence definition of a mild
     outlier: anything more than 1.5x the middle 50%'s spread (Q3 - Q1)
     beyond Q1 or Q3. Clamped back to the real min/max wherever the fence
     would extend past the actual data (e.g. no outliers at all, where the
     fence naturally lands outside the data and should just use the data's
     own edges instead).

     This is deliberately count-based via quartiles rather than a fixed
     "trim the outer 10%" cut: chopping a fixed percentage off a small
     dataset (e.g. 10 books) can still let a single extreme value leak
     partway into the trimmed edge through interpolation, whereas Q1/Q3 and
     the fence multiplier scale naturally with how spread out the *bulk* of
     the data actually is.
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
 Renders one distribution as a simple vertical bar chart into the given
 container id. Shared by all three Library Distribution charts rather than
 each one having its own bespoke rendering - the only thing that differs
 between them is which {entries, eligibleCount} object gets passed in.

 Bar height is driven by the exact same "percent of eligibleCount" figure
 shown in the count/percentage label underneath each bar (rather than a
 separate relative-to-the-largest-bucket calculation) - those two numbers
 disagreeing was a real bug: a bucket could show "3 books (19%)" while its
 bar was drawn at 75% height because the height had been computed against
 the chart's own largest bucket instead of the full eligible count. Tying
 both to the same number keeps what's drawn and what's printed consistent.
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
     Completion Duration is *calendar* time between firstOpened and
     completedDate - e.g. "started July 6, finished July 13 -> 7 days" -
     which is a different metric from reading time (timeSpentSeconds) and
     is deliberately never derived from it. Tracked in the same single-pass,
     running-min/max style already used for longestBook/shortestBook above,
     rather than a second filter/reduce pass over loadedBooksMemory.
    */
    let completionDurationSumMs = 0;
    let completionDurationCount = 0;
    let fastestCompletion = null; // {book, durationMs}
    let slowestCompletion = null;
    /*
     Pages/day is a distinct metric from pages/hour: pages/hour is reading
     time (timeSpentSeconds), pages/day is calendar days between firstOpened
     and completedDate - the same qualifying condition as Completion
     Duration above (completed books only, both dates required), just
     expressed as pages-read / calendar-days instead of a duration string.
     Tracked with the same single-pass running-min/max approach.
    */
    let pagesPerDaySum = 0;
    let pagesPerDayCount = 0;
    let fastestPagesPerDay = null; // {book, pagesPerDay}
    let slowestPagesPerDay = null;
    /*
     "Reading Speed Over Lifetime" - per-completed-book pages/hour entries,
     kept as a flat list (rather than folded into a running sum like the
     other stats above) because this one needs to be sorted chronologically
     by completedDate and displayed book-by-book afterward, not just
     reduced to a single number.
    */
    const speedProgressionEntries = []; // {book, completedDate, pagesPerHour}
    /*
     Real per-session durations, pulled straight from each book's
     readingSessions log (see appendReadingSession() in 02-db.js /
     endReadingSession() in this file). This is the actual source of truth
     for "average session length" going forward - totalSessions/sessionTime
     above only exist as a fallback for books that predate this feature
     and have no readingSessions recorded yet (requirement: existing books
     without session history should continue working).
    */
    const allRealSessionDurationsMins = [];

    /*
     Raw per-book metric values, collected during the single pass below and
     turned into table rows only afterward (see the second pass right after
     this loop) - the "delta from average" comparisons need the full-dataset
     averages, which aren't known until every book has been visited, so row
     HTML can't be finalized until this loop is done. Keeping this as a flat
     array of plain values (rather than re-deriving them a second time) means
     the delta pass reuses the exact same numbers already computed here
     instead of duplicating any of the calculations above.
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
         Only books with both fields qualify - a book can be marked read (or
         have a manually-edited completedDate via setBookCompletionDate())
         without firstOpened ever having been set, e.g. a very old record.
         Pages/day is derived from the same completionDurationMs computed
         here rather than re-deriving it, but is additionally gated on
         isRead since - unlike Completion Duration - it's a "completed
         books only" metric (calendar days is floored at 1 so a same-day
         completion can't divide by a near-zero day count).
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
         Reading Speed Over Lifetime: completed books only, needs both a
         completedDate (for chronological sorting) and MEANINGFUL tracked
         reading time - previously gated on the raw "timeSpentSeconds > 0"
         (any nonzero value, however tiny) and divided by the raw,
         unrounded seconds directly. That let a book with e.g. 6 tracked
         seconds produce an absurd pages/hour figure (344 pages / (6/3600)
         hours = 206,400 p/h) in this list even though the main per-book
         table correctly showed "0m" for that same book - see
         getMeaningfulTrackedSeconds() in 14-utils.js, now the single
         shared gate both this and the main table's `mins` above go
         through, so they can never disagree again.
        */
        if (isRead && book.completedDate && totalPages > 0 && meaningfulTrackedSeconds > 0) {
            const trackedReadingHours = meaningfulTrackedSeconds / 3600;
            speedProgressionEntries.push({
                book,
                completedDate: book.completedDate,
                pagesPerHour: totalPages / trackedReadingHours,
                mins: getMeaningfulTrackedMinutes(book.timeSpentSeconds),
                completionDurationMs,
                pagesPerDay,
            });
        }

        // Stash this book's raw metric values instead of building its row
        // string right now - see perBookMetrics comment above.
        perBookMetrics.push({
            book,
            isRead,
            // Same "has the user actually opened/progressed this book" check
            // already used just above for the pagesRead estimate - reused
            // here (rather than re-derived) for the Reading Status
            // distribution's "In Progress" vs "Not Started" split.
            isStarted: book.currentChapter > 0 || book.scrollOffset > 100,
            // Finer-grained status than isRead/isStarted above - adds
            // "Paused" (in progress, but no real reading activity for
            // longer than Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS) on
            // top of the existing Completed/In Progress/Not Started split.
            // See getBookReadingStatus() in 14-utils.js, the single source
            // of truth this and the Completion Timeline's Gantt mode both
            // read from.
            status: getBookReadingStatus(book),
            pagesRead,
            totalPages,
            mins,
            pagesPerHour: mins > 0 ? (pagesRead / mins * 60) : null, // numeric, not the "—"-formatted string used in the old inline template
            completionDurationMs,
            pagesPerDay,
        });
    }

    /*
     Averages used for the per-book "delta from average" comparisons (Time
     Spent, Pages per Hour, Completion Duration, Pages per Day). Deliberately
     computed from perBookMetrics rather than re-walking loadedBooksMemory:
     the qualifying condition for each metric ("has valid data") is exactly
     "this book contributed a non-null value to perBookMetrics", so reusing
     that array keeps the qualifying logic in one place (the main loop above)
     instead of redefining it a second time here. See computeStatAverages().
    */
    const statAverages = computeStatAverages(perBookMetrics);

    // Flush table rows inside dashboard
    tbody.innerHTML = perBookMetrics.map(m => buildStatsRowHtml(m, statAverages)).join("");

    /*
     Library Distribution charts (Book Length, Reading Status, Reading
     Speed) - see computeLibraryDistributions()/renderDistributionBarChart()
     above. Reuses perBookMetrics rather than a fresh pass over
     loadedBooksMemory, same as statAverages just above.
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
     Average reading session length now prefers real recorded sessions
     (actual engaged-reading durations from readingSessions - see
     appendReadingSession()/endReadingSession()) over the old
     totalSessions/timeSpentSeconds approximation. Falls back to that
     approximation only for whatever books haven't accumulated any real
     session records yet, so older libraries keep showing a reasonable
     number instead of suddenly dropping to zero.
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
     Completion Timeline now lives in 14-completion-timeline.js as a
     modular multi-mode system (see buildCompletionTimelineData() there).
     completionsByMonth computed above still feeds the per-book table's
     other stats untouched - only the timeline rendering itself moved out.
     The data object is stashed on window so the mode-switch buttons and
     hover-tooltip handlers (wired via inline onclick/onmouseenter, which
     only get the DOM event) can look it back up without recomputing it.
    */
    window.__completionTimelineData = buildCompletionTimelineData(loadedBooksMemory);
    renderCompletionTimeline(window.__completionTimelineData);
    renderReadingSpeedProgression(speedProgressionEntries, statAverages);

    // See 17-reading-history.js. Guarded the same way the other optional
    // stats-view pieces in this function are, so this keeps working whether
    // or not that script (and its container in index.html) is present.
    if (typeof renderReadingActivityCalendar === "function") {
        renderReadingActivityCalendar();
    }
}

/*
 Handler for the "Backfill Completion Dates" button in the stats view.
 Runs the bulk migration in 02-db.js, refreshes loadedBooksMemory from
 IndexedDB, re-renders the stats view so the timeline and counts reflect
 the newly-filled-in dates, and reports back how many books were touched.
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
 Renders #stats-reading-speed-progression, showing full per-book metrics
 (Time Spent, Pages per Hour, Completion Duration, Pages per Day - the same
 four shown in the "Individual Breakdown Per Book" table, including their
 "delta from average" lines) for every completed book, grouped by the month
 it was completed in and sorted chronologically - so the person can see
 whether their reading pace is trending up or down over time, book to book.
 Deliberately a flat chronological list rather than an average-per-month
 rollup: with typically just a few completions per month, showing each book
 individually is what actually surfaces a trend. Ends with the single
 overall average pages/hour across every entry.

 Reuses buildFourMetricDeltas() - the same helper the per-book table above
 uses - rather than re-implementing the delta/average-comparison logic a
 second time here; entries carry the same mins/completionDurationMs/
 pagesPerDay fields as a perBookMetrics row specifically so this works (see
 where speedProgressionEntries is built in showStatsViewState()).
*/
function renderReadingSpeedProgression(entries, statAverages) {
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
                const deltas = buildFourMetricDeltas(entry, statAverages);
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
     "Average" footer - one line per comparable metric (Time Spent, Pages
     per Hour, Completion Duration, Pages per Day), read straight off the
     shared statAverages object (see computeStatAverages()) rather than
     recomputed here. Looping over FOUR_METRIC_DEFINITIONS instead of
     writing one line per metric by hand means this footer automatically
     picks up any future metric added to that list without needing its own
     edit - it stays a plain "average for whatever's comparable" list.

     Each metric formats its own average with the same format() function
     used to render individual books' values (e.g. formatMinutes for Time
     Spent, formatCompletionDuration for Completion Duration), so the units
     the footer shows are guaranteed to match the units used everywhere
     else in this section. A metric with no qualifying books at all (mean()
     returned null in computeStatAverages) is simply skipped rather than
     shown as "—", since an average of zero books isn't a real average to
     report.
    */
    const averageRows = FOUR_METRIC_DEFINITIONS
        .map((def) => {
            const average = statAverages[def.averageKey];
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
