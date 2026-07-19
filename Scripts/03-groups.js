// =================================================================
// STRUCTURAL LOCAL BUNDLE GROUPINGS ENGINES
// =================================================================
/*
 Note: this file used to also contain promptCreateGroup() and
 promptEditGroup(), an older prompt()-based create/edit flow. Both were dead
 code — fully superseded by the openGroupModal()/submitGroupModalForm() flow
 below (wired up to the "New Group" button and each group card's "Edit"
 button in index.html) and never called from anywhere. Removed to avoid two
 diverging implementations of the same feature.
*/
function deleteGroup(groupId) {
  if (
    !confirm(
      "Are you sure you want to delete this group? (Books inside will return to Global Library view)",
    )
  )
    return;

  const transaction = db.transaction([STORE_BOOKS, STORE_GROUPS], "readwrite");
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);

  groupsStore.delete(groupId);

  let unassignedBooks = [];
  booksStore.getAll().onsuccess = (e) => {
    const records = e.target.result;
    records.forEach((book) => {
      if (book.groupId === groupId) {
        book.groupId = null;
        book.lastModified = new Date().getTime();
        booksStore.put(book);
        unassignedBooks.push(book);
      }
    });
  };
  transaction.oncomplete = () => {
    fetchLocalLibrary();
    if (typeof deleteGroupFromCloud === "function") {
      deleteGroupFromCloud(groupId);
      unassignedBooks.forEach((book) => pushBookMetadataToCloud(book));
    }
  };
}

function enterGroupView(groupId, groupName, colorVal = null) {
  activeGroupFilterId = groupId;
  activeGroupFilterColor = colorVal;
  if (colorVal) {
    document.getElementById("library-view").style.setProperty("--group-view-tint", `color-mix(in srgb, ${colorVal} 12%, var(--bg-main))`);
  } else {
    document.getElementById("library-view").style.removeProperty("--group-view-tint");
  }
  document.getElementById("current-group-indicator").innerText = `📂 [Group: ${groupName}]`;
  document.getElementById("current-group-indicator").style.display = "inline";
  document.getElementById("current-group-indicator").style.setProperty("--group-tint", colorVal || "");
  document.getElementById("btn-back-group").style.display = "inline-block";
  document.getElementById("library-view-mode").style.display = "none"; // Hide view toggle while inside a folder
  renderLibraryGrid(); // book-card tinting is applied inside buildBookCardsInLayout, reading activeGroupFilterColor
}

function exitGroupView() {
  activeGroupFilterId = null;
  activeGroupFilterColor = null;
  document.getElementById("library-view").style.removeProperty("--group-view-tint");
  document.getElementById("current-group-indicator").style.display = "none";
  document.getElementById("current-group-indicator").style.removeProperty("--group-tint");
  document.getElementById("btn-back-group").style.display = "none";
  document.getElementById("library-view-mode").style.display = "inline-block"; // Restore layout view selector controls
  renderLibraryGrid();
}

// Move item matrices targets context directly via click drops
function moveSelectedBooksToGroup(groupId) {
  if (selectedBookIds.length === 0) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);

  const movedBooks = [];
  selectedBookIds.forEach((bookId) => {
    const book = loadedBooksMemory.find((b) => b.id === bookId);
    if (book) {
      book.groupId = groupId;
      book.lastModified = new Date().getTime();
      store.put(book);
      movedBooks.push(book);
    }
  });
  transaction.oncomplete = () => {
    fetchLocalLibrary();
    if (typeof pushBookMetadataToCloud === "function") {
      movedBooks.forEach((book) => pushBookMetadataToCloud(book));
    }
  };
}

// =================================================================
// IN-APP NATIVE MODAL DIALOG INPUT MANAGEMENT FORMS
// =================================================================
function openGroupModal(isEditMode = false, groupId = null, name = '', color = '#252538') {
    const modal = document.getElementById("group-config-modal");
    document.getElementById("modal-title-text").innerText = isEditMode ? "Modify Group Settings" : "Create New Reading Group";
    document.getElementById("modal-group-id").value = isEditMode ? groupId : "";
    document.getElementById("modal-group-name").value = name;
    document.getElementById("modal-group-color").value = color;

    modal.showModal(); // Launches native backdrop tracking locks layouts safely
}

function closeGroupModal() {
    document.getElementById("group-config-modal").close();
}

function submitGroupModalForm() {
    const idVal = document.getElementById("modal-group-id").value;
    const nameVal = document.getElementById("modal-group-name").value.trim();
    const colorVal = document.getElementById("modal-group-color").value;

    if (!nameVal) {
        alert("Please enter a valid group title.");
        return;
    }

    if (idVal) {
        // EXECUTE RE-WRITE EDIT PROCESS TRACES
        const transaction = db.transaction([STORE_GROUPS], "readwrite");
        const store = transaction.objectStore(STORE_GROUPS);
        store.get(parseInt(idVal)).onsuccess = (e) => {
            const record = e.target.result;
            if (record) {
                record.name = nameVal;
                record.backgroundColor = colorVal;
                store.put(record);
            }
        };
        transaction.oncomplete = () => {
            closeGroupModal();
            fetchLocalLibrary();
            if (typeof pushGroupToCloud === "function") {
                pushGroupToCloud({ id: parseInt(idVal), name: nameVal, backgroundColor: colorVal });
            }
        };
    } else {
        // EXECUTE INSERT CREATION PROCESS TRACES
        const transaction = db.transaction([STORE_GROUPS], "readwrite");
        const store = transaction.objectStore(STORE_GROUPS);
        let newGroupId = null;
        store.add({ name: nameVal, backgroundColor: colorVal }).onsuccess = (e) => {
            newGroupId = e.target.result;
        };
        transaction.oncomplete = () => {
            closeGroupModal();
            fetchLocalLibrary();
            if (typeof pushGroupToCloud === "function") {
                pushGroupToCloud({ id: newGroupId, name: nameVal, backgroundColor: colorVal });
            }
        };
    }
}