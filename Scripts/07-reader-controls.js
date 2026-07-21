window.addEventListener("DOMContentLoaded", () => {
    loadSavedUserInterfaceSettings();
});

// =================================================================
// PROGRESS BAR INTERACTION ROUTINES & RENDERING SPLITS
// =================================================================
function renderProgressBarTicks() {
  const tickContainer = document.getElementById("chapter-ticks-container");
  const segmentContainer = document.getElementById("chapter-segments-container");
  tickContainer.innerHTML = "";
  segmentContainer.innerHTML = "";
  if (activeSpineArray.length === 0) return;

  const segmentWidth = 100 / activeSpineArray.length;

  /*
   One hoverable "chapter segment" div per chapter, sized to that chapter's
   share of the bar. These sit underneath the tick separators (appended to
   a container earlier in the DOM, so the tick lines still draw on top of
   them) and are what actually respond to :hover — expanding slightly and
   revealing a tooltip with that chapter's title. Built from
   activeChapterTitles, which parseAndRenderTOC() fills in before this runs.
  */
  for (let i = 0; i < activeSpineArray.length; i++) {
    const segment = document.createElement("div");
    segment.className = "chapter-segment";
    segment.style.left = `${segmentWidth * i}%`;
    segment.style.width = `${segmentWidth}%`;

    const tooltip = document.createElement("div");
    tooltip.className = "chapter-segment-tooltip";
    tooltip.innerText = activeChapterTitles[i] || `Chapter ${i + 1}`;
    segment.appendChild(tooltip);

    segmentContainer.appendChild(segment);
  }

  // Thin divider ticks marking each chapter boundary (none needed if there's only one chapter)
  if (activeSpineArray.length > 1) {
    for (let i = 1; i < activeSpineArray.length; i++) {
      const tick = document.createElement("div");
      tick.className = "chapter-tick-marker";
      tick.style.left = `${segmentWidth * i}%`;
      tickContainer.appendChild(tick);
    }
  }
}

function handleProgressBarClick(event) {
  if (!activeBookObject || activeSpineArray.length === 0) return;

  const track = document.getElementById("progress-line-track");
  const rect = track.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const widthPercentage = clickX / rect.width;

  // Direct mathematical interpolation of timeline bounds coordinates
  const targetSpineFloat = widthPercentage * activeSpineArray.length;
  let targetChapterIndex = Math.floor(targetSpineFloat);
  let chapterInnerScrollPercentage = targetSpineFloat - targetChapterIndex;

  // Bounds clamps validations routines
  if (targetChapterIndex >= activeSpineArray.length)
    targetChapterIndex = activeSpineArray.length - 1;
  if (targetChapterIndex < 0) targetChapterIndex = 0;

  activeSpinePointer = targetChapterIndex;

  renderActiveChapterFromZip(activeZipInstance).then(() => {
    setTimeout(() => {
      const container = document.getElementById("reader-container");
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTop = maxScroll * chapterInnerScrollPercentage;
      trackReadingProgress();
    }, 180);
  });
}

function trackReadingProgress() {
    // If a book failed to parse (or hasn't loaded yet) activeSpineArray can be
    // empty, which would otherwise make chapterWeight = 100 / 0 = Infinity and
    // turn the progress displays into "NaN%" below.
    if (activeSpineArray.length === 0) return;

    const container = document.getElementById("reader-container");
    const top = container.scrollTop;

    /*
     The end-of-chapter banner gets appended into the text frame itself
     once innerPct crosses 0.95, which grows scrollHeight right after the
     user has already scrolled near the bottom. Left uncorrected, maxScroll
     keeps growing out from under the user and innerPct (and therefore the
     global book percentage) can never actually reach 100%. Subtracting the
     banner's own height from maxScroll keeps the denominator pinned to the
     real chapter content.
    */
    const banner = document.getElementById("chapter-end-action-banner");
    const bannerHeight = banner ? banner.offsetHeight : 0;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight - bannerHeight);
    
    // 1. CALCULATE STANDALONE CHAPTER METRICS
    // Determine the exact position inside the active single text node
    const innerPct = maxScroll > 0 ? Math.min(1, top / maxScroll) : 1;
    const chapterProgressPercentage = Math.round(innerPct * 100);
    
    // Inject immediately into your new chapter metrics indicator label
    const chapterPctDisplay = document.getElementById("chapter-percentage-display");
    if (chapterPctDisplay) {
        chapterPctDisplay.innerText = `${chapterProgressPercentage}%`;
    }

    // 2. CALCULATE GLOBAL FULL-BOOK METRICS
    const chapterWeight = 100 / activeSpineArray.length;
    // Interpolate chapter index location alongside inner percentage weight offsets
    const bookScalePct = Math.round((activeSpinePointer * chapterWeight) + (innerPct * chapterWeight));

    const totalPctDisplay = document.getElementById("percentage-display");
    const progressFillBar = document.getElementById("progress-indicator-bar");
    
    if (totalPctDisplay) totalPctDisplay.innerText = `${bookScalePct}%`;
    if (progressFillBar) progressFillBar.style.width = `${bookScalePct}%`;

    // 3. BACKGROUND MAINTENANCE TASKS
    if (top < maxScroll - 10) {
        overscrollCounter = 0;
    }
    
    // Fire next chapter call invitation block if hitting the final layout stretch
    if (innerPct >= 0.95 && !document.getElementById("chapter-end-action-banner")) {
        injectChapterEndBanner();
    }

    // Once the reader has genuinely scrolled to the bottom of the last chapter
    // (innerPct can now actually reach 1 since the banner is excluded above),
    // mark the book as finished so stats/library views stop showing it as in-progress.
    const isLastChapter = activeSpinePointer >= activeSpineArray.length - 1;
    if (isLastChapter && innerPct >= 1 && activeBookObject && !activeBookObject.isRead) {
        markBookAsRead(activeBookObject.id);
    }
    
    // Commit current positions background states mutations to IndexedDB
    if (activeBookObject) {
        /*
         Normally cloud pushes are throttled to once per
         CLOUD_PROGRESS_PUSH_INTERVAL_MS (20s) so scroll-driven updates don't
         burn through the Firestore write quota. But a chapter change is a
         much bigger, much rarer jump than a scroll tick, and it's exactly
         the kind of update that's most valuable to have on the cloud right
         away — if the tab is closed a minute later without ever returning
         to the library, the throttle window could otherwise swallow it
         entirely. So whenever activeSpinePointer differs from the last
         chapter that was actually pushed, this bypasses the throttle for
         just this one push.
        */
        const chapterHasChangedSinceLastPush = lastPushedChapterIndex !== activeSpinePointer;
        updateBookProgressInDB(activeBookObject.id, activeSpinePointer, top, chapterHasChangedSinceLastPush);
        if (chapterHasChangedSinceLastPush) {
            lastPushedChapterIndex = activeSpinePointer;
            /*
             A chapter change is one of the moments the reading-history
             calendar (see 13-reading-history.js) wants flushed right away:
             it both widens the open segment's chapterStart/chapterEnd range
             to include the newly-reached chapter, and persists that segment
             immediately rather than waiting for the next periodic save.
            */
            if (typeof recordHistoryChapterVisited === "function") {
                recordHistoryChapterVisited(activeSpinePointer);
                if (typeof persistHistorySegment === "function") persistHistorySegment();
            }
        }
    }
}
/*
document.getElementById("reader-container").addEventListener("wheel", (e) => {
  const container = e.currentTarget;
  const isAtBottom =
    container.scrollTop >= container.scrollHeight - container.clientHeight - 2;
  if (isAtBottom && e.deltaY > 0) {
    overscrollCounter++;
    if (overscrollCounter >= 3) {
      overscrollCounter = 0;
      stepToNextChapter();
    }
  }
});
*/
async function stepToNextChapter() {
  if (activeSpinePointer < activeSpineArray.length - 1) {
    activeSpinePointer++;
    await renderActiveChapterFromZip(activeZipInstance);
    saveAndApplyUserStyles();
  }
}

async function stepToPrevChapter() {
  if (activeSpinePointer > 0) {
    activeSpinePointer--;
    await renderActiveChapterFromZip(activeZipInstance);
    saveAndApplyUserStyles();
  }
}

// =================================================================
// PERSISTENT CONFIGURATION STORAGE LAYER
// =================================================================
function loadSavedUserInterfaceSettings() {
    const saved = localStorage.getItem("EpubReader_UserConfig_v1");
    if (!saved) return;

    try {
        const config = JSON.parse(saved);
        
        // Hydrate DOM element states from persistence parameters
        if (config.fontFamily) document.getElementById("setting-font-family").value = config.fontFamily;
        if (config.fontSize) document.getElementById("setting-font-size").value = config.fontSize;
        if (config.lineSpacing) document.getElementById("setting-line-spacing").value = config.lineSpacing;
        if (config.margins) document.getElementById("setting-margins").value = config.margins;
        if (config.paragraphSpacing) document.getElementById("setting-paragraph-spacing").value = config.paragraphSpacing;
        if (config.scrollSpeed) document.getElementById("setting-scroll-delay").value = config.scrollSpeed;
        
        // Handle explicit initialization properties for text overrides
        const overrideCheckbox = document.getElementById("setting-enable-color-override");
        if (overrideCheckbox) {
            overrideCheckbox.checked = !!config.colorOverrideEnabled;
            if (config.fontColor) document.getElementById("setting-font-color").value = config.fontColor;
            handleColorOverrideToggle(false); // Update interaction wrapper opacity states silently
        }
        
        // Sync card metrics scales layout constraints if exists
        if (config.cardSize) {
            const cardSizeInput = document.getElementById("setting-card-size");
            if (cardSizeInput) {
                cardSizeInput.value = config.cardSize;
                applyLibraryInterfaceSettings();
            }
        }

        // Hydrate which optional reader header buttons the user has hidden
        if (config.hiddenReaderButtons) {
            Object.keys(READER_BUTTON_ELEMENT_MAP).forEach((key) => {
                const isHidden = !!config.hiddenReaderButtons[key];
                const checkbox = document.getElementById(`toggle-btn-${key}`);
                if (checkbox) checkbox.checked = !isHidden;
                applyReaderButtonVisibility(key, isHidden);
            });
        }
    } catch (e) {
        console.warn("Failed hydrating interface parameters configurations profiles", e);
    }
}

// =================================================================
// OPTIONAL READER HEADER BUTTON VISIBILITY (Settings > Reader UI Buttons)
// =================================================================
/*
 Only buttons that aren't required for core functionality are toggleable
 here (chapter navigation, contents, stats, notes, themes) - things like
 the Library button or Toggle Scroll aren't included since hiding them
 would strand the user with no way back to their library or no way to
 use a core reading feature.
*/
const READER_BUTTON_ELEMENT_MAP = {
    toc: "btn-toggle-toc",
    prev: "btn-prev-chapter",
    next: "btn-next-chapter",
    stats: "btn-global-stats",
    notes: "btn-global-notes",
    themes: "theme-selector",
    sort: "sort-selector",
    viewMode: "library-view-mode",
    openSelected: "btn-open-book",
    lastRead: "btn-last-read",
    hardReload: "btn-hard-reload",
    clearLocalData: "btn-clear-local-data",
    hardPull: "btn-hard-pull",
    hardPush: "btn-hard-push",
    softPull: "btn-soft-pull",
    softPush: "btn-soft-push",
};

function handleReaderButtonToggle(key, isChecked) {
    const shouldHide = !isChecked;
    applyReaderButtonVisibility(key, shouldHide);
    persistReaderButtonVisibilitySetting(key, shouldHide);
}

function applyReaderButtonVisibility(key, shouldHide) {
    const elementId = READER_BUTTON_ELEMENT_MAP[key];
    const el = elementId ? document.getElementById(elementId) : null;
    if (!el) return;
    el.classList.toggle("ui-btn-hidden", shouldHide);
}

function persistReaderButtonVisibilitySetting(key, isHidden) {
    const saved = localStorage.getItem("EpubReader_UserConfig_v1");
    let config = {};
    if (saved) {
        try { config = JSON.parse(saved); } catch (e) {}
    }
    if (!config.hiddenReaderButtons) config.hiddenReaderButtons = {};
    config.hiddenReaderButtons[key] = isHidden;
    localStorage.setItem("EpubReader_UserConfig_v1", JSON.stringify(config));
}

function saveAndApplyUserStyles() {
    // 1. Gather all interface metric parameters
    const font = document.getElementById("setting-font-family").value;
    const size = document.getElementById("setting-font-size").value;
    const lineSpacing = document.getElementById("setting-line-spacing").value;
    const margin = document.getElementById("setting-margins").value;
    const paragraphSpacing = document.getElementById("setting-paragraph-spacing").value;
    const colorOverrideEnabled = document.getElementById("setting-enable-color-override").checked;
    const color = document.getElementById("setting-font-color").value;
    const scrollSpeed = document.getElementById("setting-scroll-delay").value;
    const cardSize = document.getElementById("setting-card-size")?.value || "160";

    // 2. Merge into whatever config is already saved (rather than replacing
    //    it outright), so unrelated saved settings - like cardSize or the
    //    hiddenReaderButtons toggles below - don't get silently wiped out
    //    every time a font/style control changes.
    const savedRaw = localStorage.getItem("EpubReader_UserConfig_v1");
    let interfaceConfigurationPackage = {};
    if (savedRaw) {
        try { interfaceConfigurationPackage = JSON.parse(savedRaw); } catch (e) {}
    }

    Object.assign(interfaceConfigurationPackage, {
        fontFamily: font,
        fontSize: size,
        lineSpacing: lineSpacing,
        margins: margin,
        paragraphSpacing: paragraphSpacing,
        colorOverrideEnabled: colorOverrideEnabled,
        fontColor: color,
        scrollSpeed: scrollSpeed,
        cardSize: cardSize
    });

    localStorage.setItem("EpubReader_UserConfig_v1", JSON.stringify(interfaceConfigurationPackage));

    // 3. Bind UI configurations down onto the text render frames context viewport
    document.getElementById("lbl-font-size").innerText = size;
    document.getElementById("lbl-line-spacing").innerText = lineSpacing;
    document.getElementById("lbl-margins").innerText = margin;
    document.getElementById("lbl-paragraph-spacing").innerText = paragraphSpacing;
    document.getElementById("lbl-scroll-speed").innerText = scrollSpeed;
    
    const frame = document.getElementById("text-render-frame");
    const container = document.getElementById("reader-container");
    
    container.style.padding = `40px ${margin}%`;
    frame.style.fontSize = `${size}px`;
    frame.style.lineHeight = lineSpacing;
    
    // --- APPLY PARAGRAPH SPACING OVERRIDES ---
    // Inject bottom margin padding values dynamically into all internal paragraphs
    frame.querySelectorAll("p, div, blockquote").forEach(el => {
        // If the element contains substantive text blocks, give it vertical whitespace
        if (el.textContent.trim().length > 0) {
            el.style.marginBottom = `${paragraphSpacing}em`;
            el.style.marginTop = "0px"; // Normalizes layout flow tracking direction
        }
    });
    // ------------------------------------------
    
    // --- SAFE OVERRIDE COLOR CHECK CODES ---
    if (colorOverrideEnabled) {
        frame.style.color = color;
        frame.querySelectorAll("*").forEach(el => el.style.color = "inherit");
    } else {
        frame.style.removeProperty("color");
        frame.querySelectorAll("*").forEach(el => el.style.removeProperty("color"));
    }

    if (font === "publisher") {
        frame.style.fontFamily = "initial";
    } else {
        frame.style.fontFamily = font;
        frame.querySelectorAll("*").forEach(el => el.style.fontFamily = "inherit");
    }
}

function handleColorOverrideToggle(shouldTriggerReapply = true) {
    const isEnabled = document.getElementById("setting-enable-color-override").checked;
    const wrapper = document.getElementById("color-picker-wrapper");
    
    if (wrapper) {
        wrapper.style.opacity = isEnabled ? "1" : "0.5";
        wrapper.style.pointerEvents = isEnabled ? "auto" : "none";
    }
    
    if (shouldTriggerReapply) {
        saveAndApplyUserStyles();
    }
}



function toggleSidebar(id) {
  const bar = document.getElementById(id);
  const isOpen = bar.classList.contains("active");
  document
    .querySelectorAll(".reader-sidebar")
    .forEach((s) => s.classList.remove("active"));
  if (!isOpen) bar.classList.add("active");
}

/*
 Settings is reachable both from the library and from the reader (it now
 lives outside #reader-view so it isn't hidden away with the reader panel -
 see index.html/styles.css). The content is identical either way; only the
 order of the two sections changes, so the Reader Settings block is right
 at hand while actually reading, but tucked at the bottom (after the
 library-oriented settings) when opened from the library.
*/
function openSettingsPanel(context) {
    const sidebar = document.getElementById("settings-sidebar");
    const librarySection = document.getElementById("library-settings-section");
    const readerSection = document.getElementById("reader-settings-section");

    if (sidebar && librarySection && readerSection) {
        if (context === "reader") {
            sidebar.insertBefore(readerSection, librarySection);
        } else {
            sidebar.appendChild(readerSection);
        }
    }

    toggleSidebar("settings-sidebar");
}

function changeActiveTheme(themeKey) {
  document.documentElement.setAttribute("data-theme", themeKey);
}

// =================================================================
// END-OF-CHAPTER "NEXT CHAPTER" BANNER
// Triggered by trackReadingProgress() once scrolled past 95% of a chapter.
// =================================================================
function injectChapterEndBanner() {
  const frame = document.getElementById("text-render-frame");
  if (!frame || document.getElementById("chapter-end-action-banner")) return;

  const isLastChapter = activeSpinePointer >= activeSpineArray.length - 1;

  const banner = document.createElement("div");
  banner.id = "chapter-end-action-banner";
  banner.className = "chapter-end-banner";

  const label = document.createElement("span");
  label.innerText = isLastChapter
    ? "You've reached the end of the book."
    : "End of chapter.";
  banner.appendChild(label);

  if (!isLastChapter) {
    const nextBtn = document.createElement("button");
    nextBtn.className = "btn-next-chapter-action";
    nextBtn.innerText = "Next Chapter ⏭️";
    nextBtn.onclick = () => stepToNextChapter();
    banner.appendChild(nextBtn);
  }

  frame.appendChild(banner);
}