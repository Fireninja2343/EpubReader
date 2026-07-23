// =================================================================
// DRAG REORDERING DEPENDENCIES
// =================================================================
let draggedIndicesGroup = [];

function handleCardDragStart(e) {
  const currentBookId = Number(this.dataset.bookId);

  if (!selectedBookIds.includes(currentBookId)) {
    selectedBookIds = [currentBookId];

    document.querySelectorAll(".book-card").forEach((c) => {
      c.classList.toggle(
        "selected",
        Number(c.dataset.bookId) === currentBookId
      );
    });
  }

  draggedIndicesGroup = [...selectedBookIds];

  draggedIndicesGroup.forEach((id) => {
    const card = document.querySelector(
      `.book-card[data-book-id='${id}']`
    );
    if (card) card.classList.add("dragging");
  });

  e.dataTransfer.setData("text/plain", "grouped-cards");
}

function handleCardDragEnd() {
  document
    .querySelectorAll(".book-card")
    .forEach((c) => c.classList.remove("dragging"));
}

function handleCardDragOver(e) {
  e.preventDefault();
}

function allowGridDrop(e) {
  e.preventDefault();
}

function handleCardDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const targetBookId = Number(this.dataset.bookId);

  if (draggedIndicesGroup.includes(targetBookId)) return;

  const itemsMoving = draggedIndicesGroup
    .map(id => loadedBooksMemory.find(b => b.id === id))
    .filter(Boolean);

  let filteredLibrary = loadedBooksMemory.filter(
    (b) => !draggedIndicesGroup.includes(b.id)
  );

  const targetBook = loadedBooksMemory.find(b => b.id === targetBookId);
  let adjustedTargetIdx = filteredLibrary.indexOf(targetBook);

  if (adjustedTargetIdx === -1) adjustedTargetIdx = filteredLibrary.length;

  filteredLibrary.splice(adjustedTargetIdx, 0, ...itemsMoving);

  //loadedBooksMemory = filteredLibrary;

  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);

  // IMPORTANT: use filteredLibrary (new order)
  filteredLibrary.forEach((book, idx) => {
    book.sortOrder = idx;
    store.put(book);
  });

  transaction.oncomplete = () => {
    loadedBooksMemory = filteredLibrary; // keep UI in sync
    renderLibraryGrid();
  };
}

// =================================================================
// BACKUP: EXPORT / IMPORT ENTIRE LIBRARY AS JSON
// =================================================================
/*
 The backup file is deliberately a COMPLETE mirror of every local store
 plus the app's localStorage settings keys - not just books/groups - so it
 doubles as an offline-capable equivalent to Hard Pull/Hard Push (see
 15-danger-zone.js): if there's no internet, or the user isn't signed in
 to cloud sync at all, this JSON file is the only way to move a full
 library (including notes and tags) between devices or recover from a
 wipe. Whenever a new synced data type is added to the app, it should be
 added here too, the same way it must be added to the Hard Pull/Push
 checklists in 15-danger-zone.js.
*/
// =================================================================
// BACKUP: EXPORT (preserves EPUB files, notes, tags, and settings)
// =================================================================
async function exportLibraryToJSON() {
  const transaction = db.transaction(
    [STORE_BOOKS, STORE_GROUPS, STORE_NOTES, STORE_NOTE_GROUPS],
    "readonly"
  );
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);
  const notesStore = transaction.objectStore(STORE_NOTES);
  const noteGroupsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  const books = await getAllFromStore(booksStore);
  const groups = await getAllFromStore(groupsStore);
  const notes = await getAllFromStore(notesStore);
  const noteGroups = await getAllFromStore(noteGroupsStore);

  // Convert files safely
  const safeBooks = await Promise.all(
    books.map(async (b) => {
      let fileData = null;

      if (b.fileData instanceof File || b.fileData instanceof Blob) {
        fileData = await convertBlobToBase64(b.fileData);
      } else {
        fileData = b.fileData || null;
      }

      return {
        ...b,
        fileData
      };
    })
  );

  // Settings/preferences: the same localStorage-backed values mirrored to
  // Firestore by pushNoteSettingsToCloud() in 11-firebase-sync.js, plus the
  // reader/library interface config (theme, font, hidden buttons, etc.)
  // that's never synced to the cloud at all - so a local-only backup is
  // the only way to carry those settings across devices too.
  const settings = {
    userConfig: safeParseLocalStorageJSON(Config.Db.USER_CONFIG_STORAGE_KEY),
    collapsedNoteTagKeys: safeParseLocalStorageJSON(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY),
    lastUsedNoteTagIds: safeParseLocalStorageJSON(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY),
  };

  const backupPackage = {
    exportDate: new Date().toISOString(),
    // Bumped alongside the schema below - importLibraryFromJSON() uses this
    // only to decide whether notes/tags/settings are present, never to
    // reject an older backup outright, so pre-existing backups still import.
    schemaVersion: 2,
    books: safeBooks,
    groups: groups,
    notes: notes,
    noteGroups: noteGroups,
    settings: settings,
  };

  const blob = new Blob([JSON.stringify(backupPackage)], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `EpubReader_Backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

// Small helper so a missing/corrupt localStorage key just yields null in
// the backup instead of throwing and aborting the whole export.
function safeParseLocalStorageJSON(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function importLibraryFromJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = function (e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.books || !data.groups) throw new Error("Invalid schema");

      const storesToClear = [STORE_BOOKS, STORE_GROUPS, STORE_NOTES, STORE_NOTE_GROUPS];
      const transaction = db.transaction(storesToClear, "readwrite");

      const booksStore = transaction.objectStore(STORE_BOOKS);
      const groupsStore = transaction.objectStore(STORE_GROUPS);
      const notesStore = transaction.objectStore(STORE_NOTES);
      const noteGroupsStore = transaction.objectStore(STORE_NOTE_GROUPS);

      booksStore.clear();
      groupsStore.clear();
      notesStore.clear();
      noteGroupsStore.clear();

      data.groups.forEach((g) => groupsStore.put(g));

      data.books.forEach((b) => {
        let fileData = null;

        if (b.fileData && typeof b.fileData === "string") {
          fileData = base64ToBlob(b.fileData);
        }

        booksStore.put({
          ...b,
          fileData
        });
      });

      // Notes/note tags are only present in backups made after the export
      // above started including them (schemaVersion >= 2) - older backups
      // simply have nothing to restore here, which is fine since those
      // stores were already cleared above to match a full restore.
      if (Array.isArray(data.noteGroups)) {
        data.noteGroups.forEach((g) => noteGroupsStore.put(g));
      }
      if (Array.isArray(data.notes)) {
        data.notes.forEach((n) => notesStore.put(n));
      }

      transaction.oncomplete = () => {
        // Settings/preferences restore directly into localStorage - not part
        // of the IndexedDB transaction above, so this only runs once that
        // transaction has actually committed successfully.
        if (data.settings) {
          restoreLocalStorageJSON(Config.Db.USER_CONFIG_STORAGE_KEY, data.settings.userConfig);
          restoreLocalStorageJSON(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY, data.settings.collapsedNoteTagKeys);
          restoreLocalStorageJSON(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY, data.settings.lastUsedNoteTagIds);
        }

        alert("Library restored successfully! Reloading to apply restored settings…");
        // A reload (rather than just fetchLocalLibrary()) ensures restored
        // localStorage settings - theme, font, hidden reader buttons, note
        // tag layout - are actually picked back up, since those are only
        // read once on page load (see loadSavedUserInterfaceSettings() in
        // 07-reader-controls.js and the collapsedNoteTagKeys initializer in
        // 12-notes.js).
        setTimeout(() => window.location.reload(), 600);
      };
      transaction.onerror = () => {
        alert("Failed to restore backup: " + (transaction.error ? transaction.error.message : "unknown error"));
      };
    } catch (err) {
      alert("Failed to parse backup file.");
    }
  };

  reader.readAsText(file);
}

// Writes a value back into localStorage as JSON, skipping keys that were
// null/absent in the backup (e.g. an older backup file with no settings
// bundle) rather than clobbering whatever's already on this device.
function restoreLocalStorageJSON(key, value) {
  if (value === null || value === undefined) return;
  localStorage.setItem(key, JSON.stringify(value));
}