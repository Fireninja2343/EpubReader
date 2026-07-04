const Config = {
  Db: {
    DB_NAME: "LocalEpubReaderDB_v2",
    STORE_BOOKS: "books",
    STORE_GROUPS: "groups",
  },
  AutoScroller: {
    AUTOSCROLL_DEBUG: true,
    MIN_STEP_PX: 20,
    MAX_STEP_PX: 500,
    FALLBACK_STEP_PX: 100,
    TARGET_WORDS_PER_TICK: 50,
  },
  Sync: {
    FILE_CHUNK_SIZE: 700000,
    CLOUD_PROGRESS_PUSH_INTERVAL_MS: 20000,
  }
};