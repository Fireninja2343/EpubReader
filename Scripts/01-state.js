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

/*
 =================================================================
 HARD RELOAD
 Mirrors what Ctrl+Shift+R does in a desktop browser, primarily for mobile
 where that shortcut doesn't exist: drop the Service Worker's cache(s),
 unregister the worker itself so a fresh one is fetched from the network on
 next load, and then force a network-refetch of the page rather than
 letting the browser serve it from its own HTTP cache.

 IndexedDB (the library, notes, reading progress, etc.) is deliberately
 left completely untouched - this only clears *cached app resources*
 (HTML/CSS/JS/the PWA's asset cache), never any user data.

 Each step is wrapped so a browser that doesn't support one API (e.g. no
 caches API, or no Service Worker at all) still falls through to the next
 step instead of throwing and aborting the whole reload.
 ================================================================= */
async function hardReloadApp() {
  const btn = document.getElementById("btn-hard-reload");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "🧹 Reloading...";
  }

  // Unregister the Service Worker so a fresh one (and fresh precache) is
  // pulled down on the next load, instead of the old worker continuing to
  // serve whatever it already has cached.
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }
  } catch (err) {
    console.warn("[HardReload] Could not unregister Service Worker:", err);
  }

  // Drop every named Cache Storage bucket (the Service Worker's precache
  // and any runtime caches it created) - this is the actual "cached
  // application resources" being cleared.
  try {
    if (window.caches && caches.keys) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
    }
  } catch (err) {
    console.warn("[HardReload] Could not clear Cache Storage:", err);
  }

  // location.reload() alone can still be answered by the browser's own HTTP
  // cache (not the Service Worker/Cache Storage cleared above), so a
  // cache-busting query param forces a genuine network re-fetch of the page
  // itself - the closest reachable equivalent to Ctrl+Shift+R from script,
  // since no browser exposes a real "force hard refresh" API to pages.
  const url = new URL(window.location.href);
  url.searchParams.set("_hardReload", Date.now().toString());
  window.location.replace(url.toString());
}