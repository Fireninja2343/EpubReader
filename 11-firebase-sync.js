/*
 =================================================================
 FIREBASE CLOUD SYNC MODULE
 IndexedDB remains the source of truth for offline use. This module
 mirrors book metadata and reading progress to Firestore, and stores the
 actual .epub binaries as chunked base64 text also inside Firestore
 (avoiding the need for Firebase Storage or a billing plan).

 SYNC MODEL (deliberately NOT real-time):
 - On sign-in (or on every fresh page load while already signed in), one
   catch-up pass runs: anything new on the cloud is pulled down, and
   anything that only exists locally is pushed up.
 - While reading, progress is pushed to the cloud at most once every 20
   seconds per book (see the throttle logic around lastCloudProgressPush),
   no matter how much scrolling happens or how often progress updates are
   requested.
 - Closing a book ("Back to Library") forces one final push so the last
   few seconds of a session aren't lost to that 20s throttle window —
   that forced push is the only thing allowed to bypass the throttle, and
   it has its own short minimum gap so it can't double-push.
 - There is deliberately no live listener and no push triggered by
   tab-switching or backgrounding anymore — both were sources of
   uncapped, un-throttled Firestore reads/writes just from having the app
   open in a tab. As a result, changes made on another device won't show
   up here until a reload or re-sign-in happens — a real trade-off, made
   on purpose to keep background cost at zero.
 ================================================================= */

// Reuses the single copy of the config already defined in 00-config.js
// instead of keeping a second, independently-hardcoded copy here that could
// silently drift out of sync with it.
firebase.initializeApp(Config.firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();

/*
 Firestore's own offline-persistence cache (enablePersistence()) is
 intentionally left disabled here. That cache keeps a local queue of
 un-sent writes across reloads, and if writes keep failing for any reason,
 that queue can grow without ever fully draining — every reload would then
 replay the backlog and immediately flood the write stream again. Since
 the app already has IndexedDB as its durable local store, Firestore
 doesn't need a second offline cache layered on top.

 Firestore also caps a single document at roughly 1MiB. EPUB files are
 stored as base64 text split across several small documents in a
 "fileChunks" subcollection so that cap is never hit. 700,000 characters
 per chunk keeps each one safely under the limit.
*/
const FILE_CHUNK_SIZE = Config.Sync.FILE_CHUNK_SIZE;

let currentUser = null;
let booksListenerUnsub = null;
let groupsListenerUnsub = null;
let initialSyncInProgress = false;

/*
 Generic per-key throttle used by pushGroupToCloud (and available for any
 future caller that needs the same "at most once per
 CLOUD_PROGRESS_PUSH_INTERVAL_MS" behavior already used for book progress
 pushes in 02-db.js). Without this function existing, any call to
 pushGroupToCloud() throws a ReferenceError and silently breaks group
 creation/editing sync to the cloud.
*/
let lastThrottledCloudPush = {};
function throttledCloudPush(key, pushFn) {
  const now = Date.now();
  const last = lastThrottledCloudPush[key] || 0;
  if (now - last >= Config.Sync.CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
    lastThrottledCloudPush[key] = now;
    pushFn();
  }
}

/*
 Guards against re-running the entire sync setup every time Firebase
 re-emits onAuthStateChanged for the SAME user (which can happen on token
 refresh, mobile tab resume, reconnect, etc.) within a single page load.
*/
let syncedUid = null;

// Tracks how many Firestore writes are actually being issued, for visibility while debugging.
let cloudWriteCount = 0;
function logCloudWrite(label) {
  cloudWriteCount++;
  console.log(`[FirebaseSync] cloud write #${cloudWriteCount} (${label})`);
}

// -----------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------

function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();

  fbAuth.signInWithPopup(provider).catch((err) => {
    alert("Sign-in failed: " + err.message);
  });
}

// Picks up the result after signInWithRedirect() bounces the page back from Google
fbAuth.getRedirectResult().catch((err) => {
  if (err && err.code !== "auth/no-auth-event") {
    alert("Sign-in failed: " + err.message);
  }
});

function signOutOfSync() {
  syncedUid = null;
  fbAuth.signOut();
}

fbAuth.onAuthStateChanged((user) => {
  currentUser = user;
  updateSyncUI();

  if (user) {
    if (syncedUid === user.uid) {
      console.log("[FirebaseSync] onAuthStateChanged fired again for the same user — skipping re-sync");
      return;
    }
    syncedUid = user.uid;
    pullInitialSyncFromCloud();
  } else {
    syncedUid = null;
  }
});

function updateSyncUI() {
  const statusEl = document.getElementById("sync-status");
  const btnEl = document.getElementById("btn-sync-signin");
  if (!statusEl || !btnEl) return;

  if (currentUser) {
    statusEl.textContent = `☁️ Synced: ${currentUser.email}`;
    btnEl.textContent = "🔌 Sign Out";
    btnEl.onclick = signOutOfSync;
  } else {
    statusEl.textContent = "☁️ Not signed in";
    btnEl.textContent = "🔄 Sign in to Sync";
    btnEl.onclick = signInWithGoogle;
  }
}

function booksCollection() {
  return fbDb.collection("users").doc(currentUser.uid).collection("books");
}
function groupsCollection() {
  return fbDb.collection("users").doc(currentUser.uid).collection("groups");
}

// -----------------------------------------------------------------
// PUSH: local change -> cloud
// -----------------------------------------------------------------
async function pushBookMetadataToCloud(book) {
  if (!currentUser || !book || book.id == null) return;
  if (book.isRead === undefined) book.isRead = false; // Ensure isRead is always defined
  logCloudWrite(`book metadata #${book.id}`);
  await booksCollection()
    .doc(String(book.id))
    .set(
      {
        title: book.title ?? null,
        cover: book.cover ?? null,
        sortOrder: book.sortOrder ?? null,
        currentChapter: book.currentChapter ?? 0,
        scrollOffset: book.scrollOffset ?? 0,
        isRead: book.isRead ?? false,
        dateImported: book.dateImported ?? null,
        groupId: book.groupId ?? null,
        lastModified: book.lastModified || Date.now(),
        timeSpentSeconds: book.timeSpentSeconds ?? 0,
        // Cached EPUB analysis - see ensureBookMetadataCached() in 06-epub-reader.js.
        totalPages: book.totalPages ?? null,
        totalWords: book.totalWords ?? null,
        chapterCount: book.chapterCount ?? null,
        // Reading-history fields - see recordReadingSessionStart() and markBookAsRead() in 02-db.js.
        firstOpened: book.firstOpened ?? null,
        lastOpened: book.lastOpened ?? null,
        completedDate: book.completedDate ?? null,
        totalSessions: book.totalSessions ?? 0,
        // Real per-session log - see appendReadingSession() in 02-db.js and
        // the session lifecycle engine in 09-stats-and-context-menu.js.
        readingSessions: book.readingSessions ?? [],
      },
      { merge: true },
    );
}

async function pushBookFileToCloud(book) {
  if (!currentUser || !book || !book.fileData) return;

  // Normalize to a base64 data-URL string ("data:application/epub+zip;base64,....")
  const base64DataUrl =
    book.fileData instanceof Blob
      ? await convertBlobToBase64(book.fileData)
      : book.fileData;

  const chunks = [];
  for (let i = 0; i < base64DataUrl.length; i += FILE_CHUNK_SIZE) {
    chunks.push(base64DataUrl.slice(i, i + FILE_CHUNK_SIZE));
  }

  const chunkCollection = booksCollection()
    .doc(String(book.id))
    .collection("fileChunks");

  const existing = await chunkCollection.get();
  const staleDocs = existing.docs.filter((d) => Number(d.id) >= chunks.length);
  for (const staleDoc of staleDocs) {
    logCloudWrite(`stale chunk delete #${book.id}`);
    await staleDoc.ref.delete();
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    logCloudWrite(`file chunk #${book.id}/${idx}`);
    await chunkCollection.doc(String(idx)).set({ data: chunks[idx] });
  }

  logCloudWrite(`chunkCount update #${book.id}`);
  await booksCollection()
    .doc(String(book.id))
    .set({ chunkCount: chunks.length }, { merge: true });
}

/*
 Group pushes go through the same shared throttle used elsewhere for book
 reading-progress pushes, so rapid edits to a group (renaming it, changing
 its color repeatedly, etc.) still result in no more than one Firestore
 write per group every 20 seconds.
*/
async function pushGroupToCloud(group) {
  if (!currentUser || !group || group.id == null) return;
  throttledCloudPush(`group:${group.id}`, async () => {
    logCloudWrite(`group #${group.id}`);
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
  });
}

async function deleteBookFromCloud(bookId) {
  if (!currentUser) return;
  const chunkCollection = booksCollection()
    .doc(String(bookId))
    .collection("fileChunks");
  const existingChunks = await chunkCollection.get();
  for (const chunkDoc of existingChunks.docs) {
    await chunkDoc.ref.delete().catch(() => {});
  }
  await booksCollection()
    .doc(String(bookId))
    .delete()
    .catch(() => {});
}

async function deleteGroupFromCloud(groupId) {
  if (!currentUser) return;
  await groupsCollection()
    .doc(String(groupId))
    .delete()
    .catch(() => {});
}

// -----------------------------------------------------------------
// PULL: cloud -> local (one-time catch-up run right after sign-in / reload)
// -----------------------------------------------------------------
async function pullInitialSyncFromCloud() {
  if (!currentUser || initialSyncInProgress) return;
  initialSyncInProgress = true;
  console.log("[FirebaseSync] running pullInitialSyncFromCloud()");

  try {
    const [remoteBooksSnap, remoteGroupsSnap] = await Promise.all([
      booksCollection().get(),
      groupsCollection().get(),
    ]);

    const remoteBookIds = new Set(
      remoteBooksSnap.docs.map((d) => Number(d.id)),
    );
    const remoteGroupIds = new Set(
      remoteGroupsSnap.docs.map((d) => Number(d.id)),
    );

    await new Promise((resolve) => {
      const tx = db.transaction([STORE_GROUPS], "readwrite");
      const groupsStore = tx.objectStore(STORE_GROUPS);
      remoteGroupsSnap.forEach((docSnap) => {
        groupsStore.put({ id: Number(docSnap.id), ...docSnap.data() });
      });
      tx.oncomplete = resolve;
    });

    for (const group of loadedGroupsMemory) {
      if (!remoteGroupIds.has(group.id)) {
        await pushGroupToCloud(group);
      }
    }

    for (const docSnap of remoteBooksSnap.docs) {
      const remote = docSnap.data();
      const bookId = Number(docSnap.id);
      const localBook = loadedBooksMemory.find((b) => b.id === bookId);

      if (!localBook) {
        await downloadBookFromCloud(bookId, remote);
      } else if ((remote.lastModified || 0) > (localBook.lastModified || 0)) {
        await applyRemoteBookUpdate(bookId, remote);
      } else if ((localBook.lastModified || 0) > (remote.lastModified || 0)) {
        await pushBookMetadataToCloud(localBook);
      }
    }

    for (const book of loadedBooksMemory) {
      if (!remoteBookIds.has(book.id)) {
        await pushBookMetadataToCloud(book);
        await pushBookFileToCloud(book);
      }
    }
  } catch (err) {
    console.error("Firebase sync error:", err);
    let hint = "";
    if (err.code === "permission-denied") {
      hint =
        "\n\nThis usually means your Firestore security rules aren't published yet.";
    } else if (err.code === "resource-exhausted") {
      hint = "\n\nToo many writes went out at once — try signing in again.";
    } else if (err.code === "not-found" || err.code === "unavailable") {
      hint = "\n\nCheck that the Firestore database has actually been created.";
    }
    alert("Cloud sync ran into a problem: " + err.message + hint);
  } finally {
    initialSyncInProgress = false;
    fetchLocalLibrary();
  }
}

function applyRemoteBookUpdate(bookId, remote) {
  return new Promise((resolve) => {
    const tx = db.transaction([STORE_BOOKS], "readwrite");
    const store = tx.objectStore(STORE_BOOKS);
    const getReq = store.get(bookId);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) {
        rec.currentChapter = remote.currentChapter;
        rec.scrollOffset = remote.scrollOffset;
        rec.isRead = remote.isRead;
        rec.groupId = remote.groupId;
        rec.sortOrder = remote.sortOrder;
        rec.lastModified = remote.lastModified;
        rec.timeSpentSeconds = remote.timeSpentSeconds ?? rec.timeSpentSeconds;
        /*
         Cached EPUB analysis and reading-history fields only overwrite the
         local copy if the remote doc actually has them set. Without the ??
         fallback, a book synced from a device that hasn't picked up this
         feature yet (or a remote doc written before these fields existed)
         would null out data this device already computed locally.
        */
        rec.totalPages = remote.totalPages ?? rec.totalPages;
        rec.totalWords = remote.totalWords ?? rec.totalWords;
        rec.chapterCount = remote.chapterCount ?? rec.chapterCount;
        rec.firstOpened = remote.firstOpened ?? rec.firstOpened;
        rec.lastOpened = remote.lastOpened ?? rec.lastOpened;
        rec.completedDate = remote.completedDate ?? rec.completedDate;
        rec.totalSessions = remote.totalSessions ?? rec.totalSessions;
        /*
         Same ?? fallback treatment as the other reading-history fields
         above: a remote doc written before this feature existed simply
         won't have readingSessions, so keep whatever this device already
         has locally instead of wiping it out.
        */
        rec.readingSessions = remote.readingSessions ?? rec.readingSessions;
        store.put(rec);
      }
    };
    tx.oncomplete = resolve;
  });
}

async function downloadBookFromCloud(bookId, remoteMeta) {
  try {
    if (!remoteMeta.chunkCount) return;

    const chunkCollection = booksCollection()
      .doc(String(bookId))
      .collection("fileChunks");

    const chunkSnaps = [];
    for (let idx = 0; idx < remoteMeta.chunkCount; idx++) {
      chunkSnaps.push(await chunkCollection.doc(String(idx)).get());
    }

    if (chunkSnaps.some((snap) => !snap.exists)) return;

    const base64DataUrl = chunkSnaps.map((snap) => snap.data().data).join("");
    const blob = base64ToBlob(base64DataUrl);

    await new Promise((resolve) => {
      const tx = db.transaction([STORE_BOOKS], "readwrite");
      tx.objectStore(STORE_BOOKS).put({
        id: bookId,
        title: remoteMeta.title,
        cover: remoteMeta.cover || null,
        fileData: blob,
        sortOrder: remoteMeta.sortOrder,
        currentChapter: remoteMeta.currentChapter,
        scrollOffset: remoteMeta.scrollOffset,
        isRead: remoteMeta.isRead === undefined ? false : remoteMeta.isRead,
        dateImported: remoteMeta.dateImported,
        groupId: remoteMeta.groupId,
        lastModified: remoteMeta.lastModified,
        timeSpentSeconds: remoteMeta.timeSpentSeconds ?? 0,
        // Cached EPUB analysis, if the remote doc has it - ensureBookMetadataCached()
        // will backfill it locally later if not (e.g. an older remote doc).
        totalPages: remoteMeta.totalPages ?? null,
        totalWords: remoteMeta.totalWords ?? null,
        chapterCount: remoteMeta.chapterCount ?? null,
        firstOpened: remoteMeta.firstOpened ?? null,
        lastOpened: remoteMeta.lastOpened ?? null,
        completedDate: remoteMeta.completedDate ?? null,
        totalSessions: remoteMeta.totalSessions ?? 0,
        readingSessions: remoteMeta.readingSessions ?? [],
      });
      tx.oncomplete = resolve;
    });
  } catch (err) {
    console.warn(`Could not download book ${bookId} from cloud yet:`, err);
  }
}

/*
 -----------------------------------------------------------------
 LIVE LISTENERS — DEFINED BUT NOT USED
 Kept here in case real-time cross-device sync is wanted again later, but
 these are not called anywhere in the current flow. The problem with
 real-time listeners is that every confirmed write triggers a matching
 read via the listener attached to that same collection, which reproduces
 exactly the "reads/writes climbing just because the tab is open" behavior
 this module is designed to avoid. As long as these stay unattached, sync
 only happens during the explicit sign-in/reload catch-up pass above.
 -----------------------------------------------------------------
*/
function attachRemoteListeners() {
  if (booksListenerUnsub || groupsListenerUnsub) {
    detachRemoteListeners();
  }

  booksListenerUnsub = booksCollection().onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.doc.metadata.hasPendingWrites) return;

      const remote = change.doc.data();
      const bookId = Number(change.doc.id);

      if (change.type === "removed") {
        const tx = db.transaction([STORE_BOOKS], "readwrite");
        tx.objectStore(STORE_BOOKS).delete(bookId);
        tx.oncomplete = fetchLocalLibrary;
        return;
      }

      const localBook = loadedBooksMemory.find((b) => b.id === bookId);
      if (!localBook) {
        await downloadBookFromCloud(bookId, remote);
        fetchLocalLibrary();
      } else if ((remote.lastModified || 0) > (localBook.lastModified || 0)) {
        await applyRemoteBookUpdate(bookId, remote);
        fetchLocalLibrary();
      }
    });
  });

  groupsListenerUnsub = groupsCollection().onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.doc.metadata.hasPendingWrites) return;

      const groupId = Number(change.doc.id);
      const tx = db.transaction([STORE_GROUPS], "readwrite");
      const store = tx.objectStore(STORE_GROUPS);

      if (change.type === "removed") {
        store.delete(groupId);
      } else {
        store.put({ id: groupId, ...change.doc.data() });
      }
      tx.oncomplete = fetchLocalLibrary;
    });
  });
}

function detachRemoteListeners() {
  if (booksListenerUnsub) booksListenerUnsub();
  if (groupsListenerUnsub) groupsListenerUnsub();
  booksListenerUnsub = null;
  groupsListenerUnsub = null;
}