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

            /*
             Word/page/chapter counting reuses the zip and opfDoc already
             parsed above instead of unzipping the file a second time. This
             is the one-time cost that lets every later screen (stats table,
             per-book diagnostics) just read cached numbers off the book
             record instead of reparsing the EPUB.
            */
            const analysisMeta = await computeEpubWordStats(zip, opfDoc, opfPath);

            /*
             The parsed book is saved through the shared saveBookToDatabase()
             helper instead of writing directly to IndexedDB here. That
             shared helper is responsible for setting default fields like
             isRead and lastModified, and for kicking off the cloud push of
             both the metadata and the file itself. Writing straight to
             IndexedDB in this function would silently skip all of that.
            */
            /*
             saveBookToDatabase() now returns a Promise that resolves once the
             IndexedDB write actually finishes (see 02-db.js). Previously this
             wrapped it in a Promise that resolved immediately regardless, so
             the "process files one at a time" sequencing described above
             wasn't real: every file's IndexedDB write was fired off and the
             loop moved on to the next file's parsing before it finished,
             which could make sortOrder (based on loadedBooksMemory.length at
             call time) collide across a batch import.
            */
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
