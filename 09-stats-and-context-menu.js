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
    } else if (document.hasFocus()) {
        startActiveReadingTimer();
    }
});

// Extra insurance for desktop users closing the tab outright rather than
// switching away from it - visibilitychange covers the switch-away case above,
// this covers the close-outright case that visibilitychange isn't guaranteed to catch.
window.addEventListener("beforeunload", () => {
    saveTimeToDB();
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
}
window.addEventListener("mousemove", recordUserActivity);
window.addEventListener("keydown", recordUserActivity);
// If the autoscroller scrolls a different element than this, update the id below to match
document.getElementById("reader-container")?.addEventListener("scroll", recordUserActivity);

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
}

// =================================================================
// DYNAMIC 3-DOTS OPTIONS FLYOUT CONTROLLER CONTEXT ENGINE
// =================================================================
function toggleBookContextMenuFlyout(event, bookIndexId) {
    event.preventDefault();
    event.stopPropagation();

    currentActiveContextBookIndexId = bookIndexId;
    const menu = document.getElementById("book-context-menu");

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
// STATS VIEW DATASET LAYOUT SWITCHER (split view <-> tab view)
// =================================================================
/*
 Pure layout toggle: swaps which mode class is on #stats-view, which is all
 the CSS in styles.css needs to switch between showing the local-library and
 imported-archive .stats-section elements side-by-side (split) or one at a
 time via the tab bar (tabs). Neither .stats-section is ever removed or
 rebuilt - see the .stats-mode-split / .stats-mode-tabs rules in styles.css.
*/
function setStatsLayoutMode(mode) {
    const statsView = document.getElementById("stats-view");
    if (!statsView) return;

    statsView.classList.remove("stats-mode-split", "stats-mode-tabs");
    statsView.classList.add(mode === "tabs" ? "stats-mode-tabs" : "stats-mode-split");

    document.querySelectorAll("#stats-mode-toggle .stats-mode-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    /*
     Switching into tab view with neither section marked active would hide
     both datasets, so fall back to whichever tab button is already marked
     active (or the local-library section, the first tab) instead of
     leaving the panel blank.
    */
    if (mode === "tabs" && !document.querySelector(".stats-section.active")) {
        const currentTabBtn = document.querySelector(".stats-tab-btn.active");
        setActiveStatsTab(currentTabBtn ? currentTabBtn.dataset.target : "stats-section-local");
    }
}

/*
 Switches which dataset section is visible while in tab mode. Only matters
 visually once stats-mode-tabs is active (see CSS), but the .active class is
 kept in sync regardless of the current mode so switching to tab view later
 shows whichever tab was last selected.
*/
function setActiveStatsTab(sectionId) {
    document.querySelectorAll(".stats-section").forEach((section) => {
        section.classList.toggle("active", section.id === sectionId);
    });
    document.querySelectorAll(".stats-tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.target === sectionId);
    });
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
    tbody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted)">Loading book metadata...</td></tr>`;

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
    let sessionTime = 0;

    // Core calculation metrics
    let globalTotalPagesRead = 0;
    let globalTotalWordsRead = 0;
    let timedPagesRead = 0;

    let longestBook = null;
    let shortestBook = null;
    const completedBooks = [];
    const completionsByMonth = {}; // "YYYY-MM" -> completed count
    let totalReadingSessions = 0; // sum of totalSessions, for avg session length

    const rowTemplates = [];

    // Loop through memory records - all numbers below come straight off
    // each book's cached fields, no EPUB is opened here.
    for (const book of loadedBooksMemory) {
        combinedSecondsTracked += (book.timeSpentSeconds || 0);
        totalReadingSessions += (book.totalSessions || 0);

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
        if (book.totalSessions > 0) sessionTime += book.timeSpentSeconds/60 || 0;

        // Save row layout string reference
        rowTemplates.push(`
        <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding:12px;">${escapeHtml(book.title)}</td>
            <td style="padding:12px; color:var(--accent);">${isRead ? "✅ Completed" : "📖 In Progress"}</td>
            <td style="padding:12px;">${pagesRead} / ${totalPages || "—"} pages</td>
            <td style="padding:12px;">${formatMinutes(mins)}</td>
            <td style="padding:12px;">${pagesPerHour === "—" ? "—" : `${pagesPerHour} p/h`}</td>
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
     Average reading session length: total tracked time spread across
     however many discrete reader launches (totalSessions) actually
     happened, rather than across books - a book opened many times in
     short bursts and one opened once for a long sitting should not count
     the same "session" length just because they show similar total time.
    */
    const avgSessionMins = totalReadingSessions ? Math.round(sessionTime / totalReadingSessions) : 0;

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

    renderCompletionTimeline(completionsByMonth, "stats-completion-timeline");

    /*
     Archive dataset: reloaded fresh (same guarded-optional-function pattern
     used for fetchNotesLibrary() etc. elsewhere in this codebase, since
     fetchExternalStatsLibrary() lives in 02-db.js) so the archive section
     reflects the latest imported data every time the stats view opens, then
     rendered entirely separately from the local dataset above.
    */
    if (typeof fetchExternalStatsLibrary === "function") {
        await fetchExternalStatsLibrary();
    }
    renderArchiveStatsSection();
}

/*
 Renders a simple month-by-month "books completed" list into the given
 container, if that container exists in index.html. No charting library
 involved - just a sorted list of month labels and completed counts. Shared
 between the local dataset (grouped by book.completedDate, in
 showStatsViewState() above) and the archive dataset (grouped by
 entry.dateEnded, in renderArchiveStatsSection() below) via the containerId
 parameter - the bucketing math itself lives in each caller since the two
 datasets use different source fields for "when was this completed".
*/
function renderCompletionTimeline(completionsByMonth, containerId = "stats-completion-timeline") {
    const container = document.getElementById(containerId);
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
 -----------------------------------------------------------------
 IMPORTED ARCHIVE STATISTICS

 Everything below reads exclusively from loadedExternalStatsMemory and
 writes exclusively into the archive-* / stats-archive-* elements added to
 the archive .stats-section in index.html. It never reads loadedBooksMemory
 and never touches any local-stats element, so the two datasets stay fully
 independent, per the same rule the split/tab layout itself is built on.
 -----------------------------------------------------------------
*/

/*
 Maps an archive record's raw readStatus (as imported from the CSV) to a
 short display label, mirroring the emoji-labeled status column already
 used in the local per-book table above. Falls back to the raw value
 (or "—") for any status not in this fixed set, so an unexpected value from
 the source export still displays instead of disappearing.
*/
function formatArchiveReadStatusLabel(readStatus) {
    switch (readStatus) {
        case "read": return "✅ Read";
        case "currently-reading": return "📖 Currently Reading";
        case "did-not-finish": return "🚫 DNF";
        case "to-read": return "📌 To Read";
        default: return readStatus || "—";
    }
}

/*
 Renders the archive stat cards, the archive entries table, and the
 archive completion timeline - all three from loadedExternalStatsMemory.
 Called from showStatsViewState() above, right after the local dataset is
 rendered, using its own set of DOM ids so nothing here overwrites or
 blends with the local stats.
*/
function renderArchiveStatsSection() {
    const archiveRecords = loadedExternalStatsMemory || [];

    // --- Archive entries table ---
    const archiveTbody = document.getElementById("stats-archive-table-body");
    if (archiveTbody) {
        if (archiveRecords.length === 0) {
            archiveTbody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted)">No archive data imported yet.</td></tr>`;
        } else {
            archiveTbody.innerHTML = archiveRecords
                .map((entry) => `
                <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding:12px;">${escapeHtml(entry.title || "Untitled")}</td>
                    <td style="padding:12px;">${escapeHtml(entry.authors || "—")}</td>
                    <td style="padding:12px; color:var(--accent);">${escapeHtml(formatArchiveReadStatusLabel(entry.readStatus))}</td>
                    <td style="padding:12px;">${entry.numberOfPages != null ? entry.numberOfPages : "—"}</td>
                    <td style="padding:12px;">${entry.starRating != null ? entry.starRating : "—"}</td>
                </tr>
                `)
                .join("");
        }
    }

    // --- Stat cards + completion timeline ---
    let readCount = 0;
    let currentlyReadingCount = 0;
    let dnfCount = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    let totalPages = 0;
    const completionsByMonth = {}; // "YYYY-MM" -> completed count, from dateEnded

    for (const entry of archiveRecords) {
        if (entry.readStatus === "read") readCount++;
        else if (entry.readStatus === "currently-reading") currentlyReadingCount++;
        else if (entry.readStatus === "did-not-finish") dnfCount++;

        if (entry.starRating != null) {
            ratingSum += entry.starRating;
            ratingCount++;
        }
        if (entry.numberOfPages != null) {
            totalPages += entry.numberOfPages;
        }

        // Grouped by completion date, same bucketing approach as the local
        // timeline above but keyed off the archive's own dateEnded field
        // rather than the local book's completedDate.
        if (entry.dateEnded) {
            const parsedDate = new Date(entry.dateEnded);
            if (!isNaN(parsedDate)) {
                const monthKey = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, "0")}`;
                completionsByMonth[monthKey] = (completionsByMonth[monthKey] || 0) + 1;
            }
        }
    }

    const avgRating = ratingCount ? (ratingSum / ratingCount).toFixed(1) : null;

    const totalBooksElement = document.getElementById("archive-stat-total-books");
    if (totalBooksElement) totalBooksElement.innerText = archiveRecords.length;

    const readBooksElement = document.getElementById("archive-stat-read-books");
    if (readBooksElement) readBooksElement.innerText = readCount;

    const currentlyReadingElement = document.getElementById("archive-stat-currently-reading");
    if (currentlyReadingElement) currentlyReadingElement.innerText = currentlyReadingCount;

    const dnfElement = document.getElementById("archive-stat-dnf-count");
    if (dnfElement) dnfElement.innerText = dnfCount;

    const avgRatingElement = document.getElementById("archive-stat-avg-rating");
    if (avgRatingElement) avgRatingElement.innerText = avgRating !== null ? `${avgRating} ★` : "—";

    const totalPagesElement = document.getElementById("archive-stat-total-pages");
    if (totalPagesElement) totalPagesElement.innerText = totalPages.toLocaleString();

    renderCompletionTimeline(completionsByMonth, "stats-archive-completion-timeline");
}