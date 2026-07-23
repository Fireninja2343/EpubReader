
// =================================================================
// READER LAUNCH & CHAPTER RENDERING
// =================================================================
async function launchEpubReader(bookObject) {
  /*
   Guards against a book being launched while another one's reading
   session is still open in memory - normally showLibraryState() (see
   11-view-router.js) closes out the previous session before the user can
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