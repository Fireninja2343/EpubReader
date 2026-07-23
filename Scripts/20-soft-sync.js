/*
 SOFT PULL / SOFT PUSH MODULE
 Review-before-you-commit counterparts to Hard Pull/Push (19-danger-zone.js).
 1. Diff local vs. cloud for every synced type, without writing anything,
    into a flat list of operations (addition/update/removal).
 2. Show them in a modal, grouped by category, with per-row status.
 3. Let the user apply a subset via the same push/pull/delete primitives
    Hard Pull/Push and normal sync use.
 4. Support pause/cancel between operations (cooperative).

 New data types just need one entry in SYNC_TYPE_REGISTRY below.
*/

/*
 SYNC TYPE REGISTRY - each entry describes one synced data type
 end-to-end (read local/remote, diff, apply).

 Shared fetchRemote() shape: read every doc in a Firestore collection,
 tag each with its numeric id.
*/
async function fetchRemoteCollection(collectionFn) {
  const snap = await collectionFn().get();
  return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
}

/*
 DEEP VALUE EQUALITY. Old code JSON.stringify()'d arrays/objects before
 comparing, but Firestore doesn't guarantee map key order survives a
 write/read round trip, so identical data could come back reordered and
 get flagged as a false "update". Compare structurally instead: object
 keys are looked up by name (order-independent), only array element
 order matters.
*/
function deepValuesEqual(a, b) {
  if (a === b) return true;
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
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepValuesEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

// Every field that differs between two fieldsToCompare() outputs, via
// deepValuesEqual(). Empty result = equal; non-empty = diff UI rows.
// fieldMeta is the optional per-field { group, label, format } (see
// "Entry shape" below); missing keys get sensible defaults.
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
  // Sort group-then-key for a stable order the renderer can walk.
  diffs.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
  return diffs;
}

// One-sided version for additions/removals (only one side has data), so
// they're still expandable like an update panel, just one column filled.
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

// camelCase -> "Camel Case" fallback label when fieldMeta omits one.
function defaultFieldLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// VALUE FORMATTERS for the expandable diff UI
function defaultFormatFieldValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return truncateForDiff(JSON.stringify(value));
  return truncateForDiff(String(value));
}

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

// Log arrays (readingSessions/readingHistory) show as a count, not raw JSON.
function formatDiffLogArray(noun) {
  return (value) => {
    const arr = Array.isArray(value) ? value : [];
    return `${arr.length} ${noun}${arr.length === 1 ? "" : "s"}`;
  };
}

// Long strings (covers, note text) truncated for display.
function truncateForDiff(str, max = 120) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/*
 Entry shape:
   key/label/icon       - id, display name, group-header emoji
   fetchLocal()         -> local records (each needs `id`); reads IndexedDB
                          directly, not an in-memory cache
   fetchRemote()        -> remote records (each needs `id`)
   describe(rec)        -> short human label
   fieldsToCompare(rec) -> fields that matter for equality, as real
                          values (not pre-serialized)
   fieldMeta            -> optional { [key]: { group, label, format } }
   applyAddition/applyUpdate/applyRemoval -> Promise-returning appliers
 Soft Pull and Soft Push share this registry; only direction differs.
*/
const SYNC_TYPE_REGISTRY = [
  {
    key: "books",
    label: "Books",
    icon: "📚",
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
      readingSessions: rec.readingSessions ?? [],
      readingHistory: rec.readingHistory ?? [],
      // chunkCount is only set once pushBookFileToCloud() fully finishes,
      // so this catches an interrupted EPUB upload that metadata alone
      // would miss.
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
        // downloadBookFromCloud() swallows its own errors, so verify by
        // checking the local store rather than trusting the promise.
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
        // Re-upload the file only if chunkCount looks incomplete, so a
        // plain rename doesn't re-push the whole EPUB.
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
    // Singleton bundle (id "settings"), not a keyed collection - treated
    // as one row rather than diffed field-by-field.
    fetchLocal: () => {
      const rawCollapsed = localStorage.getItem(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY);
      const rawLastUsed = localStorage.getItem(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY);
      // No keys written yet = no record to compare (not an empty one),
      // else a fresh device would show a spurious removal.
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
    // Never meaningfully deleted; only reached when one side hasn't
    // synced yet, so no-op (the paired Addition brings sides in line).
    applyRemoval: async () => {},
  },
];

// SMALL LOCAL-DB HELPERS, shared across registry entries.
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

// Own helper (not the generic one) so it also clears in-memory selection state.
function deleteBookLocallyOnly(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Matches the normalization pullInitialSyncFromCloud() does in 11-firebase-sync.js.
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

// COMPARISON ENGINE - pure (read-only), produces a flat operations list.
/*
 One operation: { opId, typeKey, typeLabel, typeIcon, category,
 label, status, errorMessage, run }.
 direction: "pull" (cloud -> local) or "push" (local -> cloud) - decides
 which side is source for additions/updates and which removals delete from.
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
    }
  }

  return operations;
}

// MODAL STATE + LIFECYCLE
let softSyncState = null;
/*
 { direction: "pull"|"push", operations, runState: "idle"|"running"|"paused",
   cancelRequested, pauseRequested, activeFilter, expandedOpIds: Set }
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
    // Don't resurrect a stale plan if the modal moved on while we awaited.
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
    // Cooperative cancel: in-flight op finishes, next one won't start.
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
// filterCategory: null (all) or one category. Only touches
// pending/error ops, so completed rows are never re-applied.
async function runSoftSyncQueue(filterCategory) {
  if (!softSyncState || softSyncState.runState === "running") return;

  // Snapshot reference: softSyncState may be nulled by closeSoftSyncModal()
  // mid-run; compare against this to detect that and stop cleanly.
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

    // Cooperative pause: only wait between ops, never mid-operation.
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

  if (softSyncState !== runState) return;

  runState.runState = "idle";
  runState.activeFilter = null;
  renderSoftSyncControls();

  // Refresh other views so they reflect this run's changes immediately.
  fetchLocalLibrary();
  if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
}

function pauseSoftSyncQueue() {
  if (!softSyncState || softSyncState.runState !== "running") return;
  softSyncState.pauseRequested = true;
  renderSoftSyncControls();
}

function resumeSoftSyncQueue() {
  // Guard on pauseRequested, not runState, since runState only flips to
  // "paused" on the loop's next poll tick.
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

  // Grouped by type (registry order), then category within each type.
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

// Every row with a diff is expandable; clicking toggles the field panel.
function renderOperationRowHtml(op) {
  const cat = categoryMeta(op.category);
  const st = statusMeta(op.status);
  const hasDiffs = Array.isArray(op.fieldDiffs) && op.fieldDiffs.length > 0;
  const isExpanded = hasDiffs && !!(softSyncState && softSyncState.expandedOpIds.has(op.opId));
  const opIdJsLiteral = JSON.stringify(op.opId); // safe JS string literal for the inline handler
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

// Re-renders just this row so expanding one diff doesn't scroll-jump the list.
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

function directionColumnLabels(direction) {
  return direction === "pull" ? ["Cloud", "Local"] : ["Local", "Cloud"];
}

// Expandable field-by-field diff panel. fieldDiffs is pre-sorted
// group-then-key, so a new heading is emitted exactly when group changes.
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

function renderSoftSyncOperationRow(op) {
  const rowEl = document.getElementById(`soft-sync-row-${cssEscapeId(op.opId)}`);
  if (!rowEl) return;
  rowEl.outerHTML = renderOperationRowHtml(op);
}

// Escapes characters unsafe in a raw CSS id selector.
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

  // pauseRequested (not just runState) drives isPaused so Pause feels
  // instant instead of waiting for the loop's next ~200ms tick.
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