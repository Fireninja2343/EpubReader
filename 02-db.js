// -----------------------------------------------------------------
// DATABASE MANAGEMENT PERSISTENCE CORE
// -----------------------------------------------------------------
function initIndexedDB() {
  const request = indexedDB.open(DB_NAME, 1);
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
  };
  request.onsuccess = (e) => {
    db = e.target.result;
    fetchLocalLibrary();
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
    };
  };
}

function saveBookToDatabase(title, coverData, binaryData) {
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
const CLOUD_PROGRESS_PUSH_INTERVAL_MS = 20000;

function updateBookProgressInDB(bookId, spinePointer, scrollPosition) {
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
        if (now - last >= CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
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
      record.lastModified = new Date().getTime();
      store.put(record);
      if (activeBookObject && activeBookObject.id === bookId) {
        activeBookObject.isRead = true;
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