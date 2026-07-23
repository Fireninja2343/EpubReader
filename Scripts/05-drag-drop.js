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