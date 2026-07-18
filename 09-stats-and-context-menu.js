// =================================================================
// TIME TRACKING ENGINE - ACTIVE MONITORING LAYER
// =================================================================
window.addEventListener("focus", startActiveReadingTimer);
window.addEventListener("blur", stopActiveReadingTimer);

/*
 focus/blur alone are the weaker signal for "is this tab actually the one being looked at"
 some window-manager / devtools / PWA window-switching cases don't fire them reliably.
 The Page Visibility API's hidden/visible state is the API actually meant for this and fires more consistently,
 so it's layered on top as a second, more reliable check covering the same "tab is selected" requirement.
*/
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopActiveReadingTimer();
        saveTimeToDB(); // Flush the exact trailing seconds before the tab goes away
        endReadingSession("hidden"); // Backgrounding the tab ends the current session - see definition below
    } else if (document.hasFocus()) {
        startActiveReadingTimer();
    }
});

// Extra insurance for desktop users closing the tab outright rather than
// switching away from it - visibilitychange covers the switch-away case above,
// this covers the close-outright case that visibilitychange isn't guaranteed to catch.
window.addEventListener("beforeunload", () => {
    saveTimeToDB();
    endReadingSession("unload");
});

const IDLE_THRESHOLD_MS = Config.Sync.IDLE_THRESHOLD_MS;
// If no user activity is detected for this long, the tab is considered "abandoned" and time tracking pauses

const DB_UPDATE_FREQUENCY = Config.Sync.CLOUD_PROGRESS_PUSH_INTERVAL_MS / 1000;
const TICK_MS = 2000;

let lastActivityTime = Date.now();

// Tracks physical user activity or autoscroller movement, so the timer below
// can tell "tab focused and visible" apart from "tab focused, visible, and abandoned"
function recordUserActivity() {
    lastActivityTime = Date.now();
    /*
     Also feeds the real reading-session tracker below: the first activity
     after the reader opens is what actually starts a session (opening the
     reader alone does not), and every subsequent activity keeps extending
     the session's "last interaction" clock that the inactivity check uses
     to decide when the session has ended.
    */
    continueOrStartReadingSession();
}
window.addEventListener("mousemove", recordUserActivity);
window.addEventListener("keydown", recordUserActivity);
// If the autoscroller scrolls a different element than this, update the id below to match
document.getElementById("reader-container")?.addEventListener("scroll", recordUserActivity);
/*
 mousemove/keydown/scroll alone miss deliberate clicks that don't also
 involve moving the mouse first - e.g. clicking directly on the progress
 bar (handleProgressBarClick in 07-reader-controls.js), the "Next Chapter"
 banner button (injectChapterEndBanner), or selecting text to create a
 note (12-notes.js). All of those are real engagement with the book and
 should both reset the idle clock and be able to start a session on their
 own, so click is captured on the reader container as well.
*/
document.getElementById("reader-container")?.addEventListener("click", recordUserActivity);


function startActiveReadingTimer() {
    if (focusedTimeTrackerHeartbeatInterval) return;
    focusedTimeTrackerHeartbeatInterval = setInterval(() => {
        // Condition: Must be inside a book workspace layer, and tab window must be active focus target
        const readerActive = document.getElementById("reader-view").classList.contains("active");
        const isUserActive = (Date.now() - lastActivityTime) < IDLE_THRESHOLD_MS;
        if (readerActive && activeBookObject && document.hasFocus() && !document.hidden && isUserActive) {
            if (!activeBookObject.timeSpentSeconds) activeBookObject.timeSpentSeconds = 0;
            activeBookObject.timeSpentSeconds += (TICK_MS / 1000); // Increments ticker loop heartbeat frequency step bounds

            /*
             Batches the DB write to every 30 seconds (15 ticks) instead of every
             tick, to cut down on disk I/O. activeBookObject in RAM stays perfectly
             accurate every tick regardless - only the persisted copy lags behind,
             and the visibilitychange/beforeunload handlers above flush the
             trailing remainder so nothing gets lost when the tab hides or closes.
            */
            if (activeBookObject.timeSpentSeconds % DB_UPDATE_FREQUENCY === 0) {
                saveTimeToDB();
            }
        }

        /*
         Session inactivity check runs on every tick regardless of the
         isUserActive gate above (which just pauses time-tracking - a
         session that's gone quiet needs to be checked against the much
         longer 5-minute session timeout even while time-tracking itself
         is paused).
        */
        checkSessionInactivityTimeout();
    }, TICK_MS);
}

function stopActiveReadingTimer() {
    clearInterval(focusedTimeTrackerHeartbeatInterval);
    focusedTimeTrackerHeartbeatInterval = null;
}

// Writes the in-memory timeSpentSeconds value to the book's DB record. Pulled
// out as its own function so the batched ticker and the hide/close safety
// nets above all go through the exact same save path.
function saveTimeToDB() {
    if (!activeBookObject || !activeBookObject.id) return;

    const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(Config.Db.STORE_BOOKS);
    store.get(activeBookObject.id).onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
            record.timeSpentSeconds = activeBookObject.timeSpentSeconds;
            store.put(record);
        }
    };

    /*
     Reuses this exact same batched cadence (called from the tick loop every
     DB_UPDATE_FREQUENCY seconds, plus from the hide/close safety nets) to
     also flush the open reading-history segment - see 13-reading-history.js.
     No separate interval needed, and it means active reading is never more
     than one of these save cycles away from being safely persisted if the
     tab crashes or closes unexpectedly.
    */
    if (typeof persistHistorySegment === "function") persistHistorySegment();
}

// =================================================================
// REAL READING-SESSION LIFECYCLE ENGINE
// =================================================================
/*
 This is distinct from recordReadingSessionStart() in 02-db.js, which just
 increments totalSessions once per reader launch (kept as-is for backward
 compatibility - see that function's comment). The engine below tracks
 when the person is actually engaged with a book:

   - a session STARTS on the first real interaction after the reader
     opens (not merely on open - a 5-second peek that's immediately
     closed never becomes a session at all)
   - a session CONTINUES for as long as interactions keep arriving within
     Config.Reading.SESSION_INACTIVITY_TIMEOUT_MS (~5 minutes) of each other
   - a session ENDS - and gets saved via appendReadingSession() - when the
     reader closes, the tab/window closes, or that inactivity timeout
     elapses with no further interaction
*/
const SESSION_INACTIVITY_TIMEOUT_MS = Config.Reading.SESSION_INACTIVITY_TIMEOUT_MS;

// Starts a session on first interaction, or just extends the "still going"
// clock if one is already open. Cheap no-op guard if the reader isn't
// actually the active view (e.g. activity events firing while browsing
// the library) or there's no book loaded yet.
function continueOrStartReadingSession() {
    const readerActive = document.getElementById("reader-view")?.classList.contains("active");
    if (!readerActive || !activeBookObject) return;

    const now = Date.now();
    if (currentSessionStartTime === null) {
        currentSessionStartTime = now;
        currentSessionStartChapterPointer = activeSpinePointer;
        // Opens the matching raw reading-history segment for the calendar
        // heatmap - see 13-reading-history.js. Started at exactly the same
        // moment as the session itself, and closed alongside it below in
        // endReadingSession().
        if (typeof startHistorySegment === "function") {
            startHistorySegment(activeBookObject.id, activeSpinePointer);
        }
    }
    currentSessionLastInteractionTime = now;
}

/*
 Periodic check for the inactivity-timeout session boundary. Piggybacks on
 the same TICK_MS heartbeat interval already running for time-tracking
 (started/stopped alongside it in startActiveReadingTimer/stopActiveReadingTimer
 below) rather than a second interval, since both need to run at the same
 cadence and under the same "reader is actually active" condition.
*/
function checkSessionInactivityTimeout() {
    if (currentSessionStartTime === null) return; // No open session to time out
    const idleFor = Date.now() - currentSessionLastInteractionTime;
    if (idleFor >= SESSION_INACTIVITY_TIMEOUT_MS) {
        endReadingSession("inactivity");
    }
}

/*
 Closes out the currently open session (if any) and persists it via
 appendReadingSession() in 02-db.js. Safe to call speculatively - e.g. from
 visibilitychange/beforeunload - since it's a no-op whenever no session is
 currently open (either none was ever started, or one was already ended).
 reason is purely for debugging/console visibility, not stored.
*/
function endReadingSession(reason) {
    /*
     Finalizes the raw reading-history segment (see 13-reading-history.js)
     at exactly the same moments a real session ends - reader closes, tab/
     window becomes inactive, the inactivity timeout elapses, or a new book
     is launched. Called unconditionally, before the early-return branches
     below, since it's self-contained (a no-op if no segment is open) and
     shouldn't be skipped just because the summary session log below
     considers this session too short to record.
    */
    if (typeof closeHistorySegment === "function") closeHistorySegment();

    if (currentSessionStartTime === null || !activeBookObject || !activeBookObject.id) {
        currentSessionStartTime = null;
        currentSessionLastInteractionTime = null;
        currentSessionStartChapterPointer = null;
        return;
    }

    const endTime = Date.now();
    const durationSeconds = Math.round((endTime - currentSessionStartTime) / 1000);

    /*
     Sessions under a few seconds aren't meaningful reading sessions - most
     often they're an accidental open/close or this function firing twice
     in quick succession (e.g. visibilitychange then beforeunload). Skipping
     these keeps readingSessions from filling up with noise entries that
     would drag the average session length down artificially.
    */
    if (durationSeconds < 3) {
        currentSessionStartTime = null;
        currentSessionLastInteractionTime = null;
        currentSessionStartChapterPointer = null;
        return;
    }

    // Approximate pages read this session from how far the chapter pointer
    // moved, scaled against the book's cached chapter/page counts - the
    // same page-estimation approach used elsewhere in the stats view
    // (see showStatsViewState()), just scoped to this one session instead
    // of the whole book.
    const chapterCount = activeBookObject.chapterCount || 0;
    const totalPages = activeBookObject.totalPages || 0;
    let pagesRead = 0;
    if (chapterCount > 0 && totalPages > 0 && currentSessionStartChapterPointer !== null) {
        const chaptersAdvanced = Math.max(0, activeSpinePointer - currentSessionStartChapterPointer);
        pagesRead = Math.round((chaptersAdvanced / chapterCount) * totalPages);
    }

    const sessionRecord = {
        start: currentSessionStartTime,
        end: endTime,
        durationSeconds: durationSeconds,
        pagesRead: pagesRead,
        timestamp: endTime,
    };

    const bookId = activeBookObject.id;
    currentSessionStartTime = null;
    currentSessionLastInteractionTime = null;
    currentSessionStartChapterPointer = null;

    appendReadingSession(bookId, sessionRecord);
}

// =================================================================
// DYNAMIC 3-DOTS OPTIONS FLYOUT CONTROLLER CONTEXT ENGINE
// =================================================================
function toggleBookContextMenuFlyout(event, bookIndexId) {
    event.preventDefault();
    event.stopPropagation();

    currentActiveContextBookIndexId = bookIndexId;
    const menu = document.getElementById("book-context-menu");

    /*
     The "Estimate Completion Date" row only makes sense for books that are
     marked read but are missing a completedDate (older completions from
     before that field existed) - showing it unconditionally would just be
     a dead action for every other book. Toggled here rather than baked
     into static HTML since it depends on which book's menu was opened.
     "Clear Completion Date" is the mirror image - only useful when a date
     is actually set, regardless of read status (a manually-edited date on
     an unread book should still be clearable).
    */
    const targetBookObj = loadedBooksMemory.find((b) => b.id === bookIndexId);
    const backfillRow = document.getElementById("context-item-backfill-completion");
    if (backfillRow) {
        const needsBackfill = !!(targetBookObj && targetBookObj.isRead && !targetBookObj.completedDate);
        backfillRow.style.display = needsBackfill ? "" : "none";
    }
    const clearRow = document.getElementById("context-item-clear-completion");
    if (clearRow) {
        const hasDate = !!(targetBookObj && targetBookObj.completedDate);
        clearRow.style.display = hasDate ? "" : "none";
    }

    // Flips to the left of the dots trigger (or clamps vertically) if the
    // default placement would run off the edge of the viewport - see
    // positionFlyoutMenu in 10-utils.js.
    positionFlyoutMenu(menu, event);

    // Wire listener to capture closing ticks anywhere across workspace window scopes
    document.addEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

function closeBookContextMenuFlyoutOnceOutside() {
    document.getElementById("book-context-menu").style.display = "none";
    document.removeEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

// Route target operations commands parsed through contextual components choices
function triggerContextAction(actionKey) {
    const targetBookObj = loadedBooksMemory.find(b => b.id === currentActiveContextBookIndexId);
    if (!targetBookObj) return;

    if (actionKey === 'delete') {
        if (confirm(`Remove "${targetBookObj.title}" from library completely?`)) {
            const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
            transaction.objectStore(Config.Db.STORE_BOOKS).delete(targetBookObj.id);
            transaction.oncomplete = () => {
                fetchLocalLibrary();
                /* Mirror the deletion up to Firestore too. Without this call the
                   book only disappears locally — the cloud doc (and its file
                   chunks) stay behind, so the next sign-in or live-listener pull
                   on any device just downloads it right back. */
                if (typeof deleteBookFromCloud === "function") {
                    deleteBookFromCloud(targetBookObj.id);
                }
            };
        }
    } else if (actionKey === 'toggleRead') {
        const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(Config.Db.STORE_BOOKS);
        let updatedRecord = null;
        store.get(targetBookObj.id).onsuccess = (e) => {
            const r = e.target.result;
            r.isRead = !r.isRead; // Toggle binary state
            /* Manual toggling should track completedDate the same way the
               automatic markBookAsRead() path does: set it the moment the
               book becomes read (unless it already has one), and clear it
               if the user un-marks the book so it stops counting toward
               the completion timeline in the stats view. */
            r.completedDate = r.isRead ? (r.completedDate || new Date().getTime()) : null;
            r.lastModified = new Date().getTime(); // Needed so the cloud/other devices know this copy is newer
            store.put(r);
            updatedRecord = r;
        };
        transaction.oncomplete = () => {
            fetchLocalLibrary();
            if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
                pushBookMetadataToCloud(updatedRecord);
            }
        };
    } else if (actionKey === 'backfillCompletionDate') {
        migrateSingleBookCompletionDate(targetBookObj.id).then((wasUpdated) => {
            if (wasUpdated) {
                refreshLibraryAndVisibleStats();
            } else {
                alert("This book doesn't need a completion date backfill (already has one, or isn't marked read).");
            }
        });
    } else if (actionKey === 'editCompletionDate') {
        openCompletionDateModal(targetBookObj);
    } else if (actionKey === 'clearCompletionDate') {
        setBookCompletionDate(targetBookObj.id, null).then((wasUpdated) => {
            if (wasUpdated) refreshLibraryAndVisibleStats();
        });
    } else if (actionKey === 'metadata' || actionKey === 'stats') {
        openBookDiagnosticsModal(targetBookObj, actionKey);
    } else if (actionKey === 'group') {
        /*
         Previously this asked the user to type a raw numeric group ID,
         which is an internal database key never shown anywhere in the UI —
         there was no way for a user to actually know which number
         corresponded to which group. This now lists the existing group
         names (and their real IDs) so the prompt is actually answerable,
         and validates the entered ID before using it.
        */
        if (loadedGroupsMemory.length === 0) {
            alert("No groups exist yet. Create one first with \"📁 New Group\".");
            return;
        }
        const optionsList = loadedGroupsMemory
            .map((g) => `${g.id}: ${g.name}`)
            .join("\n");
        const groupIdInput = prompt(
            `Enter a group ID to move "${targetBookObj.title}" into, or leave blank to remove it from its group:\n\n${optionsList}`,
        );
        if (groupIdInput === null) return; // user cancelled
        let newGroupId = null;
        if (groupIdInput.trim() !== "") {
            const parsed = parseInt(groupIdInput, 10);
            const matchesRealGroup = loadedGroupsMemory.some((g) => g.id === parsed);
            if (!matchesRealGroup) {
                alert("That's not a valid group ID.");
                return;
            }
            newGroupId = parsed;
        }
        const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(Config.Db.STORE_BOOKS);
        let updatedRecord = null;
        store.get(targetBookObj.id).onsuccess = (e) => {
            const r = e.target.result;
            r.groupId = newGroupId;
            r.lastModified = new Date().getTime(); // Needed so the cloud/other devices know this copy is newer
            store.put(r);
            updatedRecord = r;
        };
        transaction.oncomplete = () => {
            fetchLocalLibrary();
            if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
                pushBookMetadataToCloud(updatedRecord);
            }
        };
    }
}

/*
 Shared refresh path for every completion-date action (edit, clear, and
 the existing per-book estimate). Reloads loadedBooksMemory from
 IndexedDB so the book list/context menu reflect the change immediately,
 and - if the stats panel happens to be open right now - also re-runs
 showStatsViewState() so the completion-date-derived stats (books read
 count, completion timeline, etc.) update without the user having to
 navigate away and back.
*/
function refreshLibraryAndVisibleStats() {
    fetchLocalLibrary();
    const statsPanel = document.getElementById("stats-view");
    if (statsPanel && statsPanel.style.display !== "none") {
        showStatsViewState();
    }
}

// =================================================================
// MANUAL COMPLETION DATE EDIT MODAL
// =================================================================
function openCompletionDateModal(bookObj) {
    const dialog = document.getElementById("completion-date-modal");
    const idField = document.getElementById("completion-date-book-id");
    const dateInput = document.getElementById("completion-date-input");

    idField.value = bookObj.id;
    /* <input type="date"> expects YYYY-MM-DD in local terms. Pre-fill with
       the book's existing completedDate if it has one, otherwise leave the
       field blank rather than defaulting to today, so an empty field
       clearly means "no date chosen yet" rather than silently implying
       today's date. */
    dateInput.value = bookObj.completedDate
        ? toDateInputValue(new Date(bookObj.completedDate))
        : "";

    dialog.showModal();
}

function closeCompletionDateModal() {
    document.getElementById("completion-date-modal").close();
}

function submitCompletionDateModalForm() {
    const bookId = parseInt(document.getElementById("completion-date-book-id").value, 10);
    const dateInput = document.getElementById("completion-date-input");

    if (!dateInput.value) {
        alert("Pick a date first, or use \"Clear Completion Date\" from the book's menu instead.");
        return;
    }

    /* new Date("YYYY-MM-DD") parses as UTC midnight, which can display as
       the previous day in negative-UTC-offset timezones. Building the date
       from its parts instead keeps it anchored to local midnight on the
       day the user actually picked. */
    const [year, month, day] = dateInput.value.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day).getTime();

    setBookCompletionDate(bookId, selectedDate).then((wasUpdated) => {
        if (wasUpdated) {
            closeCompletionDateModal();
            refreshLibraryAndVisibleStats();
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}

// Formats a Date as the YYYY-MM-DD string <input type="date"> requires, in local time
function toDateInputValue(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// =================================================================
// PER-BOOK DIAGNOSTICS DISPLAY PARSING ROUTINES
// =================================================================
async function openBookDiagnosticsModal(bookObj, modeType) {
    const dialog = document.getElementById("book-metrics-modal");
    const title = document.getElementById("metrics-modal-title");
    const body = document.getElementById("metrics-modal-body");

    body.innerHTML = "Parsing structures...";
    title.innerText = modeType === 'metadata' ? "Epub Metadata Explorer" : "Book Performance Metrics";
    dialog.showModal();

    if (modeType === 'metadata') {
        /*
         Title/creator/language aren't cached on the book record (only the
         performance-metrics numbers below are), so this branch still opens
         the zip - just only when metadata mode is actually what was asked
         for, instead of unconditionally for both modes.
        */
        try {
            const zip = await JSZip.loadAsync(bookObj.fileData);
            const containerFile = await zip.file("META-INF/container.xml").async("string");
            const parser = new DOMParser();
            const containerDoc = parser.parseFromString(containerFile, "text/xml");
            const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
            const opfFile = await zip.file(opfPath).async("string");
            const opfDoc = parser.parseFromString(opfFile, "text/xml");

            const metaTitle = opfDoc.querySelector("title")?.textContent || "Unknown Title";
            const creator = opfDoc.querySelector("creator")?.textContent || "Unknown Publisher Author";
            const language = opfDoc.querySelector("language")?.textContent || "en";

            body.innerHTML = `
                <div><strong>System Core Index:</strong> ${escapeHtml(bookObj.id)}</div>
                <div><strong>Standard Manifest Title:</strong> ${escapeHtml(metaTitle)}</div>
                <div><strong>Creator/Author Authority:</strong> ${escapeHtml(creator)}</div>
                <div><strong>Language Code Element:</strong> ${escapeHtml(language)}</div>
                <div><strong>Date Indexed Locally:</strong> ${escapeHtml(new Date(bookObj.dateImported).toLocaleString())}</div>
            `;
        } catch (e) {
            body.innerHTML = `<span style="color:red">Failed extraction profiles.</span>`;
        }
        return;
    }

    /*
     Stats mode. Previously this reparsed the entire EPUB (unzip, walk the
     spine, strip HTML, count words) every single time this modal opened.
     That work now happens once - at import, or via the migration pass for
     older books - and is just read straight off the book record here.
     ensureBookMetadataCached() is a no-op if this book already has cached
     numbers, so no zip ever gets opened for a book that's been migrated.
    */
    try {
        const freshBook = await ensureBookMetadataCached(bookObj);
        const computedMinutes = Math.round((freshBook.timeSpentSeconds || 0) / 60);
        const chapterCount = freshBook.chapterCount ?? "—";
        const estimatedPagesCount = freshBook.totalPages ?? "—";

        body.innerHTML = `
            <div><strong>Total Compiled Chapters:</strong> ${chapterCount} Items</div>
            <div><strong>Calculated Page Volume Count:</strong> ~${estimatedPagesCount} pages</div>
            <div><strong>Active Time Spent Tracker:</strong> ${computedMinutes} continuous minutes</div>
        `;
    } catch (e) {
        body.innerHTML = `<span style="color:red">Failed extraction profiles.</span>`;
    }
}

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
 Computes the same four "delta from average" HTML snippets (Time Spent,
 Pages per Hour, Completion Duration, Pages per Day) for any object shaped
 like a perBookMetrics entry - i.e. anything with .mins, .pagesPerHour,
 .completionDurationMs, .pagesPerDay. Pulled out of buildStatsRowHtml so
 renderReadingSpeedProgression() (the "Reading Speed Over Lifetime" list)
 can show the exact same four comparisons without re-deriving or
 duplicating any of this logic - both call sites just pass in an object
 with those four fields and the shared statAverages.
*/
function buildFourMetricDeltas(m, statAverages) {
    return {
        timeSpent: buildStatDeltaHtml(
            m.mins > 0 ? m.mins : null, statAverages.timeSpentMins,
            formatMinutes, "", "", false, statAverages.cutoffs.timeSpentMins,
        ),
        pagesPerHour: buildStatDeltaHtml(
            m.pagesPerHour, statAverages.pagesPerHour,
            (v) => `${v.toFixed(1)} p/h`, "", "", true, statAverages.cutoffs.pagesPerHour,
        ),
        completionDuration: buildStatDeltaHtml(
            m.completionDurationMs, statAverages.completionDurationMs,
            formatCompletionDuration, "", "", false, statAverages.cutoffs.completionDurationMs,
        ),
        pagesPerDay: buildStatDeltaHtml(
            m.pagesPerDay, statAverages.pagesPerDay,
            (v) => `${v.toFixed(1)} pages/day`, "", "", true, statAverages.cutoffs.pagesPerDay,
        ),
    };
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
            <td style="padding:12px;">${escapeHtml(m.book.title)}</td>
            <td style="padding:12px; color:var(--accent);">${m.isRead ? "✅ Completed" : "📖 In Progress"}</td>
            <td style="padding:12px;">${m.pagesRead} / ${m.totalPages || "—"} pages</td>
            <td style="padding:12px;">${formatMinutes(m.mins)}${deltas.timeSpent}</td>
            <td style="padding:12px;">${pagesPerHourDisplay}${deltas.pagesPerHour}</td>
            <td style="padding:12px;">${formatCompletionDuration(m.completionDurationMs)}${deltas.completionDuration}</td>
            <td style="padding:12px;">${m.pagesPerDay !== null ? `${m.pagesPerDay.toFixed(1)} p/day` : "—"}${deltas.pagesPerDay}</td>
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
     those cached fields (see 06-epub-reader.js). Books that already have
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
        combinedSecondsTracked += (book.timeSpentSeconds || 0);
        totalReadingSessions += (book.totalSessions || 0);

        if (Array.isArray(book.readingSessions) && book.readingSessions.length > 0) {
            for (const session of book.readingSessions) {
                if (typeof session.durationSeconds === "number") {
                    allRealSessionDurationsMins.push(session.durationSeconds / 60);
                }
            }
        } else if (book.totalSessions > 0) {
            // Fallback for books with no real session log: same approximation used before this feature existed
            sessionTime += book.timeSpentSeconds / 60 || 0;
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

        const mins = Math.round((book.timeSpentSeconds || 0) / 60);
        if (mins > 0) timedPagesRead += pagesRead;

        /*
         Reading Speed Over Lifetime: completed books only, needs both a
         completedDate (for chronological sorting) and tracked reading
         time (timeSpentSeconds > 0, so a division isn't done by zero).
         Carries the same mins/completionDurationMs/pagesPerDay fields as
         perBookMetrics below (rather than just pagesPerHour) so this list
         can reuse buildStatDeltaHtml/buildStatsRowHtml instead of the
         lifetime view needing its own parallel metric-formatting logic -
         see renderReadingSpeedProgression().
        */
        if (isRead && book.completedDate && totalPages > 0 && (book.timeSpentSeconds || 0) > 0) {
            const trackedReadingHours = book.timeSpentSeconds / 3600;
            speedProgressionEntries.push({
                book,
                completedDate: book.completedDate,
                pagesPerHour: totalPages / trackedReadingHours,
                mins: Math.round(book.timeSpentSeconds / 60),
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
    const booksWithTime = loadedBooksMemory.filter(b => (b.timeSpentSeconds || 0) > 0).length;
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

    renderCompletionTimeline(completionsByMonth);
    renderReadingSpeedProgression(speedProgressionEntries, statAverages);

    // See 13-reading-history.js. Guarded the same way the other optional
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
 Renders a simple month-by-month "books completed" list into
 #stats-completion-timeline, if that container has been added to
 index.html. No charting library involved - just a sorted list of month
 labels and completed counts, built from each book's completedDate.
*/
function renderCompletionTimeline(completionsByMonth) {
    const container = document.getElementById("stats-completion-timeline");
    if (!container) return;

    const months = Object.keys(completionsByMonth).sort();
    if (months.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No completed books yet.</div>`;
        return;
    }

    container.innerHTML = months
        .map((monthKey) => {
            const count = completionsByMonth[monthKey];
            const [year, month] = monthKey.split("-");
            const label = new Date(Number(year), Number(month) - 1, 1)
                .toLocaleDateString(undefined, { month: "long", year: "numeric" });
            return `<div style="display:flex; justify-content:space-between; padding:4px 0;">
                <span>${escapeHtml(label)}</span>
                <span>${count} completed</span>
            </div>`;
        })
        .join("");
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
                                <div>${formatMinutes(entry.mins)}${deltas.timeSpent}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Hour</div>
                                <div>${entry.pagesPerHour.toFixed(1)} p/h${deltas.pagesPerHour}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Completion Duration</div>
                                <div>${formatCompletionDuration(entry.completionDurationMs)}${deltas.completionDuration}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Day</div>
                                <div>${entry.pagesPerDay !== null ? `${entry.pagesPerDay.toFixed(1)} p/day` : "—"}${deltas.pagesPerDay}</div>
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

    const overallAverage = sorted.reduce((sum, e) => sum + e.pagesPerHour, 0) / sorted.length;

    container.innerHTML = `
        ${monthSections.join("")}
        <div style="display:flex; justify-content:space-between; padding:8px 0 0; margin-top:8px; border-top:1px solid var(--border); font-weight:600;">
            <span>Average</span>
            <span>${overallAverage.toFixed(1)} p/h</span>
        </div>
    `;
}