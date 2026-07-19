// =================================================================
// COMPLETION TIMELINE - MODULAR MULTI-MODE VISUALIZATION SYSTEM
// =================================================================
/*
 Everything the "📅 Completion Timeline" section in the stats view needs
 lives in this file. It replaces the single-purpose renderCompletionTimeline()
 that used to live in 09-stats-and-context-menu.js with three layers that
 stay deliberately separate, so a future mode never has to touch an
 existing one:

   1. DATA LAYER (buildCompletionTimelineData) - one pass over
      loadedBooksMemory that produces a normalized dataset every mode reads
      from. No mode re-derives its own copy of "which books completed in
      which month" - they all read the same buildCompletionTimelineData()
      output, so a data fix (e.g. a new qualifying condition) only has to
      happen once.

   2. MODE REGISTRY (TIMELINE_MODES) - a plain array of
      {id, label, render(container, data)} entries. Adding mode 5 later is
      exactly one new entry pushed onto this array; nothing about modes 1-4
      changes.

   3. RENDER SHELL (renderCompletionTimeline) - draws the mode switcher
      buttons and hands off to whichever mode's render() is currently
      selected. This is the only function 09-stats-and-context-menu.js
      calls into, same as before.

 The book-title tooltip (shared by modes 1 and 2) reuses the exact same
 positionFlyoutMenu()-based popup pattern already established by
 showHistoryDayTooltip() in 13-reading-history.js, just against a second
 dedicated tooltip element (#completion-timeline-tooltip) so the two
 tooltips never fight over the same DOM node if both happened to be
 triggered in quick succession.
*/

// -----------------------------------------------------------------
// 1. DATA LAYER
// -----------------------------------------------------------------
/*
 Single source of truth for every timeline mode. Shape:
   {
     monthOrder: ["2026-01", "2026-02", ...],     // sorted ascending, one entry per month with >=1 completion
     completionsByMonth: {
       "2026-01": { count: 2, books: [{id,title}, ...] }
     },
     books: [ ...raw book records that qualify as "completed" (isRead && completedDate) ... ],
   }

 Deliberately keyed by "YYYY-MM" strings (matching the format already used
 elsewhere in the stats view, e.g. renderReadingSpeedProgression) so any
 future cross-referencing between sections stays trivial.
*/
function buildCompletionTimelineData(books) {
    const completionsByMonth = {};
    const completedBooks = [];

    for (const book of books) {
        if (!book.isRead || !book.completedDate) continue;
        completedBooks.push(book);

        const d = new Date(book.completedDate);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!completionsByMonth[monthKey]) {
            completionsByMonth[monthKey] = { count: 0, books: [] };
        }
        completionsByMonth[monthKey].count += 1;
        completionsByMonth[monthKey].books.push({ id: book.id, title: book.title });
    }

    const monthOrder = Object.keys(completionsByMonth).sort();

    return { monthOrder, completionsByMonth, books: completedBooks };
}

/*
 Shared month-label formatter, matching the "Month Year" long-form label
 already used across the stats view (renderCompletionTimeline's original
 label format, renderReadingSpeedProgression's month headers).
*/
function formatTimelineMonthLabel(monthKey, options = { month: "long", year: "numeric" }) {
    const [year, month] = monthKey.split("-");
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, options);
}

// Adds `count` months to a "YYYY-MM" key, returning a new "YYYY-MM" key.
function addMonthsToKey(monthKey, count) {
    const [year, month] = monthKey.split("-").map(Number);
    const d = new Date(year, month - 1 + count, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Builds every "YYYY-MM" key from `startKey` to `endKey` inclusive, in order.
function enumerateMonthRange(startKey, endKey) {
    const out = [];
    let cursor = startKey;
    // Safety cap so a corrupted date pair can never spin this into an
    // effectively-infinite loop - 1200 months is 100 years, comfortably
    // beyond any real reading history.
    let guard = 0;
    while (cursor <= endKey && guard < 1200) {
        out.push(cursor);
        cursor = addMonthsToKey(cursor, 1);
        guard++;
    }
    return out;
}

// -----------------------------------------------------------------
// 2. MODE REGISTRY
// -----------------------------------------------------------------
/*
 Persisted only in-memory (not IndexedDB/localStorage) - the person's
 chosen visualization mode is a view preference, not reading data, and
 resetting to the default on reload/reopen is expected behavior for a
 stats-view display toggle, matching how other stats-view sections (e.g.
 the reading-speed progression) don't persist any view state either.
*/
let activeTimelineModeId = "monthList";

const TIMELINE_MODES = [
    { id: "monthList", label: "📋 List", render: renderTimelineModeMonthList },
    { id: "calendar", label: "🗓️ Calendar", render: renderTimelineModeCalendar },
    { id: "graph", label: "📈 Graph", render: renderTimelineModeGraph },
    { id: "gantt", label: "📊 Gantt", render: renderTimelineModeGantt },
];

function setTimelineMode(modeId) {
    if (!TIMELINE_MODES.some((m) => m.id === modeId)) return;
    activeTimelineModeId = modeId;
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

// -----------------------------------------------------------------
// 3. RENDER SHELL - mode switcher + dispatch to the active mode
// -----------------------------------------------------------------
/*
 Entry point called from showStatsViewState() in 09-stats-and-context-menu.js,
 same call signature as the old renderCompletionTimeline(completionsByMonth)
 it replaces - except this now takes the full data object so modes beyond
 the month list (which need book-level and date-range data the old plain
 count map didn't carry) have what they need without a second data pass.
*/
function renderCompletionTimeline(data) {
    const container = document.getElementById("stats-completion-timeline");
    if (!container) return;

    const switcherHtml = `
        <div class="timeline-mode-switcher">
            ${TIMELINE_MODES.map((m) => `
                <button
                    class="timeline-mode-btn ${m.id === activeTimelineModeId ? "active" : ""}"
                    onclick="setTimelineMode('${m.id}')">${m.label}</button>
            `).join("")}
        </div>
        <div id="timeline-mode-body"></div>
    `;
    container.innerHTML = switcherHtml;

    const body = document.getElementById("timeline-mode-body");
    if (data.monthOrder.length === 0) {
        body.innerHTML = `<div style="color:var(--text-muted); padding-top:8px;">No completed books yet.</div>`;
        return;
    }

    const activeMode = TIMELINE_MODES.find((m) => m.id === activeTimelineModeId) || TIMELINE_MODES[0];
    activeMode.render(body, data);
}

// -----------------------------------------------------------------
// SHARED TOOLTIP (book titles for a given month) - modes 1 & 2
// -----------------------------------------------------------------
/*
 Mirrors showHistoryDayTooltip()/positionFlyoutMenu() in 13-reading-history.js
 exactly, just keyed by month instead of by day, and rendered against its
 own #completion-timeline-tooltip element. Height-limited with internal
 scroll (see .completion-timeline-tooltip-list in styles.css) so a month
 with a large number of completions never grows the popup itself off
 screen - only the list inside it scrolls.
*/
function showCompletionMonthTooltip(event, monthKey, data) {
    const tooltip = document.getElementById("completion-timeline-tooltip");
    if (!tooltip) return;

    const bucket = data.completionsByMonth[monthKey];
    const bookRows = bucket && bucket.books.length
        ? bucket.books.map((b) => `<div class="calendar-day-tooltip-row calendar-day-tooltip-book-title">${escapeHtml(b.title)}</div>`).join("")
        : `<div class="calendar-day-tooltip-empty">No books completed.</div>`;

    tooltip.innerHTML = `
        <div class="calendar-day-tooltip-heading">${escapeHtml(formatTimelineMonthLabel(monthKey))}</div>
        <div class="calendar-day-tooltip-total">${bucket ? bucket.count : 0} completed</div>
        <div class="completion-timeline-tooltip-list">${bookRows}</div>
    `;

    positionFlyoutMenu(tooltip, event);
}

function hideCompletionMonthTooltip() {
    const tooltip = document.getElementById("completion-timeline-tooltip");
    if (tooltip) tooltip.style.display = "none";
}

// =================================================================
// MODE 1 - MONTH LIST (existing default view, now with tooltips)
// =================================================================
function renderTimelineModeMonthList(container, data) {
    container.innerHTML = data.monthOrder
        .map((monthKey) => {
            const bucket = data.completionsByMonth[monthKey];
            const label = formatTimelineMonthLabel(monthKey);
            return `
                <div class="timeline-month-list-row"
                     onmouseenter="showCompletionMonthTooltip(event, '${monthKey}', window.__completionTimelineData)"
                     onmouseleave="hideCompletionMonthTooltip()">
                    <span>${escapeHtml(label)}</span>
                    <span>${bucket.count} completed</span>
                </div>
            `;
        })
        .join("");
}

// =================================================================
// MODE 2 - CALENDAR TIMELINE (per-year grid of month boxes)
// =================================================================
/*
 One block per year, trimmed to that year's own first->last active month
 (not the global first->last active month), with inactive months in
 between still rendered as empty boxes so gaps within an active year are
 visible. A year with zero completions that falls between two active
 years collapses to a single grayed-out placeholder rather than 12 empty
 boxes, since there's nothing month-level to show for it.
*/
function renderTimelineModeCalendar(container, data) {
    const years = data.monthOrder.map((k) => Number(k.split("-")[0]));
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    const blocks = [];
    for (let year = minYear; year <= maxYear; year++) {
        const monthsInYear = data.monthOrder.filter((k) => Number(k.split("-")[0]) === year);

        if (monthsInYear.length === 0) {
            blocks.push(`<div class="timeline-year-block timeline-year-placeholder">${year}</div>`);
            continue;
        }

        const firstMonth = Number(monthsInYear[0].split("-")[1]);
        const lastMonth = Number(monthsInYear[monthsInYear.length - 1].split("-")[1]);

        const monthBoxes = [];
        for (let month = firstMonth; month <= lastMonth; month++) {
            const monthKey = `${year}-${String(month).padStart(2, "0")}`;
            const bucket = data.completionsByMonth[monthKey];
            const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "short" });

            monthBoxes.push(`
                <div class="timeline-month-box ${bucket ? "timeline-month-box-active" : "timeline-month-box-inactive"}"
                     ${bucket ? `onmouseenter="showCompletionMonthTooltip(event, '${monthKey}', window.__completionTimelineData)" onmouseleave="hideCompletionMonthTooltip()"` : ""}>
                    <div class="timeline-month-box-label">${escapeHtml(monthLabel)}</div>
                    <div class="timeline-month-box-count">${bucket ? bucket.count : "—"}</div>
                </div>
            `);
        }

        blocks.push(`
            <div class="timeline-year-block">
                <div class="timeline-year-heading">${year}</div>
                <div class="timeline-year-months-grid">${monthBoxes.join("")}</div>
            </div>
        `);
    }

    container.innerHTML = `<div class="timeline-calendar-years">${blocks.join("")}</div>`;
}

// =================================================================
// MODE 3 - PROGRESS GRAPH (line chart, monthly or cumulative)
// =================================================================
/*
 metricExtractors keeps the graph's data source pluggable: today only
 "completions" exists, but pages-read/reading-time/words-read can each be
 added later as one more entry here without touching the SVG-drawing code
 below at all - extractSeries() is the only place that needs to know which
 extractor is active.
*/
const timelineGraphMetricExtractors = {
    completions: {
        label: "books completed",
        valueForMonth: (data, monthKey) => (data.completionsByMonth[monthKey] ? data.completionsByMonth[monthKey].count : 0),
    },
};

let timelineGraphShowCumulative = false;
let timelineGraphMetric = "completions";

function toggleTimelineGraphCumulative(checked) {
    timelineGraphShowCumulative = checked;
    renderTimelineModeGraph(document.getElementById("timeline-mode-body"), window.__completionTimelineData);
}

function extractTimelineGraphSeries(data, metricKey) {
    const extractor = timelineGraphMetricExtractors[metricKey];
    const monthOrder = enumerateMonthRange(data.monthOrder[0], data.monthOrder[data.monthOrder.length - 1]);

    let cumulative = 0;
    return monthOrder.map((monthKey) => {
        const monthly = extractor.valueForMonth(data, monthKey);
        cumulative += monthly;
        return { monthKey, monthly, cumulative };
    });
}

function renderTimelineModeGraph(container, data) {
    const series = extractTimelineGraphSeries(data, timelineGraphMetric);
    const extractor = timelineGraphMetricExtractors[timelineGraphMetric];

    const controlsHtml = `
        <div class="timeline-graph-controls">
            <label class="timeline-graph-checkbox-label">
                <input type="checkbox" id="timeline-graph-cumulative-toggle"
                       ${timelineGraphShowCumulative ? "checked" : ""}
                       onchange="toggleTimelineGraphCumulative(this.checked)" />
                Show cumulative
            </label>
        </div>
    `;

    const values = series.map((pt) => (timelineGraphShowCumulative ? pt.cumulative : pt.monthly));
    const maxValue = Math.max(1, ...values); // floor of 1 avoids a degenerate 0-height chart with no data

    // Fixed viewBox coordinate space; actual on-screen size is controlled
    // entirely by CSS (see .timeline-graph-svg), same pattern as every
    // other inline SVG chart already in this codebase would use.
    const viewW = 800;
    const viewH = 300;
    const padL = 40, padR = 20, padT = 20, padB = 40;
    const plotW = viewW - padL - padR;
    const plotH = viewH - padT - padB;

    const stepX = series.length > 1 ? plotW / (series.length - 1) : 0;
    const points = series.map((pt, i) => {
        const value = timelineGraphShowCumulative ? pt.cumulative : pt.monthly;
        const x = padL + stepX * i;
        const y = padT + plotH - (value / maxValue) * plotH;
        return { x, y, pt };
    });

    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    // Only label every Nth month if there are many, so labels don't
    // overlap into an unreadable smear on a long history.
    const labelEvery = Math.max(1, Math.ceil(series.length / 12));

    const axisLabels = points
        .map((p, i) => (i % labelEvery === 0
            ? `<text x="${p.x.toFixed(1)}" y="${viewH - padB + 16}" class="timeline-graph-axis-label" text-anchor="middle">${escapeHtml(formatTimelineMonthLabel(p.pt.monthKey, { month: "short" }))}</text>`
            : ""))
        .join("");

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padT + plotH * (1 - frac);
        const value = Math.round(maxValue * frac);
        return `
            <line x1="${padL}" y1="${y.toFixed(1)}" x2="${viewW - padR}" y2="${y.toFixed(1)}" class="timeline-graph-gridline" />
            <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="timeline-graph-axis-label" text-anchor="end">${value}</text>
        `;
    }).join("");

    const dots = points.map((p, i) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" class="timeline-graph-point"
                onmouseenter="showTimelineGraphPointTooltip(event, ${i})"
                onmouseleave="hideCompletionMonthTooltip()" />
    `).join("");

    // Stashed on window so the tooltip handler (called from an inline
    // onmouseenter, which only receives the event + index) can look the
    // full point list back up without re-running extractTimelineGraphSeries().
    window.__timelineGraphSeries = series;

    container.innerHTML = `
        ${controlsHtml}
        <svg viewBox="0 0 ${viewW} ${viewH}" class="timeline-graph-svg" preserveAspectRatio="xMidYMid meet">
            ${gridLines}
            <path d="${pathD}" class="timeline-graph-line" fill="none" />
            ${dots}
            ${axisLabels}
        </svg>
        <div class="timeline-graph-legend">${escapeHtml(extractor.label)}${timelineGraphShowCumulative ? " (cumulative)" : " per month"}</div>
    `;
}

function showTimelineGraphPointTooltip(event, index) {
    const tooltip = document.getElementById("completion-timeline-tooltip");
    const series = window.__timelineGraphSeries;
    if (!tooltip || !series || !series[index]) return;

    const pt = series[index];
    tooltip.innerHTML = `
        <div class="calendar-day-tooltip-heading">${escapeHtml(formatTimelineMonthLabel(pt.monthKey))}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">${pt.monthly} completed this month</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">${pt.cumulative} completed total</div>
    `;
    positionFlyoutMenu(tooltip, event);
}

// =================================================================
// MODE 4 - READING JOURNEY GANTT TIMELINE
// =================================================================
/*
 One horizontal bar per completed book, start = firstOpened, end =
 completedDate. Books without a firstOpened (very old records that predate
 that field, or a manually-edited completedDate with no recorded open)
 fall back to using completedDate for both ends - rendered as a single-day
 sliver rather than being dropped, since "we don't know how long this
 actually took" is still worth showing as a data point on the timeline.

 Bar color = the book's group tint if it belongs to a group (mirrors
 --group-tint usage on .book-card in styles.css), otherwise --accent.
 Bar opacity is modulated along its own length using that book's
 readingHistory entries (see 13-reading-history.js) as a rough day-by-day
 "how much was read that day" signal, so a bar visually thickens/darkens
 across days with real reading activity and fades across days with none -
 without needing a second data source beyond what's already recorded per
 book.
*/
function renderTimelineModeGantt(container, data) {
    const entries = data.books
        .map((book) => {
            const endMs = book.completedDate;
            const startMs = book.firstOpened && book.firstOpened <= endMs ? book.firstOpened : endMs;
            return { book, startMs, endMs, hasRealStart: !!(book.firstOpened && book.firstOpened <= endMs) };
        })
        .sort((a, b) => a.startMs - b.startMs);

    if (entries.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No completed books yet.</div>`;
        return;
    }

    const globalStart = Math.min(...entries.map((e) => e.startMs));
    const globalEnd = Math.max(...entries.map((e) => e.endMs));
    // Floor of one day's worth of ms avoids a division by ~0 when every
    // book in the library was completed the same day it was opened.
    const totalSpanMs = Math.max(24 * 60 * 60 * 1000, globalEnd - globalStart);

    const rows = entries.map((entry, i) => {
        const leftPct = ((entry.startMs - globalStart) / totalSpanMs) * 100;
        // Minimum width floor so a same-day (or very short) completion is
        // still a visible, clickable/hoverable sliver rather than a
        // zero-width bar that's impossible to hover.
        const widthPct = Math.max(0.6, ((entry.endMs - entry.startMs) / totalSpanMs) * 100);

        const groupTint = resolveGroupTintForBook(entry.book);
        const barColor = groupTint || "var(--accent)";

        const activitySegments = buildGanttActivityGradient(entry);
        // Below this width, a title label would just overflow/get clipped
        // to nothing useful - see .gantt-bar-too-narrow in styles.css.
        const tooNarrowForLabel = widthPct < 6;

        return `
            <div class="gantt-row">
                <div class="gantt-row-label" title="${escapeHtml(entry.book.title)}">${escapeHtml(entry.book.title)}</div>
                <div class="gantt-row-track">
                    <div class="gantt-bar ${tooNarrowForLabel ? "gantt-bar-too-narrow" : ""}"
                         style="left:${leftPct.toFixed(2)}%; width:${widthPct.toFixed(2)}%; background:${barColor}; ${activitySegments}"
                         onmouseenter="showGanttBarTooltip(event, ${i})"
                         onmouseleave="hideCompletionMonthTooltip()">
                        <span class="gantt-bar-inline-label">${escapeHtml(entry.book.title)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    window.__timelineGanttEntries = entries;

    container.innerHTML = `<div class="gantt-container">${rows}</div>`;
}

/*
 Reads the book's group color if it has one, using loadedGroupsMemory to
 resolve groupId -> group record. Field name defensively checked as either
 backgroundColor (matching the activeGroupFilterColor state-var comment in
 01-state.js: "The backgroundColor of whichever group...") or color, so
 this keeps working regardless of which one the group-management module
 actually uses.
*/
function resolveGroupTintForBook(book) {
    if (book.groupId === null || book.groupId === undefined) return null;
    const group = loadedGroupsMemory.find((g) => g.id === book.groupId);
    if (!group) return null;
    return group.backgroundColor || group.color || null;
}

/*
 Builds a CSS background-image (multi-stop linear-gradient) overlay driven
 by the book's readingHistory entries, so the bar's opacity visually rises
 on days with recorded reading activity and falls on quiet days in
 between. Expressed as an inline `background-image` (layered via CSS
 multiple-backgrounds on top of the solid tint color already set via
 `background`) rather than replacing background entirely, so the group
 tint always still shows through.
*/
function buildGanttActivityGradient(entry) {
    if (!Array.isArray(entry.book.readingHistory) || entry.book.readingHistory.length === 0) {
        return "";
    }

    const spanMs = Math.max(1, entry.endMs - entry.startMs);
    const daySeconds = {};
    for (const histEntry of entry.book.readingHistory) {
        if (!histEntry || typeof histEntry.startTimestamp !== "number") continue;
        if (histEntry.startTimestamp < entry.startMs || histEntry.startTimestamp > entry.endMs) continue;
        const dayKey = formatLocalDateKey(new Date(histEntry.startTimestamp));
        daySeconds[dayKey] = (daySeconds[dayKey] || 0) + (histEntry.secondsSpent || 0);
    }

    const secondsValues = Object.values(daySeconds);
    if (secondsValues.length === 0) return "";
    const maxSeconds = Math.max(...secondsValues);

    const stops = Object.keys(daySeconds).sort().map((dayKey) => {
        // Rebuilt from y/m/d parts (rather than `new Date(dayKey)`, which
        // parses "YYYY-MM-DD" as UTC midnight in most browsers) so this
        // stays in the same local-time frame formatLocalDateKey() used to
        // produce the key in the first place - avoids an off-by-one-day
        // shift for timezones behind UTC.
        const [y, m, d] = dayKey.split("-").map(Number);
        const dayMs = new Date(y, m - 1, d).getTime();
        const posPct = Math.max(0, Math.min(100, ((dayMs - entry.startMs) / spanMs) * 100));
        // Opacity floor of 0.35 keeps even the lightest reading day visibly
        // part of the bar, rather than fading all the way to invisible.
        const opacity = 0.35 + 0.65 * (daySeconds[dayKey] / maxSeconds);
        return `rgba(255,255,255,${opacity.toFixed(2)}) ${posPct.toFixed(1)}%`;
    });

    // mix-blend-mode:overlay (see .gantt-bar in styles.css) lets this
    // lightness gradient modulate the solid tint underneath rather than
    // painting flat white over it.
    return `background-image:linear-gradient(to right, ${stops.join(", ")});`;
}

function showGanttBarTooltip(event, index) {
    const tooltip = document.getElementById("completion-timeline-tooltip");
    const entries = window.__timelineGanttEntries;
    if (!tooltip || !entries || !entries[index]) return;

    const entry = entries[index];
    const startLabel = entry.hasRealStart ? new Date(entry.startMs).toLocaleDateString() : "Unknown";
    const endLabel = new Date(entry.endMs).toLocaleDateString();
    const durationLabel = entry.hasRealStart ? formatCompletionDuration(entry.endMs - entry.startMs) : "—";

    tooltip.innerHTML = `
        <div class="calendar-day-tooltip-heading">${escapeHtml(entry.book.title)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">Started: ${escapeHtml(startLabel)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">Completed: ${escapeHtml(endLabel)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">Duration: ${escapeHtml(durationLabel)}</div>
    `;
    positionFlyoutMenu(tooltip, event);
}