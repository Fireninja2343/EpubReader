// =================================================================
// READING STATUS - shared classification (stats table + Timeline Gantt mode)
// =================================================================
/*
 Status flow:
 notStarted -> inProgress -> (paused <-> inProgress)* -> completed.

 completed always wins. notStarted means no real recorded activity exists.
 paused means activity exists but is older than the inactivity threshold;
 inProgress means recent activity exists and the book is not completed.
*/
const READING_STATUS = {
    COMPLETED: "completed",
    IN_PROGRESS: "inProgress",
    PAUSED: "paused",
    NOT_STARTED: "notStarted",
};

// Single source for status emoji/label pairing.
const READING_STATUS_LABELS = {
    [READING_STATUS.COMPLETED]: "✅ Completed",
    [READING_STATUS.IN_PROGRESS]: "📖 In Progress",
    [READING_STATUS.PAUSED]: "⏸️ Paused",
    [READING_STATUS.NOT_STARTED]: "⬜ Not Started",
};

// Timestamp of the most recent real activity, or null. Prefers
// readingSessions/readingHistory over the coarser lastOpened, which
// updates the instant the reader opens even with zero real reading.
function getLastRealReadingActivityTimestamp(book) {
    let latest = null;

    if (Array.isArray(book.readingSessions)) {
        for (const session of book.readingSessions) {
            if (typeof session.end === "number" && (latest === null || session.end > latest)) {
                latest = session.end;
            }
        }
    }

    if (Array.isArray(book.readingHistory)) {
        for (const entry of book.readingHistory) {
            if (typeof entry.endTimestamp === "number" && (latest === null || entry.endTimestamp > latest)) {
                latest = entry.endTimestamp;
            }
        }
    }

    return latest;
}

// True if the book has at least one recorded real reading session/segment.
function hasRealReadingActivity(book) {
    return (Array.isArray(book.readingSessions) && book.readingSessions.length > 0)
        || (Array.isArray(book.readingHistory) && book.readingHistory.length > 0);
}

// Main classifier. `now` is a parameter so a caller classifying a whole
// list at once can use one consistent timestamp instead of many.
function getBookReadingStatus(book, now = Date.now()) {
    if (book.isRead) return READING_STATUS.COMPLETED;
    if (!hasRealReadingActivity(book)) return READING_STATUS.NOT_STARTED;

    const lastActivity = getLastRealReadingActivityTimestamp(book);
    // Has activity but no valid end timestamp (malformed data) - treat as
    // in-progress rather than crash on a null subtraction below.
    if (lastActivity === null) return READING_STATUS.IN_PROGRESS;

    const idleFor = now - lastActivity;
    return idleFor >= Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS
        ? READING_STATUS.PAUSED
        : READING_STATUS.IN_PROGRESS;
}

// =================================================================
// SHARED STORAGE / DB HELPERS
// =================================================================
// Read/write helpers for the EpubReader_UserConfig_v1 localStorage blob.
// saveUserConfig() merges its patch into whatever's already saved.
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

function saveUserConfig(patch) {
  const config = Object.assign(getUserConfig(), patch);
  localStorage.setItem(Config.Db.USER_CONFIG_STORAGE_KEY, JSON.stringify(config));
  return config;
}

// Wraps an IndexedDB store.getAll() in a Promise.
function getAllFromStore(store) {
  return new Promise((resolve) => {
    store.getAll().onsuccess = (e) => resolve(e.target.result);
  });
}

// Same as above but opens its own readonly transaction from a store name -
// for callers (sync/backup code) that don't already have a store handle,
// and that may run before loadedBooksMemory/loadedGroupsMemory etc. are
// populated for the first time, so reading IndexedDB directly matters.
function getAllFromLocalStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
/*
 Stamps lastModified after a successful cloud push and mirrors the value
 into the matching in-memory cache entry when available.
 Shared by group, note, and note-tag sync helpers. Missing cache arrays are
 safely ignored when the data has not been loaded yet.
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

/*
 Opens an EPUB zip's META-INF/container.xml to find the OPF path, then
 parses that OPF. Returns {opfDoc, opfPath, baseDir} - baseDir is opfPath's
 directory (trailing slash included), used to resolve manifest/spine hrefs.
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

/*
 Loads a book record, mutates it via mutateFn (in place), persists it, and
 pushes to the cloud. Always stamps lastModified. Resolves to the updated
 record, or null if the book wasn't found.
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

/*
 Store-agnostic sibling of updateBookRecord() above, for stores other than
 books (e.g. notes/note tags in 12-notes.js) that don't need a cloud push
 baked in - the caller passes its own pushFn (or null to skip). Same
 get/mutate/put/stamp-lastModified shape either way.
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

/*
 Shared read/write for a JSON array persisted to a localStorage key, with
 the "_ts" companion timestamp (read by 11-firebase-sync.js to compare
 against a remote settings bundle) and a fire-and-forget settings push -
 the exact pattern behind loadCollapsedNoteTagKeys/saveCollapsedNoteTagKeys
 and loadLastUsedNoteTagIds/saveLastUsedNoteTagIds in 12-notes.js.
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

function saveJsonArrayToLocalStorage(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
  localStorage.setItem(`${key}_ts`, String(Date.now()));
  if (typeof pushNoteSettingsToCloud === "function") pushNoteSettingsToCloud();
}

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

function convertBlobToBase64(blobItem) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blobItem);
  });
}

// Escapes untrusted text (book titles/authors from an uploaded EPUB's own
// metadata) before interpolating into innerHTML, so a crafted
// <title>&lt;img onerror=...&gt;</title> can't execute as real markup.
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/*
 LIGHTWEIGHT MARKDOWN - note/comment display formatting

 Purpose-built formatter for note comments, not a full Markdown engine.
 Supports bold, italic, strike, code, underline, unordered lists, and
 ordered lists.

 Escapes raw text before substitutions so user HTML cannot reach the output.
 Inline code is protected first, then restored; bold runs before italic to
 avoid `**` being interpreted incorrectly. Lists are processed last.
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

/*
 Groups consecutive bullet/numbered lines into one <ul>/<ol> rather than a
 stack of one-item lists. Non-list lines are rejoined with <br> so a plain
 multi-line comment still breaks visually the same way innerText did.
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

/*
 Single source of truth for whether tracked timeSpentSeconds represents
 meaningful reading or just noise from brief opens/taps.
 Returns 0 below the configured threshold and the original value otherwise.
 Stats should use this instead of reading timeSpentSeconds directly, so
 tiny values cannot distort calculations inconsistently.
*/
function getMeaningfulTrackedSeconds(rawSeconds) {
    const seconds = rawSeconds || 0;
    return seconds >= Config.Reading.MIN_MEANINGFUL_TRACKED_SECONDS ? seconds : 0;
}

// Minutes-returning convenience wrapper.
function getMeaningfulTrackedMinutes(rawSeconds) {
    return Math.round(getMeaningfulTrackedSeconds(rawSeconds) / 60);
}

function formatMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round((mins % 60)*10)/10;
    return h ? `${h}h ${m}m` : `${m}m`;
}

/*
 Formats a calendar-time duration in ms (e.g. firstOpened to completedDate)
 - hours while under a day, whole days otherwise. Kept separate from
 formatMinutes() above since that formats accumulated reading time (hh/mm)
 while this formats elapsed wall-clock time between two dates.
*/
function formatCompletionDuration(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    const hours = ms / (1000 * 60 * 60);
    if (hours < 1) return "<1h";
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}

// =================================================================
// ADAPTIVE AUTO-SCROLLER
// =================================================================
let enabled = false;
const AUTOSCROLL_DEBUG = Config.AutoScroller.AUTOSCROLL_DEBUG;

// MIN/MAX_STEP_PX bound computeAdaptiveStepPx() below so an all-image
// screen (0 measurable words) or one giant word can't produce a step
// that's far too small or large.
const MIN_STEP_PX = Config.AutoScroller.MIN_STEP_PX;
const MAX_STEP_PX = Config.AutoScroller.MAX_STEP_PX;
const FALLBACK_STEP_PX = Config.AutoScroller.FALLBACK_STEP_PX; // used if no visible words can be measured

// Roughly how many words should scroll past per tick at default speed.
// The speed slider only changes the delay between ticks (getCooldownMs).
const TARGET_WORDS_PER_TICK = Config.AutoScroller.TARGET_WORDS_PER_TICK;

function getCooldownMs() {
  return Number(document.getElementById("setting-scroll-delay").value) * 1000;
}

function countVisibleWords() {
  const container = document.getElementById("reader-container");
  const frame = document.getElementById("text-render-frame");
  if (!container || !frame) return 0;
 
  const containerRect = container.getBoundingClientRect();
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  let words = 0;
  let node;
 
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text.trim()) continue;
 
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
 
    const isVisible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    if (isVisible) {
      words += text.trim().split(/\s+/).filter(Boolean).length;
    }
  }
 
  return words;
}

/*
 Converts visible-word density into a per-tick pixel step. pixelsPerWord
 shrinks on dense pages (small text/tight spacing) and grows on sparse
 ones, so scrolling TARGET_WORDS_PER_TICK worth of words always takes
 about the same reading time regardless of layout.
*/
function computeAdaptiveStepPx() {
  const container = document.getElementById("reader-container");
  if (!container) return FALLBACK_STEP_PX;
 
  const visibleHeight = container.clientHeight;
  const visibleWords = countVisibleWords();
 
  if (!visibleWords || !visibleHeight) {
    if (AUTOSCROLL_DEBUG) {
      console.log(`[AutoScroll] no visible words detected (visibleWords=${visibleWords},
         visibleHeight=${visibleHeight}) — using fallback step of ${FALLBACK_STEP_PX}px`);
    }
    return FALLBACK_STEP_PX;
  }
 
  const wordsPerPixel = visibleWords / visibleHeight;
  const pixelsPerWord = 1 / wordsPerPixel;
  const idealStep = TARGET_WORDS_PER_TICK * pixelsPerWord;
  const clampedStep = Math.min(MAX_STEP_PX, Math.max(MIN_STEP_PX, idealStep));
 
  if (AUTOSCROLL_DEBUG) {
    console.log(
      `[AutoScroll] visible words=${visibleWords} in ${visibleHeight}px ` +
      `→ ${pixelsPerWord.toFixed(2)}px/word ` +
      `→ ideal step=${idealStep.toFixed(1)}px ` +
      (clampedStep !== idealStep ? `→ CLAMPED to ${clampedStep.toFixed(1)}px` : `→ using ${clampedStep.toFixed(1)}px`)
    );
  }
 
  return clampedStep;
}

let lastScrollTime = 0;
let interval = null;
const fill = document.getElementById("fill");

function applySpeedChange() {
  if (!enabled) return;
  clearInterval(interval);
  toggleScroll();
  toggleScroll();
}
document.getElementById("setting-scroll-delay").addEventListener("input", applySpeedChange);

function startScroll() {
  lastScrollTime = Date.now();
  fill.style.width = "100%";
  interval = setInterval(() => {
    document.getElementById("reader-container").scrollBy(0, computeAdaptiveStepPx());
 
    lastScrollTime = Date.now();
  }, getCooldownMs());
  fill.style.boxShadow = "0 0 3px 5px var(--accent)";
  requestAnimationFrame(updateBar);
}
 
function stopScroll() {
  clearInterval(interval);
  fill.style.boxShadow = "none";
  fill.style.width = "100%";
  interval = null;
  enabled = false;
}
 
function toggleScroll() {
  enabled = !enabled;
 
  if (enabled) startScroll();
  else stopScroll();
}
 
function updateBar() {
  if (!enabled) return;
 
  const now = Date.now();
  const remaining = Math.max(0, getCooldownMs() - (now - lastScrollTime));
  const pct = remaining / getCooldownMs();
 
  fill.style.width = (pct * 100) + "%";
 
  requestAnimationFrame(updateBar);
}
 
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "d") {
    e.preventDefault();
    toggleScroll();
  }
});
 
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    return;
  }
  if (e.ctrlKey && e.key === "d") {
    return; // Already handled above — avoids immediately re-toggling
  }
 
  stopScroll();
});