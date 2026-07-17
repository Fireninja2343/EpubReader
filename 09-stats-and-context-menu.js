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

    const rowTemplates = [];

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

        // Only books with both fields qualify - a book can be marked read
        // (or have a manually-edited completedDate via setBookCompletionDate())
        // without firstOpened ever having been set, e.g. a very old record.
        let completionDurationMs = null;
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
        }

        /*
         Pages/day: only for completed books with both firstOpened and
         completedDate (isRead used as the "completed books only"
         requirement, matching how completedBooks/completionsByMonth above
         are gated). Calendar days is the completion duration converted
         from ms to whole-ish days, floored at 1 so a same-day completion
         doesn't divide by zero or produce an inflated fractional day.
        */
        let pagesPerDay = null;
        if (isRead && book.firstOpened && book.completedDate && totalPages > 0) {
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
        const pagesPerHour = mins > 0 ? (pagesRead / mins * 60).toFixed(1) : "—";
        if (mins > 0) timedPagesRead += pagesRead;

        // Reading Speed Over Lifetime: completed books only, needs both a
        // completedDate (for chronological sorting) and tracked reading
        // time (timeSpentSeconds > 0, so a division isn't done by zero).
        if (isRead && book.completedDate && totalPages > 0 && (book.timeSpentSeconds || 0) > 0) {
            const trackedReadingHours = book.timeSpentSeconds / 3600;
            speedProgressionEntries.push({
                book,
                completedDate: book.completedDate,
                pagesPerHour: totalPages / trackedReadingHours,
            });
        }

        // Save row layout string reference
        rowTemplates.push(`
        <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding:12px;">${escapeHtml(book.title)}</td>
            <td style="padding:12px; color:var(--accent);">${isRead ? "✅ Completed" : "📖 In Progress"}</td>
            <td style="padding:12px;">${pagesRead} / ${totalPages || "—"} pages</td>
            <td style="padding:12px;">${formatMinutes(mins)}</td>
            <td style="padding:12px;">${pagesPerHour === "—" ? "—" : `${pagesPerHour} p/h`}</td>
            <td style="padding:12px;">${formatCompletionDuration(completionDurationMs)}</td>
            <td style="padding:12px;">${pagesPerDay !== null ? `${pagesPerDay.toFixed(1)} p/day` : "—"}</td>
        </tr>
        `);
    }

    // Flush table rows inside dashboard
    tbody.innerHTML = rowTemplates.join("");

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
    renderReadingSpeedProgression(speedProgressionEntries);

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
 Renders #stats-reading-speed-progression, showing pages/hour per completed
 book grouped by the month it was completed in and sorted chronologically -
 so the person can see whether their reading speed is trending up or down
 over time, book to book. Deliberately a flat chronological list rather
 than an average-per-month rollup: with typically just a few completions
 per month, showing each book individually is what actually surfaces a
 speed trend. Ends with the single overall average across every entry.
*/
function renderReadingSpeedProgression(entries) {
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
            .map((entry) => `
                <div style="display:flex; justify-content:space-between; padding:2px 0 2px 16px;">
                    <span>${escapeHtml(entry.book.title)}</span>
                    <span>${entry.pagesPerHour.toFixed(1)} p/h</span>
                </div>
            `)
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