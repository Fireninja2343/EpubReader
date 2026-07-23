// =================================================================
// BACKUP: EXPORT / IMPORT ENTIRE LIBRARY AS JSON
// =================================================================
/*
 The backup file mirrors all local stores and relevant localStorage settings,
 not just books and groups. It acts as an offline equivalent of Hard
 Pull/Hard Push, allowing full library migration or recovery without cloud
 access.

 Any new synced data type added to the app should also be added here and to
 the Hard Pull/Push checklists in 19-danger-zone.js.
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

// Settings/preferences: includes values mirrored to Firestore by
// pushNoteSettingsToCloud() and local-only reader/library UI settings such as theme, font, and hidden buttons.
// Backup preserves both so settings can transfer between devices even when they are not cloud-synced.
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
        // A reload ensures restored localStorage settings are picked up, since
        // theme, font, hidden reader buttons, note tag layout, and similar settings
        // are only initialized during page load.
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