// -----------------------------------------------------------------
// LIVE READING/LISTENING SYNC
// -----------------------------------------------------------------
/*
 Bridges 23-audio-player.js (playback) and the EPUB reader (10-reader-
 controls.js / 09-epub-reader.js) using the pure mapping functions from
 24-audio-pairing.js. Owns no state those files already own - just reads
 activeAudioElement/activeSpinePointer/etc. and drives them.

 The live scroll loop uses the shared engine (26-auto-scroll.js) with a
 step function that maps audio time to a scroll delta each tick. The
 step function arms a consume‑once lock just before scrollBy() is called;
 the scroll event handler consumes the lock and ignores sync‑caused
 scrolls. This prevents the sync's own movement from being misread as
 user input, which previously caused runaway offset accumulation.
*/

let syncModeActive = false;
/** Raw pixel offset added on top of every synced scroll target, until changed again or cleared. */
let syncUserOffsetPx = 0;
/** How often the sync loop ticks. Fixed, not user-configurable.
 this is following real playback time, not an artificial reading pace. */
const SYNC_TICK_MS = 2500;

/**
 Records the current listening position for a book in the shared sync store.
 Reads the audio element's currentTime and the book's chapter list to determine
 the chapter index and percent within that chapter.
 
 @param {number} bookId - The book's ID.
 @param {Object} [options] - Optional explicit position.
 @param {number} [options.chapterIndex] - If provided, uses this instead of computing.
 @param {number} [options.percentInChapter] - If provided, uses this instead of computing.
 @returns {Promise<void>}
 */
async function recordListeningPosition(bookId, options = {}) {
    if (!bookId) return;
    if (!activeAudioElement) return;

    const forceCloudPush = options.forceCloudPush === true;
    let chapterIndex = options.chapterIndex;
    let percentInChapter = options.percentInChapter;

    // If explicit values were passed, use them directly
    if (chapterIndex !== undefined && percentInChapter !== undefined) {
        const audiobook = await getAudiobookForBook(bookId);
        const maxChapter = audiobook?.chapters?.length ? audiobook.chapters.length - 1 : 0;
        chapterIndex = Math.max(0, Math.min(chapterIndex, maxChapter));
        percentInChapter = Math.max(0, Math.min(1, percentInChapter || 0));
        await updateAudioSyncPosition(bookId, {
            chapterIndex,
            percentInChapter,
            userOffsetPx: syncUserOffsetPx || 0,
            lastMode: 'listening',
            forceCloudPush,
        });
        return;
    }

    // Otherwise compute from current time
    const audiobook = await getAudiobookForBook(bookId);
    if (!audiobook || !audiobook.chapters || audiobook.chapters.length === 0) {
        console.warn("[recordListeningPosition] No chapters found for book", bookId);
        return;
    }

    const currentTime = activeAudioElement.currentTime || 0;
    const chapterPos = secondsToChapterPosition(audiobook.chapters, currentTime);
    if (!chapterPos) {
        console.warn("[recordListeningPosition] Could not map time", currentTime, "to chapter for book", bookId);
        return;
    }

    chapterIndex = Math.max(0, Math.min(chapterPos.audioChapterIndex, audiobook.chapters.length - 1));
    percentInChapter = Math.max(0, Math.min(1, chapterPos.percentInChapter || 0));

    await updateAudioSyncPosition(bookId, {
        chapterIndex,
        percentInChapter,
        userOffsetPx: syncUserOffsetPx || 0,
        lastMode: 'listening',
        forceCloudPush,
    });
}

/**
 True between a sync tick arming its scrollBy() and the resulting scroll
 event being consumed by handleSyncScrollEvent() - events in this window are
 sync-caused, not user input. The handler CONSUMES the lock; there is
 deliberately no timer-based release: scroll events fire during the next
 rendering update, which is not guaranteed to happen before a setTimeout(0)
 callback, so a timed release races the event and loses, letting this
 tick's own scroll be misread as user input (which compounded into
 syncUserOffsetPx and made the reader accelerate away from the audio).
*/
let syncApplyingScroll = false;

/** Flip to true to re-enable per-tick sync logs. */
const SYNC_DEBUG = false;

/**
 Resolves the calibrated chapter offset for a paired book, defaulting to 0
 (EPUB chapter N = audio chapter N) if calibration hasn't been run yet.
 @param {Object} audiobook - Record from getAudiobookForBook().
 @returns {number}
*/
function resolveChapterOffset(audiobook) {
  return audiobook.chapterOffset ?? 0;
}

/**
 Toggles live sync on/off. Turning on requires a paired book with audio
 loaded - silently does nothing if those aren't met.
*/
async function toggleReadingAudioSync() {
  if (syncModeActive) {
    stopReadingAudioSync();
    return;
  }
  if (!activeBookObject || !activeAudioElement) return;
  const audiobook = await getAudiobookForBook(activeBookObject.id);
  if (!audiobook) return;

  if (!audiobook.syncMode) {
    alert("Please select a sync mode (Chapter or Whole) in the pairing panel first.");
    return;
  }
  if (audiobook.syncMode === "whole") {
    const wordData = await resolveWordCountData(activeBookObject.id);
    if (!wordData) {
      alert("Whole-book sync needs this book's chapter word counts (computed at EPUB import). Re-import the book or switch to Chapter mode in the pairing panel.");
      return;
    }
  }

  syncModeActive = true;
  syncUserOffsetPx = 0;
  attachSyncScrollListener();
  startScroll({
    getStepPx: () => computeSyncStepPx(audiobook),
    getCooldownMs: () => SYNC_TICK_MS,
    colorVar: "--audio-accent",
    glowVar: "--audio-glow",
    // Force instant per tick regardless of any CSS scroll-behavior: smooth on
    // #reader-container - an animated scrollBy fires MANY scroll events, which
    // would defeat the consume-once lock (only the first would be consumed).
    scrollBehavior: "instant",
  });
}

/**
 Turns off live sync. Does not pause audio - per design, stopping playback
 (not toggling sync) is what ends auto-scroll; this just stops the reader
 from following along.
*/
function stopReadingAudioSync() {
  syncModeActive = false;
  stopScroll();
  detachSyncScrollListener();
}

/**
 Computes this tick's scroll delta: maps the audio's current time to a
 target EPUB scroll position (chapter + percent, converted to pixels, plus
 the persistent user offset) and returns target - current scrollTop.
 Called by startScroll()'s interval via getStepPx() - see 26-auto-scroll.js.
 Switches the rendered chapter first if the audio has moved into a
 different mapped chapter than what's currently on screen.

 Wrapped in the syncApplyingScroll lock (set true here, released after the
 scrollBy() this return value feeds into) so the resulting scroll event is
 recognized as programmatic, not user input.

 @param {Object} audiobook - The paired audiobook record.
 @returns {number} Pixel delta for startScroll()'s scrollBy() call. 0 if audio is paused/unavailable or nothing should move yet.
*/
function computeSyncStepPx(audiobook) {
  if (!syncModeActive || !activeAudioElement || activeAudioElement.paused) return 0;

  const container = document.getElementById("reader-container");
  if (!container) return 0;

  const chapterPos = secondsToChapterPosition(audiobook.chapters, activeAudioElement.currentTime);
  if (!chapterPos) return 0;

  const scrollTarget = mapChapterToScroll({
    mode: audiobook.syncMode,
    chapterOffset: resolveChapterOffset(audiobook),
    audioChapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject?.chapterWordCounts || [],
    totalWords: activeBookObject?.totalWords || 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

  if (!scrollTarget) return 0;
  if (scrollTarget.epubSpineIndex !== activeSpinePointer) {
    if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return 0;
    activeSpinePointer = scrollTarget.epubSpineIndex;
    syncUserOffsetPx = 0;
    // The async render will reset scrollTop when it swaps the DOM. Null the
    // baseline so its scroll events can't fold in as user input (the
    // scrollHeight heuristic in handleSyncScrollEvent is the primary
    // defense; this covers the no-scroll-event edge), then re-baseline once
    // it settles.
    syncLastKnownScrollTop = null;
    syncLastKnownScrollHeight = null;
    renderActiveChapterFromZip(activeZipInstance).then(() => {
      const c = document.getElementById("reader-container");
      if (c) {
        syncLastKnownScrollTop = c.scrollTop;
        syncLastKnownScrollHeight = c.scrollHeight;
      }
      if (typeof saveAndApplyUserStyles === "function") saveAndApplyUserStyles();
    }).catch(() => {});
    return 0;
  }

  // Same denominator trackReadingProgress() uses - banner-inflated
  // scrollHeight must not pull the sync target toward the banner zone.
  const banner = document.getElementById("chapter-end-action-banner");
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight - (banner ? banner.offsetHeight : 0));
  const targetScrollTop = Math.max(0, Math.min(maxScroll, scrollTarget.innerPct * maxScroll + syncUserOffsetPx));
  const delta = targetScrollTop - container.scrollTop;

  if (SYNC_DEBUG) {
    console.log("[sync] t:", activeAudioElement.currentTime, "chapterPos:", chapterPos,
      "target:", targetScrollTop, "current:", container.scrollTop, "delta:", delta);
  }

  if (Math.abs(delta) < 1) return 0;

  syncApplyingScroll = true;
  return delta;
}
// -----------------------------------------------------------------
// MANUAL-SCROLL OFFSET DETECTION
// -----------------------------------------------------------------
/*
 A capturing-phase listener runs alongside the existing
 onscroll="trackReadingProgress()" HTML binding rather than replacing it -
 both fire independently, trackReadingProgress() keeps saving normal
 reading position regardless of sync state.

 Any scroll event that fires while syncApplyingScroll is false is
 unambiguously user-caused (wheel, drag, keyboard) - the reader's actual
 scrollTop, compared against what the last sync tick targeted, becomes the
 new persistent offset. This does NOT fight the user: sync keeps running on
 the next tick, just from the new offset going forward, per the design.
*/

let syncLastKnownScrollTop = null;
/**
 scrollHeight at the time of the last baselined event. A changed scrollHeight
 is the fingerprint of a layout shift (chapter render, banner injection, image
 load, style reapply) rather than a user scroll - those events carry the
 displacement of the RESET, not a user delta, and folding them into the offset
 used to slam it to roughly -(old scrollTop) on every chapter switch.
*/
let syncLastKnownScrollHeight = null;

function attachSyncScrollListener() {
  const container = document.getElementById("reader-container");
  syncApplyingScroll = false; // never inherit a stale lock from a previous session
  syncLastKnownScrollTop = container.scrollTop;
  syncLastKnownScrollHeight = container.scrollHeight;
  container.addEventListener("scroll", handleSyncScrollEvent);
}

function detachSyncScrollListener() {
  document.getElementById("reader-container").removeEventListener("scroll", handleSyncScrollEvent);
  syncLastKnownScrollTop = null;
  syncLastKnownScrollHeight = null;
  syncApplyingScroll = false;
}

function handleSyncScrollEvent() {
  if (!syncModeActive) return;
  const container = document.getElementById("reader-container");

  // Sync-caused scroll: consume the lock, re-baseline, do NOT touch
  // syncUserOffsetPx (folding it in double-applies each tick's delta and
  // compounds quadratically).
  if (syncApplyingScroll) {
    syncApplyingScroll = false;
    syncLastKnownScrollTop = container.scrollTop;
    syncLastKnownScrollHeight = container.scrollHeight;
    return;
  }

  // Layout shift, not user input: re-baseline only, drop the event. A pure
  // user wheel/drag/keyboard scroll never changes scrollHeight.
  if (syncLastKnownScrollHeight != null && container.scrollHeight !== syncLastKnownScrollHeight) {
    syncLastKnownScrollTop = container.scrollTop;
    syncLastKnownScrollHeight = container.scrollHeight;
    return;
  }

  // Plain user scroll: fold movement since the last event into the offset.
  // lastKnown is re-baselined on EVERY path, or a user delta would absorb
  // displacement that happened since the last baseline.
  if (syncLastKnownScrollTop != null) {
    syncUserOffsetPx += container.scrollTop - syncLastKnownScrollTop;
  }
  syncLastKnownScrollTop = container.scrollTop;
  syncLastKnownScrollHeight = container.scrollHeight;
}

// -----------------------------------------------------------------
// MODE-SWITCH PROMPTS
// -----------------------------------------------------------------
/*
 Triggered right when a file loads successfully (fresh pair, resume, or
 opening the reader) - the earliest natural moment, and consistent with
 where chapter calibration already auto-opens. Declining leaves the
 current position untouched; this never forces a jump.
*/
/** bookIds already asked "continue reading from your last listening session?" this session. */
const listeningPromptHandled = new Set();
/**
 Call after the reader opens for a paired book. If a listening session is
 recorded as more recent than the reader's own last-known position, offers
 to jump the reader to that spot.
 @param {number} bookId - id of the book just opened in the reader.
*/
async function promptSyncReadingToAudio(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  // Only for the book actually open, and at most once per session - lastMode
  // stays "listening" until the next pause overwrites it, so without the
  // guard this re-prompted on every reader open / re-pair / resume.
  if (!activeBookObject || activeBookObject.id !== bookId) return;
  if (listeningPromptHandled.has(bookId)) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "listening") return;
  listeningPromptHandled.add(bookId);

  const confirmed = confirm("Continue reading from your last listening session?");
  if (!confirmed) return;

  const scrollTarget = mapChapterToScroll({
    mode: audiobook.syncMode || "chapter",
    chapterOffset: resolveChapterOffset(audiobook),
    audioChapterIndex: position.chapterIndex,
    percentInChapter: position.percentInChapter ?? 0,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject.chapterWordCounts || [],
    totalWords: activeBookObject.totalWords || 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

  // Mapper contract: null = unmappable (whole mode with no word data etc.).
  // Used to deref .epubSpineIndex straight off it and throw.
  if (!scrollTarget) {
    console.warn("[sync-prompt] listening->reading: position unmappable, skipping jump");
    return;
  }
  if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return;

  activeSpinePointer = scrollTarget.epubSpineIndex;
  await renderActiveChapterFromZip(activeZipInstance);
  // Fresh renders drop inline typography (stepToNextChapter re-applies for
  // the same reason after every render).
  if (typeof saveAndApplyUserStyles === "function") saveAndApplyUserStyles();

  // A fresh deliberate jump - a stale user offset from the old chapter must
  // not skew the landing spot.
  syncUserOffsetPx = 0;

  const container = document.getElementById("reader-container");
  const banner = document.getElementById("chapter-end-action-banner");
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight - (banner ? banner.offsetHeight : 0));
  container.scrollTop = Math.max(0, Math.min(maxScroll, scrollTarget.innerPct * maxScroll));
  trackReadingProgress();
}

/**
 Call after audio finishes loading (pair, resume) for a paired book. If a
 reading session is recorded as more recent than the audio's own position,
 offers to seek audio to that spot.

 The stored reading position (chapterIndex = EPUB spine, percentInChapter =
 scroll fraction) is mode-independent; syncMode only decides how it projects
 onto the audio timeline. Chapter mode projects spine ± chapterOffset and
 needs no EPUB data. Whole mode projects a word-weighted whole-book fraction
 and therefore REQUIRES this specific book's word counts - resolved via
 resolveWordCountData() (active reader if it's this book, else the DB
 record), never from activeBookObject blindly: with no/different book open
 that used to feed empty or wrong chapter lengths into cumulativeWordPct(),
 whose degenerate fallback divides by 1 and clamps to 1 - seeking the audio
 to the literal end of the file. If syncMode was never selected, falls back
 to "chapter"/offset 0, matching the live loop's default.

 Every result is validated and verified by round-tripping through the
 forward mapping; any garbage refuses the seek instead of jumping blindly.
*/
async function promptSyncAudioToReading(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !activeAudioElement) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "reading") return;

  const mode = audiobook.syncMode || "chapter";
  const spineIndex = position.chapterIndex;
  const innerPct = position.percentInChapter ?? 0;

  if (!Number.isInteger(spineIndex) || spineIndex < 0) return;

  // Whole mode needs THIS book's word data before we can promise a sane
  // seek; a stale spine index past the book's real chapter count (re-paired
  // EPUB) can't be mapped either. Both cases skip the prompt entirely
  // rather than ask and then refuse.
  let wordData = null;
  if (mode === "whole") {
    wordData = await resolveWordCountData(bookId);
    if (!wordData) {
      console.warn("[sync-prompt] whole mode: no chapter word counts for book", bookId,
        "- can't map reading position to audio, skipping jump");
      return;
    }
    if (spineIndex >= wordData.chapterCount) {
      console.warn("[sync-prompt] stored reading position", spineIndex,
        "is past this book's", wordData.chapterCount, "chapters - stale record, skipping");
      return;
    }
  }

  const confirmed = confirm("Jump audio to your last reading session?");
  if (!confirmed) return;

  const mappingInput = {
    mode,
    chapterOffset: resolveChapterOffset(audiobook),
    epubSpineIndex: spineIndex,
    innerPct,
    audiobook,
    chapterWordCounts: wordData ? wordData.chapterWordCounts : [],
    totalWords: wordData ? wordData.totalWords : 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  };

  const chapterPos = mapScrollToChapter(mappingInput);
  if (!chapterPos || !Number.isFinite(chapterPos.audioChapterIndex)) {
    console.warn("[sync-prompt] mapScrollToChapter returned no usable position:", chapterPos);
    return;
  }

  // Round-trip guard: feed the result back through the FORWARD mapping (the
  // one the live loop exercises every tick). With correct inputs this is
  // exact up to fp noise; a mismatch means something upstream is lying.
  // Known false-positive: whole-mode seeks that legitimately clamp to the
  // very start/end of the audio because wholeBookOffset pushes the fraction
  // past the edge - rare, and refusing those is an acceptable trade for
  // never seeking on garbage.
  const roundTrip = mapChapterToScroll({
    ...mappingInput,
    audioChapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
  });
  const spineOk = roundTrip && Math.abs(roundTrip.epubSpineIndex - spineIndex) <= 1;
  const pctOk = roundTrip && Math.abs((roundTrip.innerPct ?? 0) - innerPct) <= 0.1;
  if (!spineOk || !pctOk) {
    console.warn("[sync-prompt] mapping failed round-trip check - not seeking.",
      { requested: { spineIndex, innerPct }, mapped: chapterPos, roundTrip, mode });
    return;
  }

  let seconds = chapterPositionToSeconds(audiobook.chapters, chapterPos.audioChapterIndex, chapterPos.percentInChapter);

  // NaN is not null: a bare `seconds != null` check happily passes NaN into
  // seekAudio (currentTime = NaN throws / wedges playback).
  if (seconds == null || !Number.isFinite(seconds)) {
    console.warn("[sync-prompt] chapterPositionToSeconds produced no usable time:", seconds);
    return;
  }

  const duration = activeAudioElement.duration;
  if (Number.isFinite(duration)) seconds = Math.min(Math.max(seconds, 0), duration);
  else if (seconds < 0) seconds = 0;

  if (SYNC_DEBUG) {
    console.log("[sync-prompt] mode:", mode, "reading pos:", { spineIndex, innerPct },
      "-> audio:", chapterPos, "-> seconds:", seconds);
  }

  seekAudio(seconds);
}