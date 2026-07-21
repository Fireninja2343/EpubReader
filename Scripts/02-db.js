// -----------------------------------------------------------------
// DATABASE MANAGEMENT PERSISTENCE CORE
// -----------------------------------------------------------------
function initIndexedDB() {
  /*
   Bumped from 1 to 2 to add the notes/noteGroups stores below. Existing
   users on version 1 will have onupgradeneeded fire once, which only adds
   the two new stores and leaves books/groups (and their data) untouched.
  */
  const request = indexedDB.open(DB_NAME, 2);
  request.onupgradeneeded = (e) => {
    const database = e.target.result;
    if (!database.objectStoreNames.contains(STORE_BOOKS)) {
      database.createObjectStore(STORE_BOOKS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_GROUPS)) {
      database.createObjectStore(STORE_GROUPS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_NOTES)) {
      database.createObjectStore(STORE_NOTES, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_NOTE_GROUPS)) {
      database.createObjectStore(STORE_NOTE_GROUPS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
  };
  request.onsuccess = (e) => {
    db = e.target.result;
    fetchLocalLibrary();
    // Guarded the same way pushBookMetadataToCloud() calls are elsewhere in this
    // codebase, since 12-notes.js only exists once the notes feature is loaded.
    if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
  };
  // Without this handler, a failure to open IndexedDB (blocked by private
  // browsing settings, storage quota issues, another tab holding an
  // incompatible version open, etc.) fails completely silently — the
  // library just never loads and nothing tells the user why.
  request.onerror = (e) => {
    console.error("Failed to open IndexedDB:", e.target.error);
    alert(
      "Could not open the local library database. Your browser may be blocking storage (e.g. private browsing mode), or another tab may need to be closed.",
    );
  };
}

function fetchLocalLibrary() {
  const transaction = db.transaction([STORE_BOOKS, STORE_GROUPS], "readonly");
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);

  let booksRequest = booksStore.getAll();
  let groupsRequest = groupsStore.getAll();

  booksRequest.onsuccess = () => {
    loadedBooksMemory = booksRequest.result;
    groupsRequest.onsuccess = () => {
      loadedGroupsMemory = groupsRequest.result;
      /* Re-sort the in-memory library list according to whatever sort
         option (title, date added, progress, etc.) the user currently
         has selected, so the UI reflects that ordering right away. */
      sortLibrary();
      /*
       Fire-and-forget: backfills totalPages/totalWords/chapterCount on any
       book that predates those fields (see ensureBookMetadataCached() in
       06-epub-reader.js). Not awaited here so the library still renders
       immediately; it's a no-op per book once that book has been migrated,
       so calling it after every fetch costs nothing on repeat visits.
      */
      if (typeof migrateMissingBookMetadata === "function") {
        migrateMissingBookMetadata();
      }
    };
  };
}

// Returns a Promise that resolves only once the book has actually been
// written to IndexedDB (previously this function returned nothing, so
// handleFileImport()'s "await saveBookToDatabase(...)" was never really
// waiting for anything — see the fix in 06-epub-reader.js).
function saveBookToDatabase(title, coverData, binaryData, analysisMeta = {}) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const entry = {
      title: title,
      cover: coverData,
      fileData: binaryData,
      sortOrder: loadedBooksMemory.length,
      currentChapter: 0,
      scrollOffset: 0,
      isRead: false,
      dateImported: new Date().getTime(),
      /* Whatever group/folder the library is currently filtered to becomes
         the new book's group, so it lands in the collection the user is
         actively looking at instead of an unfiled "all books" view. */
      groupId: activeGroupFilterId,
      /* Timestamp used later to decide which copy (this device's or the
         cloud's) is newer when reconciling data during a Firebase sync. */
      lastModified: new Date().getTime(),
      /* One-time EPUB analysis computed by the caller from the zip it
         already has open (see handleFileImport in 06-epub-reader.js), so
         the stats views never need to reparse this file just to show page
         counts. Left null if the caller didn't pass anything, in which
         case ensureBookMetadataCached() will backfill it later. */
      totalPages: analysisMeta.totalPages ?? null,
      totalWords: analysisMeta.totalWords ?? null,
      chapterCount: analysisMeta.chapterCount ?? null,
      /* Reading-history fields, updated as the book is actually read: see
         recordReadingSessionStart() below and markBookAsRead(). */
      firstOpened: null,
      lastOpened: null,
      completedDate: null,
      totalSessions: 0,
      /* Real reading-session log - see startReadingSession()/endReadingSession()
         in 09-stats-and-context-menu.js. Kept separate from totalSessions
         above (which just counts reader launches) so average session
         length can be computed from actual engaged reading time instead of
         from "time spent / times opened". */
      readingSessions: [],
      /* Raw per-session activity log powering the reading-activity calendar
         heatmap in the stats view - see 13-reading-history.js and
         upsertReadingHistoryEntry() below. Kept separate from readingSessions
         above: readingSessions stores a fully-closed session summary
         (duration + estimated pages), while readingHistory stores the raw
         {startTimestamp, endTimestamp, secondsSpent, chapterStart,
         chapterEnd} data an in-progress session is periodically flushed
         into, so pages/day and other derived stats can be computed later
         without ever storing a derived value here. */
      readingHistory: [],
    };
    store.add(entry).onsuccess = (e) => {
      const newId = e.target.result;
      fetchLocalLibrary();
      // Push the freshly imported book up to the cloud (no-op if not signed in)
      if (typeof pushBookMetadataToCloud === "function") {
        const savedBook = { ...entry, id: newId };
        pushBookMetadataToCloud(savedBook);
        pushBookFileToCloud(savedBook);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve(); // resolve either way so the import loop doesn't hang forever
  });
}

/*
 Firestore's free tier caps writes at 20k/day. Reading progress is tracked
 on every scroll pixel, so pushing to the cloud on every single update
 would burn through that daily cap within minutes of normal reading.
 IndexedDB is written every time regardless (that's local, free, and
 instant) — only the Firestore push is throttled, using the timestamps
 below to make sure at most one cloud write per book happens within each
 CLOUD_PROGRESS_PUSH_INTERVAL_MS window.
*/
let lastCloudProgressPush = {};
// Reuses the single source of truth in Config instead of a second hardcoded
// copy of the same number, which could silently drift out of sync with it.
const CLOUD_PROGRESS_PUSH_INTERVAL_MS = Config.Sync.CLOUD_PROGRESS_PUSH_INTERVAL_MS;

function updateBookProgressInDB(bookId, spinePointer, scrollPosition, forceImmediateCloudPush = false) {
  if (!bookId) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      record.currentChapter = spinePointer;
      record.scrollOffset = scrollPosition;
      record.lastModified = new Date().getTime();
      store.put(record);
      if (typeof pushBookMetadataToCloud === "function") {
        const now = Date.now();
        const last = lastCloudProgressPush[bookId] || 0;
        /*
         forceImmediateCloudPush lets a caller (trackReadingProgress, when it
         detects the chapter itself just changed) bypass the usual 20s
         throttle for this one push. The timestamp below is still updated
         either way, so a forced push here also resets the throttle window
         rather than stacking on top of it.
        */
        if (forceImmediateCloudPush || now - last >= CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
          lastCloudProgressPush[bookId] = now;
          pushBookMetadataToCloud(record);
        }
      }
    }
  };
}

/*
 Sends the latest reading progress to the cloud immediately, ignoring the
 throttle above. This should be called right before the in-memory reading
 session is about to be lost — for example when the reader closes the book,
 the tab is backgrounded, or the tab/window is closing — so the last few
 seconds of progress aren't dropped by the throttle window. The timestamp
 is still updated here so this can't fire twice in immediate succession.
*/
/*
 Flips a book's isRead flag to true and syncs the change locally and to the
 cloud. Called from trackReadingProgress() once the user has actually
 scrolled to the bottom of the last chapter, so books don't stay stuck at
 "In Progress" just because the user never opened the context menu to
 toggle read status manually.
*/
function markBookAsRead(bookId) {
  if (!bookId || !db) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record && !record.isRead) {
      record.isRead = true;
      record.completedDate = new Date().getTime();
      record.lastModified = new Date().getTime();
      store.put(record);
      if (activeBookObject && activeBookObject.id === bookId) {
        activeBookObject.isRead = true;
        activeBookObject.completedDate = record.completedDate;
      }
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(record);
      }
    }
  };
}

/*
 Picks the best available estimate for a completed book's completedDate,
 for books that were marked isRead before completedDate existed as a
 field. Falls through the fields in order of how trustworthy they are as
 a stand-in for "when did this book actually get finished": lastOpened
 (most recent reader visit) first, then lastModified (last time the
 record changed at all), then firstOpened, and only if none of those
 exist does it fall back to right now.
*/
function estimateCompletionDate(book) {
  return book.lastOpened || book.lastModified || book.firstOpened || new Date().getTime();
}

/*
 Finds every book where isRead is true but completedDate is missing
 (older completions predating that field) and backfills it using
 estimateCompletionDate() above. Never overwrites a completedDate that's
 already set. Returns a Promise resolving to the number of books updated,
 so callers (the bulk backfill button and the stats view) can report a
 count back to the user.
*/
function migrateMissingCompletionDates() {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const request = store.getAll();
    const updatedRecords = [];
    request.onsuccess = () => {
      const allBooks = request.result;
      for (const record of allBooks) {
        if (record.isRead && !record.completedDate) {
          record.completedDate = estimateCompletionDate(record);
          record.lastModified = new Date().getTime();
          store.put(record);
          updatedRecords.push(record);
        }
      }
    };
    transaction.oncomplete = () => {
      // Mirror each backfilled record up to the cloud, same as every other write path in this file
      if (typeof pushBookMetadataToCloud === "function") {
        updatedRecords.forEach((r) => pushBookMetadataToCloud(r));
      }
      resolve(updatedRecords.length);
    };
    transaction.onerror = () => resolve(0);
  });
}

/*
 Single-book counterpart to migrateMissingCompletionDates() above, for the
 per-book "Backfill Completion Date" context menu action. Resolves to true
 if the book was updated, false if it didn't need it (already has a date,
 isn't marked read, or wasn't found).
*/
function migrateSingleBookCompletionDate(bookId) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record && record.isRead && !record.completedDate) {
        record.completedDate = estimateCompletionDate(record);
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

/*
 Directly sets (or clears, when passed null) a book's completedDate. This
 is the write path for the manual "Edit Completion Date" and "Clear
 Completion Date" context menu actions - unlike migrateSingleBookCompletionDate()
 above, it's not gated on isRead or on completedDate currently being empty,
 since a manual edit is allowed to overwrite an existing date or blank one
 out outright. The migration functions above are left untouched by this.
*/
function setBookCompletionDate(bookId, completedDateValue) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        record.completedDate = completedDateValue;
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

/*
 Called once per reader launch (see launchEpubReader() in
 06-epub-reader.js) - every visit to the reader counts as a new reading
 session for that book. firstOpened is only ever set the first time;
 lastOpened and totalSessions update on every open after that.

 NOTE: totalSessions here still just counts launches, kept exactly as
 before for backward compatibility with existing stats and cloud data.
 The *actual* engaged-reading session (start time, duration, pages read)
 is tracked separately - see startReadingSession()/endReadingSession() in
 09-stats-and-context-menu.js, which write into readingSessions via
 appendReadingSession() below once a session genuinely ends.
*/
function recordReadingSessionStart(bookId) {
  if (!bookId || !db) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      const now = new Date().getTime();
      if (!record.firstOpened) record.firstOpened = now;
      record.lastOpened = now;
      record.totalSessions = (record.totalSessions || 0) + 1;
      record.lastModified = now;
      store.put(record);
      if (activeBookObject && activeBookObject.id === bookId) {
        activeBookObject.firstOpened = record.firstOpened;
        activeBookObject.lastOpened = record.lastOpened;
        activeBookObject.totalSessions = record.totalSessions;
      }
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(record);
      }
    }
  };
}

/*
 Appends one completed reading-session record to a book's readingSessions
 array and persists it. This is the write path for a *real* session end
 (see endReadingSession() in 09-stats-and-context-menu.js), as opposed to
 recordReadingSessionStart() above which just counts the launch.

 sessionRecord shape: { start, end, durationSeconds, pagesRead, timestamp }

 Trims the array to Config.Reading.MAX_STORED_SESSIONS_PER_BOOK (keeping
 the most recent ones) so this can't grow unbounded for a book that's
 been opened hundreds of times. Existing books that predate this field
 simply have no readingSessions array yet - defaulting to [] here handles
 that transparently, no separate migration needed.
*/
function appendReadingSession(bookId, sessionRecord) {
  if (!bookId || !db || !sessionRecord) return Promise.resolve(false);

  // -----------------------------------------------------------------
  // LOW-TIME & NO-PROGRESS DISCARD GUARD
  // Discard tab-switches or brief opens under 60s OR where 0 pages were read
  // -----------------------------------------------------------------
const duration = sessionRecord.durationSeconds || 0;
  const pages = sessionRecord.pagesRead || 0;

  if (duration < 60 || pages === 0) {
    console.log(`[02-db] Discarded noise session (${duration}s, ${pages} pages read)`);
    
    // Decrement totalSessions so the launcher count isn't inflated by quick peeks
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record && record.totalSessions > 0) {
        record.totalSessions -= 1;
        record.lastModified = Date.now();
        store.put(record);
      }
    };

    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        if (!Array.isArray(record.readingSessions)) record.readingSessions = [];
        record.readingSessions.push(sessionRecord);
        const cap = Config.Reading.MAX_STORED_SESSIONS_PER_BOOK;
        if (record.readingSessions.length > cap) {
          record.readingSessions = record.readingSessions.slice(-cap);
        }
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.readingSessions = record.readingSessions;
        }
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

/*
 Write path for one readingHistory entry - raw {startTimestamp, endTimestamp,
 secondsSpent, chapterStart, chapterEnd} data used by the reading-activity
 calendar/heatmap in the stats view (see 13-reading-history.js).

 Unlike appendReadingSession() above (which only ever appends a fully-closed
 session once), a single in-progress reading session is flushed here
 repeatedly *while it's still open* - see persistHistorySegment() in
 13-reading-history.js, called from the periodic save cadence, chapter
 changes, and session-end. Any entry sharing the same startTimestamp is
 therefore the same still-open segment being extended, not a new one, so it
 gets updated in place rather than appended again - this is what keeps one
 uninterrupted reading session as a single history entry instead of many
 tiny fragments.

 Existing books that predate this field simply have no readingHistory array
 yet; the `if (!Array.isArray(...))` guard below initializes it lazily the
 first time new activity is actually recorded, with no separate migration
 step and no attempt to fabricate any historical entries.
*/
function upsertReadingHistoryEntry(bookId, entry) {
  if (!bookId || !db || !entry) return Promise.resolve(false);
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        if (!Array.isArray(record.readingHistory)) record.readingHistory = [];
        const existingIdx = record.readingHistory.findIndex(
          (h) => h.startTimestamp === entry.startTimestamp
        );
        if (existingIdx !== -1) {
          record.readingHistory[existingIdx] = entry;
        } else {
          record.readingHistory.push(entry);
          const cap = Config.Reading.MAX_STORED_HISTORY_ENTRIES_PER_BOOK;
          if (record.readingHistory.length > cap) {
            record.readingHistory = record.readingHistory.slice(-cap);
          }
        }
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.readingHistory = record.readingHistory;
        }
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

function forcePushBookProgressToCloud(bookId) {
  if (!bookId || typeof pushBookMetadataToCloud !== "function") return;
  const transaction = db.transaction([STORE_BOOKS], "readonly");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      lastCloudProgressPush[bookId] = Date.now();
      pushBookMetadataToCloud(record);
    }
  };
}