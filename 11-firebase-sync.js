// =================================================================
// FIREBASE CLOUD SYNC MODULE
// IndexedDB stays the source of truth for offline use. This module
// mirrors book metadata / reading progress to Firestore, and the
// actual .epub binaries as chunked base64 text also inside Firestore
// (no Firebase Storage / no billing plan needed), so a second device
// can pull everything down and stay in sync.
// =================================================================

// --- FILL THIS IN with the config object from your Firebase project ---
// (Project settings -> General -> "Your apps" -> Web app -> SDK setup and configuration)
// NOTE: this module only uses Auth + Firestore — no Firebase Storage — so it works
// entirely on the free "Spark" plan, no billing account required.
const firebaseConfig = {
apiKey: "AIzaSyB-lHa5mHi-iMdgGaTe5ehFZE1Xf2T8TkQ",
authDomain: "epubreader-fire2343.firebaseapp.com",
projectId: "epubreader-fire2343",
storageBucket: "epubreader-fire2343.firebasestorage.app",
messagingSenderId: "171569428425",
appId: "1:171569428425:web:7e43e4deb49ab408cdda18",
measurementId: "G-QB21V0K0KP"
};

firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();

// Keep working offline: Firestore caches locally and syncs when back online
fbDb.enablePersistence().catch(() => {
  // Multiple tabs open, or browser doesn't support it — sync will still work, just without offline cache
});

// Firestore caps a single document at ~1MiB. EPUB files are stored as base64 text
// split across several small documents in a "fileChunks" subcollection so we never
// hit that ceiling. 700,000 characters keeps each chunk safely under the limit.
const FILE_CHUNK_SIZE = 700000;

let currentUser = null;
let booksListenerUnsub = null;
let groupsListenerUnsub = null;
let initialSyncInProgress = false;

// -----------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------
function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();

  if (isMobileBrowser()) {
    // Popups get killed almost immediately by mobile browsers (that's the
    // "about:blank flashes and disappears" symptom) — redirect the whole
    // page to Google instead, then pick the result back up below on load.
    fbAuth.signInWithRedirect(provider);
  } else {
    fbAuth.signInWithPopup(provider).catch((err) => {
      alert("Sign-in failed: " + err.message);
    });
  }
}

// Picks up the result after signInWithRedirect() bounces the page back from Google
fbAuth.getRedirectResult().catch((err) => {
  if (err && err.code !== "auth/no-auth-event") {
    alert("Sign-in failed: " + err.message);
  }
});

function signOutOfSync() {
  detachRemoteListeners();
  fbAuth.signOut();
}

fbAuth.onAuthStateChanged((user) => {
  currentUser = user;
  updateSyncUI();
  if (user) {
    attachRemoteListeners();
    pullInitialSyncFromCloud();
  } else {
    detachRemoteListeners();
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
  await booksCollection().doc(String(book.id)).set(
    {
      title: book.title,
      cover: book.cover || null,
      sortOrder: book.sortOrder,
      currentChapter: book.currentChapter,
      scrollOffset: book.scrollOffset,
      isRead: book.isRead,
      dateImported: book.dateImported,
      groupId: book.groupId,
      lastModified: book.lastModified || Date.now(),
    },
    { merge: true }
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

  // Clean up leftover chunks if this version of the file is smaller than a previous upload
  const existing = await chunkCollection.get();
  await Promise.all(
    existing.docs
      .filter((d) => Number(d.id) >= chunks.length)
      .map((d) => d.ref.delete())
  );

  await Promise.all(
    chunks.map((chunkStr, idx) =>
      chunkCollection.doc(String(idx)).set({ data: chunkStr })
    )
  );

  await booksCollection()
    .doc(String(book.id))
    .set({ chunkCount: chunks.length }, { merge: true });
}

async function pushGroupToCloud(group) {
  if (!currentUser || !group || group.id == null) return;
  await groupsCollection()
    .doc(String(group.id))
    .set({ ...group, lastModified: Date.now() }, { merge: true });
}

async function deleteBookFromCloud(bookId) {
  if (!currentUser) return;
  const chunkCollection = booksCollection()
    .doc(String(bookId))
    .collection("fileChunks");
  const existingChunks = await chunkCollection.get();
  await Promise.all(existingChunks.docs.map((d) => d.ref.delete()));
  await booksCollection().doc(String(bookId)).delete().catch(() => {});
}

async function deleteGroupFromCloud(groupId) {
  if (!currentUser) return;
  await groupsCollection().doc(String(groupId)).delete().catch(() => {});
}

// -----------------------------------------------------------------
// PULL: cloud -> local (one-time catch-up run right after sign-in)
// -----------------------------------------------------------------
async function pullInitialSyncFromCloud() {
  if (!currentUser || initialSyncInProgress) return;
  initialSyncInProgress = true;

  try {
    const [remoteBooksSnap, remoteGroupsSnap] = await Promise.all([
      booksCollection().get(),
      groupsCollection().get(),
    ]);

    const remoteBookIds = new Set(remoteBooksSnap.docs.map((d) => Number(d.id)));
    const remoteGroupIds = new Set(remoteGroupsSnap.docs.map((d) => Number(d.id)));

    // Groups are small, just upsert them directly
    await new Promise((resolve) => {
      const tx = db.transaction([STORE_GROUPS], "readwrite");
      const groupsStore = tx.objectStore(STORE_GROUPS);
      remoteGroupsSnap.forEach((docSnap) => {
        groupsStore.put({ id: Number(docSnap.id), ...docSnap.data() });
      });
      tx.oncomplete = resolve;
    });

    // Any group that only exists on THIS device (e.g. this is the very first
    // sign-in and the cloud is still empty) needs to be pushed up
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
        // Book doesn't exist on this device yet — pull the file down and create it
        await downloadBookFromCloud(bookId, remote);
      } else if ((remote.lastModified || 0) > (localBook.lastModified || 0)) {
        // Cloud copy is newer (e.g. progress made on the other device) — apply it
        await applyRemoteBookUpdate(bookId, remote);
      } else if ((localBook.lastModified || 0) > (remote.lastModified || 0)) {
        // This device has the newer copy — push it back up
        await pushBookMetadataToCloud(localBook);
      }
    }

    // Any book that only exists on THIS device and has never been pushed
    // (first sign-in, or it was imported while offline) needs a full upload
    for (const book of loadedBooksMemory) {
      if (!remoteBookIds.has(book.id)) {
        await pushBookMetadataToCloud(book);
        await pushBookFileToCloud(book);
      }
    }
  } catch (err) {
    console.error("Firebase sync error:", err);
    alert(
      "Cloud sync ran into a problem: " +
        err.message +
        "\n\nMost commonly this means your Firestore security rules aren't published yet, or the database hasn't been created."
    );
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
    if (!remoteMeta.chunkCount) return; // file hasn't finished uploading from the other device yet — will retry on next sync

    const chunkCollection = booksCollection()
      .doc(String(bookId))
      .collection("fileChunks");

    const chunkSnaps = await Promise.all(
      Array.from({ length: remoteMeta.chunkCount }, (_, idx) =>
        chunkCollection.doc(String(idx)).get()
      )
    );

    if (chunkSnaps.some((snap) => !snap.exists)) return; // still mid-upload, retry later

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
        isRead: remoteMeta.isRead,
        dateImported: remoteMeta.dateImported,
        groupId: remoteMeta.groupId,
        lastModified: remoteMeta.lastModified,
      });
      tx.oncomplete = resolve;
    });
  } catch (err) {
    // The metadata doc may exist slightly before the file finishes uploading from the other device — safe to skip and retry on next sync
    console.warn(`Could not download book ${bookId} from cloud yet:`, err);
  }
}

// -----------------------------------------------------------------
// LIVE LISTENERS: cloud change while this device is open -> pull it in immediately
// -----------------------------------------------------------------
function attachRemoteListeners() {
  booksListenerUnsub = booksCollection().onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.doc.metadata.hasPendingWrites) return; // this is our own outgoing write, ignore it

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