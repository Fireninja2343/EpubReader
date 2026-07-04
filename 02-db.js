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
      sortLibrary(); // Automatically sorts data via chosen parameters controls routines
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
    groupId: activeGroupFilterId, // Binds structural item directly inside active working directories scopes
    lastModified: new Date().getTime(), // Used by Firebase sync to resolve which device has the newer copy
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

// Firestore's free tier caps writes at 20k/day. trackReadingProgress() fires on
// every scroll pixel, so pushing to the cloud on every call burns through that
// cap in minutes of normal reading. IndexedDB still gets written every time
// (that's free and instant) — only the Firestore push is throttled.
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

// Bypasses the throttle above — call this right before we're about to lose
// track of the in-memory reading session (closing the book, tab backgrounded,
// tab closing) so the last few seconds of progress still reach the cloud.
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