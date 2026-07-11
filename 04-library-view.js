// =================================================================
// SELECTION DRIVERS & INTERFACE LAYOUT RENDERER
// =================================================================
function renderLibraryGrid() {
  const container = document.getElementById("grid-container");
  container.innerHTML = "";
  selectedBookIds = [];
  lastSelectedBookId = null;

  // SCENARIO 1: VIEW GROUPS AND UNASSIGNED SECTIONS (DEFAULT HIERARCHY)
  if (globalLibraryViewMode === "grouped" && activeGroupFilterId === null) {
    // Render Group Folders First
    loadedGroupsMemory.forEach((group) => {
      const card = document.createElement("div");
      card.className = "group-card";
      card.style.backgroundColor = group.backgroundColor;
      card.style.setProperty("--card-color", group.backgroundColor);

      card.addEventListener("dragover", (e) => e.preventDefault());
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        moveSelectedBooksToGroup(group.id);
      });

      card.addEventListener("click", (e) => {
        if (e.detail === 2) {
          enterGroupView(group.id, group.name, group.backgroundColor);
        }
      });

      card.innerHTML = "";
      buildGroupCardContents(card, group);
      container.appendChild(card);
    });

    // Filter rendering scope to show ONLY standalone files with no group tags attached
    const unassignedBooks = loadedBooksMemory.filter((b) => !b.groupId);
    buildBookCardsInLayout(unassignedBooks, container);

    // SCENARIO 2: INSIDE A SPECIFIC SUB-GROUP COMPONENT FOLDER MODE
  } else if (
    globalLibraryViewMode === "grouped" &&
    activeGroupFilterId !== null
  ) {
    const structuralGroupContextBooks = loadedBooksMemory.filter(
      (b) => b.groupId === activeGroupFilterId,
    );
    buildBookCardsInLayout(structuralGroupContextBooks, container);

    // SCENARIO 3: FLAT GLOBAL LISTING - ALL BOOKS DISPLAYED REGARDLESS OF GROUPS
  } else if (globalLibraryViewMode === "all") {
    buildBookCardsInLayout(loadedBooksMemory, container);
  }
}

function buildGroupCardContents(card, group) {
  const groupBooks = loadedBooksMemory
    .filter((book) => book.groupId === group.id)
    .slice(0, 4);

  const previewGrid = document.createElement("div");
  previewGrid.className = "group-cover-grid";

  groupBooks.forEach((book) => {
    const coverTile = document.createElement("div");
    coverTile.className = "group-cover-tile";

    if (book.cover) {
      const coverImage = document.createElement("img");
      coverImage.src = book.cover;
      coverImage.alt = book.title || "Book cover";
      coverTile.appendChild(coverImage);
    } else {
      coverTile.classList.add("group-cover-tile-empty");
      coverTile.textContent = (book.title || "?").trim().charAt(0).toUpperCase();
    }

    previewGrid.appendChild(coverTile);
  });

  const metaContainer = document.createElement("div");
  metaContainer.className = "group-meta-container";

  const groupTitle = document.createElement("strong");
  groupTitle.className = "group-title";
  groupTitle.textContent = group.name;

  const actionRow = document.createElement("div");
  actionRow.className = "group-action-row";

  const editButton = document.createElement("button");
  editButton.className = "group-mini-btn";
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openGroupModal(true, group.id, group.name, group.backgroundColor);
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "group-mini-btn";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteGroup(group.id);
  });

  actionRow.appendChild(editButton);
  actionRow.appendChild(deleteButton);
  metaContainer.appendChild(groupTitle);
  metaContainer.appendChild(actionRow);

  card.appendChild(previewGrid);
  card.appendChild(metaContainer);
}

// Sub-routine utility helper to pack structural card wrappers on the grid DOM
function buildBookCardsInLayout(booksScopingContextArray, targetDOMContainer) {
  booksScopingContextArray.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-card";
    card.setAttribute("draggable", "true");

    // REAL ID instead of index
    card.dataset.bookId = book.id;

    // Tint book cards while browsing inside a group folder
    if (activeGroupFilterId !== null && activeGroupFilterColor) {
      card.style.setProperty(
        "--group-tint",
        `color-mix(in srgb, ${activeGroupFilterColor} 75%, var(--bg-card))`,
      );
    } else if (globalLibraryViewMode === "all" && book.groupId) {
      // In the flat "All Books" view there's no single active group to
      // borrow a color from (books from every group are mixed together),
      // so look up each card's own group color individually.
      const ownGroup = loadedGroupsMemory.find((g) => g.id === book.groupId);
      if (ownGroup && ownGroup.backgroundColor) {
        card.style.setProperty(
          "--group-tint",
          `color-mix(in srgb, ${ownGroup.backgroundColor} 50%, var(--bg-card))`,
        );
      }
    }

    const dotsTrigger = document.createElement("div");
    dotsTrigger.className = "book-action-trigger-dots";
    dotsTrigger.innerText = "⋮";

    dotsTrigger.onclick = (e) => {
      toggleBookContextMenuFlyout(e, book.id);
    };

    card.appendChild(dotsTrigger);

    card.addEventListener("dragstart", handleCardDragStart);
    card.addEventListener("dragend", handleCardDragEnd);
    card.addEventListener("dragover", handleCardDragOver);
    card.addEventListener("drop", handleCardDrop);

    card.addEventListener("click", (e) =>
      handleGridCardClick(e, book.id, booksScopingContextArray),
    );

    const coverWrap = document.createElement("div");
    coverWrap.className = "cover-container";

    if (book.cover) {
      const img = document.createElement("img");
      img.src = book.cover;
      img.alt = book.title || "Book cover";
      coverWrap.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "cover-placeholder";
      placeholder.innerText = "📖";
      coverWrap.appendChild(placeholder);
    }

    const title = document.createElement("div");
    title.className = "book-title";
    title.innerText = book.title;

    card.appendChild(coverWrap);
    card.appendChild(title);
    targetDOMContainer.appendChild(card);
  });
}

// Stamps a book as opened just now, persists it, then launches the reader
function openBookAndTrackLastRead(book) {
  book.lastOpenedDate = Date.now();

  if (db) {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    transaction.objectStore(STORE_BOOKS).put(book);
  }

  launchEpubReader(book);
}

// Opens whichever single book is currently selected via the grid's click
// selection (as opposed to the double-click-to-open shortcut). Backs the
// #btn-open-book button, which is only shown while exactly one book is
// selected (see handleGridCardClick below).
function openSelectedBook() {
  if (selectedBookIds.length !== 1) return;
  const book = loadedBooksMemory.find((b) => b.id === selectedBookIds[0]);
  if (book) openBookAndTrackLastRead(book);
}

// Jumps straight into whichever book was most recently opened
function openLastReadBook() {
  const candidate = loadedBooksMemory
    .filter((b) => b.lastOpenedDate)
    .sort((a, b) => b.lastOpenedDate - a.lastOpenedDate)[0];

  if (!candidate) {
    alert("No books have been opened yet.");
    return;
  }

  openBookAndTrackLastRead(candidate);
}

function handleGridCardClick(event, bookId, scopingArrayContext) {
  event.stopPropagation();

  const cards = document.querySelectorAll(".book-card");
  const openBtn = document.getElementById("btn-open-book");

  const book = scopingArrayContext.find(b => b.id === bookId);
  if (!book) return;

  if (event.detail === 2) {
    openBookAndTrackLastRead(book);
    return;
  }

  if (event.shiftKey && lastSelectedBookId !== null) {
    selectedBookIds = [];

    let foundStart = false;

    cards.forEach((c) => {
      const id = Number(c.dataset.bookId);

      if (id === lastSelectedBookId || id === bookId) {
        foundStart = !foundStart;
        selectedBookIds.push(id);
        c.classList.add("selected");
      } else if (foundStart) {
        selectedBookIds.push(id);
        c.classList.add("selected");
      } else {
        c.classList.remove("selected");
      }
    });

  } else {
    selectedBookIds = [bookId];
    lastSelectedBookId = bookId;

    cards.forEach((c) => {
      c.classList.toggle(
        "selected",
        Number(c.dataset.bookId) === bookId
      );
    });
  }

  if (openBtn) {
    openBtn.style.display =
      selectedBookIds.length === 1 ? "inline-block" : "none";
  }
}
// Tracks sorting criteria options modifications
function sortLibrary() {
  const mode = document.getElementById("sort-selector").value;
  if (mode === "alpha") {
    loadedBooksMemory.sort((a, b) => a.title.localeCompare(b.title));
  } else if (mode === "date") {
    loadedBooksMemory.sort(
      (a, b) => (b.dateImported || 0) - (a.dateImported || 0),
    );
  } else if (mode === "manual") {
    loadedBooksMemory.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }
  renderLibraryGrid();
}

function applyLibraryInterfaceSettings() {
    const size = document.getElementById("setting-card-size").value;
    const lbl = document.getElementById("lbl-card-size");
    if (lbl) lbl.innerText = size;
    document.documentElement.style.setProperty('--card-dimension-width', `${size}px`);
    
    // Update local storage backup parameters without rewriting other items defaults
    const saved = localStorage.getItem("EpubReader_UserConfig_v1");
    let currentConfig = {};
    if (saved) {
        try { currentConfig = JSON.parse(saved); } catch(e){}
    }
    currentConfig.cardSize = size;
    localStorage.setItem("EpubReader_UserConfig_v1", JSON.stringify(currentConfig));
}