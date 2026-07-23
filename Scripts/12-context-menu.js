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
const TRACKING_TICK_MS = Config.Reading.TRACKING_TICK_MS;

let lastActivityTime = Date.now();

// Tracks physical activity or autoscroller movement, so the timer can
// distinguish active reading from an abandoned focused tab.
function recordUserActivity() {
    lastActivityTime = Date.now();
    /*
     Starts or extends the real reading session tracker. The first activity
     after opening starts a session, while later activity updates the
     inactivity timeout used to detect session end.
    */
    continueOrStartReadingSession();
}
window.addEventListener("mousemove", recordUserActivity);
window.addEventListener("keydown", recordUserActivity);
// If the autoscroller scrolls a different element than this, update the id below to match
document.getElementById("reader-container")?.addEventListener("scroll", recordUserActivity);
/*
 Captures clicks that other activity listeners miss, such as progress bar
 changes, chapter banner buttons, or note selection actions.

 These interactions count as reading engagement, so they should reset the
 idle timer and start a session when needed.
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
            activeBookObject.timeSpentSeconds += (TRACKING_TICK_MS / 1000); // Increments ticker loop heartbeat frequency step bounds
            /*
            Batches DB writes every 30 seconds instead of every tick to reduce disk I/O.
            The in-memory book stays accurate on every tick; visibilitychange and
            beforeunload handlers flush remaining time before the tab hides or closes.
            */
            if (activeBookObject.timeSpentSeconds % DB_UPDATE_FREQUENCY === 0) {
                saveTimeToDB();
            }
        }
        /*
        Session inactivity is checked every tick regardless of isUserActive.
        The activity gate only pauses time tracking; inactive sessions still need
        checking against the longer 5-minute session timeout.
        */
        checkSessionInactivityTimeout();
    }, TRACKING_TICK_MS);
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

    const now = new Date().getTime();
    const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(Config.Db.STORE_BOOKS);
    store.get(activeBookObject.id).onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
            record.timeSpentSeconds = activeBookObject.timeSpentSeconds;
            record.lastModified = now;
            store.put(record);
        }
    };

    /*
    Reuses the existing DB update cadence to flush the open reading-history
    segment, avoiding a separate interval. Active reading stays within one save
    cycle of being persisted.
    */
    if (typeof persistHistorySegment === "function") persistHistorySegment();

    /*
    Mirrors the updated lastModified into activeBookObject, keeping the
    in-memory reader state consistent with the database write, like the other
    session-related updates already do.
    */
    activeBookObject.lastModified = now;
}

/*
 REAL READING-SESSION LIFECYCLE ENGINE

 Separate from recordReadingSessionStart() which only counts reader launches
 for compatibility. This tracks actual engaged reading activity.

 Sessions start on first interaction, continue while activity stays within
 the timeout window, and end on close, tab exit, or inactivity timeout,
 saving through appendReadingSession().
*/
const SESSION_INACTIVITY_TIMEOUT_MS = Config.Reading.SESSION_INACTIVITY_TIMEOUT_MS;

// Starts a session on first interaction or extends the active session clock.
// No-op when the reader is inactive, another view is open, or no book is loaded.
function continueOrStartReadingSession() {
    const readerActive = document.getElementById("reader-view")?.classList.contains("active");
    if (!readerActive || !activeBookObject) return;

    const now = Date.now();
    if (currentSessionStartTime === null) {
        currentSessionStartTime = now;
        currentSessionStartChapterPointer = activeSpinePointer;
        // Opens the matching raw reading-history segment for the calendar
        // heatmap - see 17-reading-history.js. Started at exactly the same
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
 Closes and persists the active reading session through appendReadingSession().
 Safe to call from cleanup paths because it does nothing when no session is
 open. reason is only used for debugging.
*/
function endReadingSession(reason) {
    /*
    Finalizes the raw reading-history segment at the same points as session
    endings: close, tab exit, inactivity timeout, or book switch.

    Called before early returns because it independently handles open segments.
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
    The "Estimate Completion Date" action only applies to read books missing a
    completedDate, such as older records from before that field existed.
    "Clear Completion Date" is shown whenever a date exists, regardless of read
    status, so manually added dates can always be removed.
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
    // positionFlyoutMenu in 14-utils.js.
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

    switch (actionKey) {
        case "delete":
            if (confirm(`Remove "${targetBookObj.title}" from library completely?`)) {
                const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
                transaction.objectStore(Config.Db.STORE_BOOKS).delete(targetBookObj.id);
                transaction.oncomplete = () => {
                    fetchLocalLibrary();
                    if (typeof deleteBookFromCloud === "function") {deleteBookFromCloud(targetBookObj.id);}
                }; } break;
        case "toggleRead":
            updateBookRecord(targetBookObj.id, (r) => {
                r.isRead = !r.isRead;
                r.completedDate = r.isRead ? (r.completedDate || new Date().getTime()) : null;
            }).then(() => fetchLocalLibrary()); break;
        case "backfillCompletionDate":
            migrateSingleBookCompletionDate(targetBookObj.id).then((wasUpdated) => {
                if (wasUpdated) {
                    refreshLibraryAndVisibleStats();
                } else {
                    alert("This book doesn't need a completion date backfill (already has one, or isn't marked read).");
                }
            }); break;
        case "editStartDate":
            openStartDateModal(targetBookObj); break;
        case "editCompletionDate":
            openCompletionDateModal(targetBookObj); break;
        case "clearCompletionDate":
            setBookCompletionDate(targetBookObj.id, null).then((wasUpdated) => {
                if (wasUpdated) refreshLibraryAndVisibleStats();
            }); break;
        case "metadata":
        case "stats":
            openBookDiagnosticsModal(targetBookObj, actionKey); break;
        case "group":
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
            if (groupIdInput === null) return;
            let newGroupId = null;
            if (groupIdInput.trim() !== "") {
                const parsed = parseInt(groupIdInput, 10);
                const matchesRealGroup = loadedGroupsMemory.some((g) => g.id === parsed);
                if (!matchesRealGroup) {
                    alert("That's not a valid group ID.");
                    return; }
                newGroupId = parsed; }
            updateBookRecord(targetBookObj.id, (r) => {
                r.groupId = newGroupId;
            }).then(() => fetchLocalLibrary()); break;
        default:
            console.warn(`Unknown context action: ${actionKey}`);
    }
}
/*
 Shared refresh path for completion-date actions (edit, clear, and estimate).
 Reloads loadedBooksMemory and refreshes the open stats view if needed, so
 completion-based stats update without requiring navigation away and back.
*/
function refreshLibraryAndVisibleStats(goToStats = true) {
    fetchLocalLibrary();
    const statsPanel = document.getElementById("stats-view");
    if (statsPanel && statsPanel.style.display !== "none" && goToStats) {
        showStatsViewState();
    }
}

// =================================================================
// MANUAL DATE EDIT MODAL
// =================================================================

function openStartDateModal(bookObj) {
    const dialog = document.getElementById("start-date-modal");
    const idField = document.getElementById("start-date-book-id");
    const dateInput = document.getElementById("start-date-input");

    idField.value = bookObj.id;
    dateInput.value = bookObj.firstOpened
        ? toDateInputValue(new Date(bookObj.firstOpened))
        : "";

    dialog.showModal();
}

function closeStartDateModal() {
    document.getElementById("start-date-modal").close();
}

function submitStartDateModalForm() {
    const bookId = parseInt(document.getElementById("start-date-book-id").value, 10);
    const dateInput = document.getElementById("start-date-input");

    if (!dateInput.value) {
        alert("Pick a date first, or clear the start date manually.");
        return;
    }

    const [year, month, day] = dateInput.value.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day).getTime();

    setBookStartDate(bookId, selectedDate).then((wasUpdated) => {
        if (wasUpdated) {
            closeStartDateModal();
            refreshLibraryAndVisibleStats(false);
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}


function openCompletionDateModal(bookObj) {
    const dialog = document.getElementById("completion-date-modal");
    const idField = document.getElementById("completion-date-book-id");
    const dateInput = document.getElementById("completion-date-input");

    idField.value = bookObj.id;
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

    const [year, month, day] = dateInput.value.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day).getTime();

    setBookCompletionDate(bookId, selectedDate).then((wasUpdated) => {
        if (wasUpdated) {
            closeCompletionDateModal();
            refreshLibraryAndVisibleStats(false);
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
            const { opfDoc } = await openEpubContainer(zip);

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
        const computedMinutes = getMeaningfulTrackedMinutes(freshBook.timeSpentSeconds);
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

