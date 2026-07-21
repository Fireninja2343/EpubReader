/*
 =================================================================
 SOFT PULL / SOFT PUSH MODULE
 Interactive, review-before-you-commit counterparts to Hard Pull/Hard
 Push (15-danger-zone.js). Where Hard Pull/Push are all-or-nothing
 (discard everything on one side, replace it wholesale), Soft Pull/Push:

   1. Compare local vs. cloud for every synced data type WITHOUT writing
      anything, producing a flat list of individual "operations" -
      { type, category, id, label, apply() } - classified as an
      addition/update/removal.
   2. Show that list inside a modal, grouped by category, with per-row
      status (pending/running/done/error) and running counts.
   3. Let the user run a subset (Apply All / Apply Additions / Apply
      Updates / Apply Removals) - each click walks the matching
      operations in order, applying each one via the SAME per-item
      push/pull/delete primitives Hard Pull/Push and the normal
      incremental sync already use, so the actual write path never
      diverges from the rest of the app.
   4. Keep the modal open throughout, update rows live, and support
      pause/cancel between operations (cooperative - never aborts an
      operation that's already in flight, only skips ones that haven't
      started yet).

 EXTENSIBILITY (requirement #5/#6): every data type participates through
 one entry in SYNC_TYPE_REGISTRY below. Adding a new synced data type to
 Soft Pull/Push in the future means adding one registry entry - the
 comparison engine, the modal renderer, and the apply-queue runner are
 all generic over the registry and never mention a specific data type by
 name outside of it.
 =================================================================
*/

// -----------------------------------------------------------------
// SYNC TYPE REGISTRY
// Each entry describes one synced data type end-to-end: how to read the
// current local and remote collections, how to tell two records apart,
// how to detect a real difference (vs. just a different lastModified
// with identical content), and how to apply each kind of change. This is
// the single place a future data type needs to be added.
// -----------------------------------------------------------------
/*
 Entry shape:
   key            - stable id, e.g. "books"
   label          - display name, e.g. "Books"
   icon           - emoji shown in the group header
   fetchLocal()   -> Promise<array of local records (each must have an `id`)>.
                    Reads IndexedDB directly (see getAllFromLocalStore()
                    below) rather than an in-memory cache, since those
                    caches aren't guaranteed populated yet when this runs -
                    see the comment on the books entry's fetchLocal below.
   fetchRemote()  -> Promise<array of remote records (each must have an `id`)>
   describe(rec)  -> short human label for one record, e.g. book title
   fieldsToCompare(rec) -> plain object of just the fields that matter for
                    equality, pulled from either a local or remote record
                    shape - used so a differing lastModified alone (with
                    otherwise identical content) doesn't get flagged.
   applyAddition(record)  -> Promise, create the missing side
   applyUpdate(local, remote) -> Promise, overwrite one side with the other
   applyRemoval(id)       -> Promise, delete from the side that has it
 Soft Pull and Soft Push reuse the exact same registry; only the
 direction (which side is "source of truth" for additions/updates, and
 which side removals delete from) differs - see buildSyncPlan() below.
*/
const SYNC_TYPE_REGISTRY = [
  {
    key: "books",
    label: "Books",
    icon: "📚",
    // Reads IndexedDB directly rather than trusting loadedBooksMemory: that
    // in-memory cache is only ever as fresh as the last fetchLocalLibrary()
    // call, and 11-firebase-sync.js's own pullInitialSyncFromCloud() has a
    // documented race where it can run before that cache is populated (see
    // its comment above the equivalent notes/tags read). IndexedDB itself
    // is the actual source of truth per this app's architecture, so
    // comparisons here should never be fooled by a stale/empty cache.
    fetchLocal: () => getAllFromLocalStore(STORE_BOOKS),
    fetchRemote: async () => {
      const snap = await booksCollection().get();
      return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
    },
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
      // Sessions/history are arrays - JSON-stringified for a cheap deep
      // compare, same trick used for settings below. Order matters for
      // both (they're append-ordered logs), which is fine since a real
      // difference should show up as different content either way.
      readingSessions: JSON.stringify(rec.readingSessions ?? []),
      readingHistory: JSON.stringify(rec.readingHistory ?? []),
    }),
    applyAddition: async (record, direction) => {
      if (direction === "pull") {
        // downloadBookFromCloud() writes the full local record AND
        // reassembles/pulls the chunked file binary, but it swallows its
        // own errors (and silently no-ops if chunkCount is missing or a
        // chunk hasn't finished uploading yet) rather than throwing - so
        // success here is verified by actually checking the local store
        // afterward, rather than trusting a resolved promise that may not
        // have written anything.
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
    fetchRemote: async () => {
      const snap = await groupsCollection().get();
      return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
    },
    describe: (rec) => rec.name || `Group #${rec.id}`,
    fieldsToCompare: (rec) => ({
      name: rec.name ?? null,
      backgroundColor: rec.backgroundColor ?? null,
    }),
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
    fetchRemote: async () => {
      const snap = await notesCollection().get();
      return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
    },
    describe: (rec) => (rec.selectedText ? rec.selectedText.slice(0, 40) : rec.comment ? rec.comment.slice(0, 40) : `Note #${rec.id}`),
    fieldsToCompare: (rec) => ({
      selectedText: rec.selectedText ?? "",
      comment: rec.comment ?? "",
      tagIds: JSON.stringify((rec.tagIds ?? []).slice().sort()),
      bookId: rec.bookId ?? null,
      bookTitle: rec.bookTitle ?? null,
    }),
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
    fetchRemote: async () => {
      const snap = await noteTagsCollection().get();
      return snap.docs.map((d) => ({ id: Number(d.id), ...d.data() }));
    },
    describe: (rec) => rec.name || `Tag #${rec.id}`,
    fieldsToCompare: (rec) => ({
      name: rec.name ?? null,
      color: rec.color ?? null,
    }),
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
    /*
     Settings are a singleton bundle, not a keyed collection, so this
     entry always yields exactly zero or one "record" with a fixed id
     ("settings"). Treated as one row in the plan rather than iterating
     field-by-field, since these values are already pushed/pulled as one
     atomic bundle everywhere else in the sync layer.
    */
    fetchLocal: () => {
      const rawCollapsed = localStorage.getItem(Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY);
      const rawLastUsed = localStorage.getItem(Config.Db.LAST_NOTE_TAGS_STORAGE_KEY);
      // Mirrors fetchRemote()'s "no settings bundle at all -> []" shape:
      // if neither local settings key has ever been written, there is no
      // local settings record to compare, not an empty one - otherwise an
      // untouched device with no cloud settings yet would spuriously show
      // up as a removal (present locally, absent remotely) below.
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
      collapsedNoteTagKeys: JSON.stringify((rec.collapsedNoteTagKeys ?? []).slice().sort()),
      lastUsedNoteTagIds: JSON.stringify((rec.lastUsedNoteTagIds ?? []).slice().sort()),
    }),
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
    // Settings is a singleton preference bundle, never something
    // meaningful to delete outright. The only way this branch is reached
    // is one side never having synced settings yet - in that case the
    // safe convergent action is to do nothing here (the corresponding
    // Addition on the other side, generated separately below, is what
    // actually brings the two sides in line), rather than deleting
    // whichever side does have settings.
    applyRemoval: async () => {},
  },
];

// -----------------------------------------------------------------
// SMALL LOCAL-DB HELPERS (generic put/delete, reused across registry
// entries above instead of each one opening its own transaction)
// -----------------------------------------------------------------
// getAllFromLocalStore() itself lives in 15-danger-zone.js (loaded before
// this file) and is shared as-is - see its definition there for why it
// reads IndexedDB directly instead of the in-memory caches.
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

// Books need their own removal helper (rather than the generic one above)
// because deleting a book locally should also clear it out of in-memory
// selection state, matching what the rest of the app does when a book is
// removed - see deleteSelectedBooks() equivalents elsewhere in the app.
function deleteBookLocallyOnly(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Remote note docs don't carry dateCreated the exact same way a fresh
// local note would if it's an older doc - normalized the same way
// pullInitialSyncFromCloud() already does in 11-firebase-sync.js.
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

// -----------------------------------------------------------------
// COMPARISON ENGINE
// Pure - reads local memory + does read-only cloud fetches, never
// writes anything. Produces a flat, ordered list of "operations".
// -----------------------------------------------------------------
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

      // Direction determines which side is the "source" (drives
      // additions/updates) and which side removals delete from:
      //   pull: cloud is source. Missing locally -> addition. Missing on
      //         cloud (i.e. only local) -> removal (delete locally).
      //   push: local is source. Missing on cloud -> addition. Missing
      //         locally (i.e. only remote) -> removal (delete from cloud).
      const sourceHas = direction === "pull" ? !!remoteRec : !!localRec;
      const destHas = direction === "pull" ? !!localRec : !!remoteRec;

      if (sourceHas && !destHas) {
        const sourceRec = direction === "pull" ? remoteRec : localRec;
        operations.push({
          opId: `${entry.key}:add:${id}`,
          typeKey: entry.key,
          typeLabel: entry.label,
          typeIcon: entry.icon,
          category: "addition",
          label: entry.describe(sourceRec),
          status: "pending",
          errorMessage: null,
          run: () => entry.applyAddition(sourceRec, direction),
        });
      } else if (!sourceHas && destHas) {
        operations.push({
          opId: `${entry.key}:remove:${id}`,
          typeKey: entry.key,
          typeLabel: entry.label,
          typeIcon: entry.icon,
          category: "removal",
          label: entry.describe(direction === "pull" ? localRec : remoteRec),
          status: "pending",
          errorMessage: null,
          run: () => entry.applyRemoval(isNaN(Number(id)) ? id : Number(id), direction),
        });
      } else if (sourceHas && destHas) {
        const localFields = entry.fieldsToCompare(localRec);
        const remoteFields = entry.fieldsToCompare(remoteRec);
        if (!shallowFieldsEqual(localFields, remoteFields)) {
          operations.push({
            opId: `${entry.key}:update:${id}`,
            typeKey: entry.key,
            typeLabel: entry.label,
            typeIcon: entry.icon,
            category: "update",
            label: entry.describe(direction === "pull" ? remoteRec : localRec),
            status: "pending",
            errorMessage: null,
            run: () => entry.applyUpdate(localRec, remoteRec, direction),
          });
        }
      }
      // sourceHas && !destHas handled; !sourceHas && !destHas is
      // impossible (id came from the union of both maps); the remaining
      // case (equal, no diff) intentionally produces no operation.
    }
  }

  return operations;
}

function shallowFieldsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// -----------------------------------------------------------------
// MODAL STATE + LIFECYCLE
// -----------------------------------------------------------------
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
  };

  renderSoftSyncModal();
  modal.showModal();
  setSoftSyncZoneButtonsDisabled(true);

  try {
    const operations = await buildSyncPlan(direction);
    // A concurrent close (user clicked away fast) shouldn't resurrect a
    // stale plan into a modal that's no longer showing this run.
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
    // Treat closing mid-run as a cancel request rather than blocking the
    // close outright - the in-flight operation still finishes (cooperative
    // cancellation, see runSoftSyncQueue()), it just won't start the next one.
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

// -----------------------------------------------------------------
// APPLY QUEUE RUNNER
// -----------------------------------------------------------------
/*
 filterCategory: null ("Apply All") or "addition"/"update"/"removal" to
 restrict this run to one category. Only touches operations currently
 "pending" or "error" (so a completed row from a previous partial run is
 never re-applied, and a previously-failed row can be retried by pressing
 the same Apply button again).
*/
async function runSoftSyncQueue(filterCategory) {
  if (!softSyncState || softSyncState.runState === "running") return;

  // Held as a local reference for the lifetime of this run: closeSoftSyncModal()
  // sets the module-level softSyncState to null on close, which would
  // otherwise throw on the next loop iteration below if the modal is closed
  // while this run is paused/in-progress. Comparing against this snapshot
  // lets the loop notice "the modal I was running for is gone" and stop
  // cleanly instead of dereferencing null.
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

    // Cooperative pause: wait here (between operations only - never mid-
    // operation) until resumed or cancelled, without blocking the rest of
    // the page since this is just an async loop, not a synchronous one.
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

  // If the modal was closed mid-run, softSyncState is already null (or
  // points at a newer run) - nothing left here to finalize or re-render.
  if (softSyncState !== runState) return;

  runState.runState = "idle";
  runState.activeFilter = null;
  renderSoftSyncControls();

  // A successful pull/push changes local memory or cloud state that other
  // views read from - refresh those caches now so the rest of the app
  // (library grid, notes page, stats) reflects what this run just did,
  // without needing the user to close the modal first.
  fetchLocalLibrary();
  if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
}

function pauseSoftSyncQueue() {
  if (!softSyncState || softSyncState.runState !== "running") return;
  softSyncState.pauseRequested = true;
  renderSoftSyncControls();
}

function resumeSoftSyncQueue() {
  // Guards on pauseRequested rather than runState === "paused": the loop in
  // runSoftSyncQueue() only flips runState to "paused" once it actually
  // reaches its next poll tick, so a fast Pause-then-Resume click could
  // otherwise land while runState still reads "running" and silently no-op,
  // leaving pauseRequested stuck true with nothing left to clear it.
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

// -----------------------------------------------------------------
// RENDERING
// -----------------------------------------------------------------
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

  // Grouped by data type first (matches the registry order, so books
  // always lead), then by category within each type, so related changes
  // to the same book/note/etc. sit near each other instead of being
  // scattered by category across the whole list.
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

function renderOperationRowHtml(op) {
  const cat = categoryMeta(op.category);
  const st = statusMeta(op.status);
  return `
    <div class="soft-sync-op-row soft-sync-op-row-${op.category} ${st.cls}" id="soft-sync-row-${cssEscapeId(op.opId)}">
      <span class="soft-sync-op-category" title="${cat.label}">${cat.icon}</span>
      <span class="soft-sync-op-label">${escapeHtml(op.label)}</span>
      <span class="soft-sync-op-status">
        ${st.icon} ${st.label}
        ${op.status === "error" && op.errorMessage ? `<span class="soft-sync-op-error" title="${escapeHtml(op.errorMessage)}">— ${escapeHtml(op.errorMessage)}</span>` : ""}
      </span>
    </div>
  `;
}

// Re-renders just one row in place (used during a live run so the whole
// list doesn't re-render, and therefore doesn't scroll-jump, on every
// single operation completing).
function renderSoftSyncOperationRow(op) {
  const rowEl = document.getElementById(`soft-sync-row-${cssEscapeId(op.opId)}`);
  if (!rowEl) return;
  rowEl.outerHTML = renderOperationRowHtml(op);
}

// IDs can contain characters (colons) that aren't safe unescaped inside a
// CSS id selector - opIds are built from our own known-safe strings plus
// arbitrary local ids, so this is a defensive minimum rather than a full solution.
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

  // Driven off pauseRequested directly (not just runState) so clicking
  // Pause flips the UI instantly - the polling loop in runSoftSyncQueue()
  // only updates runState itself once it reaches its next ~200ms tick,
  // and waiting on that would make Pause feel laggy/unresponsive.
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