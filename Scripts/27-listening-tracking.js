// =================================================================
// LISTENING SESSION TRACKING
// =================================================================
/*
  Parallel to the reading timer (09-epub-reader.js / 10-reader-controls.js)
  but driven by audio playback events.

  Listens to 'play', 'pause', 'ended', and 'timeupdate' on the active
  audio element. Uses the same inactivity timeout and pause‑split
  thresholds as reading, so both modes share the same user expectations.
*/

// -----------------------------------------------------------------
// STATE
// -----------------------------------------------------------------
let listeningSessionStartTime = null;          // when the current listening session started (or last resumed)
let listeningLastInteractionTime = null;       // last time we recorded activity (play, seek, etc.)
let listeningPausedMs = 0;                     // total accumulated paused time during this session (manual pauses)
let listeningPauseStartTime = null;            // when the current pause began (if paused)
let listeningHeartbeatInterval = null;         // interval handle for the heartbeat tick
let currentListeningBookId = null;             // book being listened to (to avoid mismatches)

// -----------------------------------------------------------------
// SESSION LIFECYCLE
// -----------------------------------------------------------------

/**
  Starts a new listening session or resumes the current one.
  Called on audio 'play' event.
  @param {number} bookId - The book being listened to.
*/
function startListeningSession(bookId) {
  if (!bookId) return;
  const now = Date.now();

  // If we're already tracking a different book, end that session first.
  if (currentListeningBookId && currentListeningBookId !== bookId) {
    endListeningSession('bookSwitch');
  }

  currentListeningBookId = bookId;

  // If we have no session or it was ended, start fresh.
  if (listeningSessionStartTime === null) {
    listeningSessionStartTime = now;
    listeningPausedMs = 0;
    // Record firstOpened/lastOpened (shared with reading)
    if (typeof recordReadingSessionStart === 'function') {
      recordReadingSessionStart(bookId);
    }
  } else {
    // Resuming after a pause: compute how long we were paused.
    if (listeningPauseStartTime !== null) {
      const pauseDuration = now - listeningPauseStartTime;
      if (pauseDuration > Config.Reading.PAUSE_SPLIT_THRESHOLD_MS) {
        // Long pause → split the session.
        endListeningSession('pauseSplit', listeningPauseStartTime);
        currentListeningBookId = bookId;
        // Start a new session now.
        listeningSessionStartTime = now;
        listeningPausedMs = 0;
        if (typeof recordReadingSessionStart === 'function') {
          recordReadingSessionStart(bookId);
        }
      } else {
        // Short pause: add to paused accumulator and clear pause start.
        listeningPausedMs += pauseDuration;
        listeningPauseStartTime = null;
      }
    }
  }

  listeningLastInteractionTime = now;

  // Ensure the heartbeat is running.
  startListeningHeartbeat();
}

/**
  Pauses the current listening session (manual pause, e.g. user presses pause).
  Called on audio 'pause' event.
*/
function pauseListeningSession() {
  if (listeningSessionStartTime === null) return;
  // If already paused, just update the pause start time.
  if (listeningPauseStartTime === null) {
    listeningPauseStartTime = Date.now();
  }
  // The heartbeat will still run, but we won't accumulate time while paused.
  // We'll stop adding time inside the heartbeat when pauseStart is set.
}

/**
  Ends the current listening session and persists it.
  @param {string} reason - Log reason (e.g. 'inactivity', 'unload', 'bookSwitch').
  @param {number} [asOfTime=Date.now()] - End time (for retroactive splits).
*/
function endListeningSession(reason, asOfTime = Date.now()) {
  if (listeningSessionStartTime === null || !currentListeningBookId) {
    // Reset everything.
    listeningSessionStartTime = null;
    listeningLastInteractionTime = null;
    listeningPausedMs = 0;
    listeningPauseStartTime = null;
    currentListeningBookId = null;
    stopListeningHeartbeat();
    return;
  }

  const endTime = asOfTime;
  // Total duration = (end - start) - total paused time.
  let totalPausedMs = listeningPausedMs;
  // If we're currently paused, add the pause duration up to endTime.
  if (listeningPauseStartTime !== null && endTime >= listeningPauseStartTime) {
    totalPausedMs += (endTime - listeningPauseStartTime);
  }
  const durationSeconds = Math.max(0, Math.round((endTime - listeningSessionStartTime - totalPausedMs) / 1000));

  // Minimum threshold: discard very short sessions.
  if (durationSeconds < Config.Reading.MIN_MEANINGFUL_TRACKED_SECONDS) {
    // Reset and return.
    listeningSessionStartTime = null;
    listeningLastInteractionTime = null;
    listeningPausedMs = 0;
    listeningPauseStartTime = null;
    currentListeningBookId = null;
    stopListeningHeartbeat();
    return;
  }

  // Build the session record. No pages read.
  const sessionRecord = {
    start: listeningSessionStartTime,
    end: endTime,
    durationSeconds: durationSeconds,
    pagesRead: 0, // listening has no pages, but keep field for compatibility
    timestamp: endTime,
  };

  // Persist via the wrapper.
  if (typeof appendListeningSession === 'function') {
    appendListeningSession(currentListeningBookId, sessionRecord);
  }

  // Reset state.
  listeningSessionStartTime = null;
  listeningLastInteractionTime = null;
  listeningPausedMs = 0;
  listeningPauseStartTime = null;
  currentListeningBookId = null;
  stopListeningHeartbeat();
}

/**
  Checks if the user has been inactive for too long (no play/pause/seek events).
  If so, ends the session.
*/
function checkListeningInactivity() {
  if (listeningSessionStartTime === null) return;
  if (listeningPauseStartTime !== null) {
    // If we're paused, we don't want to end due to inactivity – the user is away.
    // But we might want to end if the pause is very long? The pause-split logic already handles that on resume.
    return;
  }
  const now = Date.now();
  const idleFor = now - listeningLastInteractionTime;
  if (idleFor >= Config.Reading.SESSION_INACTIVITY_TIMEOUT_MS) {
    endListeningSession('inactivity');
  }
}

// -----------------------------------------------------------------
// HEARTBEAT
// -----------------------------------------------------------------

/**
  Starts the heartbeat interval that ticks every TRACKING_TICK_MS.
  Accumulates time and checks inactivity.
*/
function startListeningHeartbeat() {
  if (listeningHeartbeatInterval) return;
  listeningHeartbeatInterval = setInterval(() => {
    // Refresh interaction time while audio is actively playing, so a long
    // stretch of continuous listening doesn't trip the inactivity timeout.
    if (listeningSessionStartTime !== null && listeningPauseStartTime === null) {
      if (activeAudioElement && !activeAudioElement.paused) {
        listeningLastInteractionTime = Date.now();
      }
    }
    checkListeningInactivity();
  }, Config.Reading.TRACKING_TICK_MS);
}
/**
  Stops the heartbeat interval.
*/
function stopListeningHeartbeat() {
  if (listeningHeartbeatInterval) {
    clearInterval(listeningHeartbeatInterval);
    listeningHeartbeatInterval = null;
  }
}

// -----------------------------------------------------------------
// AUDIO EVENT HOOKS (to be called from 23-audio-player.js)
// -----------------------------------------------------------------

/**
  Call this when the audio element is created or when a new book is loaded.
  Sets up listeners for play/pause/ended/timeupdate.
  We'll call it from loadM4bAudio after setting activeAudioElement.
*/
function attachListeningEventListeners() {
  if (!activeAudioElement) return;
  // Remove any previous listeners to avoid duplicates (if we reload audio).
  activeAudioElement.removeEventListener('play', onAudioPlay);
  activeAudioElement.removeEventListener('pause', onAudioPause);
  activeAudioElement.removeEventListener('ended', onAudioEnded);
  activeAudioElement.removeEventListener('seeked', onAudioSeeked);

  activeAudioElement.addEventListener('play', onAudioPlay);
  activeAudioElement.addEventListener('pause', onAudioPause);
  activeAudioElement.addEventListener('ended', onAudioEnded);
  activeAudioElement.addEventListener('seeked', onAudioSeeked);
}

function onAudioPlay() {
  // If we have an active book, start/resume session.
  if (activeBookObject && activeBookObject.id) {
    startListeningSession(activeBookObject.id);
    // Also record the listening position (already done via timeupdate).
  }
}

function onAudioPause() {
  pauseListeningSession();
  // Record final position (already done in pauseAudio).
}

function onAudioEnded() {
  // Mark the book as read if not already.
  if (activeBookObject && activeBookObject.id) {
    if (typeof markBookAsRead === 'function') {
      markBookAsRead(activeBookObject.id);
    }
  }
  // End the listening session.
  endListeningSession('completed');
}

function onAudioSeeked() {
  // User manually seeked; update last interaction time.
  if (listeningSessionStartTime !== null) {
    listeningLastInteractionTime = Date.now();
  }
  // Record position (already done via timeupdate).
}

// -----------------------------------------------------------------
// VISIBILITY CHANGE / UNLOAD
// -----------------------------------------------------------------

// Handle tab visibility changes – pause when hidden, resume when visible.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause listening session if it's active? The audio will likely be paused by the browser.
    // But we can call pauseListeningSession() to ensure we account for the gap.
    // However, the audio element might still be playing in background? Browsers often pause.
    // To be safe, we can check if audio is playing and if not, treat as pause.
    // Simpler: call pauseListeningSession() and set a flag that we are in background.
    // We'll handle it in the heartbeat? For now, do nothing; the audio pause event will fire.
    // But if the browser keeps audio playing, we might need to handle it.
    // We'll trust the 'pause' event.
  } else {
    // If we come back and audio is still playing, we may have missed the play event.
    // We can check if activeAudioElement is playing and if we have no session.
    if (activeAudioElement && !activeAudioElement.paused && listeningSessionStartTime === null && activeBookObject) {
      startListeningSession(activeBookObject.id);
    }
  }
});

// On page unload, end the session.
window.addEventListener('beforeunload', () => {
  endListeningSession('unload');
});

// -----------------------------------------------------------------
// INITIALISATION (called once when the script loads)
// -----------------------------------------------------------------

// This file loads after 23-audio-player.js, so we can attach listeners
// when the audio element is created. We'll call attachListeningEventListeners
// inside loadM4bAudio after creating the element.

// We'll also export the functions so they can be called from other modules if needed.