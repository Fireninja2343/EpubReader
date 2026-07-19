// =================================================================
// READING STATUS - shared classification used by the per-book stats
// table ("Individual Breakdown Per Book") and the Completion Timeline's
// Gantt mode (14-timeline.js)
// =================================================================
/*
 Four mutually-exclusive statuses, in the order a book actually moves
 through them: notStarted -> inProgress -> (paused <-> inProgress)* -> completed.
 Kept as one function so both consumers can never disagree about which
 status a given book is in - "In Progress" in the stats table always means
 the exact same thing as "In Progress" in the timeline.

   - completed: book.isRead is true. Always wins regardless of any
     inactivity gap - a finished book is never "Paused", even if the
     person hasn't opened it since finishing it.

   - notStarted: the book has never accumulated any real recorded reading
     activity. "Real" here means readingSessions/readingHistory - both
     arrays are only ever written to once a session survives the existing
     noise-floor checks in continueOrStartReadingSession()/endReadingSession()
     (09-stats-and-context-menu.js) and persistHistorySegment()
     (13-reading-history.js), which already require genuine interaction
     (scroll/click/keydown) to have fired and a handful of seconds to have
     passed - so an empty history here is a reliable stand-in for "opened
     it, but never actually engaged with it," without this function needing
     to duplicate that interaction/duration tracking itself. Falling back to
     book.currentChapter/scrollOffset (set the moment the reader opens,
     regardless of engagement) would be too eager to call a book "started."

   - paused: has real recorded activity, isn't completed, but the most
     recent activity is older than Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS.

   - inProgress: has real recorded activity, isn't completed, and the most
     recent activity is within the pause threshold.
*/
const READING_STATUS = {
    COMPLETED: "completed",
    IN_PROGRESS: "inProgress",
    PAUSED: "paused",
    NOT_STARTED: "notStarted",
};

// Display metadata for each status - single source for the emoji/label
// pairing so the stats table (and anywhere else that lists a book's
// status as text) can't drift out of sync with the classification above.
const READING_STATUS_LABELS = {
    [READING_STATUS.COMPLETED]: "✅ Completed",
    [READING_STATUS.IN_PROGRESS]: "📖 In Progress",
    [READING_STATUS.PAUSED]: "⏸️ Paused",
    [READING_STATUS.NOT_STARTED]: "⬜ Not Started",
};

/*
 Returns the timestamp of the most recent *real* reading activity recorded
 for a book, or null if it has none. Prefers readingSessions (session.end)
 and readingHistory (entry.endTimestamp) over the coarser lastOpened field,
 since lastOpened updates the instant the reader opens even if the person
 immediately closes it again - it would reset a book's "last activity" clock
 without any real reading having happened, defeating the point of the pause
 check below.
*/
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

// True if this book has at least one recorded real reading session/segment
// - see the notStarted case in the big comment above.
function hasRealReadingActivity(book) {
    return (Array.isArray(book.readingSessions) && book.readingSessions.length > 0)
        || (Array.isArray(book.readingHistory) && book.readingHistory.length > 0);
}

/*
 The main classifier. `now` is accepted as a parameter (defaulting to the
 real current time) purely so callers building a whole list at once - or
 tests - can pass a single consistent timestamp instead of each book's
 classification potentially straddling a clock tick.
*/
function getBookReadingStatus(book, now = Date.now()) {
    if (book.isRead) return READING_STATUS.COMPLETED;

    if (!hasRealReadingActivity(book)) return READING_STATUS.NOT_STARTED;

    const lastActivity = getLastRealReadingActivityTimestamp(book);
    // Has session/history entries but somehow no valid end timestamp on any
    // of them (malformed data) - treat as in-progress rather than crash on
    // a null subtraction below, since we know for certain it was started.
    if (lastActivity === null) return READING_STATUS.IN_PROGRESS;

    const idleFor = now - lastActivity;
    if (idleFor >= Config.Reading.PAUSED_INACTIVITY_THRESHOLD_MS) {
        return READING_STATUS.PAUSED;
    }
    return READING_STATUS.IN_PROGRESS;
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

// Escapes text pulled from untrusted sources (book titles/authors parsed out
// of an uploaded .epub's own metadata) before it's interpolated into an
// innerHTML template string. Without this, an .epub crafted with e.g.
// <title>&lt;img src=x onerror=alert(1)&gt;</title> in its OPF metadata would
// have that markup executed as real HTML wherever the title is displayed via
// innerHTML (the book-metrics modal and the stats table).
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =================================================================
// LIGHTWEIGHT MARKDOWN - note/comment display formatting
// =================================================================
/*
 Small, purpose-built formatter for note comments (see buildNoteCard() in
 12-notes.js) - not a general-purpose Markdown engine, and deliberately
 not one: the codebase doesn't already depend on a Markdown library, and
 pulling one in just for a handful of inline styles (bold, italic,
 strikethrough, inline code) would be a lot of dead weight for a feature
 this narrow. Supports:

   **bold**            -> <strong>
   *italic*             -> <em>
   ~~strike~~ or -strike- -> <del>
   inline code (single backticks) -> <code>
   __underline__        -> <u>
   - item / * item       -> <ul><li>
   1. item               -> <ol><li>

 CRITICAL ORDERING: raw text is escaped FIRST (escapeHtml), before any
 Markdown substitution runs - every substitution below only ever wraps
 already-escaped text in a fixed, hardcoded tag, and never re-inserts
 anything the user typed as unescaped HTML. This is what makes it safe to
 render the result with innerHTML: even if someone's comment literally
 contains a script tag as text, escapeHtml turns that into inert
 "&lt;script&gt;..." text before any of the rules below ever see it, so
 there's no way for user-authored markup to survive into the rendered
 output - only the handful of tags this function itself hardcodes
 (strong, em, del, code, u, ul/ol/li) ever appear.

 Rule order also matters for correctness, independent of safety:
   1. Inline code runs first and is swapped out for placeholder
      tokens before anything else touches the text, so formatting
      characters *inside* a code span are never
      misinterpreted as real Markdown - they're restored verbatim at the
      very end.
   2. Bold (double asterisk) before italic (single asterisk), since they
      share a character - matching the double-asterisk form greedily first
      prevents it from being parsed as an empty italic span next to
      leftover asterisks.
   3. Strikethrough and underline don't share a marker with anything else
      above, so their order relative to bold/italic doesn't matter.
   4. List lines are handled last, on the whole (already inline-formatted)
      text split by line, since they're block-level rather than inline.
*/
function renderLightweightMarkdown(rawText) {
    if (rawText === null || rawText === undefined || rawText === "") return "";

    let escaped = escapeHtml(rawText);

    // --- 1. Inline code: pull spans out first, replace with placeholders ---
    const codeSpans = [];
    escaped = escaped.replace(/`([^`\n]+?)`/g, (match, code) => {
        const token = `\u0000CODE${codeSpans.length}\u0000`;
        codeSpans.push(code);
        return token;
    });

    // --- 2. Bold: **text** (before italic, since both use *) ---
    escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");

    // --- 3. Italic: *text* (single asterisk, what's left after bold above) ---
    escaped = escaped.replace(/\*([^\n*]+?)\*/g, "<em>$1</em>");

    // --- 4. Strikethrough: ~~text~~ or -text- ---
    // The single-dash form requires no whitespace touching either dash
    // (same convention as *italic* below) so ordinary hyphenated prose
    // like "well - this is odd" or "a - b" doesn't get misread as strikethrough.
    escaped = escaped.replace(/~~([^\n]+?)~~/g, "<del>$1</del>");
    escaped = escaped.replace(/-(\S(?:[^\n-]*\S)?)-/g, "<del>$1</del>");

    // --- 5. Underline: __text__ ---
    escaped = escaped.replace(/__([^\n]+?)__/g, "<u>$1</u>");
    escaped = escaped.replace(/_([^\n]+?)_/g, "<u>$1</u>");


    // --- 6. Lists: group consecutive "- item"/"* item" or "1. item" lines ---
    escaped = renderMarkdownLists(escaped);

    // --- 7. Restore inline code spans, escaping any Markdown-looking
    // characters inside them isn't needed (they were never processed as
    // Markdown to begin with - see step 1) ---
    escaped = escaped.replace(/\u0000CODE(\d+)\u0000/g, (match, idx) => `<code>${codeSpans[Number(idx)]}</code>`);

    return escaped;
}

/*
 Groups consecutive bullet ("- " / "* ") or numbered ("1. ", "2. ", ...)
 lines into a single <ul>/<ol>, rather than wrapping every line in its own
 list individually - a run of list lines should render as one list, not a
 stack of one-item lists. Lines that aren't part of a list are rejoined
 with <br> (see the loop at the bottom) so a plain multi-line comment still
 breaks visually the same way it did under the innerText this replaces.
*/
function renderMarkdownLists(text) {
    const lines = text.split("\n");
    // Each entry is {content, isBlock} - isBlock true for a flushed
    // <ul>/<ol>, false for an ordinary line. Only consecutive non-block
    // entries get glued together with <br> (see the join step below) -
    // <ul>/<ol> are already block-level and don't need (or want) a <br>
    // stitched onto either side of them, which would otherwise add an
    // extra visual gap in most browsers.
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

    /*
     Rejoin, inserting <br> only between two consecutive plain lines -
     innerText (what this replaces in buildNoteCard()) rendered a bare
     newline as a visual line break, but innerHTML collapses raw "\n" into
     a single space. This is what keeps a plain multi-line comment (no list
     markers at all) displaying exactly as it did before Markdown rendering
     existed, without adding a stray extra gap around list blocks (which
     are already block-level and don't need a <br> of their own).
    */
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

  // Make the menu visible (but off in the corner) first so its natural
  // width/height can actually be measured before it's positioned for real.
  menu.style.display = "block";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const menuRect = menu.getBoundingClientRect();

  // Default: open to the right of the trigger. Flip to the left if that
  // would touch or exceed the right edge of the viewport.
  let left = triggerRect.right;
  if (left + menuRect.width >= window.innerWidth) {
    left = triggerRect.left - menuRect.width;
  }
  // If flipping left would touch or exceed the left edge too (e.g. a
  // narrow viewport), fall back to the right side and just clamp it.
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

function formatMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round((mins % 60)*10)/10;
    return h ? `${h}h ${m}m` : `${m}m`;
}

/*
 Formats a *calendar-time* duration in milliseconds (e.g. firstOpened to
 completedDate - see "Completion Duration" in the stats view) - hours while
 under a day, whole days otherwise. Deliberately separate from
 formatMinutes() above: that one formats accumulated *reading time*
 (hh/mm), this one formats *elapsed wall-clock time* between two dates.
 They're different metrics that happen to both be durations, so they stay
 different functions rather than being forced through one shared formatter.
*/
function formatCompletionDuration(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    const hours = ms / (1000 * 60 * 60);
    if (hours < 1) return "<1h";
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}

let enabled = false;
const AUTOSCROLL_DEBUG = Config.AutoScroller.AUTOSCROLL_DEBUG;

/*
 Auto-scroll moves a variable distance on each tick instead of a fixed
 pixel amount, calculated by computeAdaptiveStepPx() below based on how
 dense the currently visible text is. MIN_STEP_PX and MAX_STEP_PX are just
 safety bounds on that calculation, so a screen that's all images (0
 measurable words) or one giant word doesn't cause a step that's far too
 small or far too large.
*/
const MIN_STEP_PX = Config.AutoScroller.MIN_STEP_PX;
const MAX_STEP_PX = Config.AutoScroller.MAX_STEP_PX;
const FALLBACK_STEP_PX = Config.AutoScroller.FALLBACK_STEP_PX; // used if no visible words can be measured at all

/*
 Roughly how many words should scroll past the viewport per tick at the
 default speed setting. The speed slider in the UI only changes the delay
 between ticks (via getCooldownMs below); this constant is what defines
 how much content counts as "one tick's worth" of reading.
*/
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
 Converts "words currently visible in the viewport" into "pixels to scroll
 on this tick." pixelsPerWord is the value that actually changes with text
 density: a dense page packs words tightly, so pixelsPerWord is small and
 scrolling past TARGET_WORDS_PER_TICK worth of words only takes a few
 pixels. A sparse page (large text, lots of whitespace) has a large
 pixelsPerWord, so the same word target requires scrolling further.
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
    return; // Already handled by the listener above — returning here avoids immediately re-toggling
  }
 
  stopScroll();
});