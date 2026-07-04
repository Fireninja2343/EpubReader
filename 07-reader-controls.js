window.addEventListener("DOMContentLoaded", () => {
    loadSavedUserInterfaceSettings();
});

// =================================================================
// PROGRESS BAR INTERACTION ROUTINES & RENDERING SPLITS
// =================================================================
function renderProgressBarTicks() {
  const container = document.getElementById("chapter-ticks-container");
  container.innerHTML = "";
  if (activeSpineArray.length <= 1) return;

  const segmentWidth = 100 / activeSpineArray.length;
  for (let i = 1; i < activeSpineArray.length; i++) {
    const tick = document.createElement("div");
    tick.className = "chapter-tick-marker";
    tick.style.left = `${segmentWidth * i}%`;
    container.appendChild(tick);
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
    const container = document.getElementById("reader-container");
    const top = container.scrollTop;
    const maxScroll = container.scrollHeight - container.clientHeight;
    
    // 1. CALCULATE STANDALONE CHAPTER METRICS
    // Determine the exact position inside the active single text node
    const innerPct = maxScroll > 0 ? (top / maxScroll) : 0;
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
    
    // Commit current positions background states mutations to IndexedDB
    if (activeBookObject) {
        updateBookProgressInDB(activeBookObject.id, activeSpinePointer, top);
    }
}

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
        if (config.scrollSpeed) document.getElementById("setting-scroll-speed").value = config.scrollSpeed;
        
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
    } catch (e) {
        console.warn("Failed hydrating interface parameters configurations profiles", e);
    }
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
    const scrollSpeed = document.getElementById("setting-scroll-speed").value;
    const cardSize = document.getElementById("setting-card-size")?.value || "160";

    // 2. Package parameters bundle for LocalStorage tracking dumps
    const interfaceConfigurationPackage = {
        fontFamily: font,
        fontSize: size,
        lineSpacing: lineSpacing,
        margins: margin,
        paragraphSpacing: paragraphSpacing,
        colorOverrideEnabled: colorOverrideEnabled,
        fontColor: color,
        scrollSpeed: scrollSpeed,
        cardSize: cardSize
    };
    
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

function changeActiveTheme(themeKey) {
  document.documentElement.setAttribute("data-theme", themeKey);
}

// =================================================================
// END-OF-CHAPTER "NEXT CHAPTER" BANNER
// Triggered by trackReadingProgress() once you scroll past 95% of a chapter.
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