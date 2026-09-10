// -----------------------------------------------------------------
// M4B AUDIO PLAYBACK
// -----------------------------------------------------------------
/*
 Thin wrapper around a plain <audio> element. Phase 0 scope only: load an M4B
 blob and provide play/pause/seek/speed. No chapter-aware seeking, no
 EPUB sync, no position persistence yet - those build on top of this in
 later steps.

 Follows the same object-URL loading pattern as the EPUB side (JSZip blobs
 re-wrapped with an explicit MIME type - see 09-epub-reader.js): create an
 object URL from the raw file/blob and hand that to <audio> directly, since
 browsers play M4B natively without needing it unpacked first.
*/

let activeAudioElement = null;
let activeAudioObjectUrl = null;

let lastListeningPositionRecordTime = 0;
const LISTENING_POSITION_RECORD_INTERVAL_MS = 5000; // record at most every 5 seconds during playback

/**
 Loads an M4B file into a fresh <audio> element, replacing any previously
 loaded one. Revokes the prior object URL (if any) to avoid leaking memory
 across repeated loads within the same session.

 @param {File|Blob} file - The M4B file to load.
 @returns {HTMLAudioElement} The audio element, ready for playAudio()/pauseAudio() etc.
   once its 'loadedmetadata' event fires.
*/
function loadM4bAudio(file) {
  if (activeAudioObjectUrl) {
    URL.revokeObjectURL(activeAudioObjectUrl);
  }
  if (activeAudioElement) {
    activeAudioElement.pause();
  }

  activeAudioObjectUrl = URL.createObjectURL(file);
  activeAudioElement = new Audio(activeAudioObjectUrl);
  activeAudioElement.preload = "metadata";

  // Attach timeupdate listener to record position periodically while playing
  activeAudioElement.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - lastListeningPositionRecordTime >= LISTENING_POSITION_RECORD_INTERVAL_MS) {
          lastListeningPositionRecordTime = now;
          // Only record if we have an active book
          if (activeBookObject && activeBookObject.id) {
              recordListeningPosition(activeBookObject.id);
          }
      }
  });

  activeAudioElement.onerror = () => {
    console.error("[23-audio-player] Audio element error:", activeAudioElement.error);
  };

  if (typeof attachListeningEventListeners === 'function') {
    attachListeningEventListeners();
  }

  return activeAudioElement;
}

/**
 Starts/resumes playback of the currently loaded audio.
 @returns {Promise<void>|undefined} The play() promise, or undefined if nothing is loaded.
*/
function playAudio() {
  if (!activeAudioElement) return undefined;
  if (activeBookObject && typeof recordListeningPosition === 'function') {
    recordListeningPosition(activeBookObject.id);
  }
  return activeAudioElement.play();
}

/**
 Pauses the currently loaded audio. No-op if nothing is loaded.
 Pushes the current listening position to the cloud if an active book is set.
*/
function pauseAudio() {
    if (!activeAudioElement) return;
    activeAudioElement.pause();
    if (activeBookObject && activeBookObject.id) {
        recordListeningPosition(activeBookObject.id, { forceCloudPush: true });
    }
}

/**
 Seeks the currently loaded audio to an absolute time.
 @param {number} seconds - Target playback position in seconds.
*/
function seekAudio(seconds) {
  if (!activeAudioElement) return;
  activeAudioElement.currentTime = Math.max(0, seconds);
}

/**
 Seeks to the start of a given chapter. Same mechanism as seekAudio() -
 look up the chapter's start time, seek there - just resolved from a
 chapters array instead of a raw second value handed in directly.

 @param {Array<{title: string, startSec: number, endSec: number}>} chapters - Chapter list, e.g. from a paired audiobook's stored metadata.
 @param {number} chapterIndex - 0-indexed chapter to jump to.
*/
function seekToChapter(chapters, chapterIndex) {
  const chapter = chapters?.[chapterIndex];
  if (!chapter) return;
  seekAudio(chapter.startSec);
}

/**
 Sets playback speed on the currently loaded audio.
 @param {number} rate - Playback rate multiplier (e.g. 1.0, 1.5, 2.0).
*/
function setAudioSpeed(rate) {
  if (!activeAudioElement) return;
  activeAudioElement.playbackRate = rate;
}

/**
 Sets volume on the currently loaded audio.
  @param {number} volume - Volume level from 0.0 (silent) to 1.0 (full).
*/
function setAudioVolume(volume) {
  if (!activeAudioElement) return;
  activeAudioElement.volume = Math.min(Math.max(volume, 0), 1);
}
/**
 Releases the currently loaded audio element and its object URL. Call when
 leaving the audio player context entirely (not for pause - see the
 IDEA doc: stopping playback is the intended way to end auto-scroll,
 which is separate from unloading).
*/
function unloadM4bAudio() {
  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.src = "";
  }
  if (activeAudioObjectUrl) {
    URL.revokeObjectURL(activeAudioObjectUrl);
  }
  activeAudioElement = null;
  activeAudioObjectUrl = null;
}

// -----------------------------------------------------------------
// TEMPORARY DEBUG HARNESS (Phase 0 test milestone)
// -----------------------------------------------------------------
/*
 Wires the file input in the "🔧 Audio Debug" panel (index.html) to
 extractM4bMetadata() and loadM4bAudio() so parsing/playback can be sanity
 checked without opening devtools. No pairing, no persistence - delete
 this section (and the matching HTML block) once the real pairing UI lands.
*/

function audioDebugLog(msg) {
  const out = document.getElementById("audio-debug-output");
  if (out) out.textContent += msg + "\n";
  console.log(msg);
}

async function handleAudioDebugFileSelect(event) {
  const file = event.target.files[0];
  const out = document.getElementById("audio-debug-output");
  if (out) out.textContent = "";
  if (!file) return;

  audioDebugLog(`Loading: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

  try {
    const meta = await extractM4bMetadata(file);
    audioDebugLog(`Duration: ${meta.duration.toFixed(1)}s`);
    audioDebugLog(`Title: ${meta.title ?? "(none)"}`);
    audioDebugLog(`Author: ${meta.author ?? "(none)"}`);
    audioDebugLog(`Cover art: ${meta.coverArt ? "present" : "(none)"}`);
    audioDebugLog(`Chapters (${meta.chapters.length}):`);
    meta.chapters.forEach((ch, i) => {
      audioDebugLog(`  ${i + 1}. ${ch.title ?? "(untitled)"} — ${ch.startSec.toFixed(1)}s to ${ch.endSec.toFixed(1)}s`);
    });
  } catch (err) {
    audioDebugLog(`Metadata extraction failed: ${err.message}`);
    console.error(err);
  }

  try {
    loadM4bAudio(file);
    audioDebugLog("Audio loaded, ready for play/pause/seek.");
  } catch (err) {
    audioDebugLog(`Audio load failed: ${err.message}`);
    console.error(err);
  }
}

function audioDebugPlay() {
  playAudio()?.catch((err) => audioDebugLog(`Play failed: ${err.message}`));
}

function audioDebugPause() {
  pauseAudio();
  audioDebugLog("Paused.");
}

function audioDebugSeek() {
  const input = document.getElementById("audio-debug-seek-input");
  const seconds = Number(input?.value) || 0;
  seekAudio(seconds);
  audioDebugLog(`Seeked to ${seconds}s.`);
}