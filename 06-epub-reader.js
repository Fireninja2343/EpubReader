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
            const containerFile = await zip.file("META-INF/container.xml").async("string");
            const parser = new DOMParser();
            const containerDoc = parser.parseFromString(containerFile, "text/xml");
            const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
            const opfFile = await zip.file(opfPath).async("string");
            const opfDoc = parser.parseFromString(opfFile, "text/xml");

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
                    const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/")) + "/";
                    const fullCoverPath = normalizePath(baseDir + relCoverPath);
                    const imgFile = zip.file(fullCoverPath);
                    if (imgFile) {
                        const blob = await imgFile.async("blob");
                        coverBase64 = await convertBlobToBase64(blob);
                    }
                }
            }

            /*
             The parsed book is saved through the shared saveBookToDatabase()
             helper instead of writing directly to IndexedDB here. That
             shared helper is responsible for setting default fields like
             isRead and lastModified, and for kicking off the cloud push of
             both the metadata and the file itself. Writing straight to
             IndexedDB in this function would silently skip all of that.
            */
            await new Promise((resolve) => {
                saveBookToDatabase(title, coverBase64, file);
                resolve();
            });

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
  activeBookObject = bookObject;
  document.getElementById("current-book-indicator").innerText =
    bookObject.title;
  document.getElementById("current-book-indicator").style.display = "inline";
  document.getElementById("reader-controls").style.display = "flex";

  try {
    activeZipInstance = await JSZip.loadAsync(bookObject.fileData);
    const containerFile = await activeZipInstance
      .file("META-INF/container.xml")
      .async("string");
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerFile, "text/xml");
    const opfPath = containerDoc
      .querySelector("rootfile")
      .getAttribute("full-path");
    const opfFile = await activeZipInstance.file(opfPath).async("string");
    const opfDoc = parser.parseFromString(opfFile, "text/xml");
    const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/")) + "/";

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
    frame.innerHTML = `<p style="color:red; text-align:center;">Failed loading chapter element.</p>`;
  }
}

async function parseAndRenderTOC(zip, opfDoc, baseDir) {
  const tocList = document.getElementById("toc-render-list");
  tocList.innerHTML = "";
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
      const row = document.createElement("div");
      row.className = "toc-list-item";
      row.innerText = text;
      row.onclick = () => {
        const targetIdx = activeSpineArray.indexOf(absoluteChapterPath);
        if (targetIdx !== -1) {
          activeSpinePointer = targetIdx;
          renderActiveChapterFromZip(activeZipInstance);
        }
      };
      tocList.appendChild(row);
    });
  } catch (e) {
    console.warn(e);
  }
}