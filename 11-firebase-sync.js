/*
 =================================================================
 FIREBASE CLOUD SYNC MODULE
 IndexedDB stays the source of truth for offline use. This module
 mirrors book metadata / reading progress to Firestore, and the
 actual .epub binaries as chunked base64 text also inside Firestore
 (no Firebase Storage / no billing plan needed).

 SYNC MODEL (deliberately NOT real-time):
 - On sign-in (or every fresh page load while already signed in), we do
   ONE catch-up pass: pull down anything new from the cloud, push up
   anything that's only local.
 - While reading, progress pushes to the cloud AT MOST once per 20s per
   book (see throttledCloudPush in 02-db.js), no matter how much you
   scroll or how often the app calls updateBookProgressInDB.
 - Closing a book ("Back to Library") forces one final push so the last
   few seconds of a session aren't lost to the throttle window — that is
   the ONLY thing allowed to bypass the 20s throttle, and even it has its
   own short minimum gap so it can't double-push.
 - There is deliberately NO live listener and NO push on tab-switch/
   backgrounding anymore — both were sources of uncapped, un-throttled
   Firestore reads/writes just from having the app open. That means
   changes made on another device won't appear here until  reload or
   re-sign-in — a real trade-off, made on purpose to keep this at zero
   background cost.
 ================================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyB-lHa5mHi-iMdgGaTe5ehFZE1Xf2T8TkQ",
  authDomain: "epubreader-fire2343.firebaseapp.com",
  projectId: "epubreader-fire2343",
  storageBucket: "epubreader-fire2343.firebasestorage.app",
  messagingSenderId: "171569428425",
  appId: "1:171569428425:web:7e43e4deb49ab408cdda18",
  measurementId: "G-QB21V0K0KP",
};

firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
/*
 NOTE: Firestore's own offline-persistence cache (enablePersistence()) is
 intentionally NOT enabled. That cache keeps a local queue of un-sent
 writes across reloads, and if writes keep failing, that queue can grow
 and never fully drain — every reload then replays the pile-up and
 immediately floods the write stream again. The app's own IndexedDB is
 already the durable local store, so Firestore doesn't need a second one.

 Firestore caps a single document at ~1MiB. EPUB files are stored as base64 text
 split across several small documents in a "fileChunks" subcollection so we never
 hit that ceiling. 700,000 characters keeps each chunk safely under the limit.
*/
const FILE_CHUNK_SIZE = Config.Sync.FILE_CHUNK_SIZE;

let currentUser = null;
let booksListenerUnsub = null;
let groupsListenerUnsub = null;
let initialSyncInProgress = false;
/*
 Guards against re-running the whole sync setup every time Firebase re-emits
 onAuthStateChanged for the SAME user (token refresh, mobile tab resume,
 reconnect, etc.) within one page load.
*/
let syncedUid = null;

// Simple visibility into how many Firestore writes we're actually issuing.
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

// Group pushes go through the SAME shared throttle as book progress
// (defined in 02-db.js) — no more than one push per group per 20s, even
// from rapid edits.
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
      });
      tx.oncomplete = resolve;
    });
  } catch (err) {
    console.warn(`Could not download book ${bookId} from cloud yet:`, err);
  }
}

/* -----------------------------------------------------------------
 LIVE LISTENERS — DEFINED BUT NOT USED
 Kept here in case of ever wanting a real-time cross-device sync back later, but
 they are not called anywhere right now. Real-time listeners mean every
 confirmed write triggers a matching read via your own listener, which is
 exactly the "reads/writes climbing just from the tab being open" behavior
 we don't want. Without these attached, syncing only happens on the
 explicit sign-in/reload catch-up pass above.
 ----------------------------------------------------------------- */
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
