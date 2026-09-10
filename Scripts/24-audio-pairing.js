// -----------------------------------------------------------------
// AUDIOBOOK PAIRING
// -----------------------------------------------------------------
/*
 Links an EPUB book to an M4B audiobook. Uses the File System Access API
 (showOpenFilePicker) so a previously-picked file can be reopened later with
 one click instead of a full re-browse, scoped to only the most-recently-active
 paired audiobook (see setLastAudioContext() in 02-db.js). Falls back to a
 plain <input type="file"> re-upload on browsers without that API (Firefox).
*/

const supportsFileHandles = typeof window.showOpenFilePicker === "function";

/**
 Opens the native file picker restricted to M4B/M4A files and returns the
 picked File plus its handle (null on browsers without File System Access
 API support, in which case only the plain File is usable this session).

 @returns {Promise<{file: File, handle: FileSystemFileHandle|null}|null>} Null if
   the user cancels the picker.
*/
async function pickAudioFile() {
  if (supportsFileHandles) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Audiobook", accept: { "audio/mp4": [".m4b", ".m4a"] } }],
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (err) {
      // AbortError = user cancelled the picker; not a real failure.
      if (err.name !== "AbortError") console.warn("[24-audio-pairing] File picker failed:", err);
      return null;
    }
  }

  console.log("[24-audio-pairing] falling back to plain <input> - no handle will be available");
  // Fallback for browsers without showOpenFilePicker: a hidden plain input.
  // FIX: the original resolved only from onchange, so a CANCELLED picker
  // leaked a forever-pending promise and left handlePairAudiobookClick()
  // suspended indefinitely. A settle-latch plus the 'cancel' event fixes it.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".m4b,.m4a,audio/*";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    input.onchange = () => settle(input.files[0] ? { file: input.files[0], handle: null } : null);
    // 'cancel' on file inputs: Chromium 113+, Firefox 91+, Safari 16.4+.
    // Older browsers just behave as before (promise stays pending on cancel).
    input.oncancel = () => settle(null);
    input.click();
  });
}

/**
 Pairs a freshly-picked M4B with a book: extracts metadata, saves it, stores
 the file handle (if available), and marks this book as the current
 auto-resume context. Used for first-time pairing where there's nothing to
 diff against yet - see checkAudioFileForMismatch() for re-pick handling.

 @param {number} bookId - id of the EPUB book to pair.
 @param {File} file - The picked M4B file.
 @param {FileSystemFileHandle|null} handle - Handle for one-click resume, or null on unsupported browsers.
 @returns {Promise<Object>} The extracted metadata, so the caller (pairing UI) can display it immediately.
*/
async function pairAudiobookFile(bookId, file, handle) {
  const metadata = await extractM4bMetadata(file);
  await pairAudiobook(bookId, metadata);
  if (handle) {
    await saveAudioFileHandle(bookId, handle, file.name);
  }
  await setLastAudioContext(bookId);
  return metadata;
}

/**
 Attempts one-click resume for a given book, or for the global last-audio
 context when no target is supplied.

 @param {number|null} [targetBookId=null] - Book to resume; if null/undefined,
   falls back to the stored global last-audio context.
 @returns {Promise<{bookId: number, file: File, handle: FileSystemFileHandle}|null>}
*/
async function tryAutoResumeAudio(targetBookId = null) {
  const bookId = targetBookId != null ? targetBookId : await getLastAudioContext();
  if (bookId == null) return null;

  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !audiobook.fileHandle) return null;

  try {
    const permission = await audiobook.fileHandle.requestPermission({ mode: "read" });
    if (permission !== "granted") return null;
    const file = await audiobook.fileHandle.getFile();
    return { bookId, file, handle: audiobook.fileHandle };
  } catch (err) {
    console.warn("[24-audio-pairing] Auto-resume failed:", err);
    return null;
  }
}

// -----------------------------------------------------------------
// METADATA MISMATCH CHECK
// -----------------------------------------------------------------
/*
 Every time a file is put in hand for a book that's already paired (whether
 auto-resumed or manually re-picked), its metadata is re-extracted and
 diffed field-by-field against what's stored. Chapters compare by count and
 by each chapter's title, since start/end times can drift by fractions of a
 second between encodes of "the same" file without being a meaningful
 mismatch worth flagging.
*/

/**
 Diffs freshly-extracted metadata against a book's stored audiobook record.
 @param {Object} storedRecord - Existing STORE_AUDIOBOOKS record for this book.
 @param {Object} freshMetadata - Result of extractM4bMetadata() on the file now in hand.
 @returns {Array<{field: string, stored: string, fresh: string}>} One entry per
   mismatched field; empty array if everything matches.
*/
function diffAudiobookMetadata(storedRecord, freshMetadata) {
  const mismatches = [];

  const addIfDifferent = (field, storedVal, freshVal) => {
    if (storedVal !== freshVal) {
      mismatches.push({ field, stored: storedVal ?? "(none)", fresh: freshVal ?? "(none)" });
    }
  };

  addIfDifferent("Title", storedRecord.title, freshMetadata.title);
  addIfDifferent("Author", storedRecord.author, freshMetadata.author);

  // Duration compared to the nearest second - encodes of "the same" audio
  // can differ by sub-second container overhead without being a real mismatch.
  // FIX: simplified. The original's conditional expression reduced to exactly
  // this comparison; same output, no roundabout self-reference.
  const storedDurationRounded = Math.round(storedRecord.duration ?? 0);
  const freshDurationRounded = Math.round(freshMetadata.duration ?? 0);
  addIfDifferent("Duration", `${storedDurationRounded}s`, `${freshDurationRounded}s`);

  const storedChapters = storedRecord.chapters ?? [];
  const freshChapters = freshMetadata.chapters ?? [];
  addIfDifferent("Chapter count", storedChapters.length, freshChapters.length);

  // Only compare titles up to the shorter list's length, so a count
  // mismatch (already flagged above) doesn't also spam one row per extra
  // chapter on the longer side.
  const compareLength = Math.min(storedChapters.length, freshChapters.length);
  for (let i = 0; i < compareLength; i++) {
    addIfDifferent(`Chapter ${i + 1} title`, storedChapters[i].title, freshChapters[i].title);
  }

  return mismatches;
}

/**
 Full re-pick/resume verification flow: extracts metadata from the file now
 in hand, diffs it against the stored record, and returns both so the
 calling UI can decide what to show (silent proceed if no mismatches, or
 the mismatch table if any exist).

 @param {number} bookId - id of the book being verified.
 @param {File} file - The file now in hand (from resume or manual re-pick).
 @returns {Promise<{metadata: Object, mismatches: Array}>}
*/
async function verifyAudioFileAgainstStored(bookId, file) {
  const storedRecord = await getAudiobookForBook(bookId);
  const metadata = await extractM4bMetadata(file);
  const mismatches = storedRecord ? diffAudiobookMetadata(storedRecord, metadata) : [];
  return { metadata, mismatches };
}

// -----------------------------------------------------------------
// PAIRING UI
// -----------------------------------------------------------------
/*
 Entry points wired to the pairing panel/modal in index.html. Handles both
 first-time pairing (no stored record - no diff needed) and re-pick/resume
 (diff against stored metadata, show a mismatch table if anything differs).

 FIX: every load path now funnels through activatePairedAudio() below.
 The four call sites used to hand-roll the load sequence and had already
 drifted apart (mismatch-Continue never loaded the audio at all; resume
 never refreshed the pairing cache) - a shared path makes "forgot a step"
 structurally impossible.
*/

/** Book currently targeted by the pairing panel, set when it's opened. */
let audioPairingTargetBookId = null;

/**
 FIX (new): book whose audio is currently loaded into activeAudioElement.
 Set ONLY by activatePairedAudio() - i.e. only when the audio was loaded
 through this file's pairing flows. Guards every "does the loaded audio
 belong to the book I'm acting on?" check. Without it, the old code checked
 merely "does ANY audio exist", so opening book B's panel while book A's
 audio was loaded would seek A's audio to B's reading position
 (promptSyncAudioToReading seeks whatever activeAudioElement holds).
*/
let activeAudioBookId = null;

/**
 FIX (new): bookIds whose "jump audio to your last reading session?" prompt
 was already handled this session. The stored lastMode stays "reading" until
 the next pause overwrites it, so without this the prompt re-fired on every
 panel open and every re-pair/resume of the same book.
*/
const syncPromptHandled = new Set();

let cachedAudioDisplayBook = null;
/**
 FIX (new): central "audio is now loaded and usable for bookId" path.
 Wires up the player, restores the file's own last position, offers the
 cross-mode jump, refreshes caches. Every load entry point goes through
 this so none can forget a step - handleMismatchContinue() used to pair
 the file but never call loadM4bAudio(), leaving the player holding the
 previous file (or nothing).

 @param {number} bookId
 @param {File} file
*/
async function activatePairedAudio(bookId, file) {
  loadM4bAudio(file);
  attachAudioPositionDisplay(bookId);
  activeAudioBookId = bookId;
  document.getElementById("audio-pairing-transport").style.display = "flex";
  await restoreOwnListeningPosition(bookId);
  await promptSyncAudioToReading(bookId);
  refreshActiveBookAudioPairingCache(bookId);
  const audiobook = await getAudiobookForBook(bookId);
  cachedAudioDisplayBook = { bookId, audiobook };
}

/**
 FIX (new): promptSyncAudioToReading() wrapper with the guards the raw call
 sites lacked:
 - Only prompts when the loaded audio belongs to THIS book (activeAudioBookId).
 - At most once per book per session (syncPromptHandled).
 Safe to call from any pairing entry point; silently no-ops otherwise.
 @param {number} bookId
*/
async function promptSyncAudioToReading(bookId) {
  if (!activeAudioElement || activeAudioBookId !== bookId) return;
  if (syncPromptHandled.has(bookId)) return;
  syncPromptHandled.add(bookId);
  await promptSyncAudioToReading(bookId);
}

/**
 Opens the pairing panel for a given book and shows its current pairing
 state (paired/unpaired) if any.
 @param {number} bookId - id of the book to pair/manage audio for.
*/
async function openAudioPairingPanel(bookId) {
  audioPairingTargetBookId = bookId;
  const panel = document.getElementById("audio-pairing-panel");
  const statusEl = document.getElementById("audio-pairing-status");
  panel.style.display = "flex";

  // FIX: ownership-aware transport visibility. The old check was
  // "any audio is loaded", which showed book A's transport inside book B's
  // pairing panel when A's audio happened to be the loaded one.
  document.getElementById("audio-pairing-transport").style.display =
    activeAudioElement && activeAudioBookId === bookId ? "flex" : "none";

  const existing = await getAudiobookForBook(bookId);
  statusEl.textContent = existing
    ? `Paired: ${existing.title ?? existing.lastPickedFileName ?? "(untitled)"}`
    : "No audiobook paired yet.";

  // ---- show/hide calibration sections based on sync mode ----
  const modeChapter = document.getElementById("sync-mode-chapter");
  const modeWhole = document.getElementById("sync-mode-whole");
  const chapterCalDiv = document.getElementById("chapter-calibration-section");
  const wholeCalDiv = document.getElementById("whole-calibration-section");

  if (existing) {
    const mode = existing.syncMode || null;
    if (mode === "chapter") {
      modeChapter.classList.add("active");
      modeWhole.classList.remove("active");
      chapterCalDiv.style.display = "block";
      wholeCalDiv.style.display = "none";
    } else if (mode === "whole") {
      modeWhole.classList.add("active");
      modeChapter.classList.remove("active");
      chapterCalDiv.style.display = "none";
      wholeCalDiv.style.display = "block";
      updateWholeBookCalibrationDisplay();
    } else {
      // both off
      modeChapter.classList.remove("active");
      modeWhole.classList.remove("active");
      chapterCalDiv.style.display = "none";
      wholeCalDiv.style.display = "none";
    }
  } else {
    chapterCalDiv.style.display = "none";
    wholeCalDiv.style.display = "none";
  }
  // ---------------------------------------------------------

  // FIX: was `if (activeAudioElement && existing) promptSyncAudioToReading(bookId)`
  // - the wrong-book seek described on activeAudioBookId, plus re-prompt spam.
  // The wrapper checks ownership and once-per-session.
  await promptSyncAudioToReading(bookId);
}

function closeAudioPairingPanel() {
  document.getElementById("audio-pairing-panel").style.display = "none";
  audioPairingTargetBookId = null;
}

/**
 "Pair Audiobook" button handler. Picks a file and either pairs it directly
 (no stored record yet) or runs the mismatch check first (re-pairing over
 an existing record). FIX: both branches now collapse to pairAudiobookFile()
 + activatePairedAudio() + calibration, instead of two hand-rolled copies
 of the load sequence (the source of the mismatch-Continue bug).
*/
async function handlePairAudiobookClick() {
  if (audioPairingTargetBookId == null) return;
  const bookId = audioPairingTargetBookId;
  const picked = await pickAudioFile();
  if (!picked) return;

  const existing = await getAudiobookForBook(bookId);
  if (existing) {
    const { mismatches } = await verifyAudioFileAgainstStored(bookId, picked.file);
    if (mismatches.length > 0) {
      showMismatchTable(mismatches, picked);
      return;
    }
  }

  const metadata = await pairAudiobookFile(bookId, picked.file, picked.handle);
  document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? picked.file.name}`;
  await activatePairedAudio(bookId, picked.file);
  // Calibration opens AFTER the jump prompt (prompt runs inside
  // activatePairedAudio) so the user decides the jump before the
  // calibration UI covers the screen.
  openCalibrationModal(bookId);
}

/**
 "Resume Listening" button handler - the one user-gesture click required to
 re-request permission on a stored file handle. Runs the same mismatch
 check as a manual re-pick, since the file on disk could have changed since
 it was last paired. FIX: goes through activatePairedAudio() (the old copy
 never refreshed the pairing cache) and passes the handle through to the
 mismatch table so Continue keeps one-click resume working.
*/
async function handleResumeListeningClick() {
  const resumed = await tryAutoResumeAudio(audioPairingTargetBookId);
  if (!resumed) {
    document.getElementById("audio-pairing-status").textContent =
      "Couldn't auto-resume - please re-select the file.";
    return;
  }

  const { mismatches } = await verifyAudioFileAgainstStored(resumed.bookId, resumed.file);
  if (mismatches.length === 0) {
    document.getElementById("audio-pairing-status").textContent = "Resumed, metadata matches.";
    await activatePairedAudio(resumed.bookId, resumed.file);
  } else {
    // Handle passed through so mismatch-Continue re-pairs with the handle intact.
    showMismatchTable(mismatches, { file: resumed.file, handle: resumed.handle ?? null });
  }
}

/** Pending re-pick file info, held while the mismatch table is showing a decision. */
let pendingMismatchFile = null;

/**
 Renders the mismatch table modal with Cancel / Continue / Choose Different
 File actions.
 @param {Array} mismatches - Result of diffAudiobookMetadata().
 @param {{file: File, handle: FileSystemFileHandle|null}} picked - The file under review.
*/
function showMismatchTable(mismatches, picked) {
  pendingMismatchFile = picked;
  const modal = document.getElementById("audio-mismatch-modal");
  const tbody = document.getElementById("audio-mismatch-tbody");
  tbody.innerHTML = "";

  mismatches.forEach((m) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${m.field}</td><td>${m.stored}</td><td>${m.fresh}</td>`;
    tbody.appendChild(row);
  });

  modal.style.display = "flex";
}

function closeMismatchModal() {
  document.getElementById("audio-mismatch-modal").style.display = "none";
  pendingMismatchFile = null;
}

/** "Continue" - accepts the fresh file/metadata as the new paired truth.
    FIX: actually loads the accepted file now (via activatePairedAudio).
    The old version paired the record but never called loadM4bAudio(), so
    accepting a mismatched file left the player playing whatever was loaded
    before - or nothing. */
async function handleMismatchContinue() {
  if (!pendingMismatchFile || audioPairingTargetBookId == null) return;
  const bookId = audioPairingTargetBookId;
  const file = pendingMismatchFile.file;
  const handle = pendingMismatchFile.handle;
  const metadata = await pairAudiobookFile(bookId, file, handle);
  document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? file.name}`;
  closeMismatchModal();
  await activatePairedAudio(bookId, file);
  openCalibrationModal(bookId);
}

/** "Choose Different File" - discards this pick, re-opens the file picker. */
async function handleMismatchChooseDifferent() {
  closeMismatchModal();
  await handlePairAudiobookClick();
}

// -----------------------------------------------------------------
// POSITION MAPPING (EPUB spine <-> audio chapter)
// -----------------------------------------------------------------
/*
 Pure functions, no DOM/DB access - easy to reason about and reuse from both
 the live sync loop (audio -> scroll) and trackReadingProgress() (scroll ->
 audio position write). EPUB and M4B chapters are assumed to correspond via
 a single constant integer offset, set by chapter calibration: EPUB spine
 index N corresponds to audio chapter (N - chapterOffset). This is the
 "roughly line up" assumption from the original design doc - not a full
 per-chapter manual mapping.

 percentInChapter means the same thing on both sides: how far through the
 *current* chapter, 0-1. For EPUB this is exactly innerPct as already
 computed by trackReadingProgress() (10-reader-controls.js); for audio it's
 (currentTime - chapterStartSec) / (chapterEndSec - chapterStartSec).

 CONTRACT FIX: both mappers can now return NULL when the input can't be
 mapped (missing chapter data, non-positive duration, NaN anywhere). The
 old failure modes produced concrete garbage positions instead - chapter 0
 top-of-book for the forward direction (slamming the reader to the start
 every sync tick), or NaN leaking past the Math.min/Math.max clamp idiom
 (which passes NaN straight through) into scrollBy()/seekAudio(). EVERY
 caller of mapChapterToScroll/mapScrollToChapter must null-check - known
 call sites to audit: computeSyncStepPx() and the mode-switch prompts in
 25-audio-sync.js, trackReadingProgress() in 10-reader-controls.js.
*/

/**
 Converts an audio chapter position to an EPUB scroll position.
 Supports both "chapter" (offset-based) and "whole" (percentage-based) modes.
 @param {Object} params
 @param {string} params.mode - "chapter" or "whole".
 @param {number} params.chapterOffset - Used only in "chapter" mode.
 @param {number} params.audioChapterIndex - Audio chapter index.
 @param {number} params.percentInChapter - 0-1 within that audio chapter.
 @param {Object} params.audiobook - Full audiobook record (for duration/chapters).
 @param {number[]} params.chapterWordCounts - EPUB per-chapter word counts.
 @param {number} params.totalWords - EPUB total words.
 @param {number} params.wholeBookOffset - Fractional offset for "whole" mode.
 @returns {{epubSpineIndex: number, innerPct: number}|null} Null when the
   position is unmappable (no chapter data, non-positive duration, or NaN
   input) - callers MUST handle null as "sit this tick out", never as
   chapter 0.
*/
function mapChapterToScroll({ mode, chapterOffset, audioChapterIndex, percentInChapter, audiobook, chapterWordCounts, totalWords, wholeBookOffset }) {
  if (mode === "whole") {
    const chapter = audiobook.chapters?.[audioChapterIndex];
    // FIX: was `if (!chapter) return { epubSpineIndex: 0, innerPct: 0 }` -
    // out-of-range audio chapters made the live loop yank the reader to
    // chapter 0 and HOLD it there every tick. Also guards duration<=0 and
    // NaN: `Math.min(1, Math.max(0, NaN))` is NaN, not 0 or 1, so the old
    // clamp idiom let NaN flow into the scroll target.
    if (!chapter || !(audiobook.duration > 0)) return null;
    const chapterDuration = chapter.endSec - chapter.startSec;
    const audioPct = (chapter.startSec + percentInChapter * chapterDuration) / audiobook.duration;
    if (!Number.isFinite(audioPct)) return null;
    const epubPct = Math.min(1, Math.max(0, audioPct + wholeBookOffset));
    return findEpubChapterForPct(epubPct, chapterWordCounts, totalWords);
  } else {
    // Legacy chapter-offset mode
    return {
      epubSpineIndex: audioChapterIndex + chapterOffset,
      innerPct: Math.min(1, Math.max(0, percentInChapter)),
    };
  }
}

/**
 Converts an EPUB scroll position to an audio chapter position.
 Supports both modes.
 @param {Object} params
 @param {string} params.mode - "chapter" or "whole".
 @param {number} params.chapterOffset - Used only in "chapter" mode.
 @param {number} params.epubSpineIndex - EPUB chapter index.
 @param {number} params.innerPct - 0-1 within that EPUB chapter.
 @param {Object} params.audiobook - Full audiobook record.
 @param {number[]} params.chapterWordCounts - EPUB per-chapter word counts.
 @param {number} params.totalWords - EPUB total words.
 @param {number} params.wholeBookOffset - Fractional offset for "whole" mode.
 @returns {{audioChapterIndex: number, percentInChapter: number}|null} Null when
   unmappable (same contract as mapChapterToScroll).
*/
function mapScrollToChapter({ mode, chapterOffset, epubSpineIndex, innerPct, audiobook, chapterWordCounts, totalWords, wholeBookOffset }) {
  if (mode === "whole") {
    // FIX: mirror of the forward guard - no chapters or no duration must
    // return null rather than produce NaN/garbage seconds.
    if (!audiobook.chapters?.length || !(audiobook.duration > 0)) return null;
    const epubPct = cumulativeWordPct(epubSpineIndex, innerPct, chapterWordCounts, totalWords);
    const audioPct = Math.min(1, Math.max(0, epubPct - wholeBookOffset));
    const seconds = audioPct * audiobook.duration;
    return secondsToChapterPosition(audiobook.chapters, seconds);
  } else {
    return {
      audioChapterIndex: epubSpineIndex - chapterOffset,
      percentInChapter: Math.min(1, Math.max(0, innerPct)),
    };
  }
}

/**
 Resolves an audio chapter position to an absolute seek time in seconds,
 using the audiobook's actual chapter boundaries (not just the offset math -
 this is where percentInChapter gets multiplied out against a real chapter's
 duration).

 FIX: NaN percentInChapter now returns null instead of NaN. NaN != null, so
 the old contract let NaN slip past every `!= null` check into seekAudio()
 (currentTime = NaN throws / wedges playback).

 @param {Array<{startSec: number, endSec: number}>} chapters - Audiobook chapters array.
 @param {number} audioChapterIndex - 0-indexed chapter to resolve.
 @param {number} percentInChapter - 0-1, how far through that chapter.
 @returns {number|null} Absolute seconds to seek to, or null if audioChapterIndex is out of range or input is not finite.
*/
function chapterPositionToSeconds(chapters, audioChapterIndex, percentInChapter) {
  const chapter = chapters?.[audioChapterIndex];
  if (!chapter || !Number.isFinite(percentInChapter)) return null;
  const duration = chapter.endSec - chapter.startSec;
  return chapter.startSec + percentInChapter * duration;
}

/**
 Resolves an absolute audio playback time to its chapter index + percent
 within that chapter. Inverse of chapterPositionToSeconds(). Scans linearly -
 chapter counts are small (tens, not thousands), so this is cheap enough to
 call on every sync-loop tick without needing a smarter lookup.

 FIX: NaN/Infinity currentTimeSec now returns null. It used to fall through
 findIndex into the last-chapter fallback and come back with
 percentInChapter: NaN - which then flowed into the mapping and clamps.

 @param {Array<{startSec: number, endSec: number}>} chapters - Audiobook chapters array.
 @param {number} currentTimeSec - Absolute playback position in seconds.
 @returns {{audioChapterIndex: number, percentInChapter: number}|null} Null if
   currentTimeSec falls outside every chapter (e.g. empty chapters array) or is not finite.
*/
function secondsToChapterPosition(chapters, currentTimeSec) {
  if (!chapters || chapters.length === 0 || !Number.isFinite(currentTimeSec)) return null;
  const idx = chapters.findIndex((ch) => currentTimeSec >= ch.startSec && currentTimeSec < ch.endSec);
  // Falls through to the last chapter if currentTimeSec is at/past the very
  // end of the book (findIndex misses because endSec is an exclusive bound).
  const resolvedIdx = idx !== -1 ? idx : chapters.length - 1;
  const chapter = chapters[resolvedIdx];
  const duration = chapter.endSec - chapter.startSec;
  const percentInChapter = duration > 0 ? (currentTimeSec - chapter.startSec) / duration : 0;
  return { audioChapterIndex: resolvedIdx, percentInChapter: Math.min(1, Math.max(0, percentInChapter)) };
}

// -----------------------------------------------------------------
// WHOLE-BOOK PERCENTAGE HELPERS (for syncMode "whole")
// -----------------------------------------------------------------

/**
 Resolves the EPUB word-count data that whole-mode mapping needs, for ONE
 specific book. FIX (new): whole-book percentage math is only meaningful
 against that book's own chapter lengths, and callers used to feed it
 `activeBookObject?.chapterWordCounts || []` blindly - with the wrong book
 open (or none), the empty-data fallback below divided by 1 and clamped to
 1, i.e. "end of the book". Preference: the live reader's object when it IS
 this book (freshest, matches what the sync loop uses), else the persisted
 book record - the same fallback pattern updateWholeBookCalibrationDisplay()
 already uses.

 @param {number} bookId
 @returns {Promise<{chapterWordCounts: number[], totalWords: number, chapterCount: number}|null>}
   Null when the book has no usable word data at all.
*/
async function resolveWordCountData(bookId) {
  let counts = null;
  let storedTotal = 0;

  if (activeBookObject && activeBookObject.id === bookId &&
      Array.isArray(activeBookObject.chapterWordCounts) && activeBookObject.chapterWordCounts.length) {
    counts = activeBookObject.chapterWordCounts;
    storedTotal = activeBookObject.totalWords || 0;
  } else {
    const bookRecord = await getBookById(bookId);
    if (bookRecord && Array.isArray(bookRecord.chapterWordCounts) && bookRecord.chapterWordCounts.length) {
      counts = bookRecord.chapterWordCounts;
      storedTotal = bookRecord.totalWords || 0;
    }
  }

  if (!counts) return null;
  // Derive the total from the counts themselves - a stored totalWords can be
  // missing or stale after a re-import, and the array is what the mapping
  // actually walks.
  return {
    chapterWordCounts: counts,
    totalWords: storedTotal || counts.reduce((a, b) => a + b, 0),
    chapterCount: counts.length,
  };
}

/**
 Computes the cumulative word percentage for a given EPUB spine position.
 @param {number} spineIndex - 0-indexed chapter index.
 @param {number} innerPct - 0-1 scroll fraction within that chapter.
 @param {number[]} chapterWordCounts - Per-chapter word counts.
 @param {number} totalWords - Sum of chapterWordCounts.
 @returns {number} 0-1 fraction of total words.
*/
function cumulativeWordPct(spineIndex, innerPct, chapterWordCounts, totalWords) {
  // FIX: negative spineIndex used to slice from the END of the array
  // (slice(0, -1)) and return nonsense. All current callers pass >= 0, but
  // this is a pure function - clamp instead of leaving a landmine.
  if (spineIndex < 0) return 0;
  if (!chapterWordCounts || chapterWordCounts.length === 0 || totalWords === 0) {
    // Fallback: treat chapters as equal length
    // (Callers that can't tolerate this degenerate fallback - sync seeks,
    // jump prompts - must resolve word data via resolveWordCountData() first
    // and refuse to map when it returns null.)
    const n = Math.max(1, chapterWordCounts?.length || 1);
    return (spineIndex + innerPct) / n;
  }
  const cumBefore = chapterWordCounts.slice(0, spineIndex).reduce((a, b) => a + b, 0);
  const wordsInChapter = chapterWordCounts[spineIndex] || 0;
  return (cumBefore + innerPct * wordsInChapter) / totalWords;
}

/**
 Finds the EPUB chapter and inner percentage for a given whole-book percentage.
 @param {number} pct - 0-1 whole-book fraction.
 @param {number[]} chapterWordCounts - Per-chapter word counts.
 @param {number} totalWords - Sum of chapterWordCounts.
 @returns {{epubSpineIndex: number, innerPct: number}}
*/
function findEpubChapterForPct(pct, chapterWordCounts, totalWords) {
  if (!chapterWordCounts || chapterWordCounts.length === 0 || totalWords === 0) {
    const n = Math.max(1, chapterWordCounts?.length || 1);
    const idx = Math.min(Math.floor(pct * n), n - 1);
    const inner = (pct * n) - idx;
    return { epubSpineIndex: idx, innerPct: Math.min(1, Math.max(0, inner)) };
  }
  let cumulative = 0;
  for (let i = 0; i < chapterWordCounts.length; i++) {
    const wordCount = chapterWordCounts[i];
    if (pct * totalWords < cumulative + wordCount || i === chapterWordCounts.length - 1) {
      const before = cumulative;
      // FIX: zero-word chapters (empty spine items - covers, nav pages) made
      // this 0/0 = NaN when pct landed on them (e.g. pct=1 with a zero-word
      // final chapter forced entry via the last-chapter clause). NaN then
      // survived the clamp below and reached the reader's scroll target.
      const inChapter = wordCount > 0 ? (pct * totalWords - before) / wordCount : 0;
      return { epubSpineIndex: i, innerPct: Math.min(1, Math.max(0, inChapter)) };
    }
    cumulative += wordCount;
  }
  return { epubSpineIndex: chapterWordCounts.length - 1, innerPct: 1 };
}

// -----------------------------------------------------------------
// CHAPTER CALIBRATION
// -----------------------------------------------------------------
/**
 Extracts the spine array + chapter titles for a book WITHOUT loading it
 into the reader. Calibration needs the EPUB's chapter list, but the reader
 is a whole separate context (closes any active session, swaps globals) -
 pulling the spine data locally keeps calibration self-contained.

 Uses the live reader state only when the target book happens to already
 be the one open (same data the sync loop uses, no reparse). Otherwise
 parses the EPUB directly from the book's stored fileData.

 @param {number} bookId
 @returns {Promise<{spineArray: string[], chapterTitles: string[]}|null>}
   Null when the book record or fileData is missing, or the EPUB can't be parsed.
*/
async function extractSpineAndTitlesForCalibration(bookId) {
  if (activeBookObject && activeBookObject.id === bookId && activeSpineArray.length > 0) {
    return {
      spineArray: activeSpineArray.slice(),
      chapterTitles: activeChapterTitles.slice(),
    };
  }

  const book = await getBookById(bookId);
  if (!book || !book.fileData) return null;

  try {
    const zip = await JSZip.loadAsync(book.fileData);
    const { opfDoc, baseDir } = await openEpubContainer(zip);

    const manifestItems = {};
    opfDoc.querySelectorAll("manifest > item").forEach((item) => {
      manifestItems[item.getAttribute("id")] = normalizePath(
        baseDir + item.getAttribute("href"),
      );
    });
    const spineArray = [];
    opfDoc.querySelectorAll("spine > itemref").forEach((ref) => {
      const idref = ref.getAttribute("idref");
      if (manifestItems[idref]) spineArray.push(manifestItems[idref]);
    });
    if (spineArray.length === 0) return null;

    const chapterTitles = spineArray.map((_, idx) => `Chapter ${idx + 1}`);
    const tocItem =
      opfDoc.querySelector("item[media-type='application/x-dtbncx+xml']") ||
      opfDoc.querySelector("item[properties='nav']");
    if (tocItem) {
      try {
        const tocPath = normalizePath(baseDir + tocItem.getAttribute("href"));
        const tocFileStr = await zip.file(tocPath).async("string");
        const tocDoc = new DOMParser().parseFromString(tocFileStr, "text/xml");
        tocDoc.querySelectorAll("navPoint, li").forEach((node) => {
          const labelNode = node.querySelector("navLabel > text, a, span");
          const contentNode = node.querySelector("content, a");
          if (!labelNode || !contentNode) return;
          const text = labelNode.textContent.trim();
          let href = contentNode.getAttribute("src") || contentNode.getAttribute("href");
          if (!href) return;
          href = href.split("#")[0];
          const absPath = normalizePath(baseDir + href);
          const idx = spineArray.indexOf(absPath);
          if (idx !== -1) chapterTitles[idx] = text;
        });
      } catch (e) {
        console.warn("[24-audio-pairing] TOC parse failed; falling back to default labels:", e);
      }
    }

    return { spineArray, chapterTitles };
  } catch (err) {
    console.warn("[24-audio-pairing] EPUB parse for calibration failed:", err);
    return null;
  }
}

/*
 Two-pane picker: click one EPUB chapter, click one audio chapter, save. The
 difference between their indices becomes chapterOffset. Requires the book
 to actually be open in the reader (activeSpineArray/activeChapterTitles
 populated) since that's the only place EPUB chapter titles are available -
 calibrating a book that isn't currently open just shows a message asking
 the user to open it first, rather than trying to load it separately here.
*/

let calibrationSelectedEpubIndex = null;
let calibrationSelectedAudioIndex = null;
let calibrationTargetBookId = null;

/**
 Opens the calibration modal for a book, populating both chapter lists.
 @param {number} bookId - id of the book to calibrate.
*/
async function openCalibrationModal(bookId) {
  if (bookId == null) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  calibrationTargetBookId = bookId;
  calibrationSelectedEpubIndex = null;
  calibrationSelectedAudioIndex = null;

  const epubList = document.getElementById("calibration-epub-list");
  const audioList = document.getElementById("calibration-audio-list");
  const statusEl = document.getElementById("calibration-status");

  // Audio list is self-contained - populate immediately.
  audioList.innerHTML = "";
  audiobook.chapters.forEach((ch, idx) => {
    const row = document.createElement("div");
    row.textContent = `${idx + 1}. ${ch.title ?? `Chapter ${idx + 1}`}`;
    row.style.cursor = "pointer";
    row.onclick = () => selectCalibrationAudioChapter(idx, row);
    audioList.appendChild(row);
  });

  // EPUB list needs a parse - show a loading state, then fill in.
  epubList.innerHTML = "<p>Loading EPUB chapters…</p>";
  statusEl.textContent = "";
  document.getElementById("audio-calibration-modal").style.display = "flex";

  const extracted = await extractSpineAndTitlesForCalibration(bookId);
  if (!extracted) {
    epubList.innerHTML = "<p>Couldn't read this book's EPUB structure. The file may be missing or corrupted.</p>";
    return;
  }

  epubList.innerHTML = "";
  extracted.spineArray.forEach((_, idx) => {
    const row = document.createElement("div");
    row.textContent = `${idx + 1}. ${extracted.chapterTitles[idx] ?? `Chapter ${idx + 1}`}`;
    row.style.cursor = "pointer";
    row.onclick = () => selectCalibrationEpubChapter(idx, row);
    epubList.appendChild(row);
  });

  statusEl.textContent = "Select one chapter from each side.";
}
/**
 Marks an EPUB chapter row as selected (visually and in state). Deselects
 any previously-selected row in the same list first, so only one can be
 active at a time.
 @param {number} idx - 0-indexed spine position clicked.
 @param {HTMLElement} rowEl - The clicked row, for highlight styling.
*/
function selectCalibrationEpubChapter(idx, rowEl) {
  document.querySelectorAll("#calibration-epub-list > div").forEach((el) => (el.style.fontWeight = "normal"));
  rowEl.style.fontWeight = "bold";
  calibrationSelectedEpubIndex = idx;
  updateCalibrationStatus();
}

/**
 Marks an audio chapter row as selected. Same single-selection behavior as
 selectCalibrationEpubChapter().
 @param {number} idx - 0-indexed audio chapter clicked.
 @param {HTMLElement} rowEl - The clicked row, for highlight styling.
*/
function selectCalibrationAudioChapter(idx, rowEl) {
  document.querySelectorAll("#calibration-audio-list > div").forEach((el) => (el.style.fontWeight = "normal"));
  rowEl.style.fontWeight = "bold";
  calibrationSelectedAudioIndex = idx;
  updateCalibrationStatus();
}

function updateCalibrationStatus() {
  const statusEl = document.getElementById("calibration-status");
  if (calibrationSelectedEpubIndex == null || calibrationSelectedAudioIndex == null) {
    statusEl.textContent = "Select one chapter from each side.";
  } else {
    statusEl.textContent = `EPUB chapter ${calibrationSelectedEpubIndex + 1} = Audio chapter ${calibrationSelectedAudioIndex + 1}`;
  }
}

function closeCalibrationModal() {
  document.getElementById("audio-calibration-modal").style.display = "none";
  calibrationTargetBookId = null;
}

// -----------------------------------------------------------------
// WHOLE-BOOK CALIBRATION UI
// -----------------------------------------------------------------

let calibrationWholeEpubPct = null;
let calibrationWholeAudioPct = null;
let calibrationWholeTargetBookId = null;

/**
 Opens the whole-book calibration UI inside the pairing panel.
 Reads current positions from the active reader and audio.
*/
async function openWholeBookCalibration() {
  if (!audioPairingTargetBookId) return;
  const bookId = audioPairingTargetBookId;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  calibrationWholeTargetBookId = bookId;
  calibrationWholeEpubPct = null;
  calibrationWholeAudioPct = null;
  await updateWholeBookCalibrationDisplay();
}

/**
 Updates the EPUB and Audio percentage display in the pairing panel.
 Also shows the current offset.
*/
async function updateWholeBookCalibrationDisplay() {
  const bookId = audioPairingTargetBookId;
  if (!bookId) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  let epubPct = null;
  let audioPct = null;

  // Try live reader first
  if (activeBookObject && activeBookObject.id === bookId && activeSpineArray.length > 0) {
    const totalWords = activeBookObject.totalWords || 0;
    const chapterWordCounts = activeBookObject.chapterWordCounts || [];
    const container = document.getElementById("reader-container");
    const maxScroll = container ? container.scrollHeight - container.clientHeight : 0;
    const innerPct = maxScroll > 0 ? container.scrollTop / maxScroll : 0;
    epubPct = cumulativeWordPct(activeSpinePointer, innerPct, chapterWordCounts, totalWords);
  } else {
    const bookRecord = await getBookById(bookId);
    if (bookRecord) {
      const totalWords = bookRecord.totalWords || 0;
      const chapterWordCounts = bookRecord.chapterWordCounts || [];
      const currentChapter = bookRecord.currentChapter || 0;
      const scrollOffset = bookRecord.scrollOffset || 0;
      epubPct = cumulativeWordPct(currentChapter, scrollOffset, chapterWordCounts, totalWords);
    }
  }

  if (activeAudioElement && audiobook) {
    audioPct = activeAudioElement.currentTime / audiobook.duration;
  }

  // --- ALWAYS update the offset display, regardless of whether percentages are available ---
  const currentOffset = audiobook.wholeBookOffset || 0;
  const offsetPercent = (currentOffset * 100).toFixed(2);
  let direction;
  if (currentOffset > 0.0001) direction = "EPUB is ahead";
  else if (currentOffset < -0.0001) direction = "Audio is ahead";
  else direction = "aligned";
  document.getElementById("whole-offset-display").textContent = `Offset: ${offsetPercent}% (${direction})`;

  // Update status line (percentages if available)
  const statusEl = document.getElementById("whole-calibration-status");
  if (epubPct !== null && audioPct !== null) {
    statusEl.textContent = `📖 EPUB: ${(epubPct * 100).toFixed(2)}%  |  🎧 Audio: ${(audioPct * 100).toFixed(2)}%`;
  } else {
    statusEl.textContent = "Open the book and load audio to see percentages.";
  }
}

/**
 Sets the EPUB reference percentage for whole-book calibration.
 FIX: reads the LIVE reader position when this book is open (the same source
 updateWholeBookCalibrationDisplay() shows) instead of unconditionally using
 the persisted record - the on-screen percentage and the calibrated value
 used to come from different sources, baking any un-persisted scroll into
 wholeBookOffset. Falls back to the stored record when the book isn't open,
 which is what makes calibrating from the library view work at all.
*/
async function setWholeCalibrationEpub() {
  if (!audioPairingTargetBookId) return;
  const bookId = audioPairingTargetBookId;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) {
    alert("Audiobook record not found.");
    return;
  }

  let spineIndex, innerPct;
  let totalWords = 0;
  let chapterWordCounts = [];

  if (activeBookObject && activeBookObject.id === bookId &&
      Array.isArray(activeBookObject.chapterWordCounts) && activeBookObject.chapterWordCounts.length) {
    // Live reader – use its data
    totalWords = activeBookObject.totalWords || 0;
    chapterWordCounts = activeBookObject.chapterWordCounts;
    const container = document.getElementById("reader-container");
    const maxScroll = container ? container.scrollHeight - container.clientHeight : 0;
    spineIndex = activeSpinePointer;
    innerPct = maxScroll > 0 ? container.scrollTop / maxScroll : 0;
  } else {
    // Fallback to persisted record – use ITS data, not the active book's
    const bookRecord = await getBookById(bookId);
    if (!bookRecord) {
      alert("Book record not found.");
      return;
    }
    spineIndex = bookRecord.currentChapter || 0;
    innerPct = bookRecord.scrollOffset || 0;
    totalWords = bookRecord.totalWords || 0;
    chapterWordCounts = Array.isArray(bookRecord.chapterWordCounts) ? bookRecord.chapterWordCounts : [];
  }

  calibrationWholeEpubPct = cumulativeWordPct(spineIndex, innerPct, chapterWordCounts, totalWords);
  document.getElementById("whole-calibration-status-text").textContent = "EPUB reference set.";
  checkWholeCalibrationReady();
}

/**
 Sets the Audio reference percentage for whole-book calibration.
*/
async function setWholeCalibrationAudio() {
  if (!audioPairingTargetBookId) return;
  const audiobook = await getAudiobookForBook(audioPairingTargetBookId);
  if (!audiobook) return;
  if (activeAudioElement) {
    calibrationWholeAudioPct = activeAudioElement.currentTime / audiobook.duration;
    document.getElementById("whole-calibration-status-text").textContent = "Audio reference set.";
  } else {
    alert("Please load and play audio first.");
  }
  checkWholeCalibrationReady();
}

function checkWholeCalibrationReady() {
  if (calibrationWholeEpubPct !== null && calibrationWholeAudioPct !== null) {
    document.getElementById("whole-save-offset-btn").disabled = false;
    document.getElementById("whole-calibration-status-text").textContent =
      "EPUB + Audio references set - ready to save offset.";
  }
}

/**
 Saves the calculated offset from the two reference points.
*/
async function saveWholeCalibrationOffset() {
  if (!audioPairingTargetBookId) return;
  if (calibrationWholeEpubPct === null || calibrationWholeAudioPct === null) return;
  const offset = calibrationWholeEpubPct - calibrationWholeAudioPct;
  await setAudiobookSyncMode(audioPairingTargetBookId, "whole", offset);
  await updateWholeBookCalibrationDisplay();
  // Assignment, not +=: updateWholeBookCalibrationDisplay() already rewrote
  // the line above; concatenating onto it accumulated across saves.
  document.getElementById("whole-calibration-status-text").textContent = `Offset saved: ${(offset * 100).toFixed(2)}%`;
  calibrationWholeEpubPct = null;
  calibrationWholeAudioPct = null;
  document.getElementById("whole-save-offset-btn").disabled = true;
}

/**
 Resets the offset to 0. FIX: added the missing target guard (every neighbor
 has one; this could run with the panel closed and a stale/null target).
*/
async function resetWholeCalibrationOffset() {
  if (!audioPairingTargetBookId) return;
  await setAudiobookSyncMode(audioPairingTargetBookId, "whole", 0);
  await updateWholeBookCalibrationDisplay();
  document.getElementById("whole-calibration-status").textContent = "Offset reset to 0.";
}

/**
 Handler for the sync mode selection buttons (Chapter / Whole).
 FIX: preserves wholeBookOffset on BOTH transitions. The old code passed 0
 when switching to "chapter", which (given setAudiobookSyncMode()'s
 signature) wiped the user's calibrated whole offset on a
 whole -> chapter -> whole round trip, forcing full recalibration.
*/
async function selectSyncMode(mode) {
  const bookId = audioPairingTargetBookId;
  if (!bookId) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  if (audiobook.syncMode === mode) return;
  await setAudiobookSyncMode(bookId, mode, audiobook.wholeBookOffset || 0);
  openAudioPairingPanel(bookId);
}

/**
 Saves the calibration: computes chapterOffset from the two selected
 indices and persists it via setAudiobookChapterOffset().
 FIX: if no sync mode has been picked yet, defaults it to "chapter" - the
 user just calibrated chapter alignment, and sync refuses to run without a
 mode, so the saved offset was previously unusable until they also clicked a
 mode button. An already-set mode is NEVER overridden (calibrating chapters
 while in "whole" mode must not silently flip the mode).
*/
async function submitCalibration() {
  if (calibrationSelectedEpubIndex == null || calibrationSelectedAudioIndex == null) return;
  const bookId = calibrationTargetBookId;
  const offset = calibrationSelectedEpubIndex - calibrationSelectedAudioIndex;
  await setAudiobookChapterOffset(bookId, offset);
  const audiobook = await getAudiobookForBook(bookId);
  if (audiobook && !audiobook.syncMode) {
    await setAudiobookSyncMode(bookId, "chapter", audiobook.wholeBookOffset || 0);
  }
  closeCalibrationModal();
}

// -----------------------------------------------------------------
// LISTENING POSITION SNAPSHOT
// -----------------------------------------------------------------
/*
 Writes a listening-side position into STORE_AUDIO_SYNC_POSITION, the same
 store trackReadingProgress() (10-reader-controls.js) writes the reading
 side into - see updateAudioSyncPosition() (02-db.js). Without this, the
 mode-switch prompts have nothing to ever compare against, since the store
 stays permanently empty.

 Phase 2 scope only: a snapshot taken on pause/seek, not continuous tracking
 (that's Phase 3's live sync loop, which will replace/extend this with a
 write on every tick instead of only these discrete moments).
*/

/**
 Snapshots the current audio position for a paired book. Silently does
 nothing if the book isn't paired or nothing is loaded - callers don't need
 to check first.
 @param {number} bookId - id of the book whose audio position to record.
*/
async function recordListeningPosition(bookId) {
  if (bookId == null || !activeAudioElement) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  const chapterPos = secondsToChapterPosition(audiobook.chapters, activeAudioElement.currentTime);
  if (!chapterPos) return;

  await updateAudioSyncPosition(bookId, {
    chapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
    lastMode: "listening",
  });
}

// -----------------------------------------------------------------
// ACTIVE BOOK PAIRING CACHE
// -----------------------------------------------------------------
/*
 In-memory only (never persisted) - lets trackReadingProgress()
 (10-reader-controls.js), which fires on every scroll event, skip the
 STORE_AUDIO_SYNC_POSITION write for unpaired books without an async DB
 read on every tick. No second source of truth to keep in sync: this is
 just a cache of what STORE_AUDIOBOOKS already says, refreshed whenever a
 book opens or its pairing changes, never written to independently.
*/

/** bookId of the currently open book if it's audio-paired, else null. Read by trackReadingProgress(). */
let activeBookAudioPairingCache = null;

/**
 Refreshes the cache for the book currently open in the reader. Call
 whenever a book opens (launchEpubReader()) or whenever pairing state for
 the active book might have changed (after a fresh pair, mismatch-continue,
 or resume - anywhere pairAudiobookFile() runs for the active book). All of
 those now go through activatePairedAudio(), which calls this - call sites
 can no longer forget it (the resume path used to).
 @param {number} bookId - id of the book to check.
*/
async function refreshActiveBookAudioPairingCache(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  activeBookAudioPairingCache = audiobook ? bookId : null;
}

/**
 Restores the audio to its own last recorded listening position (not a
 cross-mode sync - just "continue where this file itself left off"). Called
 by activatePairedAudio() on every successful load, before the cross-mode
 prompt, so resuming a listening session picks up mid-chapter rather than
 always restarting at 0:00. No-op (and no prompt) if no listening position
 was ever recorded.

 @param {number} bookId - id of the book whose audio just loaded.
*/
async function restoreOwnListeningPosition(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !activeAudioElement) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position) return;

  let seconds;
  if (position.lastMode === "listening") {
    seconds = chapterPositionToSeconds(
      audiobook.chapters, position.chapterIndex, position.percentInChapter
    );
  } else {
    const chapterPos = mapScrollToChapter({
      mode: audiobook.syncMode || "chapter",
      chapterOffset: resolveChapterOffset(audiobook),
      epubSpineIndex: position.chapterIndex,
      innerPct: position.percentInChapter,
      audiobook,
      chapterWordCounts: [],
      totalWords: 0,
      wholeBookOffset: audiobook.wholeBookOffset || 0,
    });
    if (!chapterPos) return;
    seconds = chapterPositionToSeconds(
      audiobook.chapters, chapterPos.audioChapterIndex, chapterPos.percentInChapter
    );
  }

  if (seconds != null && Number.isFinite(seconds) && seconds > 1) seekAudio(seconds);
}

// -----------------------------------------------------------------
// PAIRING PANEL & FLOATING PANEL POSITION DISPLAY
// -----------------------------------------------------------------
/*
 Live chapter/time readout, driven by the <audio> element's native
 'timeupdate' event (fires ~4x/sec during playback) rather than a separate
 polling loop - cheap, and exactly what the event exists for.

 Two display targets share one update: the pairing panel's readout and the
 reader's floating panel (index.html). Writing both from a single fetch/calc
 pass avoids duplicating the chapter-lookup logic - each target is just a
 set of element IDs, written to only if those elements actually exist, so
 whichever panel isn't currently in the DOM/visible is silently skipped
 rather than erroring. Phase 6's fuller player replaces the pairing-panel
 target entirely; the floating-panel target is expected to stay.
*/

/**
 FIX (new): the currently-attached timeupdate handler. attachAudioPositionDisplay()
 used to assume "a fresh load means a fresh <audio> element" - an assumption
 about loadM4bAudio() in 23-audio-player.js. If that ever reuses one element
 (common), every pair/resume stacked another listener and the STALE closures
 kept writing the OLD book's chapter readout against the NEW audio's
 currentTime. Removing the previous handler first is correct under either
 implementation (removing a foreign handler is a harmless no-op).
*/
let audioPositionDisplayHandler = null;

/**
 Attaches the position-display update to the currently loaded audio
 element. Call once per load (activatePairedAudio() does it). Safe to call
 repeatedly - the previous handler is always removed first, so listeners
 can never stack regardless of whether loadM4bAudio() reuses the element.
 @param {number} bookId - id of the book whose audio is loaded, for chapter lookups.
*/
function attachAudioPositionDisplay(bookId) {
  if (!activeAudioElement) return;
  if (audioPositionDisplayHandler) {
    activeAudioElement.removeEventListener("timeupdate", audioPositionDisplayHandler);
  }
  audioPositionDisplayHandler = () => updateAudioPositionDisplay(bookId);
  activeAudioElement.addEventListener("timeupdate", audioPositionDisplayHandler);
}

/**
 Writes a computed chapter/time readout into one set of display elements.
 Each id is optional - missing elements (the panel isn't in the DOM, or
 this target doesn't show all three fields) are silently skipped.
 @param {Object} ids - {chapterId, chapterTimeId, totalTimeId}, each an element id or omitted.
 @param {Object|null} chapterPos - {audioChapterIndex, percentInChapter} from secondsToChapterPosition(), or null.
 @param {Object} audiobook - The paired audiobook record.
 @param {number} currentTime - Current playback position in seconds.
*/
function writeAudioPositionDisplay(ids, chapterPos, audiobook, currentTime) {
  const chapterDisplay = ids.chapterId && document.getElementById(ids.chapterId);
  const chapterTimeDisplay = ids.chapterTimeId && document.getElementById(ids.chapterTimeId);
  const totalTimeDisplay = ids.totalTimeId && document.getElementById(ids.totalTimeId);

  if (chapterPos) {
    const chapter = audiobook.chapters[chapterPos.audioChapterIndex];
    const timeIntoChapter = currentTime - chapter.startSec;
    const chapterDuration = chapter.endSec - chapter.startSec;
    if (chapterDisplay) chapterDisplay.textContent = `${chapterPos.audioChapterIndex + 1}/${audiobook.chapters.length}`;
    if (chapterTimeDisplay) chapterTimeDisplay.textContent = `${formatTime(timeIntoChapter)}/${formatTime(chapterDuration)}`;
  }
  if (totalTimeDisplay) totalTimeDisplay.textContent = `${formatTime(currentTime)}/${formatTime(audiobook.duration)}`;
}

/**
 One-shot refresh of every known position display, called on every
 'timeupdate' tick. Looks up chapters fresh each time rather than caching
 them, since that's a cheap in-memory read (getAudiobookForBook still
 touches IndexedDB, so this trades a small async cost for never risking a
 stale chapters array after a recalibration or re-pair).
 @param {number} bookId
*/
async function updateAudioPositionDisplay(bookId) {
  if (!activeAudioElement) return;
  let audiobook = cachedAudioDisplayBook?.bookId === bookId ? cachedAudioDisplayBook.audiobook : null;
  if (!audiobook) {
      audiobook = await getAudiobookForBook(bookId);
      cachedAudioDisplayBook = { bookId, audiobook };
  }
  if (!audiobook) return;

  const currentTime = activeAudioElement.currentTime;
  const chapterPos = secondsToChapterPosition(audiobook.chapters, currentTime);

  writeAudioPositionDisplay(
    { chapterId: "audio-pairing-chapter-display", chapterTimeId: "audio-pairing-chapter-time-display", totalTimeId: "audio-pairing-total-time-display" },
    chapterPos, audiobook, currentTime,
  );
  writeAudioPositionDisplay(
    { chapterId: "audio-floating-chapter-display", chapterTimeId: "audio-floating-chapter-time-display", totalTimeId: "audio-floating-total-time-display" },
    chapterPos, audiobook, currentTime,
  );
}

/**
 Adjusts the offset for the whole book calibration.
 @param {number} delta - The amount to adjust the offset by (positive or negative).
*/
async function adjustWholeBookOffset(delta) {
  const bookId = audioPairingTargetBookId;
  if (!bookId) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  const newOffset = (audiobook.wholeBookOffset || 0) + delta;
  await setAudiobookSyncMode(bookId, "whole", newOffset);
  await updateWholeBookCalibrationDisplay();
}