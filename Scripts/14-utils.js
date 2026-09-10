// =================================================================
// READING STATUS - shared classification (stats table + Timeline Gantt mode)
// =================================================================
/**
 Status flow:
 notStarted -> inProgress -> (paused <-> inProgress)* -> completed.

 completed always wins. notStarted means no real recorded activity exists.
 paused means activity exists but is older than the inactivity threshold;
 inProgress means recent activity exists and the book is not completed.
*/
const READING_STATUS = Config.Miscellaneous.READING_STATUS;
// Single source for status emoji/label pairing.
const READING_STATUS_LABELS = {
    [READING_STATUS.COMPLETED]: "✅ Completed",
    [READING_STATUS.IN_PROGRESS]: "📖 In Progress",
    [READING_STATUS.PAUSED]: "⏸️ Paused",
    [READING_STATUS.NOT_STARTED]: "⬜ Not Started",
};

const MERGE_TIME_DOMINANCE_RATIO = Config.Miscellaneous.MERGE_TIME_DOMINANCE_RATIO ;
/**
 Merges reading and listening time for a book, applying the dominance rule:
 - If one mode is >ratioThreshold%(65%) of total, return that mode's time (ignore the other).
 - If one mode is <1 - ratioThreshold%(35%) of total, return the other mode's time.
 - Otherwise, return the average.
 @param {number|null|undefined} readingSec - Seconds spent reading (or 0 if none).
 @param {number|null|undefined} listeningSec - Seconds spent listening (or 0 if none).
 @returns {number} Merged seconds (0 if both are falsy).
*/
function mergeReadingAndListeningTime(readingSec, listeningSec) {
    const r = readingSec || 0;
    const l = listeningSec || 0;
    if (r === 0 && l === 0) return 0;
    if (r === 0) return l;
    if (l === 0) return r;
    const total = r + l;
    const ratio = r / total;
    if (ratio > MERGE_TIME_DOMINANCE_RATIO) return r;
    if (ratio < 1 - MERGE_TIME_DOMINANCE_RATIO) return l;
    return total / 2;
}

/**
 Checks if a book has any real reading or listening activity (i.e., at least one
 recorded session or history entry).
 @param {Object} book - The book record.
 @returns {boolean} True if there is at least one session or history entry.
*/
function hasRealActivity(book) {
    const sessions = Array.isArray(book.readingSessions) ? book.readingSessions : [];
    const history = Array.isArray(book.readingHistory) ? book.readingHistory : [];
    return sessions.length > 0 || history.length > 0;
}

/**
 Gets the timestamp of the most recent real activity (reading or listening) from
 sessions or history.
 @param {Object} book - The book record.
 @returns {number|null} The latest end timestamp, or null if none.
 */
function getLastRealActivityTimestamp(book) {
    let latest = null;
    const sessions = Array.isArray(book.readingSessions) ? book.readingSessions : [];
    const history = Array.isArray(book.readingHistory) ? book.readingHistory : [];
    for (const session of sessions) {
        if (typeof session.end === 'number' && (latest === null || session.end > latest)) {
            latest = session.end;
        }
    }
    for (const entry of history) {
        if (typeof entry.endTimestamp === 'number' && (latest === null || entry.endTimestamp > latest)) {
            latest = entry.endTimestamp;
        }
    }
    return latest;
}

/**
 Main status classifier. Uses `hasRealActivity` and `getLastRealActivityTimestamp`
 to decide between NOT_STARTED, IN_PROGRESS, PAUSED, or COMPLETED.
 @param {Object} book - The book record.
 @param {number} [now=Date.now()] - The current timestamp for inactivity calculation.
 @returns {string} One of READING_STATUS values.
 */
function getBookReadingStatus(book, now = Date.now()) {
    if (book.isRead) return READING_STATUS.COMPLETED;
    if (!hasRealActivity(book)) return READING_STATUS.NOT_STARTED;
    const lastActivity = getLastRealActivityTimestamp(book);
    if (lastActivity === null) return READING_STATUS.IN_PROGRESS;
    const idleFor = now - lastActivity;
    return idleFor >= Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS
        ? READING_STATUS.PAUSED
        : READING_STATUS.IN_PROGRESS;
}


// =================================================================
// SHARED STORAGE / DB HELPERS
// =================================================================
/** Read/write helpers for the `USER_CONFIG_STORAGE_KEY` localStorage blob. */
function getUserConfig() {
  const raw = localStorage.getItem(Config.Db.USER_CONFIG_STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to parse saved user config, falling back to defaults:", e);
    return {};
  }
}

/** Merges patch into whatever's already saved. */
function saveUserConfig(patch) {
  const config = Object.assign(getUserConfig(), patch);
  localStorage.setItem(Config.Db.USER_CONFIG_STORAGE_KEY, JSON.stringify(config));
  return config;
}

/**
 Wraps an IndexedDB store.getAll() in a Promise.

 @param {IDBObjectStore} store - The IndexedDB object store instance to read from.
 @returns {Promise<Array<*>>} A promise that resolves to an array of all records in the store.
 */
function getAllFromStore(store) {
  return new Promise((resolve) => {
    store.getAll().onsuccess = (e) => resolve(e.target.result);
  });
}

/**
 Same as getAllFromStore() but opens its own readonly transaction from a store name, for callers (sync/backup code) that
 don't already have a store handle and may run before loadedBooksMemory/loadedGroupsMemory etc. are populated
 for the first time.

 @param {string} storeName - The name of the IndexedDB object store to fetch records from.
 @returns {Promise<Array<*>>} A promise that resolves to an array of all records, or empty array if empty/undefined.
 */
function getAllFromLocalStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
/**
 Stamps lastModified after a successful cloud push and mirrors the value into the matching in-memory cache
 entry when available. Shared by group, note, and note-tag sync helpers. Missing cache arrays are safely
 ignored when the data has not been loaded yet.

 @param {string} storeName - The name of the IndexedDB object store.
 @param {Array<Object>|null} cacheArray - The in-memory array cache to update, or null if not loaded.
 @param {string|number} recordId - The unique identifier of the record to stamp.
 @param {number} lastModified - The timestamp (milliseconds) to set as lastModified.
 @returns {Promise<void>} A promise that resolves when the database transaction completes or handles an error.
 */
function stampLocalRecordLastModified(storeName, cacheArray, recordId, lastModified) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    store.get(recordId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        record.lastModified = lastModified;
        store.put(record);
        const cached = cacheArray && cacheArray.find((r) => r.id === recordId);
        if (cached) cached.lastModified = lastModified;
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => resolve();
  });
}

/**
  Opens an EPUB zip's META-INF/container.xml to find the OPF path, then parses that OPF.
  @param {import('jszip')} zip - The JSZip instance containing the loaded EPUB file.
  @returns {Promise<{opfDoc: Document, opfPath: string, baseDir: string}>}
  An object containing the parsed OPF XML document, its path, and its base directory (with trailing slash).
 */
async function openEpubContainer(zip) {
  const containerFile = await zip.file("META-INF/container.xml").async("string");
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerFile, "text/xml");
  const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
  const opfFile = await zip.file(opfPath).async("string");
  const opfDoc = parser.parseFromString(opfFile, "text/xml");
  const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);
  return { opfDoc, opfPath, baseDir };
}

/**
 Loads a book record, mutates it via mutateFn (in place), persists it, and pushes to the cloud. Always
 stamps lastModified. Resolves to the updated record, or null if the book wasn't found.

 @param {string|number} bookId - The unique identifier of the book record to update.
 @param {function(Object): void} mutateFn - A callback function that mutates the retrieved book record in place.
 @returns {Promise<Object|null>} A promise that resolves to the updated book record, or null if the book was not found or an error occurred.
 */
function updateBookRecord(bookId, mutateFn) {
  return new Promise((resolve) => {
    const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(Config.Db.STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        mutateFn(record);
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(updatedRecord);
    };
    transaction.onerror = () => resolve(null);
  });
}

/**
 Store-agnostic sibling of updateBookRecord() above, for stores other than books (e.g. notes/note tags in
 12-notes.js) that don't need a cloud push baked in - the caller passes its own pushFn (or null to skip).
 Same get/mutate/put/stamp-lastModified shape either way.

 @param {string} storeName - The name of the IndexedDB object store.
 @param {string|number} recordId - The unique identifier of the record to update.
 @param {function(Object): void} mutateFn - A callback function that mutates the retrieved record in place.
 @param {function(Object): void|null} [pushFn] - Optional callback function to push the updated record to a remote service.
 @returns {Promise<Object|null>} A promise that resolves to the updated record, or null if not found or an error occurred.
 */
function updateRecordInStore(storeName, recordId, mutateFn, pushFn) {
  return new Promise((resolve) => {
    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);
    let updatedRecord = null;
    store.get(recordId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        mutateFn(record);
        record.lastModified = Date.now();
        store.put(record);
        updatedRecord = record;
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushFn === "function") pushFn(updatedRecord);
      resolve(updatedRecord);
    };
    transaction.onerror = () => resolve(null);
  });
}

/**
 Shared read for a JSON array persisted to a localStorage key, with the "_ts" companion timestamp
 (read by 11-firebase-sync.js to compare against a remote settings bundle) and a fire-and-forget settings
 push - the exact pattern behind loadCollapsedNoteTagKeys/saveCollapsedNoteTagKeys and
 loadLastUsedNoteTagIds/saveLastUsedNoteTagIds in 12-notes.js.

 @param {string} key - The localStorage key to retrieve and parse.
 @returns {Array<*>} The parsed array stored at the key, or an empty array if invalid or not found.
 */
function loadJsonArrayFromLocalStorage(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
/** Saves a JSON array and its timestamp to localStorage, then triggers a cloud settings push. */
function saveJsonArrayToLocalStorage(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
  localStorage.setItem(`${key}_ts`, String(Date.now()));
  if (typeof pushNoteSettingsToCloud === "function") pushNoteSettingsToCloud();
}

/** Resolves relative components (`.` and `..`) in a URL path string to produce a normalized path. */
function normalizePath(pathString) {
  const parts = pathString.split("/");
  const output = [];
  for (let chunk of parts) {
    if (chunk === "." || chunk === "") continue;
    if (chunk === "..") {
      if (output.length) output.pop();
    } else {
      output.push(chunk);
    }
  }
  return output.join("/");
}

/** Converts a Blob or File object into a base64-encoded Data URL string. */
function convertBlobToBase64(blobItem) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blobItem);
  });
}

/** Converts a base64 Data URL string back into a Blob object. */
function base64ToBlob(base64) {
  const [header, data] = base64.split(",");
  const mime = header.match(/:(.*?);/)[1];

  const binary = atob(data);
  const array = [];

  for (let i = 0; i < binary.length; i++) {
    array.push(binary.charCodeAt(i));
  }

  return new Blob([new Uint8Array(array)], { type: mime });
}

/** Determines the MIME type for an image based on its file extension, defaulting to `image/png`. */
function guessImageMimeType(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return map[ext] || "image/png";
}

/**
 Escapes untrusted text (such as book titles/authors from EPUB metadata) 
 before interpolating into innerHTML to prevent XSS vulnerability.

 @param {string|null|undefined} str
 @returns {string} Escaped HTML-safe string or empty string.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 Formats a timestamp into a DD/MM/YYYY date string.

 @param {number|string|Date} timestamp
 @returns {string} Formatted date string, or "Unknown".
 */
function formatDateOnly(timestamp) {
    if (!timestamp) return "Unknown";

    const date = new Date(timestamp);

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();

    return `${day}/${month}/${year}`;
}

/**
 Lightweight Markdown formatter for note/comment display - purpose-built for note comments, not a full
 Markdown engine. Supports bold, italic, strike, code, underline, unordered lists, and ordered lists.

 Escapes raw text before substitutions so user HTML cannot reach the output. Inline code is protected first,
 then restored; bold runs before italic to avoid `**` being interpreted incorrectly. Lists are processed last.

 @param {string} rawText
 @returns {string}
 */
function renderLightweightMarkdown(rawText) {
    if (rawText === null || rawText === undefined || rawText === "") return "";

    let escaped = escapeHtml(rawText);

    // 1. Inline code: pull spans out first, replace with placeholders
    const codeSpans = [];
    escaped = escaped.replace(/`([^`\n]+?)`/g, (match, code) => {
        const token = `\u0000CODE${codeSpans.length}\u0000`;
        codeSpans.push(code);
        return token;
    });

    // 2. Bold: **text** (before italic, since both use *)
    escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");

    // 3. Italic: *text*
    escaped = escaped.replace(/\*([^\n*]+?)\*/g, "<em>$1</em>");

    // 4. Strikethrough: ~~text~~ or -text- (single-dash form requires no
    // whitespace touching either dash, so "well - this" isn't misread)
    escaped = escaped.replace(/~~([^\n]+?)~~/g, "<del>$1</del>");
    escaped = escaped.replace(/-(\S(?:[^\n-]*\S)?)-/g, "<del>$1</del>");

    // 5. Underline: __text__
    escaped = escaped.replace(/__([^\n]+?)__/g, "<u>$1</u>");
    escaped = escaped.replace(/_([^\n]+?)_/g, "<u>$1</u>");

    // 6. Lists: group consecutive "- item"/"* item" or "1. item" lines
    escaped = renderMarkdownLists(escaped);

    // 7. Restore inline code spans (never processed as Markdown, so no
    // re-escaping needed)
    escaped = escaped.replace(/\u0000CODE(\d+)\u0000/g, (match, idx) => `<code>${codeSpans[Number(idx)]}</code>`);

    return escaped;
}

/**
 Groups consecutive bullet/numbered lines into one <ul>/<ol> rather than a stack of one-item lists. Non-list
 lines are rejoined with <br> so a plain multi-line comment still breaks visually the same way innerText did.
 @param {string} text
 @returns {string}
 */
function renderMarkdownLists(text) {
    const lines = text.split("\n");
    // {content, isBlock} - isBlock true for a flushed <ul>/<ol> (already
    // block-level, shouldn't get a <br> stitched on either side).
    const output = [];
    let listBuffer = [];
    let listType = null; // "ul" | "ol"

    function flushList() {
        if (listBuffer.length === 0) return;
        const tag = listType;
        output.push({ content: `<${tag}>${listBuffer.map((item) => `<li>${item}</li>`).join("")}</${tag}>`, isBlock: true });
        listBuffer = [];
        listType = null;
    }

    for (const line of lines) {
        const bulletMatch = line.match(/^[-*]\s+(.+)$/);
        const numberedMatch = line.match(/^\d+\.\s+(.+)$/);

        if (bulletMatch) {
            if (listType && listType !== "ul") flushList();
            listType = "ul";
            listBuffer.push(bulletMatch[1]);
        } else if (numberedMatch) {
            if (listType && listType !== "ol") flushList();
            listType = "ol";
            listBuffer.push(numberedMatch[1]);
        } else {
            flushList();
            output.push({ content: line, isBlock: false });
        }
    }
    flushList();

    // Rejoin, inserting <br> only between two consecutive plain lines
    // (raw "\n" collapses to a space under innerHTML, unlike innerText).
    let result = "";
    for (let i = 0; i < output.length; i++) {
        if (i > 0 && !output[i].isBlock && !output[i - 1].isBlock) {
            result += "<br>";
        }
        result += output[i].content;
    }
    return result;
}

/**
 Positions a flyout menu relative to a trigger element while clamping it inside the viewport.
 @param {HTMLElement} menu
 @param {MouseEvent|Event} triggerEvent
 */
function positionFlyoutMenu(menu, triggerEvent) {
  const triggerRect = triggerEvent.currentTarget.getBoundingClientRect();

  // Show off-screen first so natural width/height can be measured.
  menu.style.display = "block";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const menuRect = menu.getBoundingClientRect();

  // Default: open to the right of the trigger; flip left if that would
  // run off the viewport's right edge.
  let left = triggerRect.right;
  if (left + menuRect.width >= window.innerWidth) {
    left = triggerRect.left - menuRect.width;
  }
  // Flipping left would also run off (narrow viewport) - fall back right and clamp.
  if (left <= 0) {
    left = triggerRect.right;
  }
  left = Math.max(0, Math.min(left, window.innerWidth - menuRect.width));

  let top = triggerRect.top;
  if (top + menuRect.height >= window.innerHeight) {
    top = window.innerHeight - menuRect.height;
  }
  top = Math.max(0, top);

  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${top + window.scrollY}px`;
}

/**
 Single source of truth for whether tracked timeSpentSeconds represents meaningful reading or just noise
 from brief opens/taps. Returns 0 below the configured threshold and the original value otherwise. Stats
 should use this instead of reading timeSpentSeconds directly, so tiny values cannot distort calculations
 inconsistently.
 @param {number} rawSeconds
 @returns {number}
 */
function getMeaningfulTrackedSeconds(rawSeconds) {
    const seconds = rawSeconds || 0;
    return seconds >= Config.Reading.MIN_MEANINGFUL_TRACKED_SECONDS ? seconds : 0;
}

/**
 Converts meaningful reading time in seconds to rounded minutes.
 @param {number} rawSeconds
 @returns {number}
 */
function getMeaningfulTrackedMinutes(rawSeconds) {
    return Math.round(getMeaningfulTrackedSeconds(rawSeconds) / 60);
}

/**
 Formats a minute count into a human-readable duration string (e.g. "1h 30m" or "45m").
 @param {number} mins
 @returns {string}
 */
function formatMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round((mins % 60)*10)/10;
    return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 Formats a seconds value as H:MM:SS (or M:SS under an hour).
 @param {number} totalSeconds
 @returns {string}
*/
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : m;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 Formats a calendar-time duration in ms (e.g. firstOpened to completedDate) - hours while under a day, whole
 days otherwise. Kept separate from formatMinutes() above since that formats accumulated reading time (hh/mm)
 while this formats elapsed wall-clock time between two dates.

 @param {number} ms
 @returns {string}
 */
function formatCompletionDuration(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    const hours = ms / (1000 *60 *60);
    if (hours < 1) return "<1h";
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}

function activateButton(button){
  if (!button) return;
  button.classList.add("active");
}

function deactivateButton(button){
  if (!button) return;
  button.classList.remove("active");
}

function toggleButton(button){
  if (!button) return;
  button.classList.toggle("active");
}