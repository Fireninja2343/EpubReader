// -----------------------------------------------------------------
// DATABASE MANAGEMENT PERSISTENCE CORE
// -----------------------------------------------------------------
function initIndexedDB() {
  /*
   Bumped from 2 to 3 to add the externalStats store below, used for
   archived reading history imported independently from the local library.
   Existing users on version 1 or 2 will have onupgradeneeded fire once,
   which only adds whichever stores are missing and leaves books/groups
   (and their data) untouched.
  */
  const request = indexedDB.open(DB_NAME, 3);
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
    /*
     Archive-only store: imported reading history that must never be merged
     into or overwrite STORE_BOOKS. localBookLinkId is reserved for a future
     linking feature and stays null until that's implemented.
    */
    if (!database.objectStoreNames.contains(STORE_EXTERNAL_STATS)) {
      database.createObjectStore(STORE_EXTERNAL_STATS, {
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

/*
 Loads the archive store (imported reading-history records) into its own
 in-memory cache, mirroring fetchLocalLibrary()'s pattern for
 loadedBooksMemory/loadedGroupsMemory above. This is intentionally kept
 separate from loadedBooksMemory and never merged with it, since archive
 data must never overwrite or blend with the local library.
*/
function fetchExternalStatsLibrary() {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_EXTERNAL_STATS], "readonly");
    const store = transaction.objectStore(STORE_EXTERNAL_STATS);
    const request = store.getAll();
    request.onsuccess = () => {
      loadedExternalStatsMemory = request.result;
      resolve(loadedExternalStatsMemory);
    };
    request.onerror = () => resolve(loadedExternalStatsMemory);
  });
}

/*
 The archive CSV format is fixed (see importExternalCSVStats() below); this
 is a small local parser rather than a shared util, since titles/authors
 can contain commas and quoted fields, and no CSV library already exists
 in this codebase. Handles quoted fields, embedded commas, and escaped
 double-quotes ("") inside quoted fields per standard CSV escaping.
*/
function parseCSVIntoRows(csvText) {
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\r") {
        // Skip; \n (handled below) marks the actual row boundary
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
  }
  // Final field/row if the file doesn't end with a trailing newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/*
 Fixed header order expected in the archive CSV export. Validated against
 the file's actual header row in importExternalCSVStats() below.
*/
const EXTERNAL_CSV_EXPECTED_HEADERS = [
  "Title",
  "Read Status",
  "Date Added",
  "Authors",
  "Date Started",
  "Date Ended",
  "Star Rating",
  "Number of Pages",
];

/*
 Imports an external reading-history CSV into STORE_EXTERNAL_STATS,
 replacing whatever archive data was previously imported (this store is
 wiped and repopulated, not appended to or diffed against). This never
 touches STORE_BOOKS, so the local library is untouched either way.

 Deliberately isolated to importing + loading: no linking to local books
 (localBookLinkId is always left null here) and no cloud sync of any kind.
*/
function importExternalCSVStats(csvText) {
  const rows = parseCSVIntoRows(csvText).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (rows.length === 0) {
    return Promise.reject(new Error("CSV file is empty."));
  }

  const headerRow = rows[0].map((h) => h.trim());
  const headersMatch =
    headerRow.length === EXTERNAL_CSV_EXPECTED_HEADERS.length &&
    EXTERNAL_CSV_EXPECTED_HEADERS.every((expected) => headerRow.includes(expected));
  if (!headersMatch) {
    return Promise.reject(
      new Error(
        `CSV headers do not match the expected format. Expected: ${EXTERNAL_CSV_EXPECTED_HEADERS.join(", ")}`,
      ),
    );
  }

  // Map header name -> column index, so column order in the file doesn't matter
  const columnIndex = {};
  EXTERNAL_CSV_EXPECTED_HEADERS.forEach((headerName) => {
    columnIndex[headerName] = headerRow.indexOf(headerName);
  });

  const dataRows = rows.slice(1);

  const toNullableString = (value) => {
    const trimmed = (value || "").trim();
    return trimmed === "" ? null : trimmed;
  };
  const toNullableNumber = (value) => {
    const trimmed = (value || "").trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const parsedEntries = [];
  for (const cols of dataRows) {
    // Skip fully empty rows (e.g. trailing blank lines in the file)
    const isEmptyRow = cols.every((c) => c.trim() === "");
    if (isEmptyRow) continue;

    parsedEntries.push({
      title: toNullableString(cols[columnIndex["Title"]]),
      readStatus: toNullableString(cols[columnIndex["Read Status"]]),
      dateAdded: toNullableString(cols[columnIndex["Date Added"]]),
      authors: toNullableString(cols[columnIndex["Authors"]]),
      dateStarted: toNullableString(cols[columnIndex["Date Started"]]),
      dateEnded: toNullableString(cols[columnIndex["Date Ended"]]),
      starRating: toNullableNumber(cols[columnIndex["Star Rating"]]),
      numberOfPages: toNullableNumber(cols[columnIndex["Number of Pages"]]),
      /* Reserved for a future linking feature; never populated by import. */
      localBookLinkId: null,
    });
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EXTERNAL_STATS], "readwrite");
    const store = transaction.objectStore(STORE_EXTERNAL_STATS);

    // Replace, not append: wipe whatever was previously imported first.
    store.clear().onsuccess = () => {
      parsedEntries.forEach((entry) => store.add(entry));
    };

    transaction.oncomplete = async () => {
      // Reload the in-memory archive cache using the same loading pattern
      // used for the local library above.
      await fetchExternalStatsLibrary();
      // Refresh the stats page via its existing refresh mechanism, if present.
      if (typeof refreshStatsPage === "function") {
        refreshStatsPage();
      }
      resolve(loadedExternalStatsMemory);
    };
    transaction.onerror = (e) => reject(e.target.error);
  });
}

/*
 -----------------------------------------------------------------
 LOCAL BOOK <-> ARCHIVE ENTRY LINKING

 The local library (STORE_BOOKS) and the imported archive
 (STORE_EXTERNAL_STATS) remain fully independent stores. Linking only ever
 writes a pair of id references (externalLinkId / localBookLinkId) between
 them - never page counts, ratings, reading statistics, or dates - unless a
 caller explicitly opts in via the copyOptions flags below, all of which
 default to false.
 -----------------------------------------------------------------
*/

/*
 Links a local book with an archive entry: writes archiveId onto the local
 book's externalLinkId and bookId onto the archive entry's localBookLinkId.
 Both writes happen inside a single IndexedDB transaction spanning both
 stores, so the link is written to both sides together or not at all.

 copyOptions lets a caller opt in to copying specific fields from the local
 book into the archive entry at link time; every flag defaults to false, and
 nothing is copied unless the corresponding flag is explicitly true. Field
 mapping (schemas don't line up 1:1 between the two stores):
  - copyPageCount: local totalPages -> archive numberOfPages
  - copyRating: local books have no rating field today, so this is a no-op
    reserved for if/when one is added
  - copyReadingStats: local firstOpened -> archive dateStarted
  - copyDates: local dateImported -> archive dateAdded (only if dateAdded is
    currently empty, so an existing imported date isn't overwritten), and
    local completedDate -> archive dateEnded
*/
function linkLocalBookWithArchiveEntry(bookId, archiveId, copyOptions = {}) {
  if (!bookId || !archiveId || !db) return Promise.resolve();

  const {
    copyPageCount = false,
    copyRating = false,
    copyReadingStats = false,
    copyDates = false,
  } = copyOptions;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BOOKS, STORE_EXTERNAL_STATS], "readwrite");
    const booksStore = transaction.objectStore(STORE_BOOKS);
    const archiveStore = transaction.objectStore(STORE_EXTERNAL_STATS);

    booksStore.get(bookId).onsuccess = (e) => {
      const bookRecord = e.target.result;
      if (!bookRecord) return;

      archiveStore.get(archiveId).onsuccess = (e2) => {
        const archiveRecord = e2.target.result;
        if (!archiveRecord) return;

        bookRecord.externalLinkId = archiveId;
        bookRecord.lastModified = new Date().getTime();
        archiveRecord.localBookLinkId = bookId;

        if (copyPageCount && bookRecord.totalPages != null) {
          archiveRecord.numberOfPages = bookRecord.totalPages;
        }
        if (copyRating) {
          // No-op: local books have no rating field to copy from today.
        }
        if (copyReadingStats && bookRecord.firstOpened != null) {
          archiveRecord.dateStarted = bookRecord.firstOpened;
        }
        if (copyDates) {
          if (bookRecord.dateImported != null && !archiveRecord.dateAdded) {
            archiveRecord.dateAdded = bookRecord.dateImported;
          }
          if (bookRecord.completedDate != null) {
            archiveRecord.dateEnded = bookRecord.completedDate;
          }
        }

        booksStore.put(bookRecord);
        archiveStore.put(archiveRecord);

        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.externalLinkId = archiveId;
        }
      };
    };

    transaction.oncomplete = async () => {
      // Reuse the existing loading helpers so both in-memory caches reflect
      // the new link right away.
      await fetchLocalLibrary();
      await fetchExternalStatsLibrary();
      resolve();
    };
    transaction.onerror = (e) => reject(e.target.error);
  });
}

/*
 Removes the link between a local book and an archive entry from both
 sides, in a single transaction (same atomicity guarantee as
 linkLocalBookWithArchiveEntry() above). Only clears the link fields, and
 only if they actually still point at each other; nothing else on either
 record is touched.
*/
function unlinkLocalBookAndArchiveEntry(bookId, archiveId) {
  if (!bookId || !archiveId || !db) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BOOKS, STORE_EXTERNAL_STATS], "readwrite");
    const booksStore = transaction.objectStore(STORE_BOOKS);
    const archiveStore = transaction.objectStore(STORE_EXTERNAL_STATS);

    booksStore.get(bookId).onsuccess = (e) => {
      const bookRecord = e.target.result;
      if (bookRecord && bookRecord.externalLinkId === archiveId) {
        bookRecord.externalLinkId = null;
        bookRecord.lastModified = new Date().getTime();
        booksStore.put(bookRecord);
        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.externalLinkId = null;
        }
      }
    };

    archiveStore.get(archiveId).onsuccess = (e) => {
      const archiveRecord = e.target.result;
      if (archiveRecord && archiveRecord.localBookLinkId === bookId) {
        archiveRecord.localBookLinkId = null;
        archiveStore.put(archiveRecord);
      }
    };

    transaction.oncomplete = async () => {
      await fetchLocalLibrary();
      await fetchExternalStatsLibrary();
      resolve();
    };
    transaction.onerror = (e) => reject(e.target.error);
  });
}

/*
 Creates a brand-new archive record from an existing local book. Per the
 "never copy stats" rule above, only title and authors are copied over -
 no page counts, ratings, reading stats, or dates. Status is set to
 "currently-reading" since spinning up a fresh archive record from a book
 implies the user is currently reading it. The new record is immediately
 linked back to the source book via linkLocalBookWithArchiveEntry() above,
 with no copyOptions passed, so no other fields cross over at link time
 either.
*/
function createArchiveEntryFromLocalBook(bookId) {
  if (!bookId || !db) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const readTransaction = db.transaction([STORE_BOOKS], "readonly");
    readTransaction.objectStore(STORE_BOOKS).get(bookId).onsuccess = (e) => {
      const bookRecord = e.target.result;
      if (!bookRecord) {
        resolve(null);
        return;
      }

      const writeTransaction = db.transaction([STORE_EXTERNAL_STATS], "readwrite");
      const archiveStore = writeTransaction.objectStore(STORE_EXTERNAL_STATS);
      const newEntry = {
        title: bookRecord.title ?? null,
        // Local books have no authors field today; left null until one exists.
        authors: bookRecord.authors ?? null,
        readStatus: "currently-reading",
        dateAdded: null,
        dateStarted: null,
        dateEnded: null,
        starRating: null,
        numberOfPages: null,
        localBookLinkId: null,
      };

      archiveStore.add(newEntry).onsuccess = (e2) => {
        const newArchiveId = e2.target.result;
        linkLocalBookWithArchiveEntry(bookId, newArchiveId).then(() => resolve(newArchiveId));
      };
      writeTransaction.onerror = (e2) => reject(e2.target.error);
    };
    readTransaction.onerror = (e) => reject(e.target.error);
  });
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
      externalLinkId: null,
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

 If this book is linked to an archive entry (externalLinkId set), the
 completion is mirrored onto that archive record too: readStatus becomes
 "read", and dateEnded is filled in with the same completedDate timestamp
 only if it was previously empty, so a real completion date already
 present in the imported archive data isn't overwritten. Only these two
 fields are synchronized - no page counts, ratings, or anything else
 crosses over, per the "stores stay independent" rule used throughout the
 rest of this file's linking helpers.
*/
function markBookAsRead(bookId) {
  if (!bookId || !db) return;
  const transaction = db.transaction([STORE_BOOKS, STORE_EXTERNAL_STATS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  const archiveStore = transaction.objectStore(STORE_EXTERNAL_STATS);
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

      if (record.externalLinkId) {
        archiveStore.get(record.externalLinkId).onsuccess = (e2) => {
          const archiveRecord = e2.target.result;
          if (archiveRecord) {
            archiveRecord.readStatus = "read";
            if (!archiveRecord.dateEnded) {
              archiveRecord.dateEnded = record.completedDate;
            }
            archiveStore.put(archiveRecord);
          }
        };
      }
    }
  };
  transaction.oncomplete = () => {
    // Reuse the existing archive loading helper so loadedExternalStatsMemory
    // reflects the synced status right away.
    fetchExternalStatsLibrary();
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