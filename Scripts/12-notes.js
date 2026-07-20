/*
 =================================================================
 NOTES MODULE
 A note is either created from text the user selects while reading (its
 bookId/bookTitle are recorded so the note stays traceable even if the book
 is later deleted) or created manually from the Notes page, optionally with
 a book chosen from a <select> of the current library.

 Organization is by TAGS rather than a single group: a note can carry any
 number of manually-assigned tags (stored in note.tagIds, referencing rows
 in the STORE_NOTE_GROUPS store - the store name/schema is unchanged, only
 the user-facing concept is now "tags" instead of a single "group"). On top
 of those manual tags, any note that originated from (or was manually
 linked to) a book automatically gets a special "book tag" - this is never
 stored as its own row, it's derived at render time from note.bookId /
 note.bookTitle plus that book's current group color, so it can't drift out
 of sync and never needs a "None" placeholder when there isn't one.

 Like the rest of the app, IndexedDB is the source of truth here; notes and
 tags are additionally mirrored to Firebase the same way books/groups are
 (see the pushNoteToCloud/pushNoteTagToCloud calls throughout this file and
 the notes/tags reconciliation in pullInitialSyncFromCloud(), 11-firebase-sync.js).
 =================================================================
*/

let loadedNotesMemory = [];
let loadedNoteTagsMemory = [];

/*
 Keys of the tag sections the user has collapsed on the Notes page. An
 empty set means "show everything expanded" - this is deliberately the
 inverse of an "expanded" set so that newly created tags (and the "All
 Notes" section) start out expanded by default without any extra
 bookkeeping. "none" is the reserved key for the untagged bucket, "all" is
 the reserved key for the All Notes section. Book auto-tags use the key
 `book:<bookId>` so they can't collide with real tag ids.

 Persisted to localStorage (see load/saveCollapsedNoteTagKeys below) so a
 user's collapse layout survives reloads instead of resetting to fully
 expanded every time the Notes page is opened.
*/
const COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY = Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY;

function loadCollapsedNoteTagKeys() {
  const raw = localStorage.getItem(COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveCollapsedNoteTagKeys() {
  localStorage.setItem(
    COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY,
    JSON.stringify(Array.from(collapsedNoteTagKeys)),
  );
  // Timestamp used only by 11-firebase-sync.js to decide whether this
  // device's or the cloud's settings bundle is newer - never read by
  // anything on this page itself.
  localStorage.setItem(`${COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY}_ts`, String(Date.now()));
  if (typeof pushSettingsToCloud === "function") pushSettingsToCloud();
}

let collapsedNoteTagKeys = loadCollapsedNoteTagKeys();

let noteSelectionButton = null;
let noteEditorBookContext = { bookId: null, bookTitle: null };
let noteEditorEditingNoteId = null; // null while creating; set to a note id while editing that note
let noteTagPickerNoteId = null; // which note "Move Note (Tag)" is currently acting on

const LAST_NOTE_TAGS_STORAGE_KEY = Config.Db.LAST_NOTE_TAGS_STORAGE_KEY;

// -----------------------------------------------------------------
// DATABASE LOAD / REFRESH
// -----------------------------------------------------------------
function fetchNotesLibrary() {
  if (!db) return;
  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readonly");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const noteTagsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  notesStore.getAll().onsuccess = (e) => {
    loadedNotesMemory = e.target.result;
  };
  noteTagsStore.getAll().onsuccess = (e) => {
    loadedNoteTagsMemory = e.target.result;
  };
  transaction.oncomplete = () => {
    renderNotesPageIfOpen();
  };
}

// Re-renders the Notes page and/or the tag-management list only if
// they're actually visible right now, so a background note-tag edit
// doesn't do pointless DOM work while the user is reading or in the library.
function renderNotesPageIfOpen() {
  const notesView = document.getElementById("notes-view");
  if (notesView && notesView.style.display === "flex") {
    renderNotesPage();
  }
  const manageModal = document.getElementById("note-tag-manage-modal");
  if (manageModal && manageModal.open) {
    renderNoteTagManageList();
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
// NOTE EDITOR MODAL (shared by the selection flow, manual creation, and
// editing an existing note)
// -----------------------------------------------------------------
function openManualNoteCreationModal() {
  // Manual creation always defaults to no book and no tags, regardless of
  // whatever was last used from the in-reader selection flow.
  openNoteEditorModal({ selectedText: "", bookId: null, bookTitle: null, tagIds: [] });
}

function openNoteEditorModal({
  selectedText = "",
  comment = "",
  bookId = null,
  bookTitle = null,
  tagIds,
  editingNoteId = null,
} = {}) {
  noteEditorEditingNoteId = editingNoteId;
  noteEditorBookContext = { bookId, bookTitle };

  document.getElementById("note-editor-modal-heading").innerText =
    editingNoteId ? "Edit Note" : "Add Note";

  document.getElementById("note-editor-text-input").value = selectedText;
  document.getElementById("note-editor-comment-input").value = comment;

  const bookSelect = document.getElementById("note-editor-book-select");
  populateNoteEditorBookSelect(bookSelect, bookId);

  const resolvedTagIds = tagIds !== undefined ? tagIds : loadLastUsedNoteTagIds();
  const tagContainer = document.getElementById("note-editor-tags-container");
  populateNoteEditorTagCheckboxes(tagContainer, resolvedTagIds || []);

  document.getElementById("note-editor-modal").showModal();
}

// Lists every book currently in the library so a manually-created note can
// be linked to one (or left as "None"). Book-originated notes get the
// originating book preselected here too, but the field stays editable.
function populateNoteEditorBookSelect(selectEl, selectedBookId) {
  selectEl.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.innerText = "None";
  selectEl.appendChild(noneOption);

  loadedBooksMemory.forEach((book) => {
    const opt = document.createElement("option");
    opt.value = String(book.id);
    opt.innerText = book.title;
    selectEl.appendChild(opt);
  });

  selectEl.value = selectedBookId != null ? String(selectedBookId) : "";
}

// Multi-select checkbox list of the real (non-book) tags, so a note can
// carry any number of them at once instead of being limited to one.
function populateNoteEditorTagCheckboxes(containerEl, selectedTagIds) {
  containerEl.innerHTML = "";

  if (loadedNoteTagsMemory.length === 0) {
    containerEl.innerHTML = `<div class="hint-text">No tags yet - create one from "🏷️ Manage Tags".</div>`;
    return;
  }

  const selectedSet = new Set((selectedTagIds || []).map(Number));

  loadedNoteTagsMemory.forEach((tag) => {
    const item = document.createElement("label");
    item.className = "note-editor-tag-checkbox-item";
    item.style.setProperty("--tag-tint", tag.color || "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(tag.id);
    checkbox.checked = selectedSet.has(tag.id);

    const span = document.createElement("span");
    span.innerText = tag.name;

    item.appendChild(checkbox);
    item.appendChild(span);
    containerEl.appendChild(item);
  });
}

function readCheckedTagIdsFrom(containerEl) {
  return Array.from(containerEl.querySelectorAll("input[type='checkbox']:checked")).map((cb) =>
    parseInt(cb.value, 10),
  );
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

  const bookSelectValue = document.getElementById("note-editor-book-select").value;
  const bookId = bookSelectValue ? parseInt(bookSelectValue, 10) : null;
  const linkedBook = bookId != null ? loadedBooksMemory.find((b) => b.id === bookId) : null;
  // Falls back to whatever book title the note already carried (e.g. when
  // editing a book-originated note whose book has since been deleted and
  // so no longer appears in the <select>) rather than wiping it out.
  const bookTitle = linkedBook ? linkedBook.title : (bookId != null ? noteEditorBookContext.bookTitle : null);

  const tagIds = readCheckedTagIdsFrom(document.getElementById("note-editor-tags-container"));

  if (noteEditorEditingNoteId != null) {
    updateNoteFields(noteEditorEditingNoteId, {
      selectedText: text,
      comment,
      bookId,
      bookTitle,
      tagIds,
    });
    saveLastUsedNoteTagIds(tagIds);
    closeNoteEditorModal();
    return;
  }

  const entry = {
    selectedText: text,
    comment: comment,
    tagIds: tagIds,
    bookId: bookId,
    bookTitle: bookTitle,
    dateCreated: Date.now(),
  };

  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).add(entry).onsuccess = (e) => {
    entry.id = e.target.result;
  };
  transaction.oncomplete = () => {
    saveLastUsedNoteTagIds(tagIds);
    closeNoteEditorModal();
    fetchNotesLibrary();
    if (typeof pushNoteToCloud === "function") pushNoteToCloud(entry);
  };
}

function loadLastUsedNoteTagIds() {
  const raw = localStorage.getItem(LAST_NOTE_TAGS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)) : [];
  } catch (e) {
    return [];
  }
}

function saveLastUsedNoteTagIds(tagIds) {
  localStorage.setItem(LAST_NOTE_TAGS_STORAGE_KEY, JSON.stringify(tagIds || []));
  localStorage.setItem(`${LAST_NOTE_TAGS_STORAGE_KEY}_ts`, String(Date.now()));
  if (typeof pushSettingsToCloud === "function") pushSettingsToCloud();
}

// -----------------------------------------------------------------
// NOTES PAGE: TAG FILTER CHIPS + TAG-SECTIONED NOTE LIST
// -----------------------------------------------------------------
function renderNotesPage() {
  renderNotesList();
}

// Every distinct book referenced by any current note gets its own
// (derived, not stored) auto-tag descriptor: {key, name, color}.
function collectBookAutoTags() {
  const byKey = new Map();
  loadedNotesMemory.forEach((note) => {
    if (note.bookId == null) return;
    const key = `book:${note.bookId}`;
    if (byKey.has(key)) return;
    const liveBook = loadedBooksMemory.find((b) => b.id === note.bookId);
    const liveGroup = liveBook && liveBook.groupId != null
      ? loadedGroupsMemory.find((g) => g.id === liveBook.groupId)
      : null;
    byKey.set(key, {
      key,
      name: (liveBook && liveBook.title) || note.bookTitle || "Unknown Book",
      color: liveGroup ? liveGroup.backgroundColor : null,
      isBookTag: true,
    });
  });
  return Array.from(byKey.values());
}

// Returns every tag key that applies to a note: its manual tagIds, plus its
// derived book auto-tag key if it has a linked book. A note with neither
// falls into the "none" (untagged) bucket.
function keysForNote(note) {
  const keys = (note.tagIds || []).slice();
  if (note.bookId != null) keys.push(`book:${note.bookId}`);
  return keys.length ? keys : ["none"];
}

function renderNotesList() {
  const container = document.getElementById("notes-list-container");
  container.innerHTML = "";

  if (loadedNotesMemory.length === 0) {
    container.innerHTML = `<div class="notes-empty-state">No notes yet. Select text while reading, or add one manually above.</div>`;
    return;
  }

  // "All Notes" is a pinned catch-all shown first, containing every note
  // regardless of tag - unlike the sections below it, it's never populated
  // by keysForNote() and always holds the full library of notes.
  const sections = [{ key: "all", name: "All Notes", color: null, notes: loadedNotesMemory.slice() }];

  // One section per real tag, one per distinct book auto-tag, plus a
  // trailing "Untagged" catch-all. A note with several tags appears in
  // every section it belongs to.
  loadedNoteTagsMemory.forEach((t) => {
    sections.push({ key: t.id, name: t.name, color: t.color, notes: [] });
  });
  collectBookAutoTags().forEach((bookTag) => {
    sections.push({ key: bookTag.key, name: `📖 ${bookTag.name}`, color: bookTag.color, notes: [] });
  });
  sections.push({ key: "none", name: "Untagged", color: null, notes: [] });

  loadedNotesMemory.forEach((note) => {
    keysForNote(note).forEach((key) => {
      const section = sections.find((s) => s.key === key);
      if (section) section.notes.push(note);
    });
  });

  sections.forEach((section) => {
    if (section.notes.length === 0) return;
    container.appendChild(buildNoteTagSection(section));
  });
}

function buildNoteTagSection(section) {
  const isCollapsed = collapsedNoteTagKeys.has(section.key);

  const wrapper = document.createElement("div");
  wrapper.className = "note-tag-section" + (isCollapsed ? " collapsed" : "");
  if (section.color) wrapper.style.setProperty("--tag-tint", section.color);

  const heading = document.createElement("div");
  heading.className = "note-tag-section-heading";

  /*
   This checkbox is the section's only control, doubling as both the
   visual "is this expanded" indicator and the click target - no separate
   button is layered on top of it. Checked means expanded (mirrors the
   ▼ Show More / ▲ Show Less convention used on note cards elsewhere in
   this file), so a brand new tag with no stored preference starts
   expanded by default with zero extra bookkeeping.
  */
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "note-tag-collapse-toggle";
  checkbox.checked = !isCollapsed;
  checkbox.title = isCollapsed ? "Expand section" : "Collapse section";
  checkbox.onchange = () => {
    if (checkbox.checked) {
      collapsedNoteTagKeys.delete(section.key);
    } else {
      collapsedNoteTagKeys.add(section.key);
    }
    saveCollapsedNoteTagKeys();
    renderNotesList();
  };

  const title = document.createElement("span");
  title.className = "note-tag-section-title";
  title.innerText = section.name;

  heading.appendChild(checkbox);
  heading.appendChild(title);
  wrapper.appendChild(heading);

  // While collapsed the section is just its colored line + heading -
  // the notes grid isn't rendered at all (rather than rendered and
  // hidden via CSS), so a collapsed section with hundreds of notes costs
  // nothing to keep around.
  if (!isCollapsed) {
    const grid = document.createElement("div");
    grid.className = "notes-grid";
    section.notes
      .slice()
      .sort((a, b) => (b.dateCreated || 0) - (a.dateCreated || 0))
      .forEach((note) => grid.appendChild(buildNoteCard(note)));

    wrapper.appendChild(grid);
  }

  return wrapper;
}

function buildNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";

  const actionsTrigger = document.createElement("button");
  actionsTrigger.className = "note-card-actions-trigger";
  actionsTrigger.innerText = "⋮";
  actionsTrigger.title = "Note actions";
  actionsTrigger.onclick = (e) => toggleNoteContextMenuFlyout(e, note.id);
  card.appendChild(actionsTrigger);

  const hasBookTag = note.bookId != null;
  const hasManualTags = (note.tagIds || []).length > 0;

  if (hasBookTag || hasManualTags) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "note-card-tags-row";

    if (hasBookTag) {
      const liveBook = loadedBooksMemory.find((b) => b.id === note.bookId);
      const liveGroup = liveBook && liveBook.groupId != null
        ? loadedGroupsMemory.find((g) => g.id === liveBook.groupId)
        : null;
      const bookPill = document.createElement("span");
      bookPill.className = "note-card-tag-pill note-card-book-tag";
      if (liveGroup) bookPill.style.setProperty("--tag-tint", liveGroup.backgroundColor);
      bookPill.innerText = `📖 ${(liveBook && liveBook.title) || note.bookTitle}`;
      tagsRow.appendChild(bookPill);
    }

    (note.tagIds || []).forEach((tagId) => {
      const tag = loadedNoteTagsMemory.find((t) => t.id === tagId);
      if (!tag) return;
      const pill = document.createElement("span");
      pill.className = "note-card-tag-pill";
      pill.style.setProperty("--tag-tint", tag.color || "");
      pill.innerText = tag.name;
      tagsRow.appendChild(pill);
    });

    card.appendChild(tagsRow);
  }

  // innerText (not innerHTML) throughout this card, same reasoning as
  // escapeHtml() elsewhere in the app - note text and comments can contain
  // anything the user typed or selected from a book, and none of it should
  // ever be interpreted as markup.
  const quote = document.createElement("blockquote");
  quote.className = "note-card-quote collapsed";
  quote.innerText = note.selectedText;
  card.appendChild(quote);

  const toggleButton = document.createElement("button");
  toggleButton.className = "note-card-expand-btn";
  toggleButton.innerText = "▼ Show More";
  toggleButton.onclick = () => toggleNoteCard(quote, toggleButton);
  card.appendChild(toggleButton);

  // Hide the button if the note isn't actually overflowing.
  requestAnimationFrame(() => {
      if (quote.scrollHeight <= quote.clientHeight + 1) {
          toggleButton.style.display = "none";
      }
  });

  if (note.comment) {
    const comment = document.createElement("div");
    comment.className = "note-card-comment";
    /*
     innerHTML + renderLightweightMarkdown() (10-utils.js) instead of the
     plain innerText this used to be - the raw note.comment string itself
     is never touched (still stored, and still loaded verbatim into the
     editor's plain <textarea> - see triggerNoteContextAction() above),
     only how it's *displayed* here changes. renderLightweightMarkdown()
     escapes all HTML before applying any formatting, so this stays exactly
     as safe against injected markup as innerText was - a comment containing
     literal "<img onerror=...>" renders as inert text, not a live tag.
    */
    comment.innerHTML = renderLightweightMarkdown(note.comment);
    card.appendChild(comment);
  }

  return card;
}

function toggleNoteCard(quoteElement, buttonElement) {
    quoteElement.classList.toggle("collapsed");

    buttonElement.innerText = quoteElement.classList.contains("collapsed")
        ? "▼ Show More"
        : "▲ Show Less";
}

function deleteNote(noteId) {
  if (!confirm("Delete this note? This cannot be undone.")) return;
  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).delete(noteId);
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof deleteNoteFromCloud === "function") deleteNoteFromCloud(noteId);
  };
}

// -----------------------------------------------------------------
// PER-NOTE 3-DOTS ACTIONS FLYOUT
// Mirrors the book-context-menu pattern in 09-stats-and-context-menu.js:
// one shared floating menu, positioned relative to whichever trigger button
// was clicked (auto-flipping to stay within the viewport, see
// positionFlyoutMenu in 10-utils.js), that acts on whichever note's
// trigger was last clicked.
// -----------------------------------------------------------------
let currentActiveContextNoteId = null;

function toggleNoteContextMenuFlyout(event, noteId) {
  event.preventDefault();
  event.stopPropagation();

  currentActiveContextNoteId = noteId;
  const menu = document.getElementById("note-context-menu");

  positionFlyoutMenu(menu, event);

  document.addEventListener("click", closeNoteContextMenuFlyoutOnceOutside);
}

function closeNoteContextMenuFlyoutOnceOutside() {
  document.getElementById("note-context-menu").style.display = "none";
  document.removeEventListener("click", closeNoteContextMenuFlyoutOnceOutside);
}

// Route the clicked menu item to the note it was opened for
function triggerNoteContextAction(actionKey) {
  const targetNote = loadedNotesMemory.find((n) => n.id === currentActiveContextNoteId);
  if (!targetNote) return;

  if (actionKey === "delete") {
    deleteNote(targetNote.id);
  } else if (actionKey === "edit") {
    openNoteEditorModal({
      selectedText: targetNote.selectedText,
      comment: targetNote.comment || "",
      bookId: targetNote.bookId,
      bookTitle: targetNote.bookTitle,
      tagIds: targetNote.tagIds || [],
      editingNoteId: targetNote.id,
    });
  } else if (actionKey === "moveTags") {
    openNoteTagPickerModal(targetNote);
  }
}

// Shared write-path for field edits
function updateNoteFields(noteId, changes) {
  const transaction = db.transaction([STORE_NOTES], "readwrite");
  const store = transaction.objectStore(STORE_NOTES);
  let updatedRecord = null;
  store.get(noteId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      Object.assign(record, changes);
      store.put(record);
      updatedRecord = record;
    }
  };
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (updatedRecord && typeof pushNoteToCloud === "function") pushNoteToCloud(updatedRecord);
  };
}

// -----------------------------------------------------------------
// "MOVE NOTE (TAG)" - lightweight tag-only picker
// A quicker path than the full editor for the common case of just
// re-tagging a note; only touches note.tagIds and never the automatic book
// tag, which is never user-editable directly.
// -----------------------------------------------------------------
function openNoteTagPickerModal(note) {
  noteTagPickerNoteId = note.id;
  const container = document.getElementById("note-tag-picker-container");
  populateNoteEditorTagCheckboxes(container, note.tagIds || []);
  document.getElementById("note-tag-picker-modal").showModal();
}

function closeNoteTagPickerModal() {
  document.getElementById("note-tag-picker-modal").close();
}

function submitNoteTagPickerForm() {
  if (noteTagPickerNoteId == null) return;
  const tagIds = readCheckedTagIdsFrom(document.getElementById("note-tag-picker-container"));
  updateNoteFields(noteTagPickerNoteId, { tagIds });
  saveLastUsedNoteTagIds(tagIds);
  closeNoteTagPickerModal();
}

// -----------------------------------------------------------------
// NOTE TAG MANAGEMENT
// -----------------------------------------------------------------
function openNoteTagManageModal() {
  renderNoteTagManageList();
  document.getElementById("note-tag-manage-modal").showModal();
}

function closeNoteTagManageModal() {
  document.getElementById("note-tag-manage-modal").close();
  // Reflect any renames, recolors, or deletions on the page underneath immediately.
  renderNotesPage();
}

function renderNoteTagManageList() {
  const list = document.getElementById("note-tag-manage-list");
  list.innerHTML = "";

  if (loadedNoteTagsMemory.length === 0) {
    list.innerHTML = `<div class="notes-empty-state">No tags yet.</div>`;
  }

  loadedNoteTagsMemory.forEach((tag) => {
    const row = document.createElement("div");
    row.className = "note-tag-manage-row";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "color-swatch-input";
    colorInput.value = tag.color || "#808080";
    colorInput.onchange = () => updateNoteTag(tag.id, { color: colorInput.value });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "full-width-input";
    nameInput.value = tag.name;
    nameInput.onchange = () => {
      const trimmed = nameInput.value.trim();
      if (!trimmed) {
        alert("Tag name can't be empty.");
        nameInput.value = tag.name;
        return;
      }
      updateNoteTag(tag.id, { name: trimmed });
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "group-mini-btn note-tag-manage-delete-btn";
    deleteBtn.innerText = "-";
    deleteBtn.title = "Delete tag";
    deleteBtn.onclick = () => deleteNoteTag(tag.id);

    row.appendChild(colorInput);
    row.appendChild(nameInput);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  });
}

function updateNoteTag(tagId, changes) {
  const transaction = db.transaction([STORE_NOTE_GROUPS], "readwrite");
  const store = transaction.objectStore(STORE_NOTE_GROUPS);
  let updatedRecord = null;
  store.get(tagId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      Object.assign(record, changes);
      store.put(record);
      updatedRecord = record;
    }
  };
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (updatedRecord && typeof pushNoteTagToCloud === "function") pushNoteTagToCloud(updatedRecord);
  };
}

function createNoteTag() {
  /*
   New tags are inserted immediately with a placeholder name and a random
   color rather than through a separate two-step creation form - the name
   and color inputs in the management list are then right there to edit,
   matching how the rest of this app's settings auto-save the moment they
   change instead of needing an explicit "create" step.
  */
  const randomColor = `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;

  const newTag = { name: "New Tag", color: randomColor };
  const transaction = db.transaction([STORE_NOTE_GROUPS], "readwrite");
  transaction.objectStore(STORE_NOTE_GROUPS).add(newTag).onsuccess = (e) => {
    newTag.id = e.target.result;
  };
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof pushNoteTagToCloud === "function") pushNoteTagToCloud(newTag);
  };
}

function deleteNoteTag(tagId) {
  if (!confirm('Delete this tag? Notes carrying it will simply lose that tag rather than being deleted.')) return;

  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readwrite");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const tagsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  tagsStore.delete(tagId);

  const notesToRepush = [];
  notesStore.getAll().onsuccess = (e) => {
    e.target.result.forEach((note) => {
      if (note.tagIds && note.tagIds.includes(tagId)) {
        note.tagIds = note.tagIds.filter((id) => id !== tagId);
        notesStore.put(note);
        notesToRepush.push(note);
      }
    });
  };

  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof deleteNoteTagFromCloud === "function") deleteNoteTagFromCloud(tagId);
    if (typeof pushNoteToCloud === "function") {
      notesToRepush.forEach((note) => pushNoteToCloud(note));
    }
  };
}