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
// =================================================================
// BACKUP: EXPORT (FIXED - preserves EPUB files)
// =================================================================
async function exportLibraryToJSON() {
  const transaction = db.transaction([STORE_BOOKS, STORE_GROUPS], "readonly");
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);

  const books = await new Promise((res) => {
    booksStore.getAll().onsuccess = (e) => res(e.target.result);
  });

  const groups = await new Promise((res) => {
    groupsStore.getAll().onsuccess = (e) => res(e.target.result);
  });

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

  const backupPackage = {
    exportDate: new Date().toISOString(),
    books: safeBooks,
    groups: groups,
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

function importLibraryFromJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = function (e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.books || !data.groups) throw new Error("Invalid schema");

      const transaction = db.transaction(
        [STORE_BOOKS, STORE_GROUPS],
        "readwrite"
      );

      const booksStore = transaction.objectStore(STORE_BOOKS);
      const groupsStore = transaction.objectStore(STORE_GROUPS);

      booksStore.clear();
      groupsStore.clear();

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

      transaction.oncomplete = () => {
        alert("Library restored successfully!");
        fetchLocalLibrary();
      };
    } catch (err) {
      alert("Failed to parse backup file.");
    }
  };

  reader.readAsText(file);
}