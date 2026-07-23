// =================================================================
// EPUB METADATA ANALYSIS & CACHING
// =================================================================
/*
 Core word/page/chapter counting logic, factored out so it exists in one
 place instead of three (previously handleFileImport, the stats-modal
 diagnostics, and the global stats table each carried their own copy of
 this same spine-walking word count loop). Takes an already-open zip and
 parsed OPF document, since callers that just imported or launched a book
 already have both in memory and shouldn't have to unzip a second time.
*/
async function computeEpubWordStats(zip, opfDoc, opfPath) {
  const spineElements = opfDoc.querySelectorAll("spine > itemref");
  const manifestItems = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    manifestItems[item.getAttribute("id")] = item.getAttribute("href");
  });
  const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  let totalWords = 0;
  for (const spine of spineElements) {
    const id = spine.getAttribute("idref");
    const href = manifestItems[id];
    if (!href) continue;

    const file = zip.file(normalizePath(baseDir + href));
    if (!file) continue;

    const html = await file.async("string");
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    totalWords += text ? text.split(/\s+/).length : 0;
  }

  return {
    totalWords,
    totalPages: Math.round(totalWords / 300),
    chapterCount: spineElements.length,
  };
}

/*
 Opens an EPUB from scratch and runs computeEpubWordStats() on it. This is
 the version the migration pass reaches for, since it only has fileData
 sitting in IndexedDB, not an already-open zip/OPF the way handleFileImport
 and launchEpubReader do.
*/
async function analyzeEpubFile(fileData) {
  const zip = await JSZip.loadAsync(fileData);
  const { opfDoc, opfPath } = await openEpubContainer(zip);
  return computeEpubWordStats(zip, opfDoc, opfPath);
}

/*
 Backfills totalPages/totalWords/chapterCount on a single book that
 predates those fields. A no-op (no zip ever opened) for any book that
 already has all three, so calling this liberally - on every library load
 and every stats view open - costs nothing once a book has been migrated
 once. Updates IndexedDB, the in-memory loadedBooksMemory entry, and
 pushes the result to the cloud the same way any other metadata edit does.
*/
async function ensureBookMetadataCached(book) {
  if (!book || !book.fileData) return book;
  const missingMetadata =
    book.totalPages == null || book.totalWords == null || book.chapterCount == null;
  if (!missingMetadata) return book;

  try {
    const { totalWords, totalPages, chapterCount } = await analyzeEpubFile(book.fileData);
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const updatedRecord = await new Promise((resolve) => {
      store.get(book.id).onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
          record.totalPages = totalPages;
          record.totalWords = totalWords;
          record.chapterCount = chapterCount;
          store.put(record);
        }
        resolve(record);
      };
    });

    if (updatedRecord) {
      const idx = loadedBooksMemory.findIndex((b) => b.id === book.id);
      if (idx !== -1) loadedBooksMemory[idx] = updatedRecord;
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      return updatedRecord;
    }
  } catch (err) {
    console.warn(`Could not compute cached metadata for book ${book.id}:`, err);
  }
  return book;
}

/*
 Runs ensureBookMetadataCached() across the whole library. Books are
 processed one at a time rather than in parallel, for the same reason
 handleFileImport() processes a batch import sequentially - unzipping
 several potentially large EPUBs at once risks spiking memory on a big
 library. metadataMigrationInProgress guards against overlapping runs,
 since this gets triggered both after every fetchLocalLibrary() call and
 explicitly (awaited) when the stats view opens.
*/
let metadataMigrationInProgress = false;
async function migrateMissingBookMetadata() {
  if (metadataMigrationInProgress) return;
  metadataMigrationInProgress = true;
  try {
    for (const book of [...loadedBooksMemory]) {
      await ensureBookMetadataCached(book);
    }
  } finally {
    metadataMigrationInProgress = false;
  }
}

