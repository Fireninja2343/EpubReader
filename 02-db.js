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
 Called once per reader launch (see launchEpubReader() in
 06-epub-reader.js) - every visit to the reader counts as a new reading
 session for that book. firstOpened is only ever set the first time;
 lastOpened and totalSessions update on every open after that.
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