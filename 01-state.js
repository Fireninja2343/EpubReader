// =================================================================
// GLOBAL STRUCTURAL ENGINE STATE MATRICES
// =================================================================
let db = null;
const DB_NAME = "LocalEpubReaderDB_v2"; // Incremented schema mapping database version
const STORE_BOOKS = "books";
const STORE_GROUPS = "groups";

let focusedTimeTrackerHeartbeatInterval = null;
let currentActiveContextBookIndexId = null; // Refers to the targeted row index selected by the 3 dots panel trigger

let loadedBooksMemory = [];
let loadedGroupsMemory = [];
let selectedBookIds = [];
let activeBookObject = null;
let activeZipInstance = null;
let activeSpineArray = [];
let activeSpinePointer = 0;
let lastSelectedBookId = null;
let overscrollCounter = 0;
let activeGroupFilterId = null; // null represents Global View mode entries pipeline

let globalLibraryViewMode = "grouped"; // Matches selector defaults tracking profiles

window.addEventListener("DOMContentLoaded", () => {
  initIndexedDB();
  setupKeyboardListeners();
});

// Handling changes to the view structure mode selection switch
function changeLibraryViewMode(modeValue) {
  globalLibraryViewMode = modeValue;
  // Clear sub-group drills automatically when swapping layout view hierarchies
  if (globalLibraryViewMode === "all") {
    exitGroupView();
  } else {
    renderLibraryGrid();
  }
}
