// =================================================================
// COMPLETION TIMELINE - MODULAR MULTI-MODE VISUALIZATION SYSTEM
// =================================================================
/*
 Everything the "📅 Completion Timeline" stats-view section needs, in
 three deliberately separate layers so a future mode never touches an
 existing one:

   1. DATA LAYER (buildCompletionTimelineData) - one pass over
      loadedBooksMemory producing a normalized dataset every mode reads
      from, so a data fix only has to happen once.
   2. MODE REGISTRY (TIMELINE_MODES) - {id, label, render(container, data)}
      entries. Adding mode 5 is one new array entry; modes 1-4 don't change.
   3. RENDER SHELL (renderCompletionTimeline) - draws the mode switcher and
      dispatches to the active mode's render(). The only function
      09-stats-and-context-menu.js calls into.

 The book-title tooltip (modes 1-2) reuses the positionFlyoutMenu()-based
 pattern from showHistoryDayTooltip() in 13-reading-history.js, against
 its own #completion-timeline-tooltip element so the two never collide.

 Mode 4 (Gantt) has its own nested sub-system on top of the above: three
 scale modes (Infinite/Scroll/Windowed - see the comment above
 ganttScaleMode below) controlling how books are laid out along the time
 axis, plus user-editable "time window" presets for Windowed mode. Both
 the active top-level mode (activeTimelineModeId) and the active Gantt
 scale mode/preset are persisted via getUserConfig()/saveUserConfig() in
 14-utils.js, so the stats view reopens on whatever the person was last
 looking at rather than resetting every reload.
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
     books: [ ...completed books (isRead && completedDate) ... ],
     ganttBooks: [ ...completed/in-progress/paused books, for mode 4 ... ],
   }

 Keyed by "YYYY-MM" strings, matching the format already used elsewhere
 in the stats view (e.g. renderReadingSpeedProgression).

 ganttBooks is separate from books rather than widening it: modes 1-3
 (list/calendar/graph) are strictly "completions per month", while mode 4
 (Gantt) also needs in-progress/paused books to draw their bars.
 Never-started books (READING_STATUS.NOT_STARTED) are excluded from both -
 nothing to draw a bar for.
*/
function buildCompletionTimelineData(books) {
    const completionsByMonth = {};
    const completedBooks = [];
    const ganttBooks = [];
    const now = Date.now();

    for (const book of books) {
        const status = getBookReadingStatus(book, now);

        if (status === READING_STATUS.NOT_STARTED) continue;
        ganttBooks.push(book);

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

    return { monthOrder, completionsByMonth, books: completedBooks, ganttBooks };
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
 Persisted via the EpubReader_UserConfig_v1 localStorage blob (see
 getUserConfig()/saveUserConfig() in 14-utils.js) rather than reset on
 every reload - the person asked for the stats view to reopen on whichever
 mode they were last looking at, same as any other durable view
 preference already stored in that blob.
*/
let activeTimelineModeId = getUserConfig().activeTimelineModeId || "monthList";

const TIMELINE_MODES = [
    { id: "monthList", label: "📋 List", render: renderTimelineModeMonthList },
    { id: "calendar", label: "🗓️ Calendar", render: renderTimelineModeCalendar },
    { id: "graph", label: "📈 Graph", render: renderTimelineModeGraph },
    { id: "gantt", label: "📊 Gantt", render: renderTimelineModeGantt },
];

function setTimelineMode(modeId) {
    if (!TIMELINE_MODES.some((m) => m.id === modeId)) return;
    activeTimelineModeId = modeId;
    saveUserConfig({ activeTimelineModeId: modeId });
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

// -----------------------------------------------------------------
// GANTT SCALE MODES (Infinite / Scroll / Windowed) - state + presets
// -----------------------------------------------------------------
/*
 Three ways of mapping the Gantt's books onto a fixed-width track:
   - "infinite": today's original behavior. globalStart/globalEnd span
     every book ever tracked, entries always fill exactly 100% of the
     container, so the track compresses further every time the person's
     overall reading history widens. No floor on how thin a bar can get
     beyond the existing per-bar 1% width minimum.
   - "scroll": a fixed px-per-day scale instead of a percentage-of-container
     scale, so bar density never changes as history grows - the container
     itself grows wider instead, inside a horizontally-scrolling wrapper
     (mirrors .heatmap-scroll-wrapper's pattern in 13-reading-history.js).
   - "windowed": globalEnd is pinned to right now (not the latest entry)
     and globalStart is pinned to a person-chosen distance before that -
     one of ganttWindowPresets - so the visible span is a constant,
     user-controlled width that always ends at "today" and never
     compresses, at the cost of not showing anything older than the window.
 All three keep reading the same ganttBooks/buildGanttEntryForBook data;
 only computeGanttScale() below and the bar layout math in
 renderTimelineModeGantt() need to know which is active.
*/
let ganttScaleMode = getUserConfig().ganttScaleMode || "infinite";

// Fixed density used by "scroll" mode - wide enough to keep month labels
// (if added later) and pause markers legible without needing to be
// user-configurable; this is a rendering density, not a data limit.
const GANTT_SCROLL_PX_PER_DAY = 6;

/*
 Seed presets shown the first time someone opens Windowed mode with no
 saved presets yet - deliberately small and calendar-shaped (not "30 days"
 style raw counts) since that's how a person actually thinks about "how
 far back do I want to look." All fully user-editable/deletable afterward;
 this array is never re-seeded once ganttWindowPresets exists in saved
 config, even if the person deletes every entry down to zero.
*/
const GANTT_DEFAULT_WINDOW_PRESETS = [
    { id: "preset-1mo", label: "1 month", valueMs: 30 * 24 * 60 * 60 * 1000 },
    { id: "preset-3mo", label: "3 months", valueMs: 91 * 24 * 60 * 60 * 1000 },
    { id: "preset-1yr", label: "1 year", valueMs: 365 * 24 * 60 * 60 * 1000 },
];

function getGanttWindowPresets() {
    const config = getUserConfig();
    return Array.isArray(config.ganttWindowPresets) ? config.ganttWindowPresets : GANTT_DEFAULT_WINDOW_PRESETS;
}

function saveGanttWindowPresets(presets) {
    saveUserConfig({ ganttWindowPresets: presets });
}

function getActiveGanttWindowPresetId() {
    const config = getUserConfig();
    const presets = getGanttWindowPresets();
    // Falls back to the first available preset if nothing's been chosen
    // yet, or if the previously-chosen preset was since deleted.
    if (config.activeGanttWindowPresetId && presets.some((p) => p.id === config.activeGanttWindowPresetId)) {
        return config.activeGanttWindowPresetId;
    }
    return presets.length > 0 ? presets[0].id : null;
}

function setGanttScaleMode(scaleMode) {
    if (!["infinite", "scroll", "windowed"].includes(scaleMode)) return;
    ganttScaleMode = scaleMode;
    saveUserConfig({ ganttScaleMode: scaleMode });
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

function setActiveGanttWindowPreset(presetId) {
    saveUserConfig({ activeGanttWindowPresetId: presetId });
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

/*
 Adds a new user-defined preset (label + magnitude/unit, converted to ms)
 and makes it the active one. valueMs uses real calendar-ish approximations
 (30-day months, 365-day years) rather than exact month-length math (unlike
 addMonthsToKey() above) since a Gantt window is a rough lookback distance,
 not a calendar-anchored range - "3 months" here always means the same
 fixed span regardless of which month it's measured from.
*/
function addGanttWindowPreset(label, amount, unit) {
    const unitMs = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000, years: 365 * 86400000 };
    const valueMs = Math.round(Number(amount)) * (unitMs[unit] || unitMs.days);
    if (!label || !valueMs || valueMs <= 0) return;

    const presets = getGanttWindowPresets().slice();
    const newPreset = { id: `preset-${Date.now()}`, label: label.trim(), valueMs };
    presets.push(newPreset);
    saveGanttWindowPresets(presets);
    saveUserConfig({ activeGanttWindowPresetId: newPreset.id });
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

function editGanttWindowPreset(presetId, label, amount, unit) {
    const unitMs = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000, years: 365 * 86400000 };
    const valueMs = Math.round(Number(amount)) * (unitMs[unit] || unitMs.days);
    if (!label || !valueMs || valueMs <= 0) return;

    const presets = getGanttWindowPresets().map((p) =>
        p.id === presetId ? { ...p, label: label.trim(), valueMs } : p
    );
    saveGanttWindowPresets(presets);
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

function deleteGanttWindowPreset(presetId) {
    const presets = getGanttWindowPresets().filter((p) => p.id !== presetId);
    saveGanttWindowPresets(presets);

    // If the deleted preset was the active one, fall back to whatever's
    // first now (or null if the person deleted every preset).
    const config = getUserConfig();
    if (config.activeGanttWindowPresetId === presetId) {
        saveUserConfig({ activeGanttWindowPresetId: presets.length > 0 ? presets[0].id : null });
    }
    renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory));
}

/*
 Single place that turns (entries, scaleMode, presets) into the
 {globalStart, globalEnd, totalSpanMs, pxPerDay} numbers
 renderTimelineModeGantt() lays bars out against - see the "infinite" /
 "scroll" / "windowed" comment block above for what each mode means.
 pxPerDay is null for "infinite"/"windowed" (both use %-of-container
 layout); only "scroll" uses it.
*/
function computeGanttScale(entries, scaleMode) {
    if (scaleMode === "windowed") {
        const presetId = getActiveGanttWindowPresetId();
        const presets = getGanttWindowPresets();
        const preset = presets.find((p) => p.id === presetId) || presets[0] || GANTT_DEFAULT_WINDOW_PRESETS[0];

        const globalEnd = Date.now();
        const globalStart = globalEnd - preset.valueMs;
        return { globalStart, globalEnd, totalSpanMs: Math.max(1, globalEnd - globalStart), pxPerDay: null };
    }

    const globalStart = Math.min(...entries.map((e) => e.startMs));
    const globalEnd = Math.max(...entries.map((e) => e.endMs));
    // Floor of one day's worth of ms avoids a division by ~0 when every
    // book in the library was completed the same day it was opened.
    const totalSpanMs = Math.max(24 * 60 * 60 * 1000, globalEnd - globalStart);

    if (scaleMode === "scroll") {
        return { globalStart, globalEnd, totalSpanMs, pxPerDay: GANTT_SCROLL_PX_PER_DAY };
    }

    // "infinite" (and any unrecognized value, defensively)
    return { globalStart, globalEnd, totalSpanMs, pxPerDay: null };
}

/*
 The 3 small scale-mode buttons (Infinite/Scroll/Windowed) that appear to
 the right of the main "📊 Gantt" button, only while Gantt is the active
 mode - see .gantt-scale-controls in styles.css for the rise-up+fade-in
 entrance. Windowed additionally reveals the preset chip row underneath.
*/
function buildGanttScaleControlsHtml() {
    const scaleButtons = [
        { id: "infinite", label: "Infinite" },
        { id: "scroll", label: "Scroll" },
        { id: "windowed", label: "Windowed" },
    ].map((s) => `
        <button class="gantt-scale-btn ${s.id === ganttScaleMode ? "active" : ""}"
                onclick="setGanttScaleMode('${s.id}')">${s.label}</button>
    `).join("");

    return `
        <div class="gantt-scale-controls">
            ${scaleButtons}
            ${ganttScaleMode === "windowed" ? buildGanttWindowPresetChipsHtml() : ""}
        </div>
    `;
}

/*
 One chip per saved preset plus a trailing "+" chip to create a new one.
 Edit/delete affordances are hover-revealed (see .gantt-preset-chip-actions
 in styles.css) rather than always-visible, so the row reads as plain
 selectable chips at a glance and only shows management controls on
 intent - same reveal-on-hover approach already used for
 .gantt-bar-too-narrow's inline label toggling.
*/
function buildGanttWindowPresetChipsHtml() {
    const presets = getGanttWindowPresets();
    const activeId = getActiveGanttWindowPresetId();

    const chips = presets.map((p) => `
        <div class="gantt-preset-chip ${p.id === activeId ? "active" : ""}">
            <span class="gantt-preset-chip-label" onclick="setActiveGanttWindowPreset('${p.id}')">${escapeHtml(p.label)}</span>
            <span class="gantt-preset-chip-actions">
                <span class="gantt-preset-chip-action" title="Edit" onclick="showGanttPresetForm('${p.id}')">✏️</span>
                <span class="gantt-preset-chip-action" title="Delete" onclick="deleteGanttWindowPreset('${p.id}')">🗑️</span>
            </span>
        </div>
    `).join("");

    return `
        <div class="gantt-preset-row" id="gantt-preset-row">
            ${chips}
            <button class="gantt-preset-add-btn" title="Add a new time limit" onclick="showGanttPresetForm(null)">+</button>
        </div>
    `;
}

/*
 Swaps the preset row into an inline create/edit form in place - no modal,
 matching the "no popup" preference already given for the scale controls
 above. presetId is null when creating a new preset, or an existing
 preset's id when editing one; either way the row re-renders back to
 normal chips on save/cancel via renderCompletionTimeline().
*/
function showGanttPresetForm(presetId) {
    const row = document.getElementById("gantt-preset-row");
    if (!row) return;

    const editing = presetId ? getGanttWindowPresets().find((p) => p.id === presetId) : null;
    // Editing an existing preset pre-fills with its current value converted
    // back to the largest clean unit, so "3 months" reopens as (3, months)
    // rather than always dumping raw days into the form.
    let amount = 1, unit = "months";
    if (editing) {
        const unitMsList = [["years", 365 * 86400000], ["months", 30 * 86400000], ["weeks", 7 * 86400000], ["days", 86400000]];
        for (const [u, ms] of unitMsList) {
            if (editing.valueMs % ms === 0) { unit = u; amount = editing.valueMs / ms; break; }
        }
    }

    row.innerHTML = `
        <div class="gantt-preset-form">
            <input type="text" id="gantt-preset-form-label" class="gantt-preset-form-input gantt-preset-form-label-input"
                   placeholder="Label (e.g. 6 months)" value="${editing ? escapeHtml(editing.label) : ""}" />
            <input type="number" id="gantt-preset-form-amount" class="gantt-preset-form-input gantt-preset-form-amount-input"
                   min="1" step="1" value="${amount}" />
            <select id="gantt-preset-form-unit" class="gantt-preset-form-input">
                <option value="days" ${unit === "days" ? "selected" : ""}>days</option>
                <option value="weeks" ${unit === "weeks" ? "selected" : ""}>weeks</option>
                <option value="months" ${unit === "months" ? "selected" : ""}>months</option>
                <option value="years" ${unit === "years" ? "selected" : ""}>years</option>
            </select>
            <button class="gantt-preset-form-save" onclick="submitGanttPresetForm(${editing ? `'${presetId}'` : "null"})">✓</button>
            <button class="gantt-preset-form-cancel" onclick="renderCompletionTimeline(buildCompletionTimelineData(loadedBooksMemory))">✕</button>
        </div>
    `;
}

function submitGanttPresetForm(presetId) {
    const label = document.getElementById("gantt-preset-form-label").value;
    const amount = document.getElementById("gantt-preset-form-amount").value;
    const unit = document.getElementById("gantt-preset-form-unit").value;

    if (presetId) {
        editGanttWindowPreset(presetId, label, amount, unit);
    } else {
        addGanttWindowPreset(label, amount, unit);
    }
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
                ${m.id === "gantt" && activeTimelineModeId === "gantt" ? buildGanttScaleControlsHtml() : ""}
            `).join("")}
        </div>
        <div id="timeline-mode-body"></div>
    `;
    container.innerHTML = switcherHtml;

    const body = document.getElementById("timeline-mode-body");
    const activeMode = TIMELINE_MODES.find((m) => m.id === activeTimelineModeId) || TIMELINE_MODES[0];

    /*
     Modes 1-3 (list/calendar/graph) are built entirely from completions,
     so they stay gated on monthOrder being empty exactly as before. Mode 4
     (Gantt) now also covers in-progress and paused books - see ganttBooks
     in buildCompletionTimelineData() - so it has its own, wider condition
     for "is there anything at all to show" instead of being gated on
     completions existing.
    */
    const isEmpty = activeMode.id === "gantt"
        ? data.ganttBooks.length === 0
        : data.monthOrder.length === 0;

    if (isEmpty) {
        const message = activeMode.id === "gantt"
            ? "No books started yet."
            : "No completed books yet.";
        body.innerHTML = `<div class="empty-state-message-spaced">${message}</div>`;
        return;
    }

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
 One horizontal bar per book that's been started (completed, in progress,
 or paused - see getBookReadingStatus() in 10-utils.js; never-started books
 have no reading period and are excluded). The bar's start is the earliest
 real reading activity found for the book; its end is completedDate for a
 completed book, or the most recent real activity for an in-progress/paused
 book (never "now" - a paused book's bar stops exactly where its reading
 did, since the whole point of Paused is that nothing has happened since).

 Books with no firstOpened and no session/history data at all can't reach
 this function (getBookReadingStatus() would have called them notStarted),
 so every entry here has a real start point.

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
    let entries = data.ganttBooks
        .map((book) => buildGanttEntryForBook(book))
        .filter(Boolean)
        .sort((a, b) => a.startMs - b.startMs);

    if (entries.length === 0) {
        container.innerHTML = `<div class="empty-state-message">No books started yet.</div>`;
        return;
    }

    const scale = computeGanttScale(entries, ganttScaleMode);
    const { globalStart, globalEnd, totalSpanMs, pxPerDay } = scale;

    if (ganttScaleMode === "windowed") {
        // Drop anything that ends before the window starts (nothing of it
        // would be visible), then clamp each surviving entry's start/end
        // into the window so a bar that began before globalStart renders
        // as starting exactly at the left edge instead of implying a
        // negative-position (or simply wrong) start date.
        entries = entries
            .filter((e) => e.endMs >= globalStart)
            .map((e) => ({
                ...e,
                clampedStartMs: Math.max(e.startMs, globalStart),
                clampedEndMs: Math.min(e.endMs, globalEnd),
            }));

        if (entries.length === 0) {
            container.innerHTML = `<div class="empty-state-message-spaced">No reading activity in this time window.</div>`;
            return;
        }
    } else {
        entries = entries.map((e) => ({ ...e, clampedStartMs: e.startMs, clampedEndMs: e.endMs }));
    }

    // px-based layout (scroll mode) needs the container to actually be
    // wide enough to hold pxPerDay * totalDays; %-based layout (infinite/
    // windowed) always fills exactly 100% of whatever width it's given.
    const totalDays = pxPerDay ? Math.ceil(totalSpanMs / (24 * 60 * 60 * 1000)) : null;
    const trackWidthPx = pxPerDay ? totalDays * pxPerDay : null;

    const rows = entries.map((entry, i) => {
        const startForLayout = entry.clampedStartMs;
        const endForLayout = entry.clampedEndMs;

        let leftStyle, widthStyle;
        if (pxPerDay) {
            const leftPx = ((startForLayout - globalStart) / (24 * 60 * 60 * 1000)) * pxPerDay;
            const widthPx = Math.max(4, ((endForLayout - startForLayout) / (24 * 60 * 60 * 1000)) * pxPerDay);
            leftStyle = `${leftPx.toFixed(1)}px`;
            widthStyle = `${widthPx.toFixed(1)}px`;
        } else {
            const leftPct = ((startForLayout - globalStart) / totalSpanMs) * 100;
            // Minimum width floor so a same-day (or very short) completion is still a visible,
            // clickable/hoverable sliver rather than a zero-width bar that's impossible to hover.
            const widthPct = Math.max(1, ((endForLayout - startForLayout) / totalSpanMs) * 100);
            leftStyle = `${leftPct.toFixed(2)}%`;
            widthStyle = `${widthPct.toFixed(2)}%`;
        }

        const groupTint = resolveGroupTintForBook(entry.book);
        const barColor = groupTint || "var(--accent)";

        const activitySegments = buildGanttActivityGradient(entry);
        // Below this width, a title label would just overflow/get clipped
        // to nothing useful - see .gantt-bar-too-narrow in styles.css.
        // Percent-based estimate still applies even in px mode (pxPerDay is
        // fixed, so a bar's px width maps back to roughly the same
        // proportion of a typical row either way).
        const approxWidthPct = pxPerDay
            ? (parseFloat(widthStyle) / (trackWidthPx || 1)) * 100
            : parseFloat(widthStyle);
        const tooNarrowForLabel = approxWidthPct < 6 && !pxPerDay;

        const statusClass = `gantt-bar-status-${entry.status}`;
        const portalMarkers = buildGanttPauseMarkers(entry);

        return `
            <div class="gantt-row">
                <div class="gantt-row-label" title="${escapeHtml(entry.book.title)}">${escapeHtml(entry.book.title)}</div>
                <div class="gantt-row-track" ${pxPerDay ? `style="width:${trackWidthPx}px;"` : ""}>
                    <div class="gantt-bar ${statusClass} ${tooNarrowForLabel ? "gantt-bar-too-narrow" : ""}"
                         style="left:${leftStyle}; width:${widthStyle}; background:${barColor}; ${activitySegments}"
                         onmouseenter="showGanttBarTooltip(event, ${i})"
                         onmouseleave="hideCompletionMonthTooltip()">
                        <span class="gantt-bar-inline-label">${escapeHtml(entry.book.title)}</span>
                        ${portalMarkers}
                    </div>
                </div>
            </div>
        `;
    }).join("");

    window.__timelineGanttEntries = entries;

    const innerHtml = `<div class="gantt-container">${rows}</div>`;
    // Only "scroll" mode needs the horizontal-overflow wrapper - infinite
    // and windowed both always fill a fixed 100%-wide track and have
    // nothing to scroll to.
    container.innerHTML = pxPerDay
        ? `<div class="gantt-scroll-wrapper">${innerHtml}</div>`
        : innerHtml;
}

/*
 Builds one Gantt entry for a book, or null if it has no real start point
 (shouldn't normally happen - defensive fallback for malformed data).

   - startMs: earliest real activity (readingSessions/readingHistory),
     falling back to firstOpened for older pre-session records.
   - endMs: completedDate if completed; otherwise the most recent real
     activity - deliberately not "now", so an in-progress bar ends at its
     actual last page turned, not stretching to today on every view.
   - pauseGaps: gaps >= Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS
     between activity intervals (see buildGanttPauseMarkers() below, which
     turns these into the "|...|" portal markers). An array since a book
     can have more than one pause, though most have zero or one.
*/
function buildGanttEntryForBook(book) {
    const status = getBookReadingStatus(book);
    const intervals = collectGanttActivityIntervals(book);

    let startMs;
    if (intervals.length > 0) {
        startMs = intervals[0].start;
    } else if (book.firstOpened) {
        startMs = book.firstOpened;
    } else {
        return null; // No usable anchor point at all - nothing to draw.
    }

    let endMs;
    let hasRealEnd = true;
    if (status === READING_STATUS.COMPLETED && book.completedDate) {
        endMs = book.completedDate;
    } else {
        const lastActivity = intervals.length > 0
            ? intervals[intervals.length - 1].end
            : null;
        if (lastActivity !== null) {
            endMs = lastActivity;
        } else if (book.lastOpened) {
            endMs = book.lastOpened;
        } else {
            // Truly nothing to anchor an end to - render as a single-day
            // sliver rather than an end point we don't actually have.
            endMs = startMs;
            hasRealEnd = false;
        }
    }

    // Guard against a corrupted/edited completedDate landing before the
    // book's own recorded start - render as a same-day sliver rather than a
    // negative-width bar.
    if (endMs < startMs) endMs = startMs;

    const pauseGaps = findGantPauseGaps(intervals);

    return { book, status, startMs, endMs, hasRealStart: true, hasRealEnd, pauseGaps };
}

/*
 Merges each book's readingSessions ({start, end}) and readingHistory
 ({startTimestamp, endTimestamp}) entries into one sorted, non-overlapping
 list of {start, end} activity intervals. Both arrays can independently
 record roughly the same time range (a session and its matching history
 segment are opened/closed together - see continueOrStartReadingSession()/
 endReadingSession() in 09-stats-and-context-menu.js), so overlapping or
 touching intervals are merged into one rather than counted as two separate
 bursts of activity with a fake "gap" of zero between them.
*/
function collectGanttActivityIntervals(book) {
    const raw = [];

    if (Array.isArray(book.readingSessions)) {
        for (const s of book.readingSessions) {
            if (typeof s.start === "number" && typeof s.end === "number" && s.end >= s.start) {
                raw.push({ start: s.start, end: s.end });
            }
        }
    }
    if (Array.isArray(book.readingHistory)) {
        for (const h of book.readingHistory) {
            if (typeof h.startTimestamp === "number" && typeof h.endTimestamp === "number" && h.endTimestamp >= h.startTimestamp) {
                raw.push({ start: h.startTimestamp, end: h.endTimestamp });
            }
        }
    }

    if (raw.length === 0) return [];

    raw.sort((a, b) => a.start - b.start);

    const merged = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
        const current = raw[i];
        const last = merged[merged.length - 1];
        if (current.start <= last.end) {
            // Overlaps or touches the previous interval - extend it instead
            // of starting a new one.
            last.end = Math.max(last.end, current.end);
        } else {
            merged.push({ ...current });
        }
    }

    return merged;
}

/*
 Finds every gap between consecutive merged activity intervals that's long
 enough to count as a real pause (same threshold used by
 getBookReadingStatus() in 10-utils.js, so a book showing as "Paused"
 always has at least one gap marker on its own bar, and the two systems
 can never disagree about what counts as a pause). Returns an array
 (rather than at most one gap) so a book that's been picked up and set
 down several times shows every pause, not just the most recent one -
 today that's most often zero or one entries, but nothing here assumes
 that's a limit.
*/
function findGantPauseGaps(intervals) {
    const gaps = [];
    for (let i = 1; i < intervals.length; i++) {
        const gapStart = intervals[i - 1].end;
        const gapEnd = intervals[i].start;
        const gapMs = gapEnd - gapStart;
        if (gapMs >= Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS) {
            gaps.push({ start: gapStart, end: gapEnd });
        }
    }
    return gaps;
}

/*
 Renders one pair of "|" portal markers per pause gap in entry.pauseGaps,
 positioned at the gap's start and end as a percentage of this bar's own
 *visible* width. Uses clampedStartMs/clampedEndMs (falling back to
 startMs/endMs when a caller hasn't set clamped* fields at all) rather than
 the book's full unclipped span, since in "windowed" mode the drawn bar
 only covers the clipped portion - anchoring against the full span there
 would push markers outside the bar or bunch them incorrectly. In
 "infinite"/"scroll" mode clamped == unclipped, so this is a no-op change
 for those two.
*/
function buildGanttPauseMarkers(entry) {
    if (!entry.pauseGaps || entry.pauseGaps.length === 0) return "";

    const barStartMs = typeof entry.clampedStartMs === "number" ? entry.clampedStartMs : entry.startMs;
    const barEndMs = typeof entry.clampedEndMs === "number" ? entry.clampedEndMs : entry.endMs;
    const barSpanMs = Math.max(1, barEndMs - barStartMs);

    return entry.pauseGaps
        // Skip gaps entirely outside the visible bar - nothing to mark.
        .filter((gap) => gap.end >= barStartMs && gap.start <= barEndMs)
        .map((gap) => {
            const startPct = Math.max(0, Math.min(100, ((gap.start - barStartMs) / barSpanMs) * 100));
            const endPct = Math.max(0, Math.min(100, ((gap.end - barStartMs) / barSpanMs) * 100));
            return `
                <span class="gantt-pause-portal-marker" style="left:${startPct.toFixed(2)}%;"></span>
                <span class="gantt-pause-portal-marker" style="left:${endPct.toFixed(2)}%;"></span>
            `;
        }).join("");
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

    // Same clamped-vs-unclipped reasoning as buildGanttPauseMarkers() above:
    // the gradient's day-by-day stops need to be positioned against the
    // bar's actual visible span, not the book's full reading span, or a
    // windowed/clipped bar's gradient would be built for a wider range than
    // what's actually drawn on screen.
    const barStartMs = typeof entry.clampedStartMs === "number" ? entry.clampedStartMs : entry.startMs;
    const barEndMs = typeof entry.clampedEndMs === "number" ? entry.clampedEndMs : entry.endMs;

    const spanMs = Math.max(1, barEndMs - barStartMs);
    const daySeconds = {};
    for (const histEntry of entry.book.readingHistory) {
        if (!histEntry || typeof histEntry.startTimestamp !== "number") continue;
        if (histEntry.startTimestamp < barStartMs || histEntry.startTimestamp > barEndMs) continue;
        const dayKey = formatLocalDateKey(new Date(histEntry.startTimestamp));
        daySeconds[dayKey] = (daySeconds[dayKey] || 0) + (histEntry.secondsSpent || 0);
    }

    const secondsValues = Object.values(daySeconds);
    if (secondsValues.length === 0) return "";
    const maxSeconds = Math.max(...secondsValues);

    const stops = [];

    const startDate = new Date(barStartMs);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(barEndMs);
    endDate.setHours(0, 0, 0, 0);

    for (
        let date = new Date(startDate);
        date <= endDate;
        date.setDate(date.getDate() + 1)
    ) {
        const dayKey = formatLocalDateKey(date);
        const dayMs = date.getTime();
        const posPct = Math.max(0,Math.min(100, ((dayMs - barStartMs) / spanMs) * 100));
        const seconds = daySeconds[dayKey] || 0;
        const opacity = seconds > 0 ? 0.35 + 0.65 * (seconds / maxSeconds): 0.05; // No reading = minimum opacity
        stops.push(`rgba(255,255,255,${opacity.toFixed(2)}) ${posPct.toFixed(1)}%`);
    }

    return `background-image:linear-gradient(to right, ${stops.join(", ")});`;
}

function showGanttBarTooltip(event, index) {
    const tooltip = document.getElementById("completion-timeline-tooltip");
    const entries = window.__timelineGanttEntries;
    if (!tooltip || !entries || !entries[index]) return;

    const entry = entries[index];
    const startLabel = entry.hasRealStart ? formatDateOnly(entry.startMs): "Unknown";

    // "Completed:" only makes sense for a finished book - an in-progress or
    // paused book's endMs is its last recorded activity, not a finish date.
    const endRowLabel = entry.status === READING_STATUS.COMPLETED ? "Completed" : "Last activity";
    const endLabel = entry.hasRealEnd ? formatDateOnly(entry.endMs) : "Unknown";
    const spanLabel = entry.hasRealStart && entry.hasRealEnd
        ? formatCompletionDuration(entry.endMs - entry.startMs)
        : "—";

    const pauseRows = entry.pauseGaps.map((gap) => `
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">
            ⏸️ Paused ${formatDateOnly(gap.start)} → ${formatDateOnly(gap.end)}
        </div>
    `).join("");

    // In windowed mode the visible bar is clipped to the window, but the
    // tooltip always reports the book's real, unclipped start/end - flagged
    // here so it's clear the bar on screen isn't necessarily the book's
    // full reading span.
    const isClipped = typeof entry.clampedStartMs === "number"
        && (entry.clampedStartMs > entry.startMs || entry.clampedEndMs < entry.endMs);
    const clippedNotice = isClipped
        ? `<div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">✂️ Bar clipped to the current time window</div>`
        : "";

    tooltip.innerHTML = `
        <div class="calendar-day-tooltip-heading">${escapeHtml(entry.book.title)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">${escapeHtml(READING_STATUS_LABELS[entry.status])}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">Started: ${escapeHtml(startLabel)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">${endRowLabel}: ${escapeHtml(endLabel)}</div>
        <div class="calendar-day-tooltip-row calendar-day-tooltip-book-meta">Span: ${escapeHtml(spanLabel)}</div>
        ${clippedNotice}
        ${pauseRows}
    `;
    positionFlyoutMenu(tooltip, event);
}