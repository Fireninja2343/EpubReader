// =================================================================
// BOOK CONTEXT MENU (3-DOTS FLYOUT)
// =================================================================
/**
 Opens the 3-dots flyout for a book card and positions it near the trigger event.
 @param {MouseEvent} event - Click event on the 3-dots trigger.
 @param {number} bookIndexId - id of the book this menu is for.
 */
function toggleBookContextMenuFlyout(event, bookIndexId) {
    event.preventDefault();
    event.stopPropagation();

    currentActiveContextBookIndexId = bookIndexId;
    const menu = document.getElementById("book-context-menu");

    // "Estimate Completion Date" only applies to read books missing a completedDate.
    // "Clear Completion Date" is shown whenever a date exists, regardless of read status.
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

    positionFlyoutMenu(menu, event);

    document.addEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

function closeBookContextMenuFlyoutOnceOutside() {
    document.getElementById("book-context-menu").style.display = "none";
    document.removeEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

/**
 Dispatches a context-menu action for the book targeted by currentActiveContextBookIndexId.
 @param {string} actionKey - Which action to run; see the switch cases for valid values.
 */
function triggerContextAction(actionKey) {
    const targetBookObj = loadedBooksMemory.find(b => b.id === currentActiveContextBookIndexId);
    if (!targetBookObj) return;

    switch (actionKey) {
        case "delete":
            if (confirm(`Remove "${targetBookObj.title}" from library completely?`)) {
                const bookId = targetBookObj.id;
                // Cascade: audiobook pairing, sync position, and the local file handle are all meaningless without the book they belong to.
                // Deleting only the book record would leave orphans that the next pull sync pushes BACK to the cloud.
                const transaction = db.transaction(
                    [STORE_BOOKS, STORE_AUDIOBOOKS, STORE_AUDIO_SYNC_POSITION, STORE_AUDIO_LOCAL],
                    "readwrite",
                );
                transaction.objectStore(STORE_BOOKS).delete(bookId);
                transaction.objectStore(STORE_AUDIOBOOKS).delete(bookId);
                transaction.objectStore(STORE_AUDIO_SYNC_POSITION).delete(bookId);
                transaction.objectStore(STORE_AUDIO_LOCAL).delete(bookId);
                transaction.oncomplete = () => {
                    fetchLocalLibrary();
                    if (typeof deleteBookFromCloud === "function") deleteBookFromCloud(bookId);
                };
            }
            break;
        case "toggleRead":
            updateBookRecord(targetBookObj.id, (r) => {
                r.isRead = !r.isRead;
                r.completedDate = r.isRead ? (r.completedDate || new Date().getTime()) : null;
            }).then(() => fetchLocalLibrary());
            break;
        case "backfillCompletionDate":
            migrateSingleBookCompletionDate(targetBookObj.id).then((wasUpdated) => {
                if (wasUpdated) {
                    refreshLibraryAndVisibleStats();
                } else {
                    alert("This book doesn't need a completion date backfill (already has one, or isn't marked read).");
                }
            });
            break;
        case "editStartDate":
            openStartDateModal(targetBookObj);
            break;
        case "editCompletionDate":
            openCompletionDateModal(targetBookObj);
            break;
        case "clearCompletionDate":
            setBookCompletionDate(targetBookObj.id, null).then((wasUpdated) => {
                if (wasUpdated) refreshLibraryAndVisibleStats();
            });
            break;
        case "editRawData":
            openEditRawDataModal(targetBookObj);
            break;
        case "pairAudiobook":
            openAudioPairingPanel(targetBookObj.id);
            break;
        case "metadata":
        case "stats":
            openBookDiagnosticsModal(targetBookObj, actionKey);
            break;
        case "group": {
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
                    return;
                }
                newGroupId = parsed;
            }
            updateBookRecord(targetBookObj.id, (r) => {
                r.groupId = newGroupId;
            }).then(() => fetchLocalLibrary());
            break;
        }
        default:
            console.warn(`Unknown context action: ${actionKey}`);
    }
}
/**
 Shared refresh path for completion-date actions. Reloads loadedBooksMemory and
 refreshes the open stats view if needed.
 @param {boolean} [goToStats=true] - Whether to also refresh the stats view if it's open.
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

// =================================================================
// EDIT RAW DATA MODAL
// Direct edit access to a book's stored IndexedDB fields for manual corrections that
// don't have their own dedicated UI.
// =================================================================
function openEditRawDataModal(bookObj) {
    document.getElementById("edit-raw-data-book-id").value = bookObj.id;
    document.getElementById("edit-raw-data-title").value = bookObj.title || "";
    // Stored as seconds; edited as whole minutes for a friendlier input.
    document.getElementById("edit-raw-data-time-spent").value =
        Math.round((bookObj.timeSpentSeconds || 0) / 60);
    document.getElementById("edit-raw-data-total-sessions").value = bookObj.totalSessions || 0;
    document.getElementById("edit-raw-data-current-chapter").value = bookObj.currentChapter || 0;
    document.getElementById("edit-raw-data-scroll-offset").value = bookObj.scrollOffset || 0;
    document.getElementById("edit-raw-data-total-pages").value = bookObj.totalPages ?? "";
    document.getElementById("edit-raw-data-total-words").value = bookObj.totalWords ?? "";
    document.getElementById("edit-raw-data-chapter-count").value = bookObj.chapterCount ?? "";
    document.getElementById("edit-raw-data-is-read").checked = !!bookObj.isRead;

    document.getElementById("edit-raw-data-modal").showModal();
}

function closeEditRawDataModal() {
    document.getElementById("edit-raw-data-modal").close();
}

function submitEditRawDataModalForm() {
    const bookId = parseInt(document.getElementById("edit-raw-data-book-id").value, 10);

    const titleInput = document.getElementById("edit-raw-data-title").value.trim();
    if (!titleInput) {
        alert("Title can't be empty.");
        return;
    }

    // Falls back to 0 for blank/invalid entries rather than writing NaN.
    const parseIntFieldOrZero = (elementId) => {
        const raw = document.getElementById(elementId).value;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    // Same, but preserves null for optional fields left blank instead of coercing to 0.
    const parseIntFieldOrNull = (elementId) => {
        const raw = document.getElementById(elementId).value;
        if (raw === "") return null;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const timeSpentMinutes = parseIntFieldOrZero("edit-raw-data-time-spent");
    const totalSessions = parseIntFieldOrZero("edit-raw-data-total-sessions");
    const currentChapter = parseIntFieldOrZero("edit-raw-data-current-chapter");
    const scrollOffset = parseIntFieldOrZero("edit-raw-data-scroll-offset");
    const totalPages = parseIntFieldOrNull("edit-raw-data-total-pages");
    const totalWords = parseIntFieldOrNull("edit-raw-data-total-words");
    const chapterCount = parseIntFieldOrNull("edit-raw-data-chapter-count");
    const isReadChecked = document.getElementById("edit-raw-data-is-read").checked;

    updateBookRecord(bookId, (record) => {
        record.title = titleInput;
        record.timeSpentSeconds = timeSpentMinutes * 60;
        record.totalSessions = totalSessions;
        record.currentChapter = currentChapter;
        record.scrollOffset = scrollOffset;
        record.totalPages = totalPages;
        record.totalWords = totalWords;
        record.chapterCount = chapterCount;
        record.isRead = isReadChecked;
        // Clears completedDate when un-marked as read, mirroring "Toggle Read Status".
        if (!isReadChecked) {
            record.completedDate = null;
        } else if (!record.completedDate) {
            record.completedDate = new Date().getTime();
        }
    }).then((updatedRecord) => {
        if (updatedRecord) {
            // Keep activeBookObject in sync if this is the book currently open in the reader.
            if (activeBookObject && activeBookObject.id === bookId) {
                Object.assign(activeBookObject, updatedRecord);
            }
            closeEditRawDataModal();
            refreshLibraryAndVisibleStats(false);
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}

/**
 Formats a Date as YYYY-MM-DD in local time, for <input type="date">.
 @param {Date} dateObj
 @returns {string}
 */
function toDateInputValue(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}
// =================================================================
// PER-BOOK DIAGNOSTICS MODAL
// =================================================================
/**
 Opens the book diagnostics modal in metadata mode (parses the EPUB for
 title/creator/language) or stats mode (reads cached word/page/chapter/time metrics).
 @param {object} bookObj - Book record to inspect.
 @param {"metadata"|"stats"} modeType - Which panel to show.
 */
async function openBookDiagnosticsModal(bookObj, modeType) {
    const dialog = document.getElementById("book-metrics-modal");
    const title = document.getElementById("metrics-modal-title");
    const body = document.getElementById("metrics-modal-body");

    body.innerHTML = "Parsing structures...";
    title.innerText = modeType === 'metadata' ? "Epub Metadata Explorer" : "Book Performance Metrics";
    dialog.showModal();

    if (modeType === 'metadata') {
        // Title/creator/language aren't cached on the book record, so this opens the zip.
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

    // Stats mode: reads cached numbers instead of reparsing the EPUB each time.
    // ensureBookMetadataCached() is a no-op if this book already has cached numbers.
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