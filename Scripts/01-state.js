// =================================================================
// GLOBAL STRUCTURAL ENGINE STATE MATRICES
// =================================================================
let db = null;
const DB_NAME = Config.Db.DB_NAME; // Incremented schema mapping database version
const STORE_BOOKS = Config.Db.STORE_BOOKS;
const STORE_GROUPS = Config.Db.STORE_GROUPS;
const STORE_NOTES = Config.Db.STORE_NOTES;
const STORE_NOTE_GROUPS = Config.Db.STORE_NOTE_GROUPS;

let focusedTimeTrackerHeartbeatInterval = null;
let currentActiveContextBookIndexId = null; // Refers to the targeted row index selected by the 3 dots panel trigger

/*
 Real reading-session tracking state (as opposed to totalSessions, which
 just counts reader launches - see 02-db.js / 09-stats-and-context-menu.js).
 currentSessionStartTime is null whenever no session is currently open;
 a session only actually "starts" on the first real interaction after the
 reader opens, not merely on open, so a 5-second peek that the user
 immediately backs out of doesn't get recorded as a session at all.
*/
let currentSessionStartTime = null;
let currentSessionLastInteractionTime = null;
let currentSessionStartChapterPointer = null;

let loadedBooksMemory = [];
let loadedGroupsMemory = [];
let selectedBookIds = [];
let activeBookObject = null;
let activeZipInstance = null;
let activeSpineArray = [];
let activeSpinePointer = 0;
let activeChapterTitles = []; // Parallel to activeSpineArray; one display title per chapter, filled in by parseAndRenderTOC()
let lastPushedChapterIndex = null; // Tracks the last chapter index that was pushed to the cloud
let lastSelectedBookId = null;
let overscrollCounter = 0;
let activeGroupFilterId = null; // null represents Global View mode entries pipeline
let activeGroupFilterColor = null; // The backgroundColor of whichever group is currently being viewed

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