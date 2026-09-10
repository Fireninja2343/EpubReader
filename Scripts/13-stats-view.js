// =================================================================
// PER-BOOK "DELTA FROM AVERAGE" COMPARISONS
// =================================================================
/**
 Computes the mean and "≈ average" cutoff for each of the four comparable metrics.
 @param {Array<Object>} groupMetrics - perBookMetrics-shaped entries to average.
 @returns {Object} Means plus per-metric cutoffs; null for metrics with no valid entries.
*/
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
        cutoffs: {
            timeSpentMins: computeApproxAverageCutoffPercent(timeSpentValues),
            pagesPerHour: computeApproxAverageCutoffPercent(pagesPerHourValues),
            completionDurationMs: computeApproxAverageCutoffPercent(completionDurationValues),
            pagesPerDay: computeApproxAverageCutoffPercent(pagesPerDayValues),
        },
    };
}
const DELTA_COMPARISON_STATUSES = [
    Config.Miscellaneous.READING_STATUS.COMPLETED,
    Config.Miscellaneous.READING_STATUS.IN_PROGRESS,
    Config.Miscellaneous.READING_STATUS.PAUSED,
];
const STATS_MODE = Config.Miscellaneous.STATS_MODE;

const ALL_STATUSES_AVERAGE_KEY = "all";
function computeStatAveragesByStatus(perBookMetrics) {
    const result = {};
    for (const status of DELTA_COMPARISON_STATUSES) {
        const groupMetrics = perBookMetrics.filter(m => m.status === status);
        result[status] = computeStatAveragesForGroup(groupMetrics);
    }
    const allComparableMetrics = perBookMetrics.filter(m => DELTA_COMPARISON_STATUSES.includes(m.status));
    result[ALL_STATUSES_AVERAGE_KEY] = computeStatAveragesForGroup(allComparableMetrics);
    return result;
}

const APPROX_AVERAGE_CUTOFF_MIN_PERCENT = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_MIN_PERCENT;
const APPROX_AVERAGE_CUTOFF_MAX_PERCENT = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_MAX_PERCENT;
const APPROX_AVERAGE_CUTOFF_SCALE = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_SCALE;

function computeApproxAverageCutoffPercent(values) {
    if (values.length < 2) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (!mean) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / Math.abs(mean);
    const cvPerSample = coefficientOfVariation / values.length;
    const cutoff = cvPerSample * 100 * APPROX_AVERAGE_CUTOFF_SCALE;
    return Math.max(APPROX_AVERAGE_CUTOFF_MIN_PERCENT, Math.min(APPROX_AVERAGE_CUTOFF_MAX_PERCENT, cutoff));
}

function buildStatDeltaHtml(value, average, formatFn, higherLabel, lowerLabel, higherIsBetter, approxCutoffPercent) {
    if (value === null || value === undefined || average === null || average === undefined || average === 0) {
        return "";
    }
    const absoluteDiff = value - average;
    const percentDiff = (absoluteDiff / average) * 100;
    const absPercent = Math.abs(percentDiff);
    const cutoff = typeof approxCutoffPercent === "number" ? approxCutoffPercent : 5;
    if (absPercent < cutoff) {
        return `<div class="stat-delta-row stat-delta-neutral">≈ average</div>`;
    }
    const isAboveAverage = absoluteDiff > 0;
    const isGood = isAboveAverage === higherIsBetter;
    const arrow = isAboveAverage ? "↑" : "↓";
    const directionLabel = isAboveAverage ? higherLabel : lowerLabel;
    const formattedAbsDiff = formatFn(Math.round(Math.abs(absoluteDiff) * 10) / 10);
    const sign = isAboveAverage ? "+" : "-";
    const alpha = Math.min(0.95, 0.35 + (absPercent / 100) * 0.6);
    const colorVar = isGood ? "--stat-good-rgb" : "--stat-bad-rgb";
    const color = `rgba(var(${colorVar}), ${alpha.toFixed(2)})`;
    const VERY_HIGH_THRESHOLD_PERCENT = Config.Miscellaneous.VERY_HIGH_THRESHOLD_PERCENT;
    const emphasisClass = absPercent >= VERY_HIGH_THRESHOLD_PERCENT ? "stat-delta-emphasis" : "";
    return `
        <div class="stat-delta-row" style="color:${color};">
            ${arrow} ${escapeHtml(formattedAbsDiff)} ${escapeHtml(directionLabel)}
            (<span class="${emphasisClass}">${sign}${absPercent.toFixed(1)}%</span>)
        </div>
    `;
}

// Single source of truth for the four comparable per-book metrics. Labels/formatters
// are stable across modes; only the underlying metric values change.
const FOUR_METRIC_DEFINITIONS = [
    {
        key: "timeSpent",
        label: "Time Spent",
        averageKey: "timeSpentMins",
        cutoffKey: "timeSpentMins",
        getValue: (m) => (m.mins > 0 ? m.mins : null),
        format: (v, mode) => formatMinutes(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerHour",
        label: "Pages per Hour",
        averageKey: "pagesPerHour",
        cutoffKey: "pagesPerHour",
        getValue: (m) => m.pagesPerHour,
        format: (v, mode) => (mode === STATS_MODE.AUDIO
            ? `${v.toFixed(2)}x`
            : `${v.toFixed(1)} p/h`),
        higherIsBetter: true,
    },
    {
        key: "completionDuration",
        label: "Completion Duration",
        averageKey: "completionDurationMs",
        cutoffKey: "completionDurationMs",
        getValue: (m) => m.completionDurationMs,
        format: (v, mode) => formatCompletionDuration(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerDay",
        label: "Pages per Day",
        averageKey: "pagesPerDay",
        cutoffKey: "pagesPerDay",
        getValue: (m) => m.pagesPerDay,
        format: (v, mode) => (mode === STATS_MODE.AUDIO
            ? `${v.toFixed(1)} h/day`
            : `${v.toFixed(1)} p/day`),
        higherIsBetter: true,
    },
];

function buildFourMetricDeltas(m, statAveragesByStatus, mode = currentStatsMode) {
    const groupAverages = statAveragesByStatus[m.status];
    const result = {};
    for (const def of FOUR_METRIC_DEFINITIONS) {
        result[def.key] = groupAverages
            ? buildStatDeltaHtml(
                def.getValue(m), groupAverages[def.averageKey],
                (v) => def.format(v, mode),
                "", "", def.higherIsBetter, groupAverages.cutoffs[def.cutoffKey],
            )
            : "";
    }
    return result;
}

function getGroupTintStyle(book) {
    if (!book.groupId) return "";
    const ownGroup = loadedGroupsMemory.find((g) => g.id === book.groupId);
    if (!ownGroup || !ownGroup.backgroundColor) return "";
    const tint = `color-mix(in srgb, ${ownGroup.backgroundColor} 50%, var(--bg-card))`;
    return `--group-tint:${tint}; background-color:var(--group-tint);`;
}

function getGroupSummaryTintStyle(group) {
    if (!group || !group.backgroundColor) return "";
    const tint = `color-mix(in srgb, ${group.backgroundColor} 75%, var(--bg-card))`;
    return `--group-tint-strong:${tint}; background-color:var(--group-tint-strong);`;
}

// =================================================================
// MODE STATE
// =================================================================
let currentStatsMode = Config.Miscellaneous.STATS_MODE.COMBINED;

function setStatsMode(mode) {
    if (mode !== STATS_MODE.COMBINED && mode !== STATS_MODE.READING && mode !== STATS_MODE.AUDIO) return;
    if (currentStatsMode === mode) return;
    currentStatsMode = mode;
    updateStatsModeButtons();
    showStatsViewState();
}

function updateStatsModeButtons() {
    const selector = document.getElementById('stats-mode-selector');
    if (!selector) return;
    selector.querySelectorAll('.stats-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentStatsMode);
    });
}

/** Injects the mode selector into #stats-view if not present, and refreshes active state. */
function ensureStatsModeSelector() {
    const statsPanel = document.getElementById('stats-view');
    if (!statsPanel) return;
    let selector = document.getElementById('stats-mode-selector');
    if (!selector) {
        const header = statsPanel.querySelector('.flex-between');
        if (!header) return;
        selector = document.createElement('div');
        selector.id = 'stats-mode-selector';
        selector.className = 'stats-mode-selector';
        selector.innerHTML = `
            <button class="stats-mode-btn" data-mode="combined" onclick="setStatsMode('Config.Miscellaneous.STATS_MODE.COMBINED')">Combined</button>
            <button class="stats-mode-btn" data-mode="reading" onclick="setStatsMode('Config.Miscellaneous.STATS_MODE.READING')">📖 Reading</button>
            <button class="stats-mode-btn" data-mode="audio" onclick="setStatsMode('Config.Miscellaneous.STATS_MODE.AUDIO')">🎧 Audio</button>
        `;
        // Insert directly after the h2 (so it reads: title | mode buttons | back)
        const h2 = header.querySelector('h2');
        if (h2 && h2.nextSibling) {
            header.insertBefore(selector, h2.nextSibling);
        } else {
            header.insertBefore(selector, header.firstChild);
        }
    }
    updateStatsModeButtons();
}

// =================================================================
// METRICS BUILDERS (one per mode)
// =================================================================
/**
 Aggregates readingSeconds/listeningSeconds across a book's readingSessions (mode field).
 @returns {{readingSeconds: number, listeningSeconds: number}}
 */
function sumBookSessionSeconds(book) {
    let readingSeconds = 0;
    let listeningSeconds = 0;
    if (Array.isArray(book.readingSessions)) {
        for (const s of book.readingSessions) {
            const dur = s.durationSeconds || 0;
            if (s.mode === 'listening') listeningSeconds += dur;
            else readingSeconds += dur;
        }
    }
    return { readingSeconds, listeningSeconds };
}

/**
 Builds a per-book metric entry for reading or audio mode.
 The output shape is the one all the existing delta/table code already consumes.
 Extra underscore-prefixed fields are used by the combined-mode table renderer.
 */
function buildSingleModeMetrics(book, mode, audiobookByBookId) {
    const { readingSeconds, listeningSeconds } = sumBookSessionSeconds(book);

    const totalPages = book.totalPages || 0;
    const totalWords = book.totalWords || 0;
    const chapterCount = book.chapterCount || 0;
    const isRead = !!book.isRead;
    const status = getBookReadingStatus(book);

    const audiobook = audiobookByBookId[book.id] || null;
    const hasAudiobook = !!audiobook;
    const audiobookDurationSec = audiobook?.duration || 0;

    // Reading progress pages
    let readingPagesRead = 0;
    if (isRead) readingPagesRead = totalPages;
    else if (book.currentChapter > 0 || book.scrollOffset > 100) {
        const chapterWordCounts = book.chapterWordCounts;
        let progress;
        if (Array.isArray(chapterWordCounts) && chapterWordCounts.length === chapterCount && totalWords > 0) {
            let wordsBefore = 0;
            for (let i = 0; i < book.currentChapter && i < chapterWordCounts.length; i++) wordsBefore += chapterWordCounts[i];
            progress = wordsBefore / totalWords;
        } else {
            progress = book.currentChapter / Math.max(1, chapterCount);
        }
        readingPagesRead = Math.round(progress * totalPages);
    }

    // Completion duration (calendar-based, shared across modes)
    let completionDurationMs = null;
    let pagesPerDay = null;
    let audioHoursPerDay = null;
    if (book.firstOpened && book.completedDate) {
        completionDurationMs = book.completedDate - book.firstOpened;
        const calendarDays = Math.max(1, completionDurationMs / (1000 * 60 * 60 * 24));
        if (isRead && totalPages > 0) pagesPerDay = totalPages / calendarDays;
        if (isRead && audiobookDurationSec > 0) audioHoursPerDay = (audiobookDurationSec / 3600) / calendarDays;
    }

    const readingMins = getMeaningfulTrackedMinutes(readingSeconds);
    const listeningMins = getMeaningfulTrackedMinutes(listeningSeconds);

    const readingPagesPerHour = readingMins > 0 ? (readingPagesRead / readingMins) * 60 : null;
    // Listening speed: full-duration / total listening time. Only meaningful once completed.
    const listeningSpeed = (isRead && audiobookDurationSec > 0 && listeningSeconds > 0)
        ? audiobookDurationSec / listeningSeconds
        : null;

    // Choose mode-specific primary values
    let mins, pagesRead, pagesPerHour, modePagesPerDay, modeAudiobookDurationSec, modeListeningSeconds, modeListeningMins;

    if (mode === 'audio') {
        mins = listeningMins;
        pagesRead = 0;
        pagesPerHour = listeningSpeed;
        modePagesPerDay = audioHoursPerDay;
        modeAudiobookDurationSec = audiobookDurationSec;
        modeListeningSeconds = listeningSeconds;
        modeListeningMins = listeningMins;
    } else {
        // 'reading' (and combined fall back to reading as the primary for pages)
        mins = readingMins;
        pagesRead = readingPagesRead;
        pagesPerHour = readingPagesPerHour;
        modePagesPerDay = pagesPerDay;
        modeAudiobookDurationSec = audiobookDurationSec;
        modeListeningSeconds = listeningSeconds;
        modeListeningMins = listeningMins;
    }

    return {
        book,
        isRead,
        isStarted: book.currentChapter > 0 || book.scrollOffset > 100 || listeningSeconds > 0,
        status,
        mins,
        pagesRead,
        totalPages,
        pagesPerHour,
        completionDurationMs,
        pagesPerDay: modePagesPerDay,

        // Raw values for combined-mode rendering
        _readingMins: readingMins,
        _listeningMins: listeningMins,
        _readingPagesRead: readingPagesRead,
        _readingPagesPerHour: readingPagesPerHour,
        _listeningSpeed: listeningSpeed,
        _hasAudiobook: hasAudiobook,
        _audiobookDurationSec: audiobookDurationSec,
        _readingSeconds: readingSeconds,
        _listeningSeconds: listeningSeconds,
        _readingPagesPerDay: pagesPerDay,
        _audioHoursPerDay: audioHoursPerDay,
        _completionDurationMs: completionDurationMs,
    };
}

/** Combines reading + audio metrics for the combined-mode table. */
function buildCombinedMetrics(book, audiobookByBookId) {
    const readingMetric = buildSingleModeMetrics(book, 'reading', audiobookByBookId);
    const audioMetric = buildSingleModeMetrics(book, 'audio', audiobookByBookId);

    const mergedSeconds = mergeReadingAndListeningTime(readingMetric._readingSeconds, audioMetric._listeningSeconds);
    const mergedMins = Math.round(mergedSeconds / 60);

    // Combined pages/hour = total pages / merged time (matches user's rule)
    const pagesPerHour = (mergedMins > 0 && readingMetric.totalPages > 0)
        ? (readingMetric.pagesRead / mergedMins) * 60
        : null;

    return {
        book,
        isRead: readingMetric.isRead,
        isStarted: readingMetric.isStarted || audioMetric.isStarted,
        status: readingMetric.status,
        mins: mergedMins,
        pagesRead: readingMetric.pagesRead,
        totalPages: readingMetric.totalPages,
        pagesPerHour,
        completionDurationMs: readingMetric.completionDurationMs,
        pagesPerDay: readingMetric.pagesPerDay,

        // Raw values for split-cell rendering
        _readingMins: readingMetric._readingMins,
        _listeningMins: audioMetric._listeningMins,
        _readingPagesRead: readingMetric._readingPagesRead,
        _readingPagesPerHour: readingMetric._readingPagesPerHour,
        _listeningSpeed: audioMetric._listeningSpeed,
        _hasAudiobook: audioMetric._hasAudiobook,
        _audiobookDurationSec: audioMetric._audiobookDurationSec,
        _readingSeconds: readingMetric._readingSeconds,
        _listeningSeconds: audioMetric._listeningSeconds,
        _readingPagesPerDay: readingMetric._readingPagesPerDay,
        _audioHoursPerDay: audioMetric._audioHoursPerDay,
        _completionDurationMs: readingMetric._completionDurationMs,
    };
}

// =================================================================
// TABLE RENDERING (mode-aware)
// =================================================================
function formatDurationShort(seconds) {
    if (!seconds || seconds <= 0) return "—";
    const mins = Math.round(seconds / 60);
    return formatMinutes(mins);
}

/**
 Builds one <tr> for the per-book stats table, with a delta line under each metric cell.
 In combined mode the Length and Time Spent cells are split.
 */
function buildStatsRowHtml(m, statAveragesByStatus, options = {}) {
    const { grouped = false, showCollapseArrow = false, groupId = null, disableCollapseArrow = false } = options;
    const deltas = buildFourMetricDeltas(m, statAveragesByStatus);
    const tintStyle = getGroupTintStyle(m.book);
    const rowClass = grouped ? "stats-row-grouped" : "";
    const gutterArrowHtml = showCollapseArrow
        ? disableCollapseArrow
            ? `<span class="stats-collapse-arrow stats-collapse-arrow-disabled">▾</span>`
            : `<span class="stats-collapse-arrow" onclick="event.stopPropagation(); toggleStatsGroupCollapse(${groupId});">▾</span>`
        : "";

    const mode = currentStatsMode;

    // --- Length cell ---
    let lengthCell;
    if (mode === 'reading') {
        lengthCell = m.totalPages > 0 ? `${m.totalPages} pages` : "—";
    } else if (mode === 'audio') {
        lengthCell = m._audiobookDurationSec > 0 ? formatDurationShort(m._audiobookDurationSec) : "—";
    } else {
        // Combined: split
        const parts = [];
        if (m.totalPages > 0) parts.push(`${m.totalPages} pages`);
        if (m._audiobookDurationSec > 0) parts.push(formatDurationShort(m._audiobookDurationSec));
        lengthCell = parts.length > 0 ? parts.join(" / ") : "—";
    }

    // --- Time Spent cell ---
    let timeSpentCell;
    if (mode === 'reading') {
        timeSpentCell = m._readingMins > 0 ? `${formatMinutes(m._readingMins)}` : "—";
    } else if (mode === 'audio') {
        timeSpentCell = m._listeningMins > 0 ? `${formatMinutes(m._listeningMins)}` : "—";
    } else {
        // Combined: show each mode
        const parts = [];
        if (m._readingMins > 0) parts.push(`${formatMinutes(m._readingMins)} 📖`);
        if (m._listeningMins > 0) parts.push(`${formatMinutes(m._listeningMins)} 🎧`);
        timeSpentCell = parts.length > 0 ? parts.join(" / ") : "—";
    }

    // --- Pages per Hour / Listening Speed ---
    let speedDisplay;
    if (mode === 'audio') {
        speedDisplay = m._listeningSpeed !== null ? `${m._listeningSpeed.toFixed(2)}x` : "—";
    } else {
        const pph = mode === 'combined' ? (m._readingPagesPerHour) : m.pagesPerHour;
        speedDisplay = pph !== null ? `${pph.toFixed(1)} p/h` : "—";
    }

    // --- Pages per Day / Duration per Day ---
    let dailyDisplay;
    if (mode === 'audio') {
        dailyDisplay = m._audioHoursPerDay !== null ? `${m._audioHoursPerDay.toFixed(1)} h/day` : "—";
    } else {
        dailyDisplay = m.pagesPerDay !== null ? `${m.pagesPerDay.toFixed(1)} p/day` : "—";
    }

    return `
        <tr class="${rowClass}" style="border-bottom: 1px solid var(--border); ${tintStyle}">
            <td><span class="stats-collapse-gutter">${gutterArrowHtml}</span>${escapeHtml(m.book.title)}</td>
            <td style="color:var(--accent);">${READING_STATUS_LABELS[m.status]}</td>
            <td>${lengthCell}</td>
            <td>${timeSpentCell}${deltas.timeSpent}</td>
            <td>${speedDisplay}${deltas.pagesPerHour}</td>
            <td>${formatCompletionDuration(m.completionDurationMs)}${deltas.completionDuration}</td>
            <td>${dailyDisplay}${deltas.pagesPerDay}</td>
        </tr>
    `;
}

function resolveGroupDeltaBaselineStatus(groupMetrics) {
    const statusesInGroup = new Set(groupMetrics.map((m) => m.status));
    if (statusesInGroup.size === 1) {
        const [onlyStatus] = statusesInGroup;
        if (DELTA_COMPARISON_STATUSES.includes(onlyStatus)) return onlyStatus;
    }
    return ALL_STATUSES_AVERAGE_KEY;
}

function buildGroupSummaryRowHtml(groupId, groupMetrics, statAveragesByStatus) {
    const group = loadedGroupsMemory.find((g) => g.id === groupId);
    const groupName = group ? group.name : "Unknown Group";
    const tintStyle = getGroupSummaryTintStyle(group);

    let completedCount = 0, inProgressCount = 0, pausedCount = 0;
    groupMetrics.forEach((m) => {
        if (m.status === READING_STATUS.COMPLETED) completedCount++;
        else if (m.status === READING_STATUS.IN_PROGRESS) inProgressCount++;
        else if (m.status === READING_STATUS.PAUSED) pausedCount++;
    });
    const bookCountLabel = `${groupMetrics.length} book${groupMetrics.length === 1 ? "" : "s"}`;
    const countsLine = `${bookCountLabel}, ${completedCount} completed / ${inProgressCount} in progress / ${pausedCount} paused`;

    const gutterArrowHtml = `<span class="stats-collapse-arrow" onclick="event.stopPropagation(); toggleStatsGroupCollapse(${groupId});">▸</span>`;

    const groupOwnAverages = computeStatAveragesForGroup(groupMetrics);
    const groupAsMetric = {
        status: resolveGroupDeltaBaselineStatus(groupMetrics),
        mins: groupOwnAverages.timeSpentMins,
        pagesPerHour: groupOwnAverages.pagesPerHour,
        completionDurationMs: groupOwnAverages.completionDurationMs,
        pagesPerDay: groupOwnAverages.pagesPerDay,
    };
    const deltas = buildFourMetricDeltas(groupAsMetric, statAveragesByStatus);
    const metricCellsHtml = FOUR_METRIC_DEFINITIONS.map((def) => {
        const value = def.getValue(groupAsMetric);
        const display = value === null || value === undefined ? "—" : def.format(value, currentStatsMode);
        return `<td>${display}${deltas[def.key]}</td>`;
    }).join("");

    return `
        <tr class="stats-row-group-summary" style="border-bottom: 1px solid var(--border); ${tintStyle}">
            <td><span class="stats-collapse-gutter">${gutterArrowHtml}</span>${escapeHtml(groupName)}</td>
            <td class="stats-group-summary-counts">${escapeHtml(countsLine)}</td>
            <td>—</td>
            ${metricCellsHtml}
        </tr>
    `;
}

function computeContiguousGroupIds(orderedMetrics) {
    const groupIdToIndices = new Map();
    orderedMetrics.forEach((m, idx) => {
        const groupId = m.book.groupId;
        if (!groupId) return;
        if (!groupIdToIndices.has(groupId)) groupIdToIndices.set(groupId, []);
        groupIdToIndices.get(groupId).push(idx);
    });
    const contiguousGroupIds = new Set();
    groupIdToIndices.forEach((indices, groupId) => {
        const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
        if (isContiguous) contiguousGroupIds.add(groupId);
    });
    return contiguousGroupIds;
}

const COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY = "collapsedStatsGroupIds";

function getCollapsedStatsGroupIds() {
    const config = getUserConfig();
    return new Set(Array.isArray(config[COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY]) ? config[COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY] : []);
}
function setCollapsedStatsGroupIds(collapsedGroupIdsSet) {
    saveUserConfig({ [COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY]: Array.from(collapsedGroupIdsSet) });
}

let cachedPerBookMetrics = null;
let cachedStatAveragesByStatus = null;

function toggleStatsGroupCollapse(groupId) {
    const collapsedGroupIds = getCollapsedStatsGroupIds();
    if (collapsedGroupIds.has(groupId)) collapsedGroupIds.delete(groupId);
    else collapsedGroupIds.add(groupId);
    setCollapsedStatsGroupIds(collapsedGroupIds);
    renderStatsTableBody();
}
function collapseAllStatsGroups() {
    if (!cachedPerBookMetrics) return;
    const allGroupIds = new Set(cachedPerBookMetrics.map((m) => m.book.groupId).filter(Boolean));
    setCollapsedStatsGroupIds(allGroupIds);
    renderStatsTableBody();
}
function expandAllStatsGroups() {
    setCollapsedStatsGroupIds(new Set());
    renderStatsTableBody();
}

function computeStatsTableUnits(perBookMetrics, isSorting) {
    const contiguousGroupIds = computeContiguousGroupIds(perBookMetrics);
    const collapsedGroupIds = getCollapsedStatsGroupIds();
    const units = [];
    let i = 0;
    while (i < perBookMetrics.length) {
        const m = perBookMetrics[i];
        const groupId = m.book.groupId;
        if (groupId && contiguousGroupIds.has(groupId)) {
            let runEnd = i;
            while (runEnd < perBookMetrics.length && perBookMetrics[runEnd].book.groupId === groupId) runEnd++;
            const runMetrics = perBookMetrics.slice(i, runEnd);
            if (collapsedGroupIds.has(groupId)) {
                units.push({ type: "collapsedGroup", groupId, groupMetrics: runMetrics });
            } else if (isSorting) {
                runMetrics.forEach((rm) => units.push({ type: "book", metric: rm }));
            } else {
                units.push({ type: "expandedGroup", groupId, groupMetrics: runMetrics });
            }
            i = runEnd;
        } else {
            units.push({ type: "book", metric: m });
            i++;
        }
    }
    return units;
}

function getStatsUnitSortValue(unit, def) {
    if (unit.type === "book") return def.getValue(unit.metric);
    const groupAverages = computeStatAveragesForGroup(unit.groupMetrics);
    const value = groupAverages[def.averageKey];
    return value === null || value === undefined ? null : value;
}

function sortStatsTableUnits(units) {
    const { columnKey, direction } = statsSortState;
    if (!columnKey || !direction) return units;
    const def = FOUR_METRIC_DEFINITIONS.find((d) => d.key === columnKey);
    if (!def) return units;
    const withValue = [];
    const withoutValue = [];
    units.forEach((unit) => {
        const value = getStatsUnitSortValue(unit, def);
        (value === null ? withoutValue : withValue).push(unit);
    });
    withValue.sort((a, b) => {
        const diff = getStatsUnitSortValue(a, def) - getStatsUnitSortValue(b, def);
        return direction === "desc" ? -diff : diff;
    });
    return [...withValue, ...withoutValue];
}

function buildStatsTableRowsHtml(perBookMetrics, statAveragesByStatus) {
    const isSorting = !!(statsSortState.columnKey && statsSortState.direction);
    const units = sortStatsTableUnits(computeStatsTableUnits(perBookMetrics, isSorting));
    return units
        .map((unit) => {
            if (unit.type === "collapsedGroup") {
                return buildGroupSummaryRowHtml(unit.groupId, unit.groupMetrics, statAveragesByStatus);
            }
            if (unit.type === "expandedGroup") {
                return unit.groupMetrics
                    .map((rm, idx) => buildStatsRowHtml(rm, statAveragesByStatus, {
                        grouped: true,
                        showCollapseArrow: idx === 0,
                        groupId: unit.groupId,
                        disableCollapseArrow: isSorting,
                    }))
                    .join("");
            }
            return buildStatsRowHtml(unit.metric, statAveragesByStatus, { grouped: !!unit.metric.book.groupId });
        })
        .join("");
}

let statsSortState = { columnKey: null, direction: null };
function resetStatsSortState() { statsSortState = { columnKey: null, direction: null }; }

function handleStatsSortHeaderClick(columnKey) {
    if (statsSortState.columnKey !== columnKey) statsSortState = { columnKey, direction: "desc" };
    else if (statsSortState.direction === "desc") statsSortState.direction = "asc";
    else statsSortState = { columnKey: null, direction: null };
    updateStatsSortHeaderUI();
    renderStatsTableBody();
}
function updateStatsSortHeaderUI() {
    FOUR_METRIC_DEFINITIONS.forEach((def) => {
        const header = document.getElementById(`stats-sort-header-${def.key}`);
        if (!header) return;
        header.querySelectorAll(".stats-sort-arrow").forEach((arrow) => {
            const isActive = statsSortState.columnKey === def.key && arrow.dataset.direction === statsSortState.direction;
            arrow.classList.toggle("active", isActive);
        });
    });
}

function renderStatsTableBody() {
    const tbody = document.getElementById("stats-books-table-body");
    if (!tbody || !cachedPerBookMetrics) return;
    tbody.innerHTML = buildStatsTableRowsHtml(cachedPerBookMetrics, cachedStatAveragesByStatus);
}

/** Rewrites the table header row based on the current mode. */
function updateStatsTableHeaders() {
    const thead = document.querySelector('#stats-view table.data-table thead');
    if (!thead) return;
    const tr = thead.querySelector('tr');
    if (!tr) return;
    const mode = currentStatsMode;
    const lengthHeader = mode === 'audio' ? "Duration" : (mode === 'combined' ? "Length" : "Pages");
    const speedHeader = mode === 'audio' ? "Listening Speed" : "Pages per Hour";
    const dailyHeader = mode === 'audio' ? "Duration per Day" : "Pages per Day";
    const headers = tr.querySelectorAll('th');
    if (headers.length >= 7) {
        headers[2].textContent = lengthHeader;
        headers[4].innerHTML = `
            ${speedHeader}
            <span class="stats-sort-arrows">
                <span class="stats-sort-arrow" data-direction="asc">▲</span>
                <span class="stats-sort-arrow" data-direction="desc">▼</span>
            </span>
        `;
        headers[6].innerHTML = `
            ${dailyHeader}
            <span class="stats-sort-arrows">
                <span class="stats-sort-arrow" data-direction="asc">▲</span>
                <span class="stats-sort-arrow" data-direction="desc">▼</span>
            </span>
        `;
    }
}

// =================================================================
// LIBRARY DISTRIBUTION - DYNAMIC BUCKETING ENGINE
// =================================================================
const MIN_VALUES_FOR_DYNAMIC_BUCKETS = 5;
const IQR_FENCE_MULTIPLIER = 1.5;

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
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const fenceMin = q1 - IQR_FENCE_MULTIPLIER * iqr;
    const fenceMax = q3 + IQR_FENCE_MULTIPLIER * iqr;
    const trimmedMin = Math.max(sorted[0], fenceMin);
    const trimmedMax = Math.min(sorted[sorted.length - 1], fenceMax);
    if (!(trimmedMax > trimmedMin)) return staticBuckets;
    const width = (trimmedMax - trimmedMin) / bucketCount;
    const edgeAt = (i) => trimmedMin + i * width;
    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
        const isFirst = i === 0;
        const isLast = i === bucketCount - 1;
        const min = isFirst ? -Infinity : edgeAt(i);
        const max = isLast ? Infinity : edgeAt(i + 1);
        const label = isLast
            ? `${Math.round(edgeAt(i))}+ ${unitLabel}`
            : `${Math.round(edgeAt(i))}\u2013${Math.round(edgeAt(i + 1))} ${unitLabel}`;
        buckets.push({ min, max, label });
    }
    return buckets;
}

function tallyIntoBuckets(values, buckets) {
    const counts = buckets.map(() => 0);
    for (const value of values) {
        for (let i = 0; i < buckets.length; i++) {
            if (value >= buckets[i].min && (value < buckets[i].max || buckets[i].max === Infinity)) {
                counts[i]++;
                break;
            }
        }
    }
    return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
}

const BOOK_LENGTH_STATIC_BUCKETS = [
    { min: 0, max: 300, label: "0\u2013299 pages" },
    { min: 300, max: 500, label: "300\u2013499 pages" },
    { min: 500, max: 700, label: "500\u2013699 pages" },
    { min: 700, max: 900, label: "700\u2013899 pages" },
    { min: 900, max: Infinity, label: "900+ pages" },
];

const AUDIO_LENGTH_STATIC_BUCKETS = [
    { min: 0, max: 3 * 3600, label: "0\u20133h" },
    { min: 3 * 3600, max: 6 * 3600, label: "3\u20136h" },
    { min: 6 * 3600, max: 10 * 3600, label: "6\u201310h" },
    { min: 10 * 3600, max: 15 * 3600, label: "10\u201315h" },
    { min: 15 * 3600, max: Infinity, label: "15+h" },
];

const READING_SPEED_STATIC_BUCKETS = [
    { min: 0, max: 50, label: "<50 p/h" },
    { min: 50, max: 60, label: "50\u201360 p/h" },
    { min: 60, max: 70, label: "60\u201370 p/h" },
    { min: 70, max: 80, label: "70\u201380 p/h" },
    { min: 80, max: 100, label: "80\u2013100 p/h" },
    { min: 100, max: Infinity, label: "100+ p/h" },
];

const LISTENING_SPEED_STATIC_BUCKETS = [
    { min: 0, max: 0.8, label: "<0.8x" },
    { min: 0.8, max: 1.2, label: "0.8\u20131.2x" },
    { min: 1.2, max: 1.6, label: "1.2\u20131.6x" },
    { min: 1.6, max: 2.2, label: "1.6\u20132.2x" },
    { min: 2.2, max: Infinity, label: "2.2x+" },
];

/**
 Computes the three Library Distribution breakdowns (plus audiobook pairing distribution).
 @param {Array<Object>} perBookMetrics - The currently-filtered metrics for the active mode.
 @param {Object} audiobookByBookId - Map of bookId -> audiobook record (for pairing count).
 @param {number} totalBooksInLibrary - Unfiltered library size (for the audiobook distribution).
 @returns {{bookLength, readingStatus, readingSpeed, audiobookDistribution}}
*/
function computeLibraryDistributions(perBookMetrics, audiobookByBookId, totalBooksInLibrary) {
    const mode = currentStatsMode;

    // 1. Length: pages (reading/combined) or duration (audio)
    let lengthDistribution;
    if (mode === 'audio') {
        const durations = perBookMetrics.filter(m => m._audiobookDurationSec > 0).map(m => m._audiobookDurationSec);
        const buckets = buildDynamicBuckets(durations, AUDIO_LENGTH_STATIC_BUCKETS, 5, "s");
        // Relabel dynamic buckets with h/min
        const labelled = buckets.map(b => {
            if (b.label.includes("s")) {
                // Convert seconds to h:min format
                const toLabel = (s) => (s >= 3600 ? `${Math.round(s/3600)}h` : `${Math.round(s/60)}m`);
                if (b.min === -Infinity) return { ...b, label: `< ${toLabel(b.max)}` };
                if (b.max === Infinity) return { ...b, label: `${toLabel(b.min)}+` };
                return { ...b, label: `${toLabel(b.min)}\u2013${toLabel(b.max)}` };
            }
            return b;
        });
        lengthDistribution = {
            entries: tallyIntoBuckets(durations, labelled),
            eligibleCount: durations.length,
        };
    } else {
        const pageCounts = perBookMetrics.filter(m => m.totalPages > 0).map(m => m.totalPages);
        const lengthBuckets = buildDynamicBuckets(pageCounts, BOOK_LENGTH_STATIC_BUCKETS, 5, "pages");
        lengthDistribution = {
            entries: tallyIntoBuckets(pageCounts, lengthBuckets),
            eligibleCount: pageCounts.length,
        };
    }

    // 2. Status
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

    // 3. Speed
    let readingSpeed;
    if (mode === 'audio') {
        const speeds = perBookMetrics.filter(m => m._listeningSpeed !== null).map(m => m._listeningSpeed);
        const buckets = buildDynamicBuckets(speeds, LISTENING_SPEED_STATIC_BUCKETS, 5, "x");
        readingSpeed = {
            entries: tallyIntoBuckets(speeds, buckets),
            eligibleCount: speeds.length,
        };
    } else {
        const speeds = perBookMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
        const buckets = buildDynamicBuckets(speeds, READING_SPEED_STATIC_BUCKETS, 5, "p/h");
        readingSpeed = {
            entries: tallyIntoBuckets(speeds, buckets),
            eligibleCount: speeds.length,
        };
    }

    // 4. Audiobook Distribution (always computed against the full library)
    let hasAudiobookCount = 0;
    let epubOnlyCount = 0;
    for (const book of loadedBooksMemory) {
        if (audiobookByBookId[book.id]) hasAudiobookCount++;
        else epubOnlyCount++;
    }
    const audiobookDistribution = {
        entries: [
            { label: "Has audiobook", count: hasAudiobookCount },
            { label: "EPUB only", count: epubOnlyCount },
        ],
        eligibleCount: totalBooksInLibrary,
    };

    return { bookLength: lengthDistribution, readingStatus, readingSpeed, audiobookDistribution };
}

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
// CARD UPDATES (mode-aware)
// =================================================================
/** Sets a card's label and value by the value element's ID. */
function setCardValue(valueElementId, label, value) {
    const valueEl = document.getElementById(valueElementId);
    if (!valueEl) return;
    const labelEl = valueEl.previousElementSibling;
    if (labelEl && labelEl.classList.contains('stat-label')) labelEl.textContent = label;
    valueEl.textContent = value;
}
/** Same as setCardValue but uses innerHTML (for values containing safe markup). */
function setCardValueHtml(valueElementId, label, valueHtml) {
    const valueEl = document.getElementById(valueElementId);
    if (!valueEl) return;
    const labelEl = valueEl.previousElementSibling;
    if (labelEl && labelEl.classList.contains('stat-label')) labelEl.textContent = label;
    valueEl.innerHTML = valueHtml;
}

function updateStatsCards(mode, perBookMetrics, allBooks, audiobookByBookId) {
    const isAudio = mode === 'audio';

    // Books in library (all books, regardless of mode)
    const totalBooksCount = allBooks.length;
    setCardValue("stat-total-books", isAudio ? "AUDIOBOOKS IN LIBRARY" : "BOOKS IN LIBRARY", totalBooksCount);

    // Books fully read
    const readBooksCount = perBookMetrics.filter(m => m.isRead).length;
    setCardValue("stat-read-books", isAudio ? "AUDIOBOOKS FULLY LISTENED" : "BOOKS FULLY READ", readBooksCount);

    // Total time tracked
    const totalMins = perBookMetrics.reduce((sum, m) => sum + m.mins, 0);
    setCardValue("stat-total-time", isAudio ? "TOTAL LISTENING TIME" : (mode === 'combined' ? "TOTAL TIME TRACKED" : "TOTAL READING TIME"), formatMinutes(totalMins));

    // Average time per book
    const booksWithTime = perBookMetrics.filter(m => m.mins > 0).length;
    const avgMins = booksWithTime ? Math.round(totalMins / booksWithTime) : 0;
    setCardValue("stat-avg-time", isAudio ? "AVERAGE LISTENING TIME PER AUDIOBOOK" : (mode === 'combined' ? "AVERAGE TIME PER BOOK" : "AVERAGE READING TIME PER BOOK"), formatMinutes(avgMins));

    // Total pages read (audio mode shows 0)
    const totalPagesRead = perBookMetrics.reduce((sum, m) => sum + m.pagesRead, 0);
    setCardValue("stat-global-pages", isAudio ? "TOTAL PAGES (N/A)" : "TOTAL PAGES READ", isAudio ? "—" : totalPagesRead);

    // Average speed
    if (isAudio) {
        const speeds = perBookMetrics.filter(m => m._listeningSpeed !== null).map(m => m._listeningSpeed);
        const avgSpeed = speeds.length ? (speeds.reduce((s, v) => s + v, 0) / speeds.length) : null;
        setCardValue("stat-avg-pages-per-hour", "AVERAGE LISTENING SPEED", avgSpeed !== null ? `${avgSpeed.toFixed(2)}x` : "—");
    } else {
        const booksWithPages = perBookMetrics.filter(m => m.pagesRead > 0 && m.mins > 0);
        const timedPages = booksWithPages.reduce((sum, m) => sum + m.pagesRead, 0);
        const timedMins = booksWithPages.reduce((sum, m) => sum + m.mins, 0);
        const avgPagesPerHour = timedMins ? (timedPages / timedMins * 60).toFixed(1) : "—";
        setCardValue("stat-avg-pages-per-hour", "AVERAGE PAGES PER HOUR", avgPagesPerHour === "—" ? "—" : `${avgPagesPerHour} p/h`);
    }

    // Average book length
    if (isAudio) {
        const durations = perBookMetrics.filter(m => m._audiobookDurationSec > 0).map(m => m._audiobookDurationSec);
        const avg = durations.length ? (durations.reduce((s, v) => s + v, 0) / durations.length) : 0;
        setCardValue("stat-avg-book-length", "AVERAGE AUDIOBOOK LENGTH", avg ? formatDurationShort(avg) : "—");
    } else {
        const booksWithPages = perBookMetrics.filter(m => m.totalPages > 0);
        const avg = booksWithPages.length ? Math.round(booksWithPages.reduce((s, m) => s + m.totalPages, 0) / booksWithPages.length) : 0;
        setCardValue("stat-avg-book-length", "AVERAGE BOOK LENGTH", avg ? `${avg} pages` : "—");
    }

    // Average completed length
    const completed = perBookMetrics.filter(m => m.isRead);
    if (isAudio) {
        const durations = completed.filter(m => m._audiobookDurationSec > 0).map(m => m._audiobookDurationSec);
        const avg = durations.length ? (durations.reduce((s, v) => s + v, 0) / durations.length) : 0;
        setCardValue("stat-avg-completed-length", "AVERAGE COMPLETED AUDIOBOOK LENGTH", avg ? formatDurationShort(avg) : "—");
    } else {
        const avg = completed.length ? Math.round(completed.reduce((s, m) => s + (m.totalPages || 0), 0) / completed.length) : 0;
        setCardValue("stat-avg-completed-length", "AVERAGE COMPLETED BOOK LENGTH", avg ? `${avg} pages` : "—");
    }

    // Longest / shortest
    if (isAudio) {
        const withDur = perBookMetrics.filter(m => m._audiobookDurationSec > 0);
        let longest = null, shortest = null;
        for (const m of withDur) {
            if (!longest || m._audiobookDurationSec > longest._audiobookDurationSec) longest = m;
            if (!shortest || m._audiobookDurationSec < shortest._audiobookDurationSec) shortest = m;
        }
        setCardValueHtml("stat-longest-book", "LONGEST AUDIOBOOK",
            longest ? `${escapeHtml(longest.book.title)} (${formatDurationShort(longest._audiobookDurationSec)})` : "—");
        setCardValueHtml("stat-shortest-book", "SHORTEST AUDIOBOOK",
            shortest ? `${escapeHtml(shortest.book.title)} (${formatDurationShort(shortest._audiobookDurationSec)})` : "—");
    } else {
        const withPages = perBookMetrics.filter(m => m.totalPages > 0);
        let longest = null, shortest = null;
        for (const m of withPages) {
            if (!longest || m.totalPages > longest.totalPages) longest = m;
            if (!shortest || m.totalPages < shortest.totalPages) shortest = m;
        }
        setCardValueHtml("stat-longest-book", "LONGEST BOOK",
            longest ? `${escapeHtml(longest.book.title)} (${longest.totalPages} pages)` : "—");
        setCardValueHtml("stat-shortest-book", "SHORTEST BOOK",
            shortest ? `${escapeHtml(shortest.book.title)} (${shortest.totalPages} pages)` : "—");
    }

    // Total words (reading only)
    const totalWords = perBookMetrics.reduce((sum, m) => sum + (m.isRead ? (m.book.totalWords || 0) : (m.pagesRead && m.totalPages ? Math.round((m.pagesRead / m.totalPages) * (m.book.totalWords || 0)) : 0)), 0);
    setCardValue("stat-total-words-read", "TOTAL WORDS READ", isAudio ? "—" : totalWords.toLocaleString());

    // Average session length (reading only)
    const totalSessions = perBookMetrics.reduce((sum, m) => sum + (m.book.totalSessions || 0), 0);
    const avgSession = totalSessions ? Math.round(totalMins / totalSessions) : 0;
    setCardValue("stat-avg-session-length", "AVERAGE SESSION LENGTH", avgSession ? formatMinutes(avgSession) : "—");

    // Completion duration stats (shared)
    const withCompletion = perBookMetrics.filter(m => m.completionDurationMs !== null);
    const avgCompletion = withCompletion.length ? (withCompletion.reduce((s, m) => s + m.completionDurationMs, 0) / withCompletion.length) : null;
    setCardValue("stat-avg-completion-duration", "AVERAGE COMPLETION DURATION", avgCompletion ? formatCompletionDuration(avgCompletion) : "—");

    let fastest = null, slowest = null;
    for (const m of withCompletion) {
        if (!fastest || m.completionDurationMs < fastest.completionDurationMs) fastest = m;
        if (!slowest || m.completionDurationMs > slowest.completionDurationMs) slowest = m;
    }
    setCardValueHtml("stat-fastest-completion", "FASTEST COMPLETED BOOK",
        fastest ? `${escapeHtml(fastest.book.title)} (${formatCompletionDuration(fastest.completionDurationMs)})` : "—");
    setCardValueHtml("stat-slowest-completion", "SLOWEST COMPLETED BOOK",
        slowest ? `${escapeHtml(slowest.book.title)} (${formatCompletionDuration(slowest.completionDurationMs)})` : "—");

    // Pages/day (or hours/day)
    if (isAudio) {
        const withAudioPerDay = perBookMetrics.filter(m => m._audioHoursPerDay !== null);
        const avg = withAudioPerDay.length ? (withAudioPerDay.reduce((s, m) => s + m._audioHoursPerDay, 0) / withAudioPerDay.length) : null;
        setCardValue("stat-avg-pages-per-day", "AVERAGE HOURS PER DAY", avg !== null ? `${avg.toFixed(1)} h/day` : "—");
        let fastA = null, slowA = null;
        for (const m of withAudioPerDay) {
            if (!fastA || m._audioHoursPerDay > fastA._audioHoursPerDay) fastA = m;
            if (!slowA || m._audioHoursPerDay < slowA._audioHoursPerDay) slowA = m;
        }
        setCardValueHtml("stat-fastest-pages-per-day", "FASTEST BY HOURS/DAY",
            fastA ? `${escapeHtml(fastA.book.title)} (${fastA._audioHoursPerDay.toFixed(1)} h/day)` : "—");
        setCardValueHtml("stat-slowest-pages-per-day", "SLOWEST BY HOURS/DAY",
            slowA ? `${escapeHtml(slowA.book.title)} (${slowA._audioHoursPerDay.toFixed(1)} h/day)` : "—");
    } else {
        const withPagesPerDay = perBookMetrics.filter(m => m.pagesPerDay !== null);
        const avg = withPagesPerDay.length ? (withPagesPerDay.reduce((s, m) => s + m.pagesPerDay, 0) / withPagesPerDay.length) : null;
        setCardValue("stat-avg-pages-per-day", "AVERAGE PAGES PER DAY", avg !== null ? `${avg.toFixed(1)} p/day` : "—");
        let fastP = null, slowP = null;
        for (const m of withPagesPerDay) {
            if (!fastP || m.pagesPerDay > fastP.pagesPerDay) fastP = m;
            if (!slowP || m.pagesPerDay < slowP.pagesPerDay) slowP = m;
        }
        setCardValueHtml("stat-fastest-pages-per-day", "FASTEST BY PAGES/DAY",
            fastP ? `${escapeHtml(fastP.book.title)} (${fastP.pagesPerDay.toFixed(1)} p/day)` : "—");
        setCardValueHtml("stat-slowest-pages-per-day", "SLOWEST BY PAGES/DAY",
            slowP ? `${escapeHtml(slowP.book.title)} (${slowP.pagesPerDay.toFixed(1)} p/day)` : "—");
    }
}

// =================================================================
// MAIN STATS VIEW ENTRY POINT
// =================================================================
async function showStatsViewState() {
    document.getElementById("library-view").style.display = "none";
    document.getElementById("reader-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";

    const statsPanel = document.getElementById("stats-view");
    statsPanel.style.display = "flex";

    ensureStatsModeSelector();
    updateStatsModeButtons();

    resetStatsSortState();
    updateStatsSortHeaderUI();

    const tbody = document.getElementById("stats-books-table-body");
    tbody.innerHTML = `<tr><td colspan="7" style="padding:12px; text-align:center; color:var(--text-muted)">Loading book metadata...</td></tr>`;

    await migrateMissingBookMetadata();

    // Load audiobooks once
    let audiobooks = [];
    try {
        audiobooks = await getAllFromLocalStore(STORE_AUDIOBOOKS);
    } catch (e) {
        console.warn("[stats] Could not load audiobooks:", e);
    }
    const audiobookByBookId = {};
    for (const ab of audiobooks) audiobookByBookId[ab.bookId] = ab;

    const allBooks = getBooksInDisplayOrder();
    const totalBooksInLibrary = allBooks.length;

    // Build all three metric sets
    const readingMetrics = allBooks
        .filter(b => (b.totalPages || 0) > 0 || b.fileData)
        .map(b => buildSingleModeMetrics(b, 'reading', audiobookByBookId));
    const audioMetrics = allBooks
        .filter(b => audiobookByBookId[b.id])
        .map(b => buildSingleModeMetrics(b, 'audio', audiobookByBookId));
    const combinedMetrics = allBooks.map(b => buildCombinedMetrics(b, audiobookByBookId));

    let perBookMetrics;
    if (currentStatsMode === 'audio') perBookMetrics = audioMetrics;
    else if (currentStatsMode === 'reading') perBookMetrics = readingMetrics;
    else perBookMetrics = combinedMetrics;

    const statAveragesByStatus = computeStatAveragesByStatus(perBookMetrics);

    cachedPerBookMetrics = perBookMetrics;
    cachedStatAveragesByStatus = statAveragesByStatus;

    updateStatsTableHeaders();
    renderStatsTableBody();

    // Distributions
    const distributions = computeLibraryDistributions(perBookMetrics, audiobookByBookId, totalBooksInLibrary);
    const bookLengthTitle = document.querySelector('#stats-view .distribution-card:nth-child(1) .distribution-card-title');
    if (bookLengthTitle) bookLengthTitle.textContent = currentStatsMode === 'audio' ? "Audiobook Length" : "Book Length";
    const statusTitle = document.querySelector('#stats-view .distribution-card:nth-child(2) .distribution-card-title');
    if (statusTitle) statusTitle.textContent = currentStatsMode === 'audio' ? "Listening Status" : "Reading Status";
    const speedTitle = document.querySelector('#stats-view .distribution-card:nth-child(3) .distribution-card-title');
    if (speedTitle) speedTitle.textContent = currentStatsMode === 'audio' ? "Listening Speed" : "Reading Speed";

    renderDistributionBarChart("dist-book-length", distributions.bookLength);
    renderDistributionBarChart("dist-reading-status", distributions.readingStatus);
    renderDistributionBarChart("dist-reading-speed", distributions.readingSpeed);
    renderDistributionBarChart("dist-audiobook", distributions.audiobookDistribution);

    // Cards
    updateStatsCards(currentStatsMode, perBookMetrics, allBooks, audiobookByBookId);

    // --- Reading-only bottom sections (unchanged) ---
    // "Reading Speed Over Lifetime" needs its own data pass (completed + tracked time).
    const speedProgressionEntries = [];
    for (const m of readingMetrics) {
        if (m.isRead && m.book.completedDate && m.totalPages > 0 && getMeaningfulTrackedSeconds(m.book.timeSpentSeconds) > 0) {
            const trackedHours = getMeaningfulTrackedSeconds(m.book.timeSpentSeconds) / 3600;
            speedProgressionEntries.push({
                book: m.book,
                status: READING_STATUS.COMPLETED,
                completedDate: m.book.completedDate,
                pagesPerHour: m.totalPages / trackedHours,
                mins: getMeaningfulTrackedMinutes(m.book.timeSpentSeconds),
                completionDurationMs: m.completionDurationMs,
                pagesPerDay: m.pagesPerDay,
            });
        }
    }
    // Averages for speed progression footer come from the reading status groups
    const readingStatAverages = computeStatAveragesByStatus(readingMetrics);
    renderReadingSpeedProgression(speedProgressionEntries, readingStatAverages);

    window.__completionTimelineData = buildCompletionTimelineData(loadedBooksMemory);
    renderCompletionTimeline(window.__completionTimelineData);

    if (typeof renderReadingActivityCalendar === "function") {
        renderReadingActivityCalendar();
    }
}

// =================================================================
// BACKFILL BUTTON + SPEED PROGRESSION
// =================================================================
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

function renderReadingSpeedProgression(entries, statAveragesByStatus) {
    const container = document.getElementById("stats-reading-speed-progression");
    if (!container) return;
    if (entries.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No completed books with tracked reading time yet.</div>`;
        return;
    }
    const sorted = [...entries].sort((a, b) => a.completedDate - b.completedDate);
    const byMonth = {};
    const monthOrder = [];
    for (const entry of sorted) {
        const d = new Date(entry.completedDate);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[monthKey]) { byMonth[monthKey] = []; monthOrder.push(monthKey); }
        byMonth[monthKey].push(entry);
    }
    const monthSections = monthOrder.map((monthKey) => {
        const [year, month] = monthKey.split("-");
        const label = new Date(Number(year), Number(month) - 1, 1)
            .toLocaleDateString(undefined, { month: "long", year: "numeric" });
        const rows = byMonth[monthKey].map((entry) => {
            const deltas = buildFourMetricDeltas(entry, statAveragesByStatus, STATS_MODE.READING);
            return `
                <div style="padding:6px 0 10px 16px; border-bottom:1px dashed var(--border);">
                    <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(entry.book.title)}</div>
                    <div class="speed-progression-metrics-grid">
                        <div><div class="speed-progression-metric-label">Time Spent</div><div class="speed-progression-metric-value-row"><span>${formatMinutes(entry.mins)}</span>${deltas.timeSpent}</div></div>
                        <div><div class="speed-progression-metric-label">Pages per Hour</div><div class="speed-progression-metric-value-row"><span>${entry.pagesPerHour.toFixed(1)} p/h</span>${deltas.pagesPerHour}</div></div>
                        <div><div class="speed-progression-metric-label">Completion Duration</div><div class="speed-progression-metric-value-row"><span>${formatCompletionDuration(entry.completionDurationMs)}</span>${deltas.completionDuration}</div></div>
                        <div><div class="speed-progression-metric-label">Pages per Day</div><div class="speed-progression-metric-value-row"><span>${entry.pagesPerDay !== null ? `${entry.pagesPerDay.toFixed(1)} p/day` : "—"}</span>${deltas.pagesPerDay}</div></div>
                    </div>
                </div>
            `;
        }).join("");
        return `<div style="padding:6px 0;"><div style="font-weight:600; padding:4px 0;">${escapeHtml(label)}</div>${rows}</div>`;
    });
    const completedAverages = statAveragesByStatus[READING_STATUS.COMPLETED];
    const averageRows = FOUR_METRIC_DEFINITIONS.map((def) => {
        const average = completedAverages[def.averageKey];
        if (average === null || average === undefined) return "";
        return `<div class="speed-progression-average-row"><span class="speed-progression-average-label">${escapeHtml(def.label)}</span><span class="speed-progression-average-value">${escapeHtml(def.format(average, STATS_MODE.READING))}</span></div>`;
    }).join("");
    container.innerHTML = `
        ${monthSections.join("")}
        <div class="speed-progression-average-block">
            <div class="speed-progression-average-heading">Average</div>
            ${averageRows}
        </div>
    `;
}