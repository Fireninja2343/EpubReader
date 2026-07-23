// =================================================================
// EPUB IMPORT
// =================================================================
async function handleFileImport(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const label = document.getElementById("upload-label");
    const totalFiles = files.length;

    /*
    Files are processed sequentially instead of in parallel. Each import
    unzips a potentially large EPUB, parses XML, and decodes images, so
    parallel processing could spike memory usage on large batches.
    Sequential handling keeps memory predictable at the cost of slower total
    import time.
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
            Word/page/chapter counting reuses the already-parsed zip and opfDoc instead
            of reopening the EPUB. Later screens can read cached values instead of
            reparsing files.
            */
            const analysisMeta = await computeEpubWordStats(zip, opfDoc, opfPath);

            // Saves through saveBookToDatabase() instead of direct IndexedDB writes, so
            // shared defaults, lastModified updates, and cloud sync are handled too.
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
