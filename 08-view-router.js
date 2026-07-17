// =================================================================
// VIEW ROUTER: LIBRARY <-> READER PANEL SWITCHING
// =================================================================
function showReaderState() {
    // 1. Switch primary workspace canvas panels
    document.getElementById("library-view").classList.remove("active");
    document.getElementById("library-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";
    document.getElementById("reader-view").classList.add("active");
    document.getElementById("reader-view").style.display = "flex";

    // 2. HIDE all administrative library tools from the navbar
    document.getElementById("upload-label").style.display = "none";
    document.getElementById("btn-create-group").style.display = "none";
    document.getElementById("library-view-mode").style.display = "none";
    document.getElementById("sort-selector").style.display = "none";
    document.getElementById("btn-export-json").style.display = "none";
    document.getElementById("btn-import-json").style.display = "none";
    document.getElementById("btn-last-read").style.display = "none";
    document.getElementById("sign-in").style.display = "none";
    document.getElementById("current-group-indicator").style.display = "none"; 
    document.getElementById("btn-library-settings").style.display = "none";


    // Safety check in case the back-to-groups button was visible
    const backGroupBtn = document.getElementById("btn-back-group");
    if (backGroupBtn) backGroupBtn.style.display = "none";

    // 3. SHOW active reader controls and book titles
    document.getElementById("current-book-indicator").style.display = "inline";
    const readerControls = document.getElementById("reader-controls");
    if (readerControls) readerControls.style.display = "flex";
}

function showLibraryState() {
    // 1. Switch primary workspace canvas panels back
    document.getElementById("reader-view").classList.remove("active");
    document.getElementById("reader-view").style.display = "none";
    document.getElementById("stats-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";
    document.getElementById("library-view").classList.add("active");
    document.getElementById("library-view").style.display = "flex";

    // 2. HIDE reader active contextual indications
    document.getElementById("current-book-indicator").style.display = "none";
    document.getElementById("current-group-indicator").style.display = "none";
    const readerControls = document.getElementById("reader-controls");
    if (readerControls) readerControls.style.display = "none";
    document.querySelectorAll(".reader-sidebar").forEach(s => s.classList.remove("active"));

    // 3. RESTORE administrative library tools
    document.getElementById("upload-label").style.display = "inline-block";
    document.getElementById("btn-create-group").style.display = "inline-block";
    document.getElementById("sort-selector").style.display = "inline-block";
    document.getElementById("btn-export-json").style.display = "inline-block";
    document.getElementById("btn-import-json").style.display = "inline-block";
    document.getElementById("btn-last-read").style.display = "inline-block";
    document.getElementById("sign-in").style.display = "inline-block";
    document.getElementById("btn-library-settings").style.display = "inline-block";

    // Conditionally restore view mode toggle or group back button based on context
    const viewModeSelector = document.getElementById("library-view-mode");
    const backGroupBtn = document.getElementById("btn-back-group");

    if (activeGroupFilterId !== null) {
        if (viewModeSelector) viewModeSelector.style.display = "none";
        if (backGroupBtn) backGroupBtn.style.display = "inline-block";
        // Re-render the folder specific title banner if in sub-directory
        document.getElementById("current-group-indicator").style.display = "inline";
    } else {
        if (viewModeSelector) viewModeSelector.style.display = "inline-block";
        if (backGroupBtn) backGroupBtn.style.display = "none";
    }

    // Send the final reading position to the cloud right away — the regular
    // progress push is throttled to once per ~20s, so without this the last
    // few seconds of a session could be lost to the cloud (still safe locally)
    if (activeBookObject && typeof forcePushBookProgressToCloud === "function") {
        forcePushBookProgressToCloud(activeBookObject.id);
    }

    /*
     Leaving the reader for the library is a session boundary just like
     backgrounding the tab or closing it - see the real reading-session
     engine (startReadingSession/endReadingSession) in
     09-stats-and-context-menu.js. saveTimeToDB() flushes the exact
     trailing timeSpentSeconds first so nothing is lost between the last
     batched write and now, then endReadingSession() closes out and
     persists whatever session was open for the book being left.
    */
    if (typeof saveTimeToDB === "function") saveTimeToDB();
    if (typeof endReadingSession === "function") endReadingSession("leftReader");

    activeBookObject = null;
    stopActiveReadingTimer();
    fetchLocalLibrary();
}

function setupKeyboardListeners() {
  window.addEventListener("keydown", (e) => {
    const readerActive = document
      .getElementById("reader-view")
      .classList.contains("active");
    if (!readerActive) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      stepToNextChapter();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepToPrevChapter();
    }
  });
}