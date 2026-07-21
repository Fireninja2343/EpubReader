/*
 =================================================================
 DANGER ZONE / SYNC RECOVERY MODULE
 Three destructive, deliberately-hard-to-trigger operations, all built on
 top of the same reusable typed-confirmation modal:

   1. clearLocalData()  - wipes every local store + localStorage app keys,
      leaves the cloud untouched, then hard-reloads into a clean local
      state (reusing hardReloadApp()'s cache-clearing behavior from
      01-state.js).
   2. hardPullFromCloud() - discards local data and rebuilds it entirely
      from whatever is currently in Firestore.
   3. hardPushToCloud()   - overwrites the cloud with a full mirror of the
      current local database, local data left untouched.

 Both sync operations are built around the existing per-store push/pull
 primitives already defined in 11-firebase-sync.js and 02-db.js, so they
 stay consistent with the rest of the sync architecture instead of
 introducing a second parallel writer. Nothing here talks to Firestore
 directly except through those existing functions (plus the couple of
 bulk collection reads/deletes that don't have an existing per-item
 helper to reuse).

 DESIGN FOR "hard to accidentally trigger" (see requirement #3):
  - Each action opens a themed confirmation dialog (see
    openDangerConfirmModal() below) that requires the user to type an
    exact confirmation phrase before the action button enables itself.
  - Pull and Push use different accent colors (pull = blue/"incoming",
    push = orange/"outgoing") and different confirmation phrases, so the
    two can't be mixed up even by someone clicking fast.
  - All three trigger buttons live behind the Settings sidebar's Danger
    Zone section, are disabled for the duration of their own operation,
    and show inline success/error status rather than a bare alert().
 =================================================================
*/

/*
 Reads every record in a store straight from IndexedDB, rather than
 whatever in-memory cache (loadedBooksMemory, loadedNotesMemory, etc.)
 happens to mirror it at this moment. This matters because those caches
 are only ever as fresh as the last explicit fetch, and this app has a
 documented race (see pullInitialSyncFromCloud() in 11-firebase-sync.js)
 where cloud sync can run before a given cache has been populated for the
 first time in a session. Both Hard Push (below) and Soft Pull/Push
 (16-soft-sync.js) share this one implementation rather than each
 duplicating it, so there's a single place that always reflects the real
 on-disk state instead of a snapshot that might be behind it.
*/
function getAllFromLocalStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// -----------------------------------------------------------------
// REUSABLE LOCAL-DATA-WIPE PRIMITIVE
// Used by both Clear Local Data and (as the first step of) Hard Pull, so
// there is exactly one code path that actually empties the local
// database - any future reset-style feature should call this too rather
// than re-implementing a wipe.
// -----------------------------------------------------------------
/*
 Wipes every object store currently defined in the local IndexedDB
 (STORE_BOOKS, STORE_GROUPS, STORE_NOTES, STORE_NOTE_GROUPS) plus the
 handful of localStorage keys this app writes to. Deliberately iterates
 db.objectStoreNames rather than a hardcoded list, so a future store added
 to initIndexedDB() is automatically included here with no matching edit
 required in this file.
*/
function wipeAllLocalAppData() {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Local database isn't open."));
      return;
    }
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) {
      resolve();
      return;
    }
    const transaction = db.transaction(storeNames, "readwrite");
    storeNames.forEach((name) => transaction.objectStore(name).clear());
    transaction.oncomplete = () => {
      clearAppLocalStorageKeys();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error || new Error("Failed to clear local database."));
  });
}

/*
 Every localStorage key this app owns, cleared explicitly (rather than
 localStorage.clear()) so this can't ever reach into unrelated keys some
 other site/tool on the same origin might have set.
*/
function clearAppLocalStorageKeys() {
  const keys = [
    "EpubReader_UserConfig_v1",
    Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY,
    `${Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY}_ts`,
    Config.Db.LAST_NOTE_TAGS_STORAGE_KEY,
    `${Config.Db.LAST_NOTE_TAGS_STORAGE_KEY}_ts`,
  ];
  keys.forEach((k) => localStorage.removeItem(k));
}

// -----------------------------------------------------------------
// REUSABLE TYPED-CONFIRMATION MODAL
// Generic enough to back any future destructive action, not just the
// three below - callers pass in the copy, theme, required phrase, and an
// async function to run once confirmed.
// -----------------------------------------------------------------
let dangerConfirmActiveConfig = null;

/*
 config = {
   theme: "clear" | "pull" | "push",   // drives the modal's accent color
   title: string,
   bodyHtml: string,                   // explains what gets overwritten
   confirmPhrase: string,              // must be typed verbatim to enable the button
   confirmLabel: string,               // button text once enabled
   onConfirm: async () => void,        // the actual operation
 }
*/
function openDangerConfirmModal(config) {
  dangerConfirmActiveConfig = config;

  const modal = document.getElementById("danger-confirm-modal");
  const titleEl = document.getElementById("danger-confirm-title");
  const bodyEl = document.getElementById("danger-confirm-body");
  const phraseHintEl = document.getElementById("danger-confirm-phrase-hint");
  const input = document.getElementById("danger-confirm-input");
  const confirmBtn = document.getElementById("danger-confirm-btn");
  const statusEl = document.getElementById("danger-confirm-status");

  modal.dataset.theme = config.theme;
  titleEl.textContent = config.title;
  bodyEl.innerHTML = config.bodyHtml;
  phraseHintEl.innerHTML = `Type <code>${escapeHtml(config.confirmPhrase)}</code> to confirm.`;
  confirmBtn.textContent = config.confirmLabel;
  confirmBtn.disabled = true;
  input.value = "";
  statusEl.textContent = "";
  statusEl.className = "danger-confirm-status";

  modal.showModal();
  // Focus after showModal() so the dialog is actually visible/focusable first.
  setTimeout(() => input.focus(), 0);
}

function handleDangerConfirmInput() {
  const input = document.getElementById("danger-confirm-input");
  const confirmBtn = document.getElementById("danger-confirm-btn");
  if (!dangerConfirmActiveConfig) return;
  confirmBtn.disabled = input.value !== dangerConfirmActiveConfig.confirmPhrase;
}

function closeDangerConfirmModal() {
  const modal = document.getElementById("danger-confirm-modal");
  // Don't allow closing mid-operation - the buttons are disabled and the
  // status line says so, but this blocks the Escape key / backdrop click too.
  if (modal.dataset.busy === "true") return;
  modal.close();
  dangerConfirmActiveConfig = null;
}

async function submitDangerConfirmModal() {
  if (!dangerConfirmActiveConfig) return;
  const modal = document.getElementById("danger-confirm-modal");
  const confirmBtn = document.getElementById("danger-confirm-btn");
  const cancelBtn = document.getElementById("danger-confirm-cancel-btn");
  const input = document.getElementById("danger-confirm-input");
  const statusEl = document.getElementById("danger-confirm-status");

  modal.dataset.busy = "true";
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  input.disabled = true;
  statusEl.className = "danger-confirm-status";
  statusEl.textContent = "Working…";

  setDangerZoneButtonsDisabled(true);

  try {
    await dangerConfirmActiveConfig.onConfirm();
    statusEl.className = "danger-confirm-status danger-confirm-status-success";
    statusEl.textContent = "Done.";
    // The two sync operations and the clear operation each handle their
    // own follow-up (reload or a final status message) inside onConfirm,
    // so this modal is left to close itself shortly after rather than
    // needing per-action cleanup here.
    setTimeout(() => {
      modal.dataset.busy = "false";
      modal.close();
      dangerConfirmActiveConfig = null;
      setDangerZoneButtonsDisabled(false);
    }, 900);
  } catch (err) {
    console.error("[DangerZone] operation failed:", err);
    modal.dataset.busy = "false";
    cancelBtn.disabled = false;
    input.disabled = false;
    statusEl.className = "danger-confirm-status danger-confirm-status-error";
    statusEl.textContent = "Failed: " + (err && err.message ? err.message : String(err));
    setDangerZoneButtonsDisabled(false);
    // Leave confirmBtn disabled until they re-type the phrase, consistent
    // with the normal input-driven enable/disable behavior above.
  }
}

function setDangerZoneButtonsDisabled(isDisabled) {
  ["btn-clear-local-data", "btn-hard-pull", "btn-hard-push"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = isDisabled;
  });
}

// -----------------------------------------------------------------
// 1. CLEAR LOCAL DATA
// -----------------------------------------------------------------
function promptClearLocalData() {
  openDangerConfirmModal({
    theme: "clear",
    title: "🗑️ Clear Local Data",
    bodyHtml: `
      <p>This permanently deletes <strong>every book, group, note, and tag stored on this device</strong>,
      along with your local reader/library settings.</p>
      <p>Your <strong>cloud (Firebase) data is not touched</strong> — if you're signed in and synced,
      it can be restored afterward with <strong>Hard Pull</strong>.</p>
      <p>The app will reload automatically once this finishes.</p>
    `,
    confirmPhrase: "DELETE LOCAL DATA",
    confirmLabel: "Clear Local Data",
    onConfirm: async () => {
      await wipeAllLocalAppData();
      // Reuses hardReloadApp()'s Service Worker / Cache Storage clearing +
      // cache-busting reload (01-state.js), so the reload after a data wipe
      // also can't be served a stale cached shell.
      await hardReloadApp();
    },
  });
}

// -----------------------------------------------------------------
// 2. HARD PULL (cloud -> local, discarding local)
// -----------------------------------------------------------------
function promptHardPull() {
  if (!currentUser) {
    alert("Sign in to Sync first — Hard Pull needs a cloud account to pull from.");
    return;
  }
  openDangerConfirmModal({
    theme: "pull",
    title: "⬇️ Hard Pull from Cloud",
    bodyHtml: `
      <p><strong>Your local data on this device will be discarded</strong> and completely rebuilt
      from what's currently stored in the cloud for <strong>${escapeHtml(currentUser.email || "your account")}</strong>.</p>
      <p>This restores books, reading progress, reading history, book order, notes, tags,
      and settings exactly as they are on the cloud right now.</p>
      <p>Use this when local and cloud data have gotten out of sync and you want the
      cloud copy to win.</p>
    `,
    confirmPhrase: "PULL FROM CLOUD",
    confirmLabel: "Hard Pull",
    onConfirm: hardPullFromCloud,
  });
}

/*
 Discards all local data and rebuilds it from Firestore. Every synced
 data type is pulled explicitly below - see the checklist in this
 function's inline comments - so a future data type that gets added to
 the sync layer needs a one-line addition here too, rather than silently
 being left out of recovery.
*/
async function hardPullFromCloud() {
  if (!currentUser) throw new Error("Not signed in.");

  // Fetch everything from the cloud FIRST, before touching local data, so
  // a network failure here leaves local data completely untouched instead
  // of wiping it out and then failing to repopulate it.
  const [booksSnap, groupsSnap, notesSnap, noteTagsSnap, userSnap] = await Promise.all([
    booksCollection().get(),
    groupsCollection().get(),
    notesCollection().get(),
    noteTagsCollection().get(),
    userDoc().get(),
  ]);

  // Wipe local only once the cloud read has actually succeeded.
  await wipeAllLocalAppData();

  // --- Groups ---
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_GROUPS], "readwrite");
    const store = tx.objectStore(STORE_GROUPS);
    groupsSnap.forEach((docSnap) => {
      store.put({ id: Number(docSnap.id), ...docSnap.data() });
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // --- Books (metadata + file binary, chunk-reassembled) ---
  for (const docSnap of booksSnap.docs) {
    const bookId = Number(docSnap.id);
    const remote = docSnap.data();
    // downloadBookFromCloud() (11-firebase-sync.js) already writes the full
    // record - progress, sessions, reading history, cached metadata, sort
    // order, everything - and pulls/reassembles the chunked file binary.
    await downloadBookFromCloud(bookId, remote);
  }

  // --- Notes + note tags ---
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readwrite");
    const notesStore = tx.objectStore(STORE_NOTES);
    const tagsStore = tx.objectStore(STORE_NOTE_GROUPS);

    noteTagsSnap.forEach((docSnap) => {
      const remote = docSnap.data();
      tagsStore.put({ id: Number(docSnap.id), name: remote.name, color: remote.color });
    });

    notesSnap.forEach((docSnap) => {
      const remote = docSnap.data();
      notesStore.put({
        id: Number(docSnap.id),
        selectedText: remote.selectedText ?? "",
        comment: remote.comment ?? "",
        tagIds: remote.tagIds ?? [],
        bookId: remote.bookId ?? null,
        bookTitle: remote.bookTitle ?? null,
        dateCreated: remote.dateCreated ?? Date.now(),
      });
    });

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // --- Settings/preferences (Notes page collapsed-tag layout + last-used tags) ---
  const remoteUserData = userSnap.exists ? userSnap.data() : null;
  const remoteSettings = remoteUserData && remoteUserData.settings;
  if (remoteSettings) {
    if (Array.isArray(remoteSettings.collapsedNoteTagKeys)) {
      localStorage.setItem(
        Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY,
        JSON.stringify(remoteSettings.collapsedNoteTagKeys),
      );
    }
    if (Array.isArray(remoteSettings.lastUsedNoteTagIds)) {
      localStorage.setItem(
        Config.Db.LAST_NOTE_TAGS_STORAGE_KEY,
        JSON.stringify(remoteSettings.lastUsedNoteTagIds),
      );
    }
  }

  // Refresh every in-memory cache + on-screen view from the freshly
  // rebuilt local database, same as what happens after a normal sign-in sync.
  fetchLocalLibrary();
  if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
  if (typeof collapsedNoteTagKeys !== "undefined" && typeof loadCollapsedNoteTagKeys === "function") {
    collapsedNoteTagKeys = loadCollapsedNoteTagKeys();
  }
}

// -----------------------------------------------------------------
// 3. HARD PUSH (local -> cloud, overwriting cloud)
// -----------------------------------------------------------------
function promptHardPush() {
  if (!currentUser) {
    alert("Sign in to Sync first — Hard Push needs a cloud account to push to.");
    return;
  }
  openDangerConfirmModal({
    theme: "push",
    title: "⬆️ Hard Push to Cloud",
    bodyHtml: `
      <p><strong>Your cloud data for ${escapeHtml(currentUser.email || "your account")} will be overwritten</strong>
      with a full copy of what's stored on this device right now.</p>
      <p>Every book, group, note, tag, and setting is uploaded — not just what's changed —
      and any cloud data this device doesn't have locally will be removed from the cloud
      to match.</p>
      <p><strong>Local data on this device is left completely unchanged.</strong></p>
      <p>Use this when this device's local data is correct and you want the cloud to match it exactly.</p>
    `,
    confirmPhrase: "PUSH TO CLOUD",
    confirmLabel: "Hard Push",
    onConfirm: hardPushToCloud,
  });
}

/*
 Overwrites the cloud with a full mirror of local data. Reuses the
 existing per-item push functions (pushBookMetadataToCloud,
 pushBookFileToCloud, pushGroupToCloud, pushNoteToCloud,
 pushNoteTagToCloud) so the shape of what's written stays identical to
 normal incremental syncing - the only difference here is that every
 local record is pushed unconditionally, and anything present in the
 cloud but no longer present locally is deleted so the cloud becomes an
 exact mirror rather than a superset.
*/
async function hardPushToCloud() {
  if (!currentUser) throw new Error("Not signed in.");

  // Read current cloud doc ids up front so we know what to delete once
  // the fresh push is written (id sets, not full docs - keeps this cheap).
  const [existingBooksSnap, existingGroupsSnap, existingNotesSnap, existingNoteTagsSnap] = await Promise.all([
    booksCollection().get(),
    groupsCollection().get(),
    notesCollection().get(),
    noteTagsCollection().get(),
  ]);

  /*
   Read straight from IndexedDB rather than loadedBooksMemory/
   loadedGroupsMemory/loadedNotesMemory/loadedNoteTagsMemory. Those
   in-memory caches are only as fresh as the last explicit fetch, and
   pullInitialSyncFromCloud() (11-firebase-sync.js) documents a real race
   where cloud sync can run before a given cache is populated for the
   first time in a session. If Hard Push trusted a stale/empty cache
   here, it wouldn't just skip pushing real local data - the cleanup pass
   below would see an empty local id set and DELETE every matching record
   from the cloud, since nothing local would appear to reference it.
  */
  const localBooks = await getAllFromLocalStore(STORE_BOOKS);
  const localGroups = await getAllFromLocalStore(STORE_GROUPS);
  const localNotes = await getAllFromLocalStore(STORE_NOTES);
  const localNoteTags = await getAllFromLocalStore(STORE_NOTE_GROUPS);

  const localBookIds = new Set(localBooks.map((b) => b.id));
  const localGroupIds = new Set(localGroups.map((g) => g.id));
  const localNoteIds = new Set(localNotes.map((n) => n.id));
  const localNoteTagIds = new Set(localNoteTags.map((t) => t.id));

  // --- Push every local record unconditionally ---
  for (const group of localGroups) {
    await pushGroupToCloudForced(group);
  }
  for (const book of localBooks) {
    await pushBookMetadataToCloud(book);
    await pushBookFileToCloud(book);
  }
  for (const tag of localNoteTags) {
    await pushNoteTagToCloud(tag);
  }
  for (const note of localNotes) {
    await pushNoteToCloud(note);
  }

  // --- Settings/preferences: push local values as-is, last-write-wins bundle ---
  if (typeof pushNoteSettingsToCloudForced === "function") {
    await pushNoteSettingsToCloudForced();
  }

  // --- Delete anything on the cloud that no longer exists locally, so the
  //     cloud becomes an exact mirror rather than a superset ---
  for (const docSnap of existingBooksSnap.docs) {
    const id = Number(docSnap.id);
    if (!localBookIds.has(id)) await deleteBookFromCloud(id);
  }
  for (const docSnap of existingGroupsSnap.docs) {
    const id = Number(docSnap.id);
    if (!localGroupIds.has(id)) await deleteGroupFromCloud(id);
  }
  for (const docSnap of existingNotesSnap.docs) {
    const id = Number(docSnap.id);
    if (!localNoteIds.has(id)) await deleteNoteFromCloud(id);
  }
  for (const docSnap of existingNoteTagsSnap.docs) {
    const id = Number(docSnap.id);
    if (!localNoteTagIds.has(id)) await deleteNoteTagFromCloud(id);
  }

  // Local data is intentionally left untouched by this whole function.
}

/*
 pushGroupToCloud() in 11-firebase-sync.js is throttled (at most once per
 CLOUD_PROGRESS_PUSH_INTERVAL_MS per group), which is correct for normal
 editing but wrong here - Hard Push needs every group written for real,
 immediately, regardless of when it was last pushed. Bypasses the shared
 throttle map directly rather than duplicating the write logic.
*/
async function pushGroupToCloudForced(group) {
  if (!currentUser || !group || group.id == null) return;
  delete lastThrottledCloudPush[`group:${group.id}`];
  await groupsCollection()
    .doc(String(group.id))
    .set(
      {
        name: group.name ?? null,
        backgroundColor: group.backgroundColor ?? null,
        lastModified: Date.now(),
      },
      { merge: true },
    );
}

/*
 Same throttle-bypass treatment as pushGroupToCloudForced() above, for the
 settings bundle (pushNoteSettingsToCloud() in 11-firebase-sync.js is
 throttled under the "settings" key).
*/
async function pushNoteSettingsToCloudForced() {
  if (!currentUser) return;
  delete lastThrottledCloudPush["settings"];
  await userDoc().set(
    {
      settings: {
        collapsedNoteTagKeys: Array.from(collapsedNoteTagKeys || []),
        lastUsedNoteTagIds: typeof loadLastUsedNoteTagIds === "function" ? loadLastUsedNoteTagIds() : [],
        lastModified: Date.now(),
      },
    },
    { merge: true },
  );
}