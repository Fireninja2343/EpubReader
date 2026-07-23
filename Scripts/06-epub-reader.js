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
 handleFileImport() processes a batch import sequentially.
 metadataMigrationInProgress guards against overlapping runs,
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

// =================================================================
// EPUB IMPORT
// =================================================================
async function handleFileImport(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const label = document.getElementById("upload-label");
    const totalFiles = files.length;

    /*
     Files are processed one at a time, in order, rather than in parallel.
     Each import involves unzipping a potentially large EPUB, parsing XML,
     and decoding cover images, so running several of these at once could
     spike memory usage and make the browser tab unresponsive on a big
     batch. Processing sequentially keeps memory use predictable at the
     cost of total import time.
    */
    for (let i = 0; i < totalFiles; i++) {
        const file = files[i];

        // Update the upload button's label so the user can see progress through the batch
        label.innerText = `Processing (${i + 1}/${totalFiles})...`;

        try {
            const zip = await JSZip.loadAsync(file);
            const { opfDoc, opfPath, baseDir } = await openEpubContainer(zip);

            const title = opfDoc.querySelector("title")?.textContent || file.name.replace(".epub", "");
            let coverBase64 = null;

            const coverMeta = opfDoc.querySelector('meta[name="cover"]');
            let coverId = coverMeta ? coverMeta.getAttribute("content") : null;
            if (!coverId) {
                const coverItem = opfDoc.querySelector("item[id*='cover']");
                if (coverItem) coverId = coverItem.getAttribute("id");
            }

            if (coverId) {
                const itemNode = opfDoc.getElementById(coverId);
                if (itemNode) {
                    const relCoverPath = itemNode.getAttribute("href");
                    const fullCoverPath = normalizePath(baseDir + relCoverPath);
                    const imgFile = zip.file(fullCoverPath);
                    if (imgFile) {
                        const blob = await imgFile.async("blob");
                        coverBase64 = await convertBlobToBase64(blob);
                    }
                }
            }
            const analysisMeta = await computeEpubWordStats(zip, opfDoc, opfPath);

            await saveBookToDatabase(title, coverBase64, file, analysisMeta);

        } catch (err) {
            console.error(`Failed parsing compilation profile for file: ${file.name}`, err);
        }
    }

    // Reset the upload label back to its default, non-progress text
    label.innerText = "➕ Import EPUB";
    event.target.value = ""; // Clear the file input so the same file can be re-selected later
    
    // Reload the library view so the newly imported books show up on screen
    fetchLocalLibrary(); 
}

// =================================================================
// READER LAUNCH & CHAPTER RENDERING
// =================================================================
async function launchEpubReader(bookObject) {
  /*
   Guards against a book being launched while another one's reading
   session is still open in memory - normally showLibraryState() (see
   08-view-router.js) closes out the previous session before the user can
   get back to the library grid to pick a new book, but this makes
   launchEpubReader() safe on its own too, rather than relying entirely on
   callers going through that path first.
  */
  if (typeof endReadingSession === "function") endReadingSession("newBookLaunched");

  activeBookObject = bookObject;
  document.getElementById("current-book-indicator").innerText =
    bookObject.title;
  document.getElementById("current-book-indicator").style.display = "inline";
  document.getElementById("reader-controls").style.display = "flex";

  /*
   Every call to launchEpubReader() is, by definition, a new reading
   session for this book - so firstOpened/lastOpened/totalSessions are
   updated here rather than anywhere progress happens to be saved. See
   recordReadingSessionStart() in 02-db.js.
  */
  if (typeof recordReadingSessionStart === "function") {
    recordReadingSessionStart(bookObject.id);
  }

  try {
    activeZipInstance = await JSZip.loadAsync(bookObject.fileData);
    const { opfDoc, baseDir } = await openEpubContainer(activeZipInstance);

    const manifestItems = {};
    opfDoc.querySelectorAll("manifest > item").forEach((item) => {
      manifestItems[item.getAttribute("id")] = normalizePath(
        baseDir + item.getAttribute("href"),
      );
    });

    activeSpineArray = [];
    opfDoc.querySelectorAll("spine > itemref").forEach((ref) => {
      const idref = ref.getAttribute("idref");
      if (manifestItems[idref]) activeSpineArray.push(manifestItems[idref]);
    });

    activeSpinePointer = bookObject.currentChapter || 0;
    /*
     Records the chapter this book was already at (as loaded from IndexedDB/
     cloud) as the "last pushed" baseline. Without this, the very first
     trackReadingProgress() call after opening the book would look like a
     chapter change (since lastPushedChapterIndex still holds whatever the
     previously-open book left behind) and would trigger a needless
     immediate cloud push right on open.
    */
    lastPushedChapterIndex = activeSpinePointer;

    await parseAndRenderTOC(activeZipInstance, opfDoc, baseDir);
    showReaderState();
    // Draw the tick marks along the progress bar, one per chapter boundary
    renderProgressBarTicks();
    await renderActiveChapterFromZip(activeZipInstance);
    saveAndApplyUserStyles();
    startActiveReadingTimer();

    setTimeout(() => {
      const container = document.getElementById("reader-container");
      container.scrollTop = bookObject.scrollOffset || 0;
      trackReadingProgress();
    }, 200);
  } catch (err) {
    console.error(err);
  }
}

async function renderActiveChapterFromZip(zipInstance) {
  if (activeSpineArray.length === 0) return;
  const targetPath = activeSpineArray[activeSpinePointer];
  const frame = document.getElementById("text-render-frame");
  const container = document.getElementById("reader-container");
  try {
    let chapterRawHTML = await zipInstance.file(targetPath).async("string");
    const parser = new DOMParser();
    const doc = parser.parseFromString(chapterRawHTML, "text/html");
    const baseDir = targetPath.substring(0, targetPath.lastIndexOf("/")) + "/";
    const images = doc.querySelectorAll("img, image");
    for (let img of images) {
      let attributeName =
        img.tagName.toLowerCase() === "image" ? "xlink:href" : "src";
      let srcVal = img.getAttribute(attributeName);
      if (srcVal && !srcVal.startsWith("data:")) {
        let absoluteImgPath = normalizePath(baseDir + srcVal);
        let imgZipFile = zipInstance.file(absoluteImgPath);
        if (imgZipFile) {
          let imgBlob = await imgZipFile.async("blob");
          let b64 = await convertBlobToBase64(imgBlob);
          img.setAttribute(attributeName, b64);
          if (img.tagName.toLowerCase() === "image")
            img.setAttribute("src", b64);
        }
      }
    }
    const cleanBody = doc.body
      ? doc.body.innerHTML
      : doc.documentElement.innerHTML;
    frame.classList.add("fade-out");
    setTimeout(() => {
      frame.innerHTML = cleanBody;
      container.style.scrollBehavior = "auto";
      container.scrollTop = 0;
      container.style.scrollBehavior = "smooth";
      document.getElementById("chapter-index-display").innerText =
        `${activeSpinePointer + 1} / ${activeSpineArray.length}`;
      trackReadingProgress();
      saveAndApplyUserStyles();
      frame.classList.remove("fade-out");
    }, 150);
  } catch (err) {
    frame.innerHTML = `<p class="text-error-centered">Failed loading chapter element.</p>`;
  }
}

async function parseAndRenderTOC(zip, opfDoc, baseDir) {
  const tocList = document.getElementById("toc-render-list");
  tocList.innerHTML = "";

  /*
   Default every chapter to a plain "Chapter N" label first. Not every
   spine entry necessarily has a matching TOC nav point (some EPUBs point
   their TOC at only a subset of files, e.g. chapter starts but not
   sub-sections), so this guarantees the progress bar tooltip always has
   something sensible to show even where the TOC below doesn't cover it.
  */
  activeChapterTitles = activeSpineArray.map((_, idx) => `Chapter ${idx + 1}`);

  let tocItem =
    opfDoc.querySelector("item[media-type='application/x-dtbncx+xml']") ||
    opfDoc.querySelector("item[properties='nav']");
  if (!tocItem) return;
  try {
    const tocPath = normalizePath(baseDir + tocItem.getAttribute("href"));
    const tocFileStr = await zip.file(tocPath).async("string");
    const tocDoc = new DOMParser().parseFromString(tocFileStr, "text/xml");
    const navPoints = tocDoc.querySelectorAll("navPoint, li");
    navPoints.forEach((node) => {
      const labelNode = node.querySelector("navLabel > text, a, span");
      const contentNode = node.querySelector("content, a");
      if (!labelNode || !contentNode) return;
      const text = labelNode.textContent.trim();
      let href =
        contentNode.getAttribute("src") || contentNode.getAttribute("href");
      if (!href) return;
      href = href.split("#")[0];
      const absoluteChapterPath = normalizePath(baseDir + href);
      const matchedSpineIdx = activeSpineArray.indexOf(absoluteChapterPath);
      // Use this TOC entry's real label for its matching chapter's progress bar tooltip
      if (matchedSpineIdx !== -1) {
        activeChapterTitles[matchedSpineIdx] = text;
      }
      const row = document.createElement("div");
      row.className = "toc-list-item";
      row.innerText = text;
      row.onclick = () => {
        if (matchedSpineIdx !== -1) {
          activeSpinePointer = matchedSpineIdx;
          renderActiveChapterFromZip(activeZipInstance);
        }
      };
      tocList.appendChild(row);
    });
  } catch (e) {
    console.warn(e);
  }
}