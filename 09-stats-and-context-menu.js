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
    } else if (document.hasFocus()) {
        startActiveReadingTimer();
    }
});

function startActiveReadingTimer() {
    if (focusedTimeTrackerHeartbeatInterval) return;
    focusedTimeTrackerHeartbeatInterval = setInterval(() => {
        // Condition: Must be inside a book workspace layer, and tab window must be active focus target
        const readerActive = document.getElementById("reader-view").classList.contains("active");
        if (readerActive && activeBookObject && document.hasFocus() && !document.hidden) {
            if (!activeBookObject.timeSpentSeconds) activeBookObject.timeSpentSeconds = 0;
            activeBookObject.timeSpentSeconds += 2; // Increments ticker loop heartbeat frequency step bounds

            /*
             activeBookObject is already the in-memory source of truth and was
             just incremented above, so the record can be written directly
             instead of doing a separate get() + re-incrementing a second
             counter - that was duplicating the same +2 in two places that
             only stayed in sync by coincidence.
            */
            const transaction = db.transaction([STORE_BOOKS], "readwrite");
            const store = transaction.objectStore(STORE_BOOKS);
            store.get(activeBookObject.id).onsuccess = (e) => {
                const record = e.target.result;
                if (record) {
                    record.timeSpentSeconds = activeBookObject.timeSpentSeconds;
                    store.put(record);
                }
            };
        }
    }, 2000);
}

function stopActiveReadingTimer() {
    clearInterval(focusedTimeTrackerHeartbeatInterval);
    focusedTimeTrackerHeartbeatInterval = null;
}

// =================================================================
// DYNAMIC 3-DOTS OPTIONS FLYOUT CONTROLLER CONTEXT ENGINE
// =================================================================
function toggleBookContextMenuFlyout(event, bookIndexId) {
    event.preventDefault();
    event.stopPropagation();

    currentActiveContextBookIndexId = bookIndexId;
    const menu = document.getElementById("book-context-menu");

    menu.style.display = "block";
    menu.style.left = `${event.clientX + window.scrollX}px`;
    menu.style.top = `${event.clientY + window.scrollY}px`;

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
            const transaction = db.transaction([STORE_BOOKS], "readwrite");
            transaction.objectStore(STORE_BOOKS).delete(targetBookObj.id);
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
        const transaction = db.transaction([STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(STORE_BOOKS);
        let updatedRecord = null;
        store.get(targetBookObj.id).onsuccess = (e) => {
            const r = e.target.result;
            r.isRead = !r.isRead; // Toggle binary state
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
        const transaction = db.transaction([STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(STORE_BOOKS);
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

    try {
        const zip = await JSZip.loadAsync(bookObj.fileData);
        const containerFile = await zip.file("META-INF/container.xml").async("string");
        const parser = new DOMParser();
        const containerDoc = parser.parseFromString(containerFile, "text/xml");
        const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
        const opfFile = await zip.file(opfPath).async("string");
        const opfDoc = parser.parseFromString(opfFile, "text/xml");

        if (modeType === 'metadata') {
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
        } else {
            // Read active spine configurations to parse total chapter volume metrics
            const spineItemsCount = opfDoc.querySelectorAll("spine > itemref").length;
            const computedMinutes = Math.round((bookObj.timeSpentSeconds || 0) / 60);

            // Mathematical approximations of word counts to yield character estimates lengths boundaries
            let approximateWordCount = 0;

            const spineElements = opfDoc.querySelectorAll("spine > itemref");

            const manifestItems = {};
            opfDoc.querySelectorAll("manifest > item").forEach(item => {
                manifestItems[item.getAttribute("id")] = item.getAttribute("href");
            });

            const baseDir =
                opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

            for (const spine of spineElements) {
                const id = spine.getAttribute("idref");
                const href = manifestItems[id];

                if (!href) continue;

                const file = zip.file(normalizePath(baseDir + href));
                if (!file) continue;

                const html = await file.async("string");

                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&[a-z]+;/gi, " ")
                    .replace(/\s+/g, " ")
                    .trim();

                approximateWordCount += text
                    ? text.split(/\s+/).length
                    : 0;
            }

            const estimatedPagesCount = Math.round(approximateWordCount / 300); 

            body.innerHTML = `
                <div><strong>Total Compiled Chapters:</strong> ${spineItemsCount} Items</div>
                <div><strong>Calculated Page Volume Count:</strong> ~${estimatedPagesCount} pages</div>
                <div><strong>Active Time Spent Tracker:</strong> ${computedMinutes} continuous minutes</div>
            `;
        }
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

    const statsPanel = document.getElementById("stats-view");
    statsPanel.style.display = "flex";

    let totalBooksCount = loadedBooksMemory.length;
    let readBooksCount = 0;
    let combinedSecondsTracked = 0;
    
    // Core calculation metrics
    let globalTotalPagesRead = 0;

    const tbody = document.getElementById("stats-books-table-body");
    tbody.innerHTML = `<tr><td colspan="4" style="padding:12px; text-align:center; color:var(--text-muted)">Analyzing book files...</td></tr>`;

    const rowTemplates = [];

    // Loop through memory records dynamically evaluating true content volume
    for (const book of loadedBooksMemory) {
        combinedSecondsTracked += (book.timeSpentSeconds || 0);
        let bookWordCount = 0;

        // --- REUSING YOUR METRICS PARSING LOGIC LOOP ---
        try {
            const zip = await JSZip.loadAsync(book.fileData);
            const containerFile = await zip.file("META-INF/container.xml").async("string");
            const parser = new DOMParser();
            const containerDoc = parser.parseFromString(containerFile, "text/xml");
            const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
            const opfFile = await zip.file(opfPath).async("string");
            const opfDoc = parser.parseFromString(opfFile, "text/xml");

            const spineItemsCount = opfDoc.querySelectorAll("spine > itemref").length;

            const spineElements = opfDoc.querySelectorAll("spine > itemref");
            const manifestItems = {};
            opfDoc.querySelectorAll("manifest > item").forEach(item => {
                manifestItems[item.getAttribute("id")] = item.getAttribute("href");
            });

            const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

            for (const spine of spineElements) {
                const id = spine.getAttribute("idref");
                const href = manifestItems[id];
                if (!href) continue;

                const file = zip.file(normalizePath(baseDir + href));
                if (!file) continue;

                const html = await file.async("string");
                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&[a-z]+;/gi, " ")
                    .replace(/\s+/g, " ")
                    .trim();

                bookWordCount += text ? text.split(/\s+/).length : 0;
            }


        // Your formula mapping pages to words
        const totalPages = Math.round(bookWordCount / 300);

        // --- CALCULATE PROGRESS & HEURISTICS ---
        let isRead = !!book.isRead;
        // Was never incremented before, so "BOOKS FULLY READ" always showed 0
        // regardless of how many books had actually been finished.
        if (isRead) readBooksCount++;

        let pagesRead;
        let wordsRead;

        if (isRead) {
            pagesRead = totalPages;
            wordsRead = bookWordCount;
        } else if (book.currentChapter > 0 || book.scrollOffset > 100) {
            const progress = book.currentChapter / Math.max(1, spineItemsCount);

            pagesRead = Math.round(progress * totalPages);
            wordsRead = Math.round(progress * bookWordCount);
        } else {
            pagesRead = 0;
            wordsRead = 0;
        }

        globalTotalPagesRead += pagesRead;

        const mins = Math.round((book.timeSpentSeconds || 0) / 60);

        // Save row layout string reference
        rowTemplates.push(`
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding:12px;">${escapeHtml(book.title)}</td>
                <td style="padding:12px; color:var(--accent);">${isRead ? '✅ Completed' : '📖 In Progress'}</td>
                <td style="padding:12px;">${pagesRead} / ${totalPages} pages</td>
                <td style="padding:12px;">${mins} minutes</td>
            </tr>
        `);
        } catch (e) {
            console.error("Error parsing word counts for stats: ", e);
        }
    }

    // Flush table rows inside dashboard
    tbody.innerHTML = rowTemplates.join("");

    // --- MATH COMPILATIONS & UI UPDATES ---
    const totalMins = Math.round(combinedSecondsTracked / 60);
    const avgMins = totalBooksCount > 0 ? Math.round(totalMins / totalBooksCount) : 0;


    // Update standard interface element outputs values
    document.getElementById("stat-total-books").innerText = totalBooksCount;
    document.getElementById("stat-read-books").innerText = readBooksCount;
    document.getElementById("stat-total-time").innerText = `${totalMins}m`;
    document.getElementById("stat-avg-time").innerText = `${avgMins}m`;
    


    const globalPagesEl = document.getElementById("stat-global-pages");
    if (globalPagesEl) {
        globalPagesEl.innerText = globalTotalPagesRead;
    }
}