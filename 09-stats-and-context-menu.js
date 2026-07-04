// =================================================================
// TIME TRACKING ENGINE - ACTIVE MONITORING LAYER
// =================================================================
window.addEventListener("focus", startActiveReadingTimer);
window.addEventListener("blur", stopActiveReadingTimer);

function startActiveReadingTimer() {
    if (focusedTimeTrackerHeartbeatInterval) return;
    focusedTimeTrackerHeartbeatInterval = setInterval(() => {
        // Condition: Must be inside a book workspace layer, and tab window must be active focus target
        const readerActive = document.getElementById("reader-view").classList.contains("active");
        if (readerActive && activeBookObject && document.hasFocus()) {
            if (!activeBookObject.timeSpentSeconds) activeBookObject.timeSpentSeconds = 0;
            activeBookObject.timeSpentSeconds += 2; // Increments ticker loop heartbeat frequency step bounds

            // Background storage silent database persistence updates loops
            const transaction = db.transaction([STORE_BOOKS], "readwrite");
            const store = transaction.objectStore(STORE_BOOKS);
            store.get(activeBookObject.id).onsuccess = (e) => {
                const record = e.target.result;
                if (record) {
                    record.timeSpentSeconds = (record.timeSpentSeconds || 0) + 2;
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
            transaction.oncomplete = () => { fetchLocalLibrary(); };
        }
    } else if (actionKey === 'toggleRead') {
        const transaction = db.transaction([STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(STORE_BOOKS);
        store.get(targetBookObj.id).onsuccess = (e) => {
            const r = e.target.result;
            r.isRead = !r.isRead; // Toggle binary state
            store.put(r);
        };
        transaction.oncomplete = () => { fetchLocalLibrary(); };
    } else if (actionKey === 'metadata' || actionKey === 'stats') {
        openBookDiagnosticsModal(targetBookObj, actionKey);
    } else if (actionKey === 'group') {
        const groupName = prompt("Enter Group ID Key or leave blank to clear group binding alignment values:");
        const transaction = db.transaction([STORE_BOOKS], "readwrite");
        const store = transaction.objectStore(STORE_BOOKS);
        store.get(targetBookObj.id).onsuccess = (e) => {
            const r = e.target.result;
            r.groupId = groupName ? parseInt(groupName) : null;
            store.put(r);
        };
        transaction.oncomplete = () => { fetchLocalLibrary(); };
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
                <div><strong>System Core Index:</strong> ${bookObj.id}</div>
                <div><strong>Standard Manifest Title:</strong> ${metaTitle}</div>
                <div><strong>Creator/Author Authority:</strong> ${creator}</div>
                <div><strong>Language Code Element:</strong> ${language}</div>
                <div><strong>Date Indexed Locally:</strong> ${new Date(bookObj.dateImported).toLocaleString()}</div>
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
    let globalTotalWordsRead = 0;

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
        globalTotalWordsRead += wordsRead;

        const mins = Math.round((book.timeSpentSeconds || 0) / 60);

        // Save row layout string reference
        rowTemplates.push(`
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding:12px;">${book.title}</td>
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