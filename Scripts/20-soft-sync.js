/*
 SOFT PULL / SOFT PUSH MODULE
 Interactive, review-before-you-commit counterparts to Hard Pull/Push
 (19-danger-zone.js). Where those are all-or-nothing, Soft Pull/Push:

   1. Compare local vs. cloud for every synced data type without writing
      anything, producing a flat list of "operations" -
      { type, category, id, label, apply() } - classified as an
      addition/update/removal.
   2. Show that list in a modal, grouped by category, with per-row status
      (pending/running/done/error) and running counts.
   3. Let the user run a subset (Apply All / Additions / Updates /
      Removals) - each applies via the SAME per-item push/pull/delete
      primitives Hard Pull/Push and normal incremental sync use, so the
      write path never diverges.
   4. Keep the modal open, update rows live, support pause/cancel between
      operations (cooperative - never aborts one already in flight).

 EXTENSIBILITY: every data type participates through one entry in
 SYNC_TYPE_REGISTRY below. Adding a new type means adding one registry
 entry - the comparison engine, renderer, and apply-queue runner are
 generic over the registry.
*/

// SYNC TYPE REGISTRY - each entry describes one synced data type
// end-to-end (read local/remote, diff, apply). Single place to add a
// new data type.

// Shared fetchRemote() shape: read every doc in a Firestore collection,
// tag each with its numeric id.
async function fetchRemoteCollection(collectionFn) {
  const snap = await collectionFn().get();
  return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
}

/*
 DEEP VALUE EQUALITY + FIELD-LEVEL DIFFING

 ROOT CAUSE (false-positive "0/1 Updates" right after a Hard Push): the
 old comparison JSON.stringify()'d array/object fields before comparing.
 Firestore does NOT guarantee a map field's key order survives a write ->
 read round trip (documented behavior - see firebase/flutterfire#3232), so
 a book with real readingSessions/readingHistory entries could read back
 with the same values in a different key order and get flagged as changed
 purely because stringify bakes in enumeration order.

 Fix: never stringify-then-compare. deepValuesEqual() looks values up by
 key (order-independent for objects/maps) and only cares about array
 *element* order, which is correct since every array field in this
 registry is either an ordered log or pre-sorted by fieldsToCompare().
*/
function deepValuesEqual(a, b) {
  if (a === b) return true;
  // Treat null/undefined/missing as the same "empty" value - defensive
  // second layer; fieldsToCompare() already normalizes most of these.
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    // Keys looked up by name, never enumerated into a string - this is
    // what makes Firestore's unordered map keys a non-issue here.
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepValuesEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false; // primitives of different value already failed === above
}

/*
 Computes every field that differs between two fieldsToCompare() outputs,
 via deepValuesEqual() rather than JSON.stringify + string compare (see
 ROOT CAUSE above). Returns diff rows for both the equality check (empty
 = equal) and the expandable diff UI (non-empty = what to show).

 fieldMeta is the optional { [fieldKey]: { group, label, format } }
 companion object each registry entry can provide (see "Entry shape"
 below) - any key left out defaults sensibly.
*/
function computeFieldDiffs(localFields, remoteFields, fieldMeta = {}) {
  const keys = new Set([...Object.keys(localFields), ...Object.keys(remoteFields)]);
  const diffs = [];
  for (const key of keys) {
    const localValue = localFields[key];
    const remoteValue = remoteFields[key];
    if (deepValuesEqual(localValue, remoteValue)) continue;
    const meta = fieldMeta[key] || {};
    const formatter = meta.format || defaultFormatFieldValue;
    diffs.push({
      key,
      group: meta.group || "Other",
      label: meta.label || defaultFieldLabel(key),
      localValue,
      remoteValue,
      localDisplay: formatter(localValue),
      remoteDisplay: formatter(remoteValue),
    });
  }
  // Stable order (insertion order isn't guaranteed from a merged Set) -
  // sort by group then key so the renderer can start a new group section
  // whenever `group` changes while walking the list.
  diffs.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
  return diffs;
}

/*
 Additions/removals only have one side's data, but every reported
 difference should still be inspectable - an addition is "this whole
 record is new," worth expanding to see, not just a title. Reuses the
 same fieldMeta grouping/labels/formatters as computeFieldDiffs() so an
 addition/removal panel looks identical to an update panel, just with
 only one column populated.
*/
function buildOneSidedFieldSnapshot(fields, fieldMeta = {}, side) {
  const rows = [];
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    const meta = fieldMeta[key] || {};
    const formatter = meta.format || defaultFormatFieldValue;
    rows.push({
      key,
      group: meta.group || "Other",
      label: meta.label || defaultFieldLabel(key),
      localValue: side === "local" ? value : undefined,
      remoteValue: side === "remote" ? value : undefined,
      localDisplay: side === "local" ? formatter(value) : null,
      remoteDisplay: side === "remote" ? formatter(value) : null,
    });
  }
  rows.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
  return rows;
}

// camelCase field key -> "Camel Case" fallback label, used only when a
// registry entry's fieldMeta doesn't specify an explicit label.
function defaultFieldLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// VALUE FORMATTERS (for the expandable diff UI)
function defaultFormatFieldValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return truncateForDiff(JSON.stringify(value));
  return truncateForDiff(String(value));
}

// Epoch-ms timestamp -> locale date/time string. Every date-ish field
// here is stored as a plain number, never a Firestore Timestamp object,
// so this is pure formatting, no Timestamp-vs-number normalization needed.
function formatDiffDate(value) {
  if (value === null || value === undefined) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatDiffDuration(seconds) {
  if (!seconds) return "0s";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h ? `${h}h` : null, m ? `${m}m` : null, `${sec}s`].filter(Boolean).join(" ");
}

// Summarizes an append-ordered log array (readingSessions/readingHistory)
// as a count rather than raw JSON, which would be unreadable for a book
// with hundreds of sessions.
function formatDiffLogArray(noun) {
  return (value) => {
    const arr = Array.isArray(value) ? value : [];
    return `${arr.length} ${noun}${arr.length === 1 ? "" : "s"}`;
  };
}

// Long strings (base64 covers, long note text) are truncated for
// display - shows that a change happened, not a full reproduction.
function truncateForDiff(str, max = 120) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/*
 Entry shape:
   key/label/icon      - id, display name, group-header emoji
   fetchLocal()        -> Promise<local records (each needs an `id`)>.
                         Reads IndexedDB directly, not an in-memory
                         cache, since caches aren't guaranteed populated
                         yet when this runs.
   fetchRemote()       -> Promise<remote records (each needs an `id`)>
   describe(rec)       -> short human label for one record
   fieldsToCompare(rec) -> just the fields that matter for equality, so a
                         differing lastModified alone doesn't get flagged.
                         Return actual values (arrays/objects as-is), not
                         pre-serialized - computeFieldDiffs() compares
                         structurally, so stringifying here would
                         reintroduce the key-order bug above.
   fieldMeta            -> optional { [fieldKey]: { group, label, format } },
                         used only for the expandable diff UI. Any field
                         left out gets a sensible default.
   applyAddition(record)      -> Promise, create the missing side
   applyUpdate(local, remote) -> Promise, overwrite one side with the other
   applyRemoval(id)           -> Promise, delete from the side that has it
 Soft Pull and Soft Push reuse the same registry; only the direction
 (which side is "source of truth") differs - see buildSyncPlan() below.
*/
const SYNC_TYPE_REGISTRY = [
  {
    key: "books",
    label: "Books",
    icon: "📚",
    // Reads IndexedDB directly rather than trusting loadedBooksMemory -
    // see "Entry shape" comment above.
    fetchLocal: () => getAllFromLocalStore(STORE_BOOKS),
    fetchRemote: () => fetchRemoteCollection(booksCollection),
    describe: (rec) => rec.title || `Book #${rec.id}`,
    fieldsToCompare: (rec) => ({
      title: rec.title ?? null,
      cover: rec.cover ?? null,
      sortOrder: rec.sortOrder ?? null,
      currentChapter: rec.currentChapter ?? 0,
      scrollOffset: rec.scrollOffset ?? 0,
      isRead: rec.isRead ?? false,
      groupId: rec.groupId ?? null,
      dateImported: rec.dateImported ?? null,
      timeSpentSeconds: rec.timeSpentSeconds ?? 0,
      totalPages: rec.totalPages ?? null,
      totalWords: rec.totalWords ?? null,
      chapterCount: rec.chapterCount ?? null,
      firstOpened: rec.firstOpened ?? null,
      lastOpened: rec.lastOpened ?? null,
      completedDate: rec.completedDate ?? null,
      totalSessions: rec.totalSessions ?? 0,
      // Passed as real arrays, NOT stringified - see deepValuesEqual()
      // comment above: Firestore doesn't guarantee map-key order, so a
      // genuinely-read book could round-trip with the same session data
      // in a different key order and get wrongly flagged as changed.
      // Array *element* order (append-ordered logs) still matters.
      readingSessions: rec.readingSessions ?? [],
      readingHistory: rec.readingHistory ?? [],
      // File-upload completeness signal: metadata can match perfectly on
      // both sides even when the EPUB binary upload was interrupted
      // mid-pushBookFileToCloud() - chunkCount is only written as that
      // function's last step. Without this field an interrupted upload
      // would show as "already in sync". Local reports "do I have file
      // data at all"; remote reports "does chunkCount look complete".
      hasUsableFile: rec.fileData !== undefined ? !!rec.fileData : !!rec.chunkCount,
    }),
    fieldMeta: {
      title: { group: "Metadata", label: "Title" },
      cover: { group: "Metadata", label: "Cover Image", format: (v) => (v ? "Image set" : "—") },
      sortOrder: { group: "Metadata", label: "Sort Order" },
      groupId: { group: "Metadata", label: "Collection" },
      dateImported: { group: "Metadata", label: "Date Imported", format: formatDiffDate },
      currentChapter: { group: "Reading Progress", label: "Current Chapter" },
      scrollOffset: { group: "Reading Progress", label: "Scroll Position" },
      isRead: { group: "Reading Progress", label: "Marked as Read" },
      firstOpened: { group: "Reading Progress", label: "First Opened", format: formatDiffDate },
      lastOpened: { group: "Reading Progress", label: "Last Opened", format: formatDiffDate },
      completedDate: { group: "Reading Progress", label: "Completed Date", format: formatDiffDate },
      totalSessions: { group: "Statistics", label: "Total Sessions (launches)" },
      timeSpentSeconds: { group: "Statistics", label: "Time Spent", format: formatDiffDuration },
      totalPages: { group: "Statistics", label: "Total Pages" },
      totalWords: { group: "Statistics", label: "Total Words" },
      chapterCount: { group: "Statistics", label: "Chapter Count" },
      readingSessions: { group: "Statistics", label: "Reading Sessions", format: formatDiffLogArray("session") },
      readingHistory: { group: "Statistics", label: "Reading History Entries", format: formatDiffLogArray("entry") },
      hasUsableFile: { group: "File", label: "EPUB File Fully Uploaded" },
    },
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        // downloadBookFromCloud() writes the local record and pulls the
        // chunked file binary, but swallows its own errors (silent no-op
        // if chunkCount is missing / a chunk isn't done uploading) rather
        // than throwing - so success is verified by checking the local
        // store afterward, not by trusting a resolved promise.
        await downloadBookFromCloud(record.id, record);
        const wasWritten = await new Promise((resolve, reject) => {
          const tx = db.transaction([STORE_BOOKS], "readonly");
          const req = tx.objectStore(STORE_BOOKS).get(record.id);
          req.onsuccess = () => resolve(!!req.result);
          req.onerror = () => reject(req.error);
        });
        if (!wasWritten) {
          throw new Error("Cloud file data isn't fully available yet (upload may still be in progress).");
        }
      } else {
        await pushBookMetadataToCloud(record);
        await pushBookFileToCloud(record);
      }
    },
    applyUpdate: async (localRec, remoteRec, direction) => {
      if (direction === "pull") {
        await applyRemoteBookUpdate(localRec.id, remoteRec);
      } else {
        await pushBookMetadataToCloud(localRec);
        // If this update was (partly) triggered by hasUsableFile looking
        // incomplete, pushing metadata alone won't fix it - chunkCount
        // only gets set by re-running pushBookFileToCloud(). Re-checking
        // here instead of always re-uploading keeps a plain rename from
        // re-uploading the whole EPUB for no reason.
        if (!remoteRec.chunkCount && localRec.fileData) {
          await pushBookFileToCloud(localRec);
        }
      }
    },
    applyRemoval: async (id, direction) => {
      if (direction === "pull") {
        await deleteBookLocallyOnly(id);
      } else {
        await deleteBookFromCloud(id);
      }
    },
  },
  {
    key: "groups",
    label: "Collections / Groups",
    icon: "🗂️",
    fetchLocal: () => getAllFromLocalStore(STORE_GROUPS),
    fetchRemote: () => fetchRemoteCollection(groupsCollection),
    describe: (rec) => rec.name || `Group #${rec.id}`,
    fieldsToCompare: (rec) => ({
      name: rec.name ?? null,
      backgroundColor: rec.backgroundColor ?? null,
    }),
    fieldMeta: {
      name: { group: "Metadata", label: "Name" },
      backgroundColor: { group: "Metadata", label: "Color" },
    },
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_GROUPS, record);
      } else {
        await pushGroupToCloudForced(record);
      }
    },
    applyUpdate: async (localRec, remoteRec, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_GROUPS, { id: localRec.id, ...remoteRec });
      } else {
        await pushGroupToCloudForced(localRec);
      }
    },
    applyRemoval: async (id, direction) => {
      if (direction === "pull") {
        await deleteLocalRecord(STORE_GROUPS, id);
      } else {
        await deleteGroupFromCloud(id);
      }
    },
  },
  {
    key: "notes",
    label: "Notes",
    icon: "📝",
    fetchLocal: () => getAllFromLocalStore(STORE_NOTES),
    fetchRemote: () => fetchRemoteCollection(notesCollection),
    describe: (rec) => (rec.selectedText ? rec.selectedText.slice(0, 40) : rec.comment ? rec.comment.slice(0, 40) : `Note #${rec.id}`),
    fieldsToCompare: (rec) => ({
      selectedText: rec.selectedText ?? "",
      comment: rec.comment ?? "",
      // Sorted (order isn't meaningful), no longer stringified - the
      // comparison engine now compares arrays directly.
      tagIds: (rec.tagIds ?? []).slice().sort((a, b) => a - b),
      bookId: rec.bookId ?? null,
      bookTitle: rec.bookTitle ?? null,
    }),
    fieldMeta: {
      selectedText: { group: "Content", label: "Highlighted Text" },
      comment: { group: "Content", label: "Comment" },
      tagIds: { group: "Metadata", label: "Tags", format: formatDiffLogArray("tag") },
      bookId: { group: "Metadata", label: "Book" },
      bookTitle: { group: "Metadata", label: "Book Title" },
    },
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_NOTES, normalizeRemoteNote(record));
      } else {
        await pushNoteToCloud(record);
      }
    },
    applyUpdate: async (localRec, remoteRec, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_NOTES, normalizeRemoteNote({ id: localRec.id, ...remoteRec }));
      } else {
        await pushNoteToCloud(localRec);
      }
    },
    applyRemoval: async (id, direction) => {
      if (direction === "pull") {
        await deleteLocalRecord(STORE_NOTES, id);
      } else {
        await deleteNoteFromCloud(id);
      }
    },
  },
  {
    key: "noteTags",
    label: "Note Tags",
    icon: "🏷️",
    fetchLocal: () => getAllFromLocalStore(STORE_NOTE_GROUPS),
    fetchRemote: () => fetchRemoteCollection(noteTagsCollection),
    describe: (rec) => rec.name || `Tag #${rec.id}`,
    fieldsToCompare: (rec) => ({
      name: rec.name ?? null,
      color: rec.color ?? null,
    }),
    fieldMeta: {
      name: { group: "Metadata", label: "Name" },
      color: { group: "Metadata", label: "Color" },
    },
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_NOTE_GROUPS, { id: record.id, name: record.name, color: record.color });
      } else {
        await pushNoteTagToCloud(record);
      }
    },
    applyUpdate: async (localRec, remoteRec, direction) => {
      if (direction === "pull") {
        await putLocalRecord(STORE_NOTE_GROUPS, { id: localRec.id, name: remoteRec.name, color: remoteRec.color });
      } else {
        await pushNoteTagToCloud(localRec);
      }
    },
    applyRemoval: async (id, direction) => {
      if (direction === "pull") {
        await deleteLocalRecord(STORE_NOTE_GROUPS, id);
      } else {
        await deleteNoteTagFromCloud(id);
      }
    },
  },
  {
    key: "settings",
    label: "Settings / Preferences",
    icon: "⚙️",
    // Settings are a singleton bundle, not a keyed collection - this
    // entry always yields zero or one "record" (id "settings"), treated
    // as one row rather than diffed field-by-field, since these values
    // are already pushed/pulled as one atomic bundle elsewhere.
    fetchLocal: () => {
      const rawCollapsed = localStorage.getItem(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY);
      const rawLastUsed = localStorage.getItem(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY);
      // Mirrors fetchRemote()'s "no bundle at all -> []" shape: if neither
      // key was ever written, there's no local record to compare, not an
      // empty one - otherwise a fresh device would spuriously show a removal.
      if (rawCollapsed === null && rawLastUsed === null) return [];
      return [
        {
          id: "settings",
          collapsedNoteTagKeys: safeParseLocalStorageJSON(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY) || [],
          lastUsedNoteTagIds: safeParseLocalStorageJSON(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY) || [],
        },
      ];
    },
    fetchRemote: async () => {
      const snap = await userDoc().get();
      const data = snap.exists ? snap.data() : null;
      const settings = data && data.settings;
      if (!settings) return [];
      return [
        {
          id: "settings",
          collapsedNoteTagKeys: settings.collapsedNoteTagKeys ?? [],
          lastUsedNoteTagIds: settings.lastUsedNoteTagIds ?? [],
        },
      ];
    },
    describe: () => "Notes page layout & tag preferences",
    fieldsToCompare: (rec) => ({
      // Sorted, no longer stringified - same reasoning as Notes' tagIds above.
      collapsedNoteTagKeys: (rec.collapsedNoteTagKeys ?? []).slice().sort(),
      lastUsedNoteTagIds: (rec.lastUsedNoteTagIds ?? []).slice().sort(),
    }),
    fieldMeta: {
      collapsedNoteTagKeys: { group: "Preferences", label: "Collapsed Tag Sections", format: formatDiffLogArray("section") },
      lastUsedNoteTagIds: { group: "Preferences", label: "Last-Used Tags", format: formatDiffLogArray("tag") },
    },
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        restoreLocalStorageJSON(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY, record.collapsedNoteTagKeys);
        restoreLocalStorageJSON(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY, record.lastUsedNoteTagIds);
        if (typeof loadCollapsedNoteTagKeys === "function") collapsedNoteTagKeys = loadCollapsedNoteTagKeys();
      } else {
        await pushNoteSettingsToCloudForced();
      }
    },
    applyUpdate: async (localRec, remoteRec, direction) => {
      if (direction === "pull") {
        restoreLocalStorageJSON(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY, remoteRec.collapsedNoteTagKeys);
        restoreLocalStorageJSON(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY, remoteRec.lastUsedNoteTagIds);
        if (typeof loadCollapsedNoteTagKeys === "function") collapsedNoteTagKeys = loadCollapsedNoteTagKeys();
      } else {
        await pushNoteSettingsToCloudForced();
      }
    },
    // Settings is a singleton, never meaningful to delete outright. This
    // branch is only reached when one side never synced settings yet -
    // the safe action is to do nothing (the Addition on the other side,
    // generated separately, is what brings the two sides in line).
    applyRemoval: async () => {},
  },
];

// SMALL LOCAL-DB HELPERS (generic put/delete, reused across registry
// entries instead of each one opening its own transaction).
// getAllFromLocalStore() lives in 10-utils.js and is shared as-is.
function putLocalRecord(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function deleteLocalRecord(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Books need their own removal helper (not the generic one above)
// because deleting a book locally should also clear it from in-memory
// selection state, matching the rest of the app's book-removal behavior.
function deleteBookLocallyOnly(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Remote note docs don't carry dateCreated like a fresh local note would
// - normalized the same way pullInitialSyncFromCloud() already does in
// 11-firebase-sync.js.
function normalizeRemoteNote(remote) {
  return {
    id: remote.id,
    selectedText: remote.selectedText ?? "",
    comment: remote.comment ?? "",
    tagIds: remote.tagIds ?? [],
    bookId: remote.bookId ?? null,
    bookTitle: remote.bookTitle ?? null,
    dateCreated: remote.dateCreated ?? Date.now(),
  };
}

// COMPARISON ENGINE - pure: reads local memory + read-only cloud
// fetches, never writes. Produces a flat, ordered list of "operations".
/*
 One operation:
   {
     opId,                  // stable string id for this row, e.g. "books:add:42"
     typeKey, typeLabel, typeIcon,
     category: "addition" | "update" | "removal",
     label,                 // human-readable description of the record
     status: "pending" | "running" | "done" | "error",
     errorMessage,          // set only if status === "error"
     run: async () => void, // performs this one operation
   }
 direction: "pull" (cloud -> local) or "push" (local -> cloud). Determines
 which side is authoritative for additions/updates and which side
 removals delete from - see each registry entry's applyX(..., direction).
*/
async function buildSyncPlan(direction) {
  const operations = [];

  for (const entry of SYNC_TYPE_REGISTRY) {
    const localRecords = await entry.fetchLocal();
    const remoteRecords = await entry.fetchRemote();

    const localById = new Map(localRecords.map((r) => [String(r.id), r]));
    const remoteById = new Map(remoteRecords.map((r) => [String(r.id), r]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

    for (const id of allIds) {
      const localRec = localById.get(id);
      const remoteRec = remoteById.get(id);

      // Direction determines the "source" (drives additions/updates) and
      // which side removals delete from:
      //   pull: cloud is source. Missing locally -> addition. Local-only
      //         -> removal (delete locally).
      //   push: local is source. Missing on cloud -> addition. Remote-only
      //         -> removal (delete from cloud).
      const sourceHas = direction === "pull" ? !!remoteRec : !!localRec;
      const destHas = direction === "pull" ? !!localRec : !!remoteRec;

      if (sourceHas && !destHas) {
        const sourceRec = direction === "pull" ? remoteRec : localRec;
        const side = direction === "pull" ? "remote" : "local";
        operations.push({
          opId: `${entry.key}:add:${id}`,
          typeKey: entry.key,
          typeLabel: entry.label,
          typeIcon: entry.icon,
          category: "addition",
          label: entry.describe(sourceRec),
          status: "pending",
          errorMessage: null,
          fieldDiffs: buildOneSidedFieldSnapshot(entry.fieldsToCompare(sourceRec), entry.fieldMeta, side),
          run: () => entry.applyAddition(sourceRec, direction),
        });
      } else if (!sourceHas && destHas) {
        const destRec = direction === "pull" ? localRec : remoteRec;
        const side = direction === "pull" ? "local" : "remote";
        operations.push({
          opId: `${entry.key}:remove:${id}`,
          typeKey: entry.key,
          typeLabel: entry.label,
          typeIcon: entry.icon,
          category: "removal",
          label: entry.describe(destRec),
          status: "pending",
          errorMessage: null,
          fieldDiffs: buildOneSidedFieldSnapshot(entry.fieldsToCompare(destRec), entry.fieldMeta, side),
          run: () => entry.applyRemoval(isNaN(Number(id)) ? id : Number(id), direction),
        });
      } else if (sourceHas && destHas) {
        const localFields = entry.fieldsToCompare(localRec);
        const remoteFields = entry.fieldsToCompare(remoteRec);
        const fieldDiffs = computeFieldDiffs(localFields, remoteFields, entry.fieldMeta);
        if (fieldDiffs.length > 0) {
          operations.push({
            opId: `${entry.key}:update:${id}`,
            typeKey: entry.key,
            typeLabel: entry.label,
            typeIcon: entry.icon,
            category: "update",
            label: entry.describe(direction === "pull" ? remoteRec : localRec),
            status: "pending",
            errorMessage: null,
            fieldDiffs,
            run: () => entry.applyUpdate(localRec, remoteRec, direction),
          });
        }
      }
      // !sourceHas && !destHas is impossible (id came from the union of
      // both maps); the remaining case (equal, no diff) produces nothing.
    }
  }

  return operations;
}

// MODAL STATE + LIFECYCLE
let softSyncState = null;
/*
 softSyncState shape while a modal is open:
   {
     direction: "pull" | "push",
     operations: [ ...see above... ],
     runState: "idle" | "running" | "paused",
     cancelRequested: boolean,
     pauseRequested: boolean,
     activeFilter: "all" | "addition" | "update" | "removal", // which Apply button is driving the current run
     expandedOpIds: Set<opId>, // which rows currently have their field-diff panel open
   }
*/

function promptSoftPull() {
  if (!currentUser) {
    alert("Sign in to Sync first — Soft Pull needs a cloud account to compare against.");
    return;
  }
  openSoftSyncModal("pull");
}

function promptSoftPush() {
  if (!currentUser) {
    alert("Sign in to Sync first — Soft Push needs a cloud account to compare against.");
    return;
  }
  openSoftSyncModal("push");
}

async function openSoftSyncModal(direction) {
  const modal = document.getElementById("soft-sync-modal");
  const titleEl = document.getElementById("soft-sync-title");
  const subtitleEl = document.getElementById("soft-sync-subtitle");

  modal.dataset.direction = direction;
  titleEl.textContent = direction === "pull" ? "⬇️ Soft Pull — Review Cloud Changes" : "⬆️ Soft Push — Review Local Changes";
  subtitleEl.textContent =
    direction === "pull"
      ? "Comparing your local library against the cloud…"
      : "Comparing the cloud against your local library…";

  softSyncState = {
    direction,
    operations: [],
    runState: "idle",
    cancelRequested: false,
    pauseRequested: false,
    activeFilter: null,
    expandedOpIds: new Set(),
  };

  renderSoftSyncModal();
  modal.showModal();
  setSoftSyncZoneButtonsDisabled(true);

  try {
    const operations = await buildSyncPlan(direction);
    // A concurrent close shouldn't resurrect a stale plan into a modal
    // that's no longer showing this run.
    if (!softSyncState || softSyncState.direction !== direction) return;
    softSyncState.operations = operations;
    renderSoftSyncModal();
  } catch (err) {
    console.error("[SoftSync] comparison failed:", err);
    subtitleEl.textContent = "Failed to compare: " + (err && err.message ? err.message : String(err));
  } finally {
    setSoftSyncZoneButtonsDisabled(false);
  }
}

function closeSoftSyncModal() {
  const modal = document.getElementById("soft-sync-modal");
  if (softSyncState && softSyncState.runState === "running") {
    // Closing mid-run is treated as a cancel request rather than a block
    // - the in-flight operation still finishes (cooperative cancellation,
    // see runSoftSyncQueue()), it just won't start the next one.
    softSyncState.cancelRequested = true;
  }
  modal.close();
  softSyncState = null;
}

function setSoftSyncZoneButtonsDisabled(isDisabled) {
  ["btn-soft-pull", "btn-soft-push"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = isDisabled;
  });
}

// APPLY QUEUE RUNNER
/*
 filterCategory: null ("Apply All") or "addition"/"update"/"removal" to
 restrict this run to one category. Only touches "pending"/"error" ops,
 so a completed row is never re-applied and a failed row can be retried
 by pressing the same Apply button again.
*/
async function runSoftSyncQueue(filterCategory) {
  if (!softSyncState || softSyncState.runState === "running") return;

  // Held as a local reference for this run's lifetime: closeSoftSyncModal()
  // nulls the module-level softSyncState on close, which would otherwise
  // throw on the next loop iteration if the modal closes mid-run. Comparing
  // against this snapshot lets the loop notice and stop cleanly.
  const runState = softSyncState;

  runState.runState = "running";
  runState.cancelRequested = false;
  runState.pauseRequested = false;
  runState.activeFilter = filterCategory;
  renderSoftSyncControls();

  const queue = runState.operations.filter(
    (op) => (filterCategory === null || op.category === filterCategory) && (op.status === "pending" || op.status === "error"),
  );

  for (const op of queue) {
    if (softSyncState !== runState || runState.cancelRequested) break;

    // Cooperative pause: wait here (between operations only, never mid-
    // operation) until resumed or cancelled, without blocking the page.
    while (runState.pauseRequested && !runState.cancelRequested && softSyncState === runState) {
      runState.runState = "paused";
      renderSoftSyncControls();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (softSyncState !== runState || runState.cancelRequested) break;

    runState.runState = "running";
    op.status = "running";
    op.errorMessage = null;
    renderSoftSyncOperationRow(op);

    try {
      await op.run();
      op.status = "done";
    } catch (err) {
      console.error(`[SoftSync] operation ${op.opId} failed:`, err);
      op.status = "error";
      op.errorMessage = err && err.message ? err.message : String(err);
    }
    renderSoftSyncOperationRow(op);
    renderSoftSyncSummaryCounts();
  }

  // If the modal was closed mid-run, softSyncState is already null (or a
  // newer run) - nothing left to finalize or re-render.
  if (softSyncState !== runState) return;

  runState.runState = "idle";
  runState.activeFilter = null;
  renderSoftSyncControls();

  // Refresh caches other views read from, so the rest of the app
  // (library grid, notes page, stats) reflects this run's changes
  // without needing the modal closed first.
  fetchLocalLibrary();
  if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
}

function pauseSoftSyncQueue() {
  if (!softSyncState || softSyncState.runState !== "running") return;
  softSyncState.pauseRequested = true;
  renderSoftSyncControls();
}

function resumeSoftSyncQueue() {
  // Guards on pauseRequested, not runState === "paused": the loop only
  // flips runState to "paused" on its next poll tick, so a fast
  // Pause-then-Resume could land while runState still reads "running"
  // and silently no-op, leaving pauseRequested stuck true.
  if (!softSyncState || !softSyncState.pauseRequested) return;
  softSyncState.pauseRequested = false;
  softSyncState.runState = "running";
  renderSoftSyncControls();
}

function cancelSoftSyncQueue() {
  if (!softSyncState) return;
  softSyncState.cancelRequested = true;
  softSyncState.pauseRequested = false;
  renderSoftSyncControls();
}

// RENDERING
function renderSoftSyncModal() {
  renderSoftSyncSummaryCounts();
  renderSoftSyncOperationList();
  renderSoftSyncControls();
}

function categoryMeta(category) {
  if (category === "addition") return { icon: "🟢", label: "Addition" };
  if (category === "update") return { icon: "🔵", label: "Update" };
  return { icon: "🔴", label: "Removal" };
}

function statusMeta(status) {
  if (status === "pending") return { icon: "⏳", label: "Pending", cls: "soft-sync-status-pending" };
  if (status === "running") return { icon: "⚙️", label: "Running…", cls: "soft-sync-status-running" };
  if (status === "done") return { icon: "✅", label: "Done", cls: "soft-sync-status-done" };
  return { icon: "❌", label: "Failed", cls: "soft-sync-status-error" };
}

function renderSoftSyncSummaryCounts() {
  const el = document.getElementById("soft-sync-summary-counts");
  const subtitleEl = document.getElementById("soft-sync-subtitle");
  if (!softSyncState) return;

  const ops = softSyncState.operations;
  if (ops.length === 0) {
    subtitleEl.textContent = "";
    el.innerHTML = `<div class="soft-sync-empty-state">✅ Everything is already in sync — no differences found.</div>`;
    return;
  }

  const counts = { addition: 0, update: 0, removal: 0 };
  const doneCounts = { addition: 0, update: 0, removal: 0 };
  ops.forEach((op) => {
    counts[op.category]++;
    if (op.status === "done") doneCounts[op.category]++;
  });

  subtitleEl.textContent =
    softSyncState.direction === "pull"
      ? "Cloud → Local: choose which differences to pull down."
      : "Local → Cloud: choose which differences to push up.";

  el.innerHTML = `
    <div class="soft-sync-count-chip soft-sync-count-addition">🟢 ${doneCounts.addition}/${counts.addition} Additions</div>
    <div class="soft-sync-count-chip soft-sync-count-update">🔵 ${doneCounts.update}/${counts.update} Updates</div>
    <div class="soft-sync-count-chip soft-sync-count-removal">🔴 ${doneCounts.removal}/${counts.removal} Removals</div>
  `;
}

function renderSoftSyncOperationList() {
  const container = document.getElementById("soft-sync-operation-list");
  if (!softSyncState) return;

  if (softSyncState.operations.length === 0) {
    container.innerHTML = "";
    return;
  }

  // Grouped by data type first (registry order, so books lead), then by
  // category within each type, so related changes to the same
  // book/note/etc. sit together instead of scattered by category.
  const byType = new Map();
  for (const op of softSyncState.operations) {
    if (!byType.has(op.typeKey)) byType.set(op.typeKey, []);
    byType.get(op.typeKey).push(op);
  }

  const sections = [];
  for (const entry of SYNC_TYPE_REGISTRY) {
    const ops = byType.get(entry.key);
    if (!ops || ops.length === 0) continue;
    sections.push(`
      <div class="soft-sync-type-section">
        <div class="soft-sync-type-heading">${entry.icon} ${escapeHtml(entry.label)} <span class="soft-sync-type-count">(${ops.length})</span></div>
        <div class="soft-sync-op-rows" data-type-key="${entry.key}">
          ${ops.map(renderOperationRowHtml).join("")}
        </div>
      </div>
    `);
  }
  container.innerHTML = sections.join("");
}

/*
 Every row with something to show (any addition/update/removal) is
 expandable: clicking toggles a field-by-field diff panel underneath.
 The outer wrapper carries the stable id renderSoftSyncOperationRow()
 targets, so toggling one row re-renders just that row.
*/
function renderOperationRowHtml(op) {
  const cat = categoryMeta(op.category);
  const st = statusMeta(op.status);
  const hasDiffs = Array.isArray(op.fieldDiffs) && op.fieldDiffs.length > 0;
  const isExpanded = hasDiffs && !!(softSyncState && softSyncState.expandedOpIds.has(op.opId));
  // JSON.stringify() rather than manual quote-escaping, to safely embed
  // opId as a JS string literal inside an inline event-handler attribute.
  const opIdJsLiteral = JSON.stringify(op.opId);
  return `
    <div class="soft-sync-op-wrapper${isExpanded ? " soft-sync-op-expanded" : ""}" id="soft-sync-row-${cssEscapeId(op.opId)}">
      <div
        class="soft-sync-op-row soft-sync-op-row-${op.category} ${st.cls}${hasDiffs ? " soft-sync-op-row-expandable" : ""}"
        ${hasDiffs ? `onclick="toggleSoftSyncOpDetails(${opIdJsLiteral})" role="button" tabindex="0" aria-expanded="${isExpanded}"` : ""}
      >
        <span class="soft-sync-op-expand-toggle">${hasDiffs ? (isExpanded ? "▾" : "▸") : ""}</span>
        <span class="soft-sync-op-category" title="${cat.label}">${cat.icon}</span>
        <span class="soft-sync-op-label">${escapeHtml(op.label)}</span>
        <span class="soft-sync-op-status">
          ${st.icon} ${st.label}
          ${op.status === "error" && op.errorMessage ? `<span class="soft-sync-op-error" title="${escapeHtml(op.errorMessage)}">— ${escapeHtml(op.errorMessage)}</span>` : ""}
        </span>
      </div>
      ${isExpanded ? renderOpDetailPanelHtml(op) : ""}
    </div>
  `;
}

// Toggles one row's expand state and re-renders just that row, so
// expanding one book's diff doesn't scroll-jump a long review list.
function toggleSoftSyncOpDetails(opId) {
  if (!softSyncState) return;
  if (softSyncState.expandedOpIds.has(opId)) {
    softSyncState.expandedOpIds.delete(opId);
  } else {
    softSyncState.expandedOpIds.add(opId);
  }
  const op = softSyncState.operations.find((o) => o.opId === opId);
  if (op) renderSoftSyncOperationRow(op);
}

// direction: "pull" (Cloud -> Local) or "push" (Local -> Cloud). Applies
// uniformly to every row in a run, since direction is a property of the
// whole run, not an individual field.
function directionColumnLabels(direction) {
  return direction === "pull" ? ["Cloud", "Local"] : ["Local", "Cloud"];
}

/*
 Renders the expandable field-by-field diff panel for one operation.
 Groups fieldDiffs by `group` (Metadata, Reading Progress, Statistics,
 etc.) - fieldDiffs is already sorted group-then-key by
 computeFieldDiffs()/buildOneSidedFieldSnapshot(), so a new group heading
 is emitted exactly when the group changes, no separate grouping pass.

 Updates show both sides (one value "flowing" into the other, in the
 run's direction); additions/removals are one-sided (the other side
 renders as "—") - same panel shape either way.
*/
function renderOpDetailPanelHtml(op) {
  if (!op.fieldDiffs || op.fieldDiffs.length === 0) return "";
  const direction = softSyncState ? softSyncState.direction : "push";
  const [fromLabel, toLabel] = directionColumnLabels(direction);

  let currentGroup = null;
  const rowsHtml = op.fieldDiffs
    .map((diff) => {
      const fromDisplay = direction === "pull" ? diff.remoteDisplay : diff.localDisplay;
      const toDisplay = direction === "pull" ? diff.localDisplay : diff.remoteDisplay;
      let groupHeadingHtml = "";
      if (diff.group !== currentGroup) {
        currentGroup = diff.group;
        groupHeadingHtml = `<div class="soft-sync-diff-group-heading">${escapeHtml(diff.group)}</div>`;
      }
      return `
        ${groupHeadingHtml}
        <div class="soft-sync-diff-row">
          <span class="soft-sync-diff-field-label">${escapeHtml(diff.label)}</span>
          <span class="soft-sync-diff-value soft-sync-diff-value-from">${escapeHtml(fromDisplay ?? "—")}</span>
          <span class="soft-sync-diff-arrow">→</span>
          <span class="soft-sync-diff-value soft-sync-diff-value-to">${escapeHtml(toDisplay ?? "—")}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div class="soft-sync-op-detail-panel">
      <div class="soft-sync-diff-column-headings">
        <span class="soft-sync-diff-field-label"></span>
        <span class="soft-sync-diff-col-heading">${escapeHtml(fromLabel)}</span>
        <span class="soft-sync-diff-arrow"></span>
        <span class="soft-sync-diff-col-heading">${escapeHtml(toLabel)}</span>
      </div>
      ${rowsHtml}
    </div>
  `;
}

// Re-renders just one row (+ detail panel, if expanded) in place - used
// both during a live run (avoids re-rendering/scroll-jumping the whole
// list on every completion) and on expand/collapse toggle.
function renderSoftSyncOperationRow(op) {
  const rowEl = document.getElementById(`soft-sync-row-${cssEscapeId(op.opId)}`);
  if (!rowEl) return;
  rowEl.outerHTML = renderOperationRowHtml(op);
}

// IDs can contain characters (colons) unsafe unescaped inside a CSS id
// selector - defensive minimum, not a full solution.
function cssEscapeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function renderSoftSyncControls() {
  const applyAllBtn = document.getElementById("soft-sync-apply-all-btn");
  const applyAddBtn = document.getElementById("soft-sync-apply-additions-btn");
  const applyUpdateBtn = document.getElementById("soft-sync-apply-updates-btn");
  const applyRemoveBtn = document.getElementById("soft-sync-apply-removals-btn");
  const pauseBtn = document.getElementById("soft-sync-pause-btn");
  const resumeBtn = document.getElementById("soft-sync-resume-btn");
  const cancelBtn = document.getElementById("soft-sync-cancel-btn");
  const stateLabel = document.getElementById("soft-sync-run-state-label");

  if (!softSyncState) return;

  // Driven off pauseRequested directly (not just runState) so Pause
  // flips the UI instantly - the polling loop in runSoftSyncQueue() only
  // updates runState on its next ~200ms tick, which would make Pause
  // feel laggy otherwise.
  const isPaused = softSyncState.runState === "paused" || (softSyncState.runState === "running" && softSyncState.pauseRequested);
  const isRunning = softSyncState.runState === "running" && !softSyncState.pauseRequested;
  const isBusy = isRunning || isPaused;

  const hasPending = (category) =>
    softSyncState.operations.some((op) => (category === null || op.category === category) && (op.status === "pending" || op.status === "error"));

  applyAllBtn.disabled = isBusy || !hasPending(null);
  applyAddBtn.disabled = isBusy || !hasPending("addition");
  applyUpdateBtn.disabled = isBusy || !hasPending("update");
  applyRemoveBtn.disabled = isBusy || !hasPending("removal");

  pauseBtn.style.display = isRunning ? "inline-block" : "none";
  resumeBtn.style.display = isPaused ? "inline-block" : "none";
  cancelBtn.style.display = isBusy ? "inline-block" : "none";

  if (isPaused) {
    stateLabel.textContent = "⏸️ Paused — remaining changes will not run until resumed.";
    stateLabel.className = "soft-sync-run-state-label soft-sync-state-paused";
  } else if (isRunning) {
    stateLabel.textContent = "⚙️ Syncing…";
    stateLabel.className = "soft-sync-run-state-label soft-sync-state-running";
  } else if (softSyncState.operations.length > 0 && !hasPending(null)) {
    stateLabel.textContent = "✅ All selected changes complete.";
    stateLabel.className = "soft-sync-run-state-label soft-sync-state-done";
  } else {
    stateLabel.textContent = "";
    stateLabel.className = "soft-sync-run-state-label";
  }
}