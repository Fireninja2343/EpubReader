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