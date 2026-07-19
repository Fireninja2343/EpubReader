const Config = {
  Db: {
    DB_NAME: "LocalEpubReaderDB_v2",
    STORE_BOOKS: "books",
    STORE_GROUPS: "groups",
    STORE_NOTES: "notes",
    STORE_NOTE_GROUPS: "noteGroups",
    COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY: "EpubReader_CollapsedNoteTagKeys_v1",
    LAST_NOTE_TAGS_STORAGE_KEY: "EpubReader_LastNoteTagIds_v1",
  },
  AutoScroller: {
    AUTOSCROLL_DEBUG: false,
    MIN_STEP_PX: 20,
    MAX_STEP_PX: 500,
    FALLBACK_STEP_PX: 100,
    TARGET_WORDS_PER_TICK: 50,
  },
  Sync: {
    FILE_CHUNK_SIZE: 700000,
    CLOUD_PROGRESS_PUSH_INTERVAL_MS: 20000,
    IDLE_THRESHOLD_MS: 30000,
  },
  Reading: {
    SESSION_INACTIVITY_TIMEOUT_MS: 5 * 60 * 1000, //mins * 60(from min->s) * 1000(from s->ms)
  //Cap on how many past sessions are kept per book, so readingSessions doesn't grow unbounded for books re-opened hundreds of times.
    MAX_STORED_SESSIONS_PER_BOOK: 50,
  //Cap on how many raw readingHistory entries (see 13-reading-history.js) are kept per book.
  //One entry is written per uninterrupted reading session, so
  //365 comfortably covers 1 year of daily reading before the oldest entries start rolling off.
    MAX_STORED_HISTORY_ENTRIES_PER_BOOK: 365,
  /*
   How long a book can go without any real recorded reading activity
   (see getBookReadingStatus() in 10-utils.js) before it's considered
   "Paused" rather than "In Progress" in the stats view and the
   Completion Timeline's Gantt mode. Configurable here rather than
   hardcoded in the status-derivation logic itself, so this can be tuned
   without touching that function.
  */
    PAUSED_INACTIVITY_THRESHOLD_MS: 7 * 24 * 60 * 60 * 1000, // Days (*24 -> h *60 -> min *60 -> s *1000 ->ms)
  },
  firebaseConfig: {
    apiKey: "AIzaSyB-lHa5mHi-iMdgGaTe5ehFZE1Xf2T8TkQ",
    authDomain: "epubreader-fire2343.firebaseapp.com",
    projectId: "epubreader-fire2343",
    storageBucket: "epubreader-fire2343.firebasestorage.app",
    messagingSenderId: "171569428425",
    appId: "1:171569428425:web:7e43e4deb49ab408cdda18",
    measurementId: "G-QB21V0K0KP",
  }
};