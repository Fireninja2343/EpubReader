function normalizePath(pathString) {
  const parts = pathString.split("/");
  const output = [];
  for (let chunk of parts) {
    if (chunk === "." || chunk === "") continue;
    if (chunk === "..") {
      if (output.length) output.pop();
    } else {
      output.push(chunk);
    }
  }
  return output.join("/");
}

function convertBlobToBase64(blobItem) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blobItem);
  });
}

function base64ToBlob(base64) {
  const [header, data] = base64.split(",");
  const mime = header.match(/:(.*?);/)[1];

  const binary = atob(data);
  const array = [];

  for (let i = 0; i < binary.length; i++) {
    array.push(binary.charCodeAt(i));
  }

  return new Blob([new Uint8Array(array)], { type: mime });
}

let enabled = false;
const AUTOSCROLL_DEBUG = Config.AutoScroller.AUTOSCROLL_DEBUG;

/*
 Auto-scroll moves a variable distance on each tick instead of a fixed
 pixel amount, calculated by computeAdaptiveStepPx() below based on how
 dense the currently visible text is. MIN_STEP_PX and MAX_STEP_PX are just
 safety bounds on that calculation, so a screen that's all images (0
 measurable words) or one giant word doesn't cause a step that's far too
 small or far too large.
*/
const MIN_STEP_PX = Config.AutoScroller.MIN_STEP_PX;
const MAX_STEP_PX = Config.AutoScroller.MAX_STEP_PX;
const FALLBACK_STEP_PX = Config.AutoScroller.FALLBACK_STEP_PX; // used if no visible words can be measured at all

/*
 Roughly how many words should scroll past the viewport per tick at the
 default speed setting. The speed slider in the UI only changes the delay
 between ticks (via getCooldownMs below); this constant is what defines
 how much content counts as "one tick's worth" of reading.
*/
const TARGET_WORDS_PER_TICK = Config.AutoScroller.TARGET_WORDS_PER_TICK;

function getCooldownMs() {
  return Number(document.getElementById("setting-scroll-delay").value) * 1000;
}

function countVisibleWords() {
  const container = document.getElementById("reader-container");
  const frame = document.getElementById("text-render-frame");
  if (!container || !frame) return 0;
 
  const containerRect = container.getBoundingClientRect();
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  let words = 0;
  let node;
 
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text.trim()) continue;
 
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
 
    const isVisible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    if (isVisible) {
      words += text.trim().split(/\s+/).filter(Boolean).length;
    }
  }
 
  return words;
}

/*
 Converts "words currently visible in the viewport" into "pixels to scroll
 on this tick." pixelsPerWord is the value that actually changes with text
 density: a dense page packs words tightly, so pixelsPerWord is small and
 scrolling past TARGET_WORDS_PER_TICK worth of words only takes a few
 pixels. A sparse page (large text, lots of whitespace) has a large
 pixelsPerWord, so the same word target requires scrolling further.
*/
function computeAdaptiveStepPx() {
  const container = document.getElementById("reader-container");
  if (!container) return FALLBACK_STEP_PX;
 
  const visibleHeight = container.clientHeight;
  const visibleWords = countVisibleWords();
 
  if (!visibleWords || !visibleHeight) {
    if (AUTOSCROLL_DEBUG) {
      console.log(`[AutoScroll] no visible words detected (visibleWords=${visibleWords},
         visibleHeight=${visibleHeight}) — using fallback step of ${FALLBACK_STEP_PX}px`);
    }
    return FALLBACK_STEP_PX;
  }
 
  const wordsPerPixel = visibleWords / visibleHeight;
  const pixelsPerWord = 1 / wordsPerPixel;
  const idealStep = TARGET_WORDS_PER_TICK * pixelsPerWord;
  const clampedStep = Math.min(MAX_STEP_PX, Math.max(MIN_STEP_PX, idealStep));
 
  if (AUTOSCROLL_DEBUG) {
    console.log(
      `[AutoScroll] visible words=${visibleWords} in ${visibleHeight}px ` +
      `→ ${pixelsPerWord.toFixed(2)}px/word ` +
      `→ ideal step=${idealStep.toFixed(1)}px ` +
      (clampedStep !== idealStep ? `→ CLAMPED to ${clampedStep.toFixed(1)}px` : `→ using ${clampedStep.toFixed(1)}px`)
    );
  }
 
  return clampedStep;
}

let lastScrollTime = 0;
let interval = null;
const fill = document.getElementById("fill");

function applySpeedChange() {
  if (!enabled) return;
  clearInterval(interval);
  toggleScroll();
  toggleScroll();
}
document.getElementById("setting-scroll-delay").addEventListener("input", applySpeedChange);

function startScroll() {
  lastScrollTime = Date.now();
  fill.style.width = "100%";
  interval = setInterval(() => {
    document.getElementById("reader-container").scrollBy(0, computeAdaptiveStepPx());
 
    lastScrollTime = Date.now();
  }, getCooldownMs());
  fill.style.boxShadow = "0 0 3px 5px var(--accent)";
  requestAnimationFrame(updateBar);
}
 
function stopScroll() {
  clearInterval(interval);
  fill.style.boxShadow = "none";
  fill.style.width = "100%";
  interval = null;
  enabled = false;
}
 
function toggleScroll() {
  enabled = !enabled;
 
  if (enabled) startScroll();
  else stopScroll();
}
 
function updateBar() {
  if (!enabled) return;
 
  const now = Date.now();
  const remaining = Math.max(0, getCooldownMs() - (now - lastScrollTime));
  const pct = remaining / getCooldownMs();
 
  fill.style.width = (pct * 100) + "%";
 
  requestAnimationFrame(updateBar);
}
 
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "d") {
    e.preventDefault();
    toggleScroll();
  }
});
 
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    return;
  }
  if (e.ctrlKey && e.key === "d") {
    return; // Already handled by the listener above — returning here avoids immediately re-toggling
  }
 
  stopScroll();
});