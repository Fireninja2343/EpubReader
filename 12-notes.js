/*
 =================================================================
 NOTES MODULE
 A note is either created from text the user selects while reading (its
 bookId/bookTitle are recorded so the note stays traceable even if the book
 is later deleted) or created manually from the Notes page with no book
 attached at all. Notes belong to an optional "note group" - a separate
 concept from the book library's folder groups in 03-groups.js, since a
 note's grouping (e.g. by theme) has nothing to do with which book folder
 it came from.

 Like the rest of the app, IndexedDB is the source of truth here; this
 module doesn't push notes to Firebase, so they stay local-only for now.
 =================================================================
*/

let loadedNotesMemory = [];
let loadedNoteGroupsMemory = [];

/*
 Keys the user has explicitly hidden via the group filter checkboxes on the
 Notes page. An empty set means "show everything" - this is deliberately
 the inverse of a "visible" set so that newly created groups show up
 checked/visible by default without any extra bookkeeping. "none" is the
 reserved key for the ungrouped bucket.
*/
let hiddenNoteGroupKeys = new Set();

let noteSelectionButton = null;
let noteEditorBookContext = { bookId: null, bookTitle: null };

const LAST_NOTE_GROUP_STORAGE_KEY = "EpubReader_LastNoteGroupId_v1";

// -----------------------------------------------------------------
// DATABASE LOAD / REFRESH
// -----------------------------------------------------------------
function fetchNotesLibrary() {
  if (!db) return;
  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readonly");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const noteGroupsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  notesStore.getAll().onsuccess = (e) => {
    loadedNotesMemory = e.target.result;
  };
  noteGroupsStore.getAll().onsuccess = (e) => {
    loadedNoteGroupsMemory = e.target.result;
  };
  transaction.oncomplete = () => {
    renderNotesPageIfOpen();
  };
}

// Re-renders the Notes page and/or the group-management list only if
// they're actually visible right now, so a background note-group edit
// doesn't do pointless DOM work while the user is reading or in the library.
function renderNotesPageIfOpen() {
  const notesView = document.getElementById("notes-view");
  if (notesView && notesView.style.display === "flex") {
    renderNotesPage();
  }
  const manageModal = document.getElementById("note-group-manage-modal");
  if (manageModal && manageModal.open) {
    renderNoteGroupManageList();
  }
}

// -----------------------------------------------------------------
// VIEW ROUTING
// -----------------------------------------------------------------
function showNotesViewState() {
  document.getElementById("library-view").style.display = "none";
  document.getElementById("reader-view").style.display = "none";
  document.getElementById("stats-view").style.display = "none";
  document.getElementById("notes-view").style.display = "flex";
  renderNotesPage();
}

// -----------------------------------------------------------------
// ADD NOTE FROM SELECTED TEXT
// -----------------------------------------------------------------
document.getElementById("reader-container").addEventListener("mouseup", handlePossibleTextSelectionForNote);
document.getElementById("reader-container").addEventListener("touchend", handlePossibleTextSelectionForNote);
// The button's position is only valid for the scroll offset it was drawn
// at, so treat any scroll inside the reading pane as reason to drop it.
document.getElementById("reader-container").addEventListener("scroll", removeNoteSelectionButton);

function handlePossibleTextSelectionForNote() {
  // A tiny delay lets the browser finish updating window.getSelection()
  // before this reads it - reading it synchronously on mouseup/touchend can
  // still reflect the previous selection on some browsers.
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";
    const container = document.getElementById("reader-container");

    if (!text || !activeBookObject || selection.rangeCount === 0 || !container.contains(selection.anchorNode)) {
      removeNoteSelectionButton();
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    showNoteSelectionButton(rect, text);
  }, 10);
}

function showNoteSelectionButton(rect, selectedText) {
  removeNoteSelectionButton();

  const btn = document.createElement("button");
  btn.id = "note-selection-trigger-btn";
  btn.className = "note-selection-trigger-btn";
  btn.innerText = "📝 Add Note";
  btn.style.top = `${Math.max(8, rect.top - 38)}px`;
  btn.style.left = `${rect.left}px`;

  // Without this, the mousedown that precedes the click collapses the
  // text selection before the click handler below ever gets to read it.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    openNoteEditorModal({
      selectedText,
      bookId: activeBookObject.id,
      bookTitle: activeBookObject.title,
    });
    removeNoteSelectionButton();
  });

  document.body.appendChild(btn);
  noteSelectionButton = btn;
}

function removeNoteSelectionButton() {
  if (noteSelectionButton) {
    noteSelectionButton.remove();
    noteSelectionButton = null;
  }
}

// Dismiss the floating button on any click elsewhere, but not on the mousedown
// that's actually targeting the button itself (see the preventDefault above).
document.addEventListener("mousedown", (e) => {
  if (noteSelectionButton && e.target !== noteSelectionButton) {
    removeNoteSelectionButton();
  }
});

// -----------------------------------------------------------------
// NOTE EDITOR MODAL (shared by the selection flow and manual creation)
// -----------------------------------------------------------------
function openManualNoteCreationModal() {
  // Manual creation always defaults its group to "None", regardless of
  // whatever group was last used from the in-reader selection flow.
  openNoteEditorModal({ selectedText: "", bookId: null, bookTitle: null, defaultGroupId: null });
}

function openNoteEditorModal({ selectedText = "", bookId = null, bookTitle = null, defaultGroupId } = {}) {
  noteEditorBookContext = { bookId, bookTitle };

  document.getElementById("note-editor-text-input").value = selectedText;
  document.getElementById("note-editor-comment-input").value = "";

  const groupSelect = document.getElementById("note-editor-group-select");
  populateNoteGroupSelect(groupSelect);

  const resolvedDefault = defaultGroupId !== undefined ? defaultGroupId : loadLastUsedNoteGroupId();
  groupSelect.value = resolvedDefault != null ? String(resolvedDefault) : "";

  document.getElementById("note-editor-modal").showModal();
}

function populateNoteGroupSelect(selectEl) {
  selectEl.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.innerText = "None";
  selectEl.appendChild(noneOption);

  loadedNoteGroupsMemory.forEach((group) => {
    const opt = document.createElement("option");
    opt.value = String(group.id);
    opt.innerText = group.name;
    selectEl.appendChild(opt);
  });
}

function closeNoteEditorModal() {
  document.getElementById("note-editor-modal").close();
}

function submitNoteEditorForm() {
  const text = document.getElementById("note-editor-text-input").value.trim();
  if (!text) {
    alert("Please enter some text for the note.");
    return;
  }

  const comment = document.getElementById("note-editor-comment-input").value.trim();
  const groupSelectValue = document.getElementById("note-editor-group-select").value;
  const groupId = groupSelectValue ? parseInt(groupSelectValue, 10) : null;

  const entry = {
    selectedText: text,
    comment: comment,
    groupId: groupId,
    bookId: noteEditorBookContext.bookId,
    bookTitle: noteEditorBookContext.bookTitle,
    dateCreated: Date.now(),
  };

  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).add(entry);
  transaction.oncomplete = () => {
    saveLastUsedNoteGroupId(groupId);
    closeNoteEditorModal();
    fetchNotesLibrary();
  };
}

function loadLastUsedNoteGroupId() {
  const raw = localStorage.getItem(LAST_NOTE_GROUP_STORAGE_KEY);
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function saveLastUsedNoteGroupId(groupId) {
  localStorage.setItem(LAST_NOTE_GROUP_STORAGE_KEY, groupId == null ? "" : String(groupId));
}

// -----------------------------------------------------------------
// NOTES PAGE: GROUP FILTER CHECKBOXES + GROUPED NOTE LIST
// -----------------------------------------------------------------
function renderNotesPage() {
  renderNoteGroupFilterCheckboxes();
  renderNotesList();
}

function renderNoteGroupFilterCheckboxes() {
  const container = document.getElementById("note-group-filter-row");
  container.innerHTML = "";

  container.appendChild(buildNoteGroupFilterCheckbox("none", "No Group", null));
  loadedNoteGroupsMemory.forEach((group) => {
    container.appendChild(buildNoteGroupFilterCheckbox(group.id, group.name, group.color));
  });
}

function buildNoteGroupFilterCheckbox(key, labelText, color) {
  const label = document.createElement("label");
  label.className = "note-group-filter-chip";
  if (color) label.style.setProperty("--group-tint", color);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = !hiddenNoteGroupKeys.has(key);
  checkbox.onchange = () => {
    if (checkbox.checked) {
      hiddenNoteGroupKeys.delete(key);
    } else {
      hiddenNoteGroupKeys.add(key);
    }
    renderNotesList();
  };

  const span = document.createElement("span");
  span.innerText = labelText;

  label.appendChild(checkbox);
  label.appendChild(span);
  return label;
}

function renderNotesList() {
  const container = document.getElementById("notes-list-container");
  container.innerHTML = "";

  if (loadedNotesMemory.length === 0) {
    container.innerHTML = `<div class="notes-empty-state">No notes yet. Select text while reading, or add one manually above.</div>`;
    return;
  }

  // One bucket per real note group, plus a trailing "No Group" catch-all -
  // that catch-all is also where a note lands if its group was since deleted.
  const sections = loadedNoteGroupsMemory.map((g) => ({
    key: g.id,
    name: g.name,
    color: g.color,
    notes: [],
  }));
  sections.push({ key: "none", name: "No Group", color: null, notes: [] });

  loadedNotesMemory.forEach((note) => {
    const key = note.groupId == null ? "none" : note.groupId;
    const section = sections.find((s) => s.key === key) || sections.find((s) => s.key === "none");
    section.notes.push(note);
  });

  let renderedAnything = false;
  sections.forEach((section) => {
    if (hiddenNoteGroupKeys.has(section.key) || section.notes.length === 0) return;
    renderedAnything = true;
    container.appendChild(buildNoteGroupSection(section));
  });

  if (!renderedAnything) {
    container.innerHTML = `<div class="notes-empty-state">No notes match the current group filters.</div>`;
  }
}

function buildNoteGroupSection(section) {
  const wrapper = document.createElement("div");
  wrapper.className = "note-group-section";
  if (section.color) wrapper.style.setProperty("--group-tint", section.color);

  const heading = document.createElement("div");
  heading.className = "note-group-section-heading";
  heading.innerText = section.name;
  wrapper.appendChild(heading);

  const grid = document.createElement("div");
  grid.className = "notes-grid";
  section.notes
    .slice()
    .sort((a, b) => (b.dateCreated || 0) - (a.dateCreated || 0))
    .forEach((note) => grid.appendChild(buildNoteCard(note)));

  wrapper.appendChild(grid);
  return wrapper;
}

function buildNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "note-card-delete-btn";
  deleteBtn.innerText = "✕";
  deleteBtn.title = "Delete note";
  deleteBtn.onclick = () => deleteNote(note.id);
  card.appendChild(deleteBtn);

  if (note.bookTitle) {
    const bookTag = document.createElement("div");
    bookTag.className = "note-card-book-tag";
    bookTag.innerText = `📖 ${note.bookTitle}`;
    card.appendChild(bookTag);
  }

  // innerText (not innerHTML) throughout this card, same reasoning as
  // escapeHtml() elsewhere in the app - note text and comments can contain
  // anything the user typed or selected from a book, and none of it should
  // ever be interpreted as markup.
  const quote = document.createElement("blockquote");
  quote.className = "note-card-quote";
  quote.innerText = note.selectedText;
  card.appendChild(quote);

  if (note.comment) {
    const comment = document.createElement("div");
    comment.className = "note-card-comment";
    comment.innerText = note.comment;
    card.appendChild(comment);
  }

  return card;
}

function deleteNote(noteId) {
  if (!confirm("Delete this note? This cannot be undone.")) return;
  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).delete(noteId);
  transaction.oncomplete = () => fetchNotesLibrary();
}

// -----------------------------------------------------------------
// NOTE GROUP MANAGEMENT
// -----------------------------------------------------------------
function openNoteGroupManageModal() {
  renderNoteGroupManageList();
  document.getElementById("note-group-manage-modal").showModal();
}

function closeNoteGroupManageModal() {
  document.getElementById("note-group-manage-modal").close();
  // Reflect any renames, recolors, or deletions on the page underneath immediately.
  renderNotesPage();
}

function renderNoteGroupManageList() {
  const list = document.getElementById("note-group-manage-list");
  list.innerHTML = "";

  if (loadedNoteGroupsMemory.length === 0) {
    list.innerHTML = `<div class="notes-empty-state">No note groups yet.</div>`;
  }

  loadedNoteGroupsMemory.forEach((group) => {
    const row = document.createElement("div");
    row.className = "note-group-manage-row";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "color-swatch-input";
    colorInput.value = group.color || "#808080";
    colorInput.onchange = () => updateNoteGroup(group.id, { color: colorInput.value });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "full-width-input";
    nameInput.value = group.name;
    nameInput.onchange = () => {
      const trimmed = nameInput.value.trim();
      if (!trimmed) {
        alert("Group name can't be empty.");
        nameInput.value = group.name;
        return;
      }
      updateNoteGroup(group.id, { name: trimmed });
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "group-mini-btn note-group-manage-delete-btn";
    deleteBtn.innerText = "-";
    deleteBtn.title = "Delete group";
    deleteBtn.onclick = () => deleteNoteGroup(group.id);

    row.appendChild(colorInput);
    row.appendChild(nameInput);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  });
}

function updateNoteGroup(groupId, changes) {
  const transaction = db.transaction([STORE_NOTE_GROUPS], "readwrite");
  const store = transaction.objectStore(STORE_NOTE_GROUPS);
  store.get(groupId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      Object.assign(record, changes);
      store.put(record);
    }
  };
  transaction.oncomplete = () => fetchNotesLibrary();
}

function createNoteGroup() {
  /*
   New groups are inserted immediately with a placeholder name and a random
   color rather than through a separate two-step creation form - the name
   and color inputs in the management list are then right there to edit,
   matching how the rest of this app's settings auto-save the moment they
   change instead of needing an explicit "create" step.
  */
  const randomColor = `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;

  const transaction = db.transaction([STORE_NOTE_GROUPS], "readwrite");
  transaction.objectStore(STORE_NOTE_GROUPS).add({ name: "New Group", color: randomColor });
  transaction.oncomplete = () => fetchNotesLibrary();
}

function deleteNoteGroup(groupId) {
  if (!confirm('Delete this group? Notes inside will move to "No Group" rather than being deleted.')) return;

  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readwrite");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const groupsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  groupsStore.delete(groupId);

  notesStore.getAll().onsuccess = (e) => {
    e.target.result.forEach((note) => {
      if (note.groupId === groupId) {
        note.groupId = null;
        notesStore.put(note);
      }
    });
  };

  transaction.oncomplete = () => fetchNotesLibrary();
}