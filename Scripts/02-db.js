// -----------------------------------------------------------------
// DATABASE MANAGEMENT PERSISTENCE CORE
// -----------------------------------------------------------------
function initIndexedDB() {
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
      // Fire-and-forget: backfills missing totalPages/totalWords/chapterCount on
      // older books. Runs in the background so rendering is not delayed, and is a
      // no-op after each book has already been migrated.
      if (typeof migrateMissingBookMetadata === "function") {
          migrateMissingBookMetadata();
      }
      // Fire-and-forget migration for missing lastModified fields on books/groups.
      // Runs after fetch like the metadata migration above. Once all records have
      // timestamps, it performs no writes on future runs.
      
      if (typeof migrateMissingLastModified === "function") {
        migrateMissingLastModified();
      }
    };
  };
}

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
      // Real reading-session log (see continueOrStartReadingSession/endReadingSession() in
      // 12-context-menu.js). Tracks actual engaged reading time instead
      // of estimating from launches and total time.
      readingSessions: [],
      // Raw per-session activity log powering the reading-activity heatmap
      // (17-reading-history.js). Stores timestamps and chapter progress so metrics
      // like pages/day can be derived later without storing derived values.
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
 Firestore has a limited daily write quota, so pushing every scroll update
 would quickly exhaust it during normal reading.
 IndexedDB is still updated immediately;
 only Firestore writes are throttled so each book syncs at most once per
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
        forceImmediateCloudPush lets callers bypass the normal 20s throttle for
        important updates, such as chapter changes.

        The timestamp is still updated after the push, so forced pushes also reset
        the throttle window instead of creating additional queued writes.
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
 Marks a book as read and syncs the change locally and to the cloud.
 Called when the user reaches the end of the last chapter, preventing books
 from remaining "In Progress" when they were completed through reading.
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
 Picks the best available completedDate estimate for books marked isRead
 before completedDate existed.

 Uses fields in trust order: lastOpened, lastModified, firstOpened, then
 the current time only if no better timestamp exists.
*/
function estimateCompletionDate(book) {
  return book.lastOpened || book.lastModified || book.firstOpened || new Date().getTime();
}

/*
 GENERIC FIELD-BACKFILL MIGRATION PRIMITIVE

 Provides reusable field backfilling for synced records that need missing
 values, such as lastModified timestamps required for conflict resolution.

 Parameterized by store, field, missing check, value generator, and optional
 cloud push so future migrations reuse this instead of duplicating loops.

 Resolves with the number of updated records. Only modifies missing fields,
 making repeated runs safe without migration flags.
*/
function backfillMissingField(storeName, isMissing, computeValue, fieldName, pushFn) {
  return new Promise((resolve) => {
    if (!db) {
      resolve(0);
      return;
    }
    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    const updatedRecords = [];
    request.onsuccess = () => {
      const allRecords = request.result;
      for (const record of allRecords) {
        if (isMissing(record)) {
          record[fieldName] = computeValue(record);
          store.put(record);
          updatedRecords.push(record);
        }
      }
    };
    transaction.oncomplete = () => {
      if (typeof pushFn === "function") {
        updatedRecords.forEach((r) => pushFn(r));
      }
      resolve(updatedRecords.length);
    };
    transaction.onerror = () => resolve(0);
  });
}

/*
 Runs lastModified backfill for synced local data types:
 books and groups. Notes/tags use their own migration from 12-notes.js.

 Adding another synced store only requires another backfillMissingField()
 call in the owning load hook, not a new migration function.

 estimateLastModifiedFallback() uses the best available timestamp signal
 instead of always using "now", avoiding false recent edits during sync
 conflict resolution.
*/
function migrateMissingLastModified() {
  backfillMissingField(
    STORE_BOOKS,
    (book) => !book.lastModified,
    (book) => book.lastOpened || book.dateImported || Date.now(),
    "lastModified",
    typeof pushBookMetadataToCloud === "function" ? pushBookMetadataToCloud : null,
  );
  backfillMissingField(
    STORE_GROUPS,
    (group) => !group.lastModified,
    () => Date.now(),
    "lastModified",
    typeof pushGroupToCloud === "function" ? pushGroupToCloud : null,
  );
}

/*
 Finds books marked as read but missing completedDate, then fills it using
 estimateCompletionDate().
 Never overwrites existing dates. Resolves with the number of updated books
 so callers can report the migration result.
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
 Directly sets or clears a book's completedDate for manual edits.
 Unlike migration functions, this can overwrite existing dates or clear
 them entirely, since manual changes are not limited by migration rules.
*/
function setBookCompletionDate(bookId, completedDateValue) {
  return updateBookRecord(bookId, (record) => {
    record.completedDate = completedDateValue;
  }).then((record) => !!record);
}
function setBookStartDate(bookId, firstOpenedValue) {
    return updateBookRecord(bookId, (record) => {
        record.firstOpened = firstOpenedValue;
    }).then((record) => !!record);
}

/*
 Called once per reader launch, where each visit counts as a new session.

 firstOpened is only set once, while lastOpened and totalSessions update on
 every open. totalSessions remains launch-based for compatibility; actual
 engaged-reading sessions are tracked separately through readingSessions.
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
 Appends a completed real reading session to readingSessions and persists
 it. This is used when a session actually ends, unlike recordReadingSessionStart()
 which only tracks launches.

 Trims stored sessions to MAX_STORED_SESSIONS_PER_BOOK and defaults missing
 arrays to [] so older books require no migration.
*/
function appendReadingSession(bookId, sessionRecord) {
  if (!bookId || !db || !sessionRecord) return Promise.resolve(false);
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
 Appends a completed real reading session to readingSessions and persists
 it. This is used when a session actually ends, unlike recordReadingSessionStart()
 which only tracks launches.

 Trims stored sessions to MAX_STORED_SESSIONS_PER_BOOK and defaults missing
 arrays to [] so older books require no migration.
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
        const now = Date.now();
        const last = lastCloudProgressPush[bookId] || 0;
        if (now - last >= CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
          lastCloudProgressPush[bookId] = now;
          pushBookMetadataToCloud(updatedRecord);
        }
      }
      resolve(!!updatedRecord);
    };
    
    transaction.onerror = () => resolve(false);
  });
}

const FORCE_PUSH_MIN_GAP_MS = Config.Sync.FORCE_PUSH_MIN_GAP_MS;
let lastForcedCloudProgressPush = {};
function forcePushBookProgressToCloud(bookId) {
  if (!bookId || typeof pushBookMetadataToCloud !== "function") return;
  const now = Date.now();
  const lastForced = lastForcedCloudProgressPush[bookId] || 0;
  if (now - lastForced < FORCE_PUSH_MIN_GAP_MS) return;
  lastForcedCloudProgressPush[bookId] = now;

  const transaction = db.transaction([STORE_BOOKS], "readonly");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      lastCloudProgressPush[bookId] = now;
      pushBookMetadataToCloud(record);
    }
  };
}