const TOTAL_PAGES = 604;
const SOLIDIFICATION_DAYS = 5;
const STORAGE_KEY = "quran-review-tracker-state-v1";
const SUPABASE_CONFIG_KEY = "quran-review-tracker-supabase";

const formatLocalDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const todayKey = () => formatLocalDateKey(new Date());
const clampPage = (value) => Math.min(TOTAL_PAGES, Math.max(1, Number(value) || 1));
const pageToJuz = (page) => Math.min(30, Math.floor((page - 1) / 20) + 1);
const pagesForJuz = (juz) => {
  const start = (juz - 1) * 20 + 1;
  const end = juz === 30 ? TOTAL_PAGES : Math.min(TOTAL_PAGES, juz * 20);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};

const initialState = {
  targetDate: "",
  userEmail: "",
  pages: {},
  setupPages: {},
  dailyEntries: {},
  selectedDate: todayKey(),
  weeklyCycleDays: 7,
  weeklyStartPage: 1,
  weeklyLastStoppedPage: null,
  reviewLogs: [],
  hifzLogs: [],
  priorityLogs: {},
  message: "",
  syncOpen: false,
  syncStatus: "Local only",
};

function freshState(overrides = {}) {
  return {
    targetDate: "",
    userEmail: "",
    pages: {},
    setupPages: {},
    dailyEntries: {},
    selectedDate: todayKey(),
    weeklyCycleDays: 7,
    weeklyStartPage: 1,
    weeklyLastStoppedPage: null,
    reviewLogs: [],
    hifzLogs: [],
    priorityLogs: {},
    message: "",
    syncOpen: false,
    syncStatus: "Local only",
    ...overrides,
  };
}

let state = loadState();
rebuildFromHistory();
let supabaseClient = null;
let pendingPriorityScrollTop = null;

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return freshState();
  try {
    return normalizeState({ ...freshState(), ...JSON.parse(saved) });
  } catch {
    return freshState();
  }
}

function normalizeState(nextState) {
  return {
    ...freshState(),
    ...nextState,
    pages: isPlainObject(nextState.pages) ? nextState.pages : {},
    setupPages: isPlainObject(nextState.setupPages) ? nextState.setupPages : deriveSetupPages(nextState.pages),
    dailyEntries: isPlainObject(nextState.dailyEntries) ? nextState.dailyEntries : {},
    selectedDate: nextState.selectedDate || todayKey(),
    weeklyCycleDays: normalizeWeeklyCycleDays(nextState.weeklyCycleDays),
    priorityLogs: isPlainObject(nextState.priorityLogs) ? nextState.priorityLogs : {},
    reviewLogs: Array.isArray(nextState.reviewLogs) ? nextState.reviewLogs : [],
    hifzLogs: Array.isArray(nextState.hifzLogs) ? nextState.hifzLogs : [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWeeklyCycleDays(value) {
  return Number(value) === 10 ? 10 : 7;
}

function weeklyCycleDays() {
  state.weeklyCycleDays = normalizeWeeklyCycleDays(state.weeklyCycleDays);
  return state.weeklyCycleDays;
}

function deriveSetupPages(pages) {
  if (!isPlainObject(pages)) return {};
  return Object.fromEntries(Object.entries(pages).map(([page, record]) => [page, { ...record, source: record.source || "setup" }]));
}

function selectedDateKey() {
  return state.selectedDate || todayKey();
}

function entryFor(date = selectedDateKey()) {
  if (!state.dailyEntries[date]) {
    state.dailyEntries[date] = {
      memorizedPages: [],
      priorityReviewedPages: [],
      weakFlaggedPages: [],
      weakClearedPages: [],
      weeklyStoppedAt: "",
    };
  }
  return state.dailyEntries[date];
}

function formatPages(pages) {
  return (pages || []).slice().sort((a, b) => a - b).join(", ");
}

function addUniquePages(existing, pages) {
  return [...new Set([...(existing || []), ...pages])].sort((a, b) => a - b);
}

function percent(value, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  saveCloud();
}

function rebuildFromHistory() {
  const pages = cloneRecords(state.setupPages);
  const priorityLogs = {};
  const reviewLogs = [];
  const hifzLogs = [];
  let weeklyStartPage = 1;
  let weeklyLastStoppedPage = null;

  Object.keys(state.dailyEntries)
    .filter((date) => date <= todayKey())
    .sort()
    .forEach((date) => {
      const entry = normalizeEntry(state.dailyEntries[date]);

      if (entry.memorizedPages.length) hifzLogs.unshift({ date, pages: entry.memorizedPages });
      applyEntryPageChanges(pages, entry, date, { includeSameDayMemorizedInPriority: date < todayKey() });
      entry.priorityReviewedPages.forEach((page) => {
        const record = pages[page];
        if (!record) return;
        priorityLogs[`${date}:${page}`] = true;
      });

      if (entry.weeklyStoppedAt) {
        const pool = reviewPoolFrom(pages);
        const stopped = clampPage(entry.weeklyStoppedAt);
        const start = nextReviewStartFrom(pool, weeklyStartPage);
        const reviewed = reviewRange(pool, Number(start), stopped);
        weeklyLastStoppedPage = stopped;
        weeklyStartPage = nextAfter(pool, stopped);
        reviewLogs.unshift({
          date,
          start,
          stopped,
          reviewed: reviewed.length,
          quota: Math.ceil(pool.length / weeklyCycleDays()),
        });
      }
    });

  state.pages = pages;
  state.priorityLogs = priorityLogs;
  state.reviewLogs = reviewLogs;
  state.hifzLogs = hifzLogs;
  state.weeklyStartPage = weeklyStartPage;
  state.weeklyLastStoppedPage = weeklyLastStoppedPage;
}

function weeklyContextForDate(targetDate) {
  const pages = cloneRecords(state.setupPages);
  let weeklyStartPage = 1;
  let cycleReviewed = 0;

  Object.keys(state.dailyEntries)
    .filter((date) => date <= targetDate && date <= todayKey())
    .sort()
    .forEach((date) => {
      const entry = normalizeEntry(state.dailyEntries[date]);

      applyEntryPageChanges(pages, entry, date, { includeSameDayMemorizedInPriority: date < targetDate });

      if (date === targetDate) return;
      if (entry.weeklyStoppedAt) {
        const pool = reviewPoolFrom(pages);
        const start = nextReviewStartFrom(pool, weeklyStartPage);
        const stopped = clampPage(entry.weeklyStoppedAt);
        const reviewed = reviewRange(pool, Number(start), stopped);
        cycleReviewed = nextCycleReviewedCount(pool, Number(start), stopped, cycleReviewed, reviewed.length);
        weeklyStartPage = nextAfter(pool, stopped);
      }
    });

  const pool = reviewPoolFrom(pages);
  cycleReviewed = Math.min(cycleReviewed, pool.length);
  return {
    start: nextReviewStartFrom(pool, weeklyStartPage),
    quota: Math.ceil(pool.length / weeklyCycleDays()),
    poolSize: pool.length,
    pool,
    cycleReviewed,
  };
}

function priorityContextForDate(targetDate) {
  const pages = cloneRecords(state.setupPages);
  Object.keys(state.dailyEntries)
    .filter((date) => date <= targetDate && date <= todayKey())
    .sort()
    .forEach((date) => {
      const entry = normalizeEntry(state.dailyEntries[date]);
      applyEntryPageChanges(pages, entry, date, {
        includePriorityReviewed: date !== targetDate,
        includeSameDayMemorizedInPriority: date < targetDate,
      });
    });
  const due = Object.keys(pages)
    .map(Number)
    .filter((page) => pages[page]?.memorized && (pages[page]?.priority || pages[page]?.weak))
    .sort((a, b) => a - b);
  const reviewed = normalizeEntry(state.dailyEntries[targetDate]).priorityReviewedPages.filter((page) => due.includes(page));
  return { due, reviewed, records: pages };
}

function applyEntryPageChanges(pages, entry, date, options = {}) {
  const includePriorityReviewed = options.includePriorityReviewed !== false;
  const includeSameDayMemorizedInPriority = options.includeSameDayMemorizedInPriority !== false;

  entry.memorizedPages.forEach((page) => {
    pages[page] = {
      ...(pages[page] || {}),
      memorized: true,
      weak: false,
      priority: includeSameDayMemorizedInPriority,
      streak: pages[page]?.streak || 0,
      memorizedAt: pages[page]?.memorizedAt || date,
      source: "daily",
    };
  });

  entry.weakFlaggedPages.forEach((page) => {
    pages[page] = {
      ...(pages[page] || {}),
      memorized: true,
      weak: true,
      priority: true,
      streak: pages[page]?.streak || 0,
      memorizedAt: pages[page]?.memorizedAt || date,
      source: pages[page]?.source || "daily",
    };
  });

  entry.weakClearedPages.forEach((page) => {
    if (!pages[page]) return;
    pages[page].weak = false;
    pages[page].priority = (pages[page].streak || 0) < SOLIDIFICATION_DAYS;
  });

  if (!includePriorityReviewed) return;
  entry.priorityReviewedPages.forEach((page) => {
    const record = pages[page];
    if (!record) return;
    if (!record.weak) {
      record.streak = (record.streak || 0) + 1;
      if (record.streak >= SOLIDIFICATION_DAYS) record.priority = false;
    }
  });
}

function nextCycleReviewedCount(pool, start, stopped, previousCount, reviewedCount) {
  if (!pool.length || !reviewedCount) return Math.min(previousCount, pool.length);
  const startIndex = pool.indexOf(start);
  const stopIndex = pool.indexOf(stopped);
  if (startIndex === -1 || stopIndex === -1) return Math.min(previousCount, pool.length);
  if (stopIndex < startIndex) return stopIndex + 1;
  const nextCount = previousCount + reviewedCount;
  return nextCount >= pool.length ? 0 : nextCount;
}

function weeklyProgressForDate(date) {
  const context = weeklyContextForDate(date);
  const entry = normalizeEntry(state.dailyEntries[date]);
  let dailyReviewed = 0;
  let cycleReviewed = context.cycleReviewed;

  if (entry.weeklyStoppedAt && context.pool.length) {
    const start = Number(context.start);
    const stopped = clampPage(entry.weeklyStoppedAt);
    const reviewed = reviewRange(context.pool, start, stopped);
    dailyReviewed = reviewed.length;
    cycleReviewed = nextCycleReviewedCount(context.pool, start, stopped, context.cycleReviewed, reviewed.length);
  }

  return {
    start: context.start,
    dailyReviewed,
    dailyTarget: context.quota,
    dailyPercent: percent(Math.min(dailyReviewed, context.quota), context.quota),
    cycleReviewed,
    cycleTotal: context.poolSize,
    cyclePercent: percent(cycleReviewed, context.poolSize),
  };
}

function renderProgressBar(label, value, total, progressPercent) {
  const displayTotal = total || 0;
  return `
    <div class="mini-progress" aria-label="${label}: ${value} of ${displayTotal}">
      <div class="mini-progress-meta">
        <span>${label}</span>
        <strong>${value} / ${displayTotal}</strong>
      </div>
      <div class="mini-progress-track">
        <div class="mini-progress-fill" style="width: ${progressPercent}%"></div>
      </div>
    </div>
  `;
}

function cloneRecords(records) {
  return Object.fromEntries(Object.entries(records || {}).map(([page, record]) => [page, { ...record }]));
}

function normalizeEntry(entry) {
  return {
    memorizedPages: Array.isArray(entry?.memorizedPages) ? entry.memorizedPages : [],
    priorityReviewedPages: Array.isArray(entry?.priorityReviewedPages) ? entry.priorityReviewedPages : [],
    weakFlaggedPages: Array.isArray(entry?.weakFlaggedPages) ? entry.weakFlaggedPages : [],
    weakClearedPages: Array.isArray(entry?.weakClearedPages) ? entry.weakClearedPages : [],
    weeklyStoppedAt: entry?.weeklyStoppedAt || "",
  };
}

function reviewPoolFrom(pages) {
  return Object.keys(pages)
    .map(Number)
    .filter((page) => pages[page]?.memorized && !pages[page]?.priority && !pages[page]?.weak)
    .sort((a, b) => a - b);
}

function nextReviewStartFrom(pool, startPage) {
  if (!pool.length) return "No pool";
  if (pool.includes(startPage)) return startPage;
  return pool.find((page) => page >= startPage) || pool[0];
}

function pageRecord(page) {
  return state.pages[page] || null;
}

function memorizedPages() {
  return Object.keys(state.pages).map(Number).filter((page) => state.pages[page]?.memorized).sort((a, b) => a - b);
}

function priorityPages() {
  return memorizedPages().filter((page) => {
    const record = pageRecord(page);
    return record?.weak || record?.priority;
  });
}

function reviewPool() {
  return memorizedPages().filter((page) => !priorityPages().includes(page));
}

function daysUntilTarget() {
  if (!state.targetDate) return null;
  const today = new Date(`${todayKey()}T00:00:00`);
  const target = new Date(`${state.targetDate}T00:00:00`);
  return Math.max(1, Math.ceil((target - today) / 86400000) + 1);
}

function dailyHifzTarget() {
  const days = daysUntilTarget();
  if (!days) return "Set date";
  const remaining = TOTAL_PAGES - memorizedPages().length;
  return (remaining / days).toFixed(1);
}

function dailyReviewQuota() {
  return Math.ceil(reviewPool().length / weeklyCycleDays());
}

function nextReviewStart() {
  const pool = reviewPool();
  if (!pool.length) return "No pool";
  if (pool.includes(state.weeklyStartPage)) return state.weeklyStartPage;
  return pool.find((page) => page >= state.weeklyStartPage) || pool[0];
}

function parsePages(input) {
  const pages = new Set();
  String(input)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const [a, b] = part.split("-").map((piece) => Number(piece.trim()));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        for (let page = start; page <= end; page += 1) pages.add(clampPage(page));
      } else if (Number.isFinite(a)) {
        pages.add(clampPage(a));
      }
    });
  return [...pages].sort((a, b) => a - b);
}

function logMemorized(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const enteredPages = parsePages(form.get("pageNumbers"));
  if (!enteredPages.length) {
    state.message = "Enter the exact page numbers you memorized today.";
    render();
    return;
  }
  const entry = entryFor();
  entry.memorizedPages = addUniquePages(entry.memorizedPages, enteredPages);
  state.message = `Logged ${enteredPages.length} page${enteredPages.length === 1 ? "" : "s"} on ${selectedDateKey()}.`;
  event.currentTarget.reset();
  rebuildFromHistory();
  saveState();
  render();
}

function completePriorityPage(page, checked) {
  const list = document.querySelector("[data-priority-list]");
  pendingPriorityScrollTop = list ? list.scrollTop : null;
  const entry = entryFor();
  if (checked) {
    entry.priorityReviewedPages = addUniquePages(entry.priorityReviewedPages, [page]);
  } else {
    entry.priorityReviewedPages = entry.priorityReviewedPages.filter((item) => item !== page);
  }
  state.message = `Priority review updated for page ${page} on ${selectedDateKey()}.`;
  rebuildFromHistory();
  saveState();
  render();
}

function toggleWeak(page, isCurrentlyWeak = null) {
  const record = state.pages[page];
  if (!record) return;
  const weakNow = isCurrentlyWeak === null ? Boolean(record.weak) : Boolean(isCurrentlyWeak);
  const entry = entryFor();
  if (weakNow) {
    entry.weakClearedPages = addUniquePages(entry.weakClearedPages, [page]);
    entry.weakFlaggedPages = entry.weakFlaggedPages.filter((item) => item !== page);
  } else {
    entry.weakFlaggedPages = addUniquePages(entry.weakFlaggedPages, [page]);
    entry.weakClearedPages = entry.weakClearedPages.filter((item) => item !== page);
  }
  state.message = weakNow
    ? `Page ${page} weak flag cleared on ${selectedDateKey()}.`
    : `Page ${page} flagged weak on ${selectedDateKey()}.`;
  rebuildFromHistory();
  saveState();
  render();
}

function logWeeklyReview(event) {
  event.preventDefault();
  const stopped = clampPage(new FormData(event.currentTarget).get("stoppedAt"));
  const context = weeklyContextForDate(selectedDateKey());
  if (!context.pool.length) return;
  const start = Number(context.start);
  const reviewed = reviewRange(context.pool, start, stopped);
  const quota = context.quota;
  entryFor().weeklyStoppedAt = stopped;
  state.message = reviewed.length < quota
    ? `Saved. ${quota - reviewed.length} page${quota - reviewed.length === 1 ? "" : "s"} roll forward without raising tomorrow's quota.`
    : "Weekly review saved. Tomorrow resumes from the next page.";
  event.currentTarget.reset();
  rebuildFromHistory();
  saveState();
  render();
}

function reviewRange(pool, start, stopped) {
  const startIndex = pool.indexOf(start);
  const stopIndex = pool.indexOf(stopped);
  if (startIndex === -1 || stopIndex === -1) return [];
  if (stopIndex >= startIndex) return pool.slice(startIndex, stopIndex + 1);
  return [...pool.slice(startIndex), ...pool.slice(0, stopIndex + 1)];
}

function nextAfter(pool, page) {
  const index = pool.indexOf(page);
  if (index === -1) return pool.find((candidate) => candidate > page) || pool[0] || 1;
  return pool[(index + 1) % pool.length] || 1;
}

function setTargetDate(value) {
  state.targetDate = value;
  state.message = "Target date updated.";
  saveState();
  render();
}

function setWeeklyCycleDays(days) {
  state.weeklyCycleDays = normalizeWeeklyCycleDays(days);
  state.message = `Weekly review cycle set to ${state.weeklyCycleDays} days.`;
  rebuildFromHistory();
  saveState();
  render();
}

function setSelectedDate(value) {
  state.selectedDate = value || todayKey();
  state.message = `Viewing ${state.selectedDate}.`;
  saveState();
  render();
}

function moveSelectedDate(days) {
  const date = new Date(`${selectedDateKey()}T00:00:00`);
  date.setDate(date.getDate() + days);
  setSelectedDate(formatLocalDateKey(date));
}

function saveCalendarEntry(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const stopped = String(form.get("calendarStoppedAt") || "").trim();
  state.dailyEntries[selectedDateKey()] = {
    memorizedPages: parsePages(form.get("calendarMemorizedPages")),
    priorityReviewedPages: parsePages(form.get("calendarPriorityPages")),
    weakFlaggedPages: parsePages(form.get("calendarWeakFlaggedPages")),
    weakClearedPages: parsePages(form.get("calendarWeakClearedPages")),
    weeklyStoppedAt: stopped ? clampPage(stopped) : "",
  };
  state.message = `Saved calendar edits for ${selectedDateKey()}.`;
  rebuildFromHistory();
  saveState();
  render();
}

function resetDemo() {
  state = freshState();
  rebuildFromHistory();
  saveState();
  render();
}

function applyMemorySetup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const solid = parsePages(form.get("solidPages"));
  const solidifying = parsePages(form.get("solidifyingPages"));
  const weak = parsePages(form.get("weakPages"));
  const clear = parsePages(form.get("clearPages"));

  solid.forEach((page) => markPage(page, "solid"));
  solidifying.forEach((page) => markPage(page, "solidifying"));
  weak.forEach((page) => markPage(page, "weak"));
  clear.forEach((page) => clearPageEverywhere(page));

  const total = new Set([...solid, ...solidifying, ...weak, ...clear]).size;
  state.message = total
    ? `Updated ${total} page${total === 1 ? "" : "s"} from memory setup.`
    : "Enter pages or choose Ajza' to update your memory map.";
  event.currentTarget.reset();
  rebuildFromHistory();
  saveState();
  render();
}

function clearPageEverywhere(page) {
  delete state.setupPages[page];
  Object.values(state.dailyEntries).forEach((entry) => {
    if (!entry) return;
    const normalized = normalizeEntry(entry);
    entry.memorizedPages = (entry.memorizedPages || []).filter((item) => item !== page);
    entry.priorityReviewedPages = normalized.priorityReviewedPages.filter((item) => item !== page);
    entry.weakFlaggedPages = normalized.weakFlaggedPages.filter((item) => item !== page);
    entry.weakClearedPages = normalized.weakClearedPages.filter((item) => item !== page);
    if (Number(entry.weeklyStoppedAt) === page) entry.weeklyStoppedAt = "";
  });
}

function markPage(page, status) {
  if (status === "clear") {
    delete state.setupPages[page];
    return;
  }
  state.setupPages[page] = {
    ...(state.setupPages[page] || {}),
    memorized: true,
    weak: status === "weak",
    priority: status === "weak" || status === "solidifying",
    streak: status === "solid" ? SOLIDIFICATION_DAYS : state.setupPages[page]?.streak || 0,
    memorizedAt: state.setupPages[page]?.memorizedAt || todayKey(),
    source: status === "solid" ? "setup" : state.pages[page]?.source || "manual",
  };
}

function toggleJuzSolid(juz) {
  const pages = pagesForJuz(juz);
  const isAllSolid = pages.every((page) => {
    const record = state.pages[page];
    return record?.memorized && !record.priority && !record.weak;
  });
  pages.forEach((page) => markPage(page, isAllSolid ? "clear" : "solid"));
  state.message = isAllSolid
    ? `Cleared Juz ${juz} from memorized pages.`
    : `Marked Juz ${juz} as already memorized in the weekly review pool.`;
  rebuildFromHistory();
  saveState();
  render();
}

function seedDemo() {
  state = freshState({ targetDate: addDays(210), selectedDate: todayKey() });
  for (let page = 1; page <= 120; page += 1) {
    state.setupPages[page] = { memorized: true, priority: false, weak: false, streak: SOLIDIFICATION_DAYS, source: "setup" };
  }
  [104, 107, 119].forEach((page) => {
    state.setupPages[page].weak = true;
    state.setupPages[page].priority = true;
  });
  state.dailyEntries[todayKey()] = {
    memorizedPages: [121, 122, 123, 124, 125],
    priorityReviewedPages: [121, 122],
    weakFlaggedPages: [],
    weakClearedPages: [],
    weeklyStoppedAt: 45,
  };
  state.message = "Loaded a realistic sample so you can explore the tracker.";
  rebuildFromHistory();
  saveState();
  render();
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatLocalDateKey(date);
}

function juzStatus(juz) {
  const pages = pagesForJuz(juz);
  const records = pages.map((page) => state.pages[page]).filter(Boolean);
  const memorized = records.filter((record) => record.memorized);
  if (!memorized.length) return "unmemorized";
  if (memorized.some((record) => record.weak)) return "weak";
  if (memorized.some((record) => record.priority)) return "solidifying";
  return "solid";
}

function render() {
  const app = document.querySelector("#app");
  const memorized = memorizedPages();
  const selectedPriority = priorityContextForDate(selectedDateKey());
  const selectedWeekly = weeklyContextForDate(selectedDateKey());
  const progress = Math.round((memorized.length / TOTAL_PAGES) * 1000) / 10;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <h1>Quran Review Tracker</h1>
        <p>Re-memorization, solidification, and weekly Muraja'ah in one quiet place.</p>
      </div>
      <div class="account">
        <button class="ghost-button" data-action="sync">${syncStatusLabel()}</button>
        <button class="soft-button" data-action="seed">Sample data</button>
      </div>
    </header>

    <section class="progress-panel" aria-label="Overall memorization progress">
      <div class="progress-meta">
        <span><strong>${memorized.length} / ${TOTAL_PAGES}</strong> pages memorized</span>
        <span>${progress}% complete</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width: ${progress}%"></div></div>
    </section>

    <section class="heatmap-wrap" aria-labelledby="heatmap-title">
      <div class="section-head">
        <div>
          <h2 id="heatmap-title">Juz Heat Map</h2>
          <p>Each Juz follows the most urgent status inside its pages.</p>
        </div>
        <div class="legend">
          <span><i class="swatch" style="background: var(--gray-block)"></i>Empty</span>
          <span><i class="swatch" style="background: var(--amber)"></i>Solidifying</span>
          <span><i class="swatch" style="background: var(--orange)"></i>Weak</span>
          <span><i class="swatch" style="background: var(--green)"></i>Solid</span>
        </div>
      </div>
      <div class="juz-grid">${renderJuzGrid()}</div>
    </section>

    ${renderSetupPanel()}

    ${renderCalendarPanel()}

    <section class="task-grid" aria-label="Today's tasks">
      ${renderMemorizePanel()}
      ${renderPriorityPanel()}
      ${renderWeeklyPanel()}
    </section>

    <section class="status-strip" aria-label="Current tracker status">
      <div class="status-item"><span>Remaining hifz</span><strong>${TOTAL_PAGES - memorized.length} pages</strong></div>
      <div class="status-item"><span>Priority queue</span><strong>${selectedPriority.due.length} pages</strong></div>
      <div class="status-item"><span>Review pool</span><strong>${selectedWeekly.poolSize} pages</strong></div>
      <div class="status-item"><span>Next weekly start</span><strong>${selectedWeekly.start}</strong></div>
    </section>

    ${renderSyncPanel()}

    <div class="footer-tools">
      <button class="ghost-button" data-action="export">Export JSON</button>
      <button class="ghost-button" data-action="reset">Reset tracker</button>
    </div>
  `;
  bindEvents();
  restorePriorityScroll();
}

function restorePriorityScroll() {
  if (pendingPriorityScrollTop === null) return;
  const list = document.querySelector("[data-priority-list]");
  if (list) list.scrollTop = pendingPriorityScrollTop;
  pendingPriorityScrollTop = null;
}

function renderCalendarPanel() {
  const entry = normalizeEntry(entryFor());
  const isToday = selectedDateKey() === todayKey();
  const weeklyContext = weeklyContextForDate(selectedDateKey());
  return `
    <section class="calendar-panel" aria-labelledby="calendar-title">
      <div class="section-head">
        <div>
          <h2 id="calendar-title">Calendar</h2>
          <p>Edit any date. The current tracker is rebuilt from all saved days through today.</p>
        </div>
        <div class="date-nav">
          <button class="ghost-button" data-action="prev-day" type="button">Previous</button>
          <input id="selectedDate" type="date" value="${selectedDateKey()}" />
          <button class="ghost-button" data-action="next-day" type="button">Next</button>
          <button class="soft-button" data-action="today" type="button" ${isToday ? "disabled" : ""}>Today</button>
        </div>
      </div>
      <form class="calendar-form" data-form="calendar">
        <div class="field">
          <label for="calendarMemorizedPages">Memorized on this date</label>
          <input id="calendarMemorizedPages" name="calendarMemorizedPages" value="${formatPages(entry.memorizedPages)}" placeholder="121-123, 126" />
        </div>
        <div class="field">
          <label for="calendarPriorityPages">Priority pages reviewed</label>
          <input id="calendarPriorityPages" name="calendarPriorityPages" value="${formatPages(entry.priorityReviewedPages)}" placeholder="121, 122" />
        </div>
        <div class="field">
          <label for="calendarWeakFlaggedPages">Weak pages flagged</label>
          <input id="calendarWeakFlaggedPages" name="calendarWeakFlaggedPages" value="${formatPages(entry.weakFlaggedPages)}" placeholder="45, 103" />
        </div>
        <div class="field">
          <label for="calendarWeakClearedPages">Weak pages cleared</label>
          <input id="calendarWeakClearedPages" name="calendarWeakClearedPages" value="${formatPages(entry.weakClearedPages)}" placeholder="45" />
        </div>
        <div class="field">
          <label for="calendarStoppedAt">Weekly stopped at</label>
          <input id="calendarStoppedAt" name="calendarStoppedAt" inputmode="numeric" value="${entry.weeklyStoppedAt || ""}" placeholder="62" />
        </div>
        <div class="calendar-weekly-context">
          <span>Weekly start</span>
          <strong>${weeklyContext.start}</strong>
          <small>Target ${weeklyContext.quota || 0} · Pool ${weeklyContext.poolSize}</small>
        </div>
        <button class="primary-button" type="submit">Save date</button>
      </form>
    </section>
  `;
}

function renderSetupPanel() {
  return `
    <section class="setup-panel" aria-labelledby="setup-title">
      <div class="section-head">
        <div>
          <h2 id="setup-title">Memory Setup</h2>
          <p>Backfill what you already know. These entries control the heat map and review pool.</p>
        </div>
      </div>
      <form class="setup-form" data-form="setup">
        <div class="field">
          <label for="solidPages">Already memorized pages</label>
          <input id="solidPages" name="solidPages" placeholder="1-20, 45, 77-82" />
        </div>
        <div class="field">
          <label for="solidifyingPages">New or solidifying pages</label>
          <input id="solidifyingPages" name="solidifyingPages" placeholder="121-123" />
        </div>
        <div class="field">
          <label for="weakPages">Weak pages</label>
          <input id="weakPages" name="weakPages" placeholder="17, 45, 103-105" />
        </div>
        <div class="field">
          <label for="clearPages">Clear memorized pages</label>
          <input id="clearPages" name="clearPages" placeholder="122, 140-142" />
        </div>
        <button class="primary-button" type="submit">Update pages</button>
      </form>
      <div class="juz-picker" aria-label="Mark whole Ajza already memorized">
        ${renderJuzPicker()}
      </div>
    </section>
  `;
}

function renderJuzPicker() {
  return Array.from({ length: 30 }, (_, index) => {
    const juz = index + 1;
    const pages = pagesForJuz(juz);
    const memorizedCount = pages.filter((page) => state.pages[page]?.memorized).length;
    const solidCount = pages.filter((page) => {
      const record = state.pages[page];
      return record?.memorized && !record.priority && !record.weak;
    }).length;
    const isAllSolid = solidCount === pages.length;
    const label = isAllSolid ? "Clear" : "Mark";
    return `
      <button class="juz-pick ${isAllSolid ? "selected" : ""}" data-juz="${juz}" type="button">
        <strong>Juz ${juz}</strong>
        <span>${label} · ${memorizedCount}/${pages.length}</span>
      </button>
    `;
  }).join("");
}

function renderJuzGrid() {
  return Array.from({ length: 30 }, (_, index) => {
    const juz = index + 1;
    const pages = pagesForJuz(juz);
    const memorizedCount = pages.filter((page) => state.pages[page]?.memorized).length;
    return `
      <div class="juz ${juzStatus(juz)}" title="Juz ${juz}: ${memorizedCount}/${pages.length} pages memorized">
        <strong>Juz ${juz}</strong>
        <small>${memorizedCount}/${pages.length}</small>
      </div>
    `;
  }).join("");
}

function renderMemorizePanel() {
  const entry = normalizeEntry(entryFor());
  return `
    <form class="task-panel" data-form="memorize">
      <div>
        <h2>Memorize</h2>
        <p class="note">Logging to ${selectedDateKey()}. Target is recalculated from pages remaining today.</p>
      </div>
      <div class="metric"><span>Target today</span><strong>${dailyHifzTarget()}</strong></div>
      <div class="field">
        <label for="targetDate">Target completion date</label>
        <input id="targetDate" name="targetDate" type="date" value="${state.targetDate}" />
      </div>
      <div class="inline-fields">
        <div class="field">
          <label for="pageCount">Pages today</label>
          <input id="pageCount" name="pageCount" inputmode="decimal" placeholder="2.5" />
        </div>
        <div class="field">
          <label for="pageNumbers">Page numbers</label>
          <input id="pageNumbers" name="pageNumbers" placeholder="121-123, 126" value="${formatPages(entry.memorizedPages)}" required />
        </div>
      </div>
      <button class="primary-button" type="submit">Log pages</button>
      <p class="message">${state.message}</p>
    </form>
  `;
}

function renderPriorityPanel() {
  const progress = priorityContextForDate(selectedDateKey());
  const pages = progress.due;
  const reviewedCount = progress.reviewed.length;
  const dueCount = progress.due.length;
  const progressPercent = percent(reviewedCount, dueCount);
  return `
    <section class="task-panel">
      <div>
        <h2>Priority Review</h2>
        <p class="note">New pages need 5 daily reviews. Weak pages stay here until unflagged.</p>
      </div>
      <div class="metric"><span>Needing daily review</span><strong>${dueCount}</strong></div>
      ${renderProgressBar("Reviewed today", reviewedCount, dueCount, progressPercent)}
      <div class="row-list" data-priority-list>
        ${pages.length ? pages.map((page) => renderPriorityRow(page, progress.records)).join("") : `<div class="empty-state">No pages in priority review.</div>`}
      </div>
    </section>
  `;
}

function renderPriorityRow(page, records = state.pages) {
  const record = records[page] || state.pages[page];
  const checked = Boolean(state.priorityLogs[`${selectedDateKey()}:${page}`]);
  const baseStreak = record.streak || 0;
  const shownStreak = Math.min(baseStreak + (checked && !record.weak ? 1 : 0), SOLIDIFICATION_DAYS);
  const dueDay = Math.min(baseStreak + 1, SOLIDIFICATION_DAYS);
  const dots = Array.from({ length: SOLIDIFICATION_DAYS }, (_, index) => `<i class="dot ${index < shownStreak ? "on" : ""}"></i>`).join("");
  return `
    <div class="review-row">
      <input type="checkbox" ${checked ? "checked" : ""} data-priority="${page}" aria-label="Mark page ${page} reviewed today" />
      <div>
        <div class="page-title">Page ${page}</div>
        <div class="page-sub">${record.weak ? "Weak spot" : `Day ${dueDay} of 5`}</div>
        <div class="dots">${dots}</div>
      </div>
      <button class="weak-toggle ${record.weak ? "on" : ""}" data-weak="${page}" data-weak-state="${record.weak ? "true" : "false"}">${record.weak ? "Weak" : "Flag"}</button>
    </div>
  `;
}

function renderWeeklyPanel() {
  const entry = normalizeEntry(entryFor());
  const weeklyProgress = weeklyProgressForDate(selectedDateKey());
  const hasPool = weeklyProgress.cycleTotal > 0;
  const cycleDays = weeklyCycleDays();
  return `
    <form class="task-panel" data-form="weekly">
      <div>
        <h2>Weekly Review</h2>
        <p class="note">Saving to ${selectedDateKey()}. Missed pages push the cycle forward.</p>
      </div>
      <div class="cycle-toggle" aria-label="Weekly review cycle length">
        <button class="${cycleDays === 7 ? "selected" : ""}" data-cycle-days="7" type="button">7 days</button>
        <button class="${cycleDays === 10 ? "selected" : ""}" data-cycle-days="10" type="button">10 days</button>
      </div>
      <div class="metric"><span>Start at page</span><strong>${weeklyProgress.start}</strong></div>
      <div class="metric"><span>Target today</span><strong>${weeklyProgress.dailyTarget || "No pool"}</strong></div>
      <p class="metric-note">Pool ${weeklyProgress.cycleTotal} pages · ${weeklyCycleDays()} day cycle</p>
      ${renderProgressBar("Daily progress", weeklyProgress.dailyReviewed, weeklyProgress.dailyTarget, weeklyProgress.dailyPercent)}
      ${renderProgressBar("Cycle progress", weeklyProgress.cycleReviewed, weeklyProgress.cycleTotal, weeklyProgress.cyclePercent)}
      <div class="field">
        <label for="stoppedAt">Stopped at page</label>
        <input id="stoppedAt" name="stoppedAt" inputmode="numeric" value="${entry.weeklyStoppedAt || ""}" placeholder="${hasPool ? weeklyProgress.start : "No review pool yet"}" ${hasPool ? "" : "disabled"} />
      </div>
      <button class="primary-button" type="submit" ${hasPool ? "" : "disabled"}>Save review</button>
      <p class="message">Last stop: ${state.weeklyLastStoppedPage || "None yet"}</p>
    </form>
  `;
}

function renderSyncPanel() {
  return `
    <section class="sync-panel ${state.syncOpen ? "open" : ""}" aria-label="Cloud sync settings">
      <div class="section-head">
        <div>
          <h2>Cloud Sync</h2>
          <p>Use the built-in Supabase settings, or paste different ones for this browser.</p>
        </div>
      </div>
      <div class="sync-grid">
        <div class="field"><label for="supabaseUrl">Supabase URL</label><input id="supabaseUrl" placeholder="https://..." value="${getSupabaseConfig().url || ""}" /></div>
        <div class="field"><label for="supabaseKey">Anon key</label><input id="supabaseKey" placeholder="ey..." value="${getSupabaseConfig().key || ""}" /></div>
        <button class="soft-button" data-action="save-sync">Save sync</button>
      </div>
      <div class="sync-grid">
        <div class="field"><label for="email">Email</label><input id="email" type="email" value="${state.userEmail}" placeholder="you@example.com" /></div>
        <div class="field"><label for="password">Password</label><input id="password" type="password" placeholder="Password" /></div>
        <button class="soft-button" data-action="email-login">Sign in</button>
      </div>
      <div class="footer-tools">
        <button class="ghost-button" data-action="email-signup">Create account</button>
        <button class="ghost-button" data-action="google-login">Google</button>
      </div>
      <p class="message">${syncStatusLabel()}. Create a Supabase table named <strong>quran_tracker_profiles</strong> with columns <strong>user_id</strong> and <strong>data</strong>.</p>
    </section>
  `;
}

function bindEvents() {
  document.querySelector('[data-form="setup"]')?.addEventListener("submit", applyMemorySetup);
  document.querySelector('[data-form="calendar"]')?.addEventListener("submit", saveCalendarEntry);
  document.querySelector('[data-form="memorize"]')?.addEventListener("submit", logMemorized);
  document.querySelector('[data-form="weekly"]')?.addEventListener("submit", logWeeklyReview);
  document.querySelector("#targetDate")?.addEventListener("change", (event) => setTargetDate(event.target.value));
  document.querySelector("#selectedDate")?.addEventListener("change", (event) => setSelectedDate(event.target.value));
  document.querySelectorAll("[data-priority]").forEach((input) => {
    input.addEventListener("change", (event) => completePriorityPage(Number(event.target.dataset.priority), event.target.checked));
  });
  document.querySelectorAll("[data-weak]").forEach((button) => {
    button.addEventListener("click", () => toggleWeak(Number(button.dataset.weak), button.dataset.weakState === "true"));
  });
  document.querySelectorAll("[data-juz]").forEach((button) => {
    button.addEventListener("click", () => toggleJuzSolid(Number(button.dataset.juz)));
  });
  document.querySelectorAll("[data-cycle-days]").forEach((button) => {
    button.addEventListener("click", () => setWeeklyCycleDays(Number(button.dataset.cycleDays)));
  });
  document.querySelector('[data-action="sync"]')?.addEventListener("click", () => {
    state.syncOpen = !state.syncOpen;
    render();
  });
  document.querySelector('[data-action="prev-day"]')?.addEventListener("click", () => moveSelectedDate(-1));
  document.querySelector('[data-action="next-day"]')?.addEventListener("click", () => moveSelectedDate(1));
  document.querySelector('[data-action="today"]')?.addEventListener("click", () => setSelectedDate(todayKey()));
  document.querySelector('[data-action="seed"]')?.addEventListener("click", seedDemo);
  document.querySelector('[data-action="reset"]')?.addEventListener("click", resetDemo);
  document.querySelector('[data-action="export"]')?.addEventListener("click", exportJson);
  document.querySelector('[data-action="save-sync"]')?.addEventListener("click", saveSyncConfig);
  document.querySelector('[data-action="email-login"]')?.addEventListener("click", signInWithEmail);
  document.querySelector('[data-action="email-signup"]')?.addEventListener("click", signUpWithEmail);
  document.querySelector('[data-action="google-login"]')?.addEventListener("click", signInWithGoogle);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `quran-review-tracker-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function getSupabaseConfig() {
  const builtIn = {
    url: window.QURAN_TRACKER_CONFIG?.supabaseUrl || "",
    key: window.QURAN_TRACKER_CONFIG?.supabaseAnonKey || "",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SUPABASE_CONFIG_KEY)) || {};
    return {
      url: saved.url || builtIn.url,
      key: saved.key || builtIn.key,
      source: saved.url && saved.key ? "saved" : builtIn.url && builtIn.key ? "built-in" : "none",
    };
  } catch {
    return { ...builtIn, source: builtIn.url && builtIn.key ? "built-in" : "none" };
  }
}

function syncStatusLabel() {
  if (state.syncStatus === "Signed in" || state.syncStatus === "Account created" || state.syncStatus === "Local saved") {
    return state.syncStatus;
  }
  const config = getSupabaseConfig();
  if (config.url && config.key) return config.source === "built-in" ? "Supabase ready" : state.syncStatus;
  return "Local only";
}

function saveSyncConfig() {
  const url = document.querySelector("#supabaseUrl").value.trim();
  const key = document.querySelector("#supabaseKey").value.trim();
  localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify({ url, key }));
  state.syncStatus = url && key ? "Supabase ready" : "Local only";
  state.message = "Sync settings saved.";
  saveState();
  render();
}

async function loadSupabase() {
  const config = getSupabaseConfig();
  if (!config.url || !config.key) return null;
  if (!supabaseClient) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm");
    supabaseClient = createClient(config.url, config.key);
  }
  return supabaseClient;
}

async function signInWithEmail() {
  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#password").value;
  state.userEmail = email;
  try {
    const client = await loadSupabase();
    if (!client) throw new Error("Add Supabase settings first.");
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    state.syncStatus = "Signed in";
    state.message = "Signed in and synced.";
    await loadCloud();
    await saveCloud();
  } catch (error) {
    state.syncStatus = "Local only";
    state.message = error.message;
  }
  saveState();
  render();
}

async function signUpWithEmail() {
  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#password").value;
  state.userEmail = email;
  try {
    const client = await loadSupabase();
    if (!client) throw new Error("Add Supabase settings first.");
    const { error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    state.syncStatus = "Account created";
    state.message = "Account created. Confirm your email if your Supabase project requires it.";
    await saveCloud();
  } catch (error) {
    state.syncStatus = "Local only";
    state.message = error.message;
  }
  saveState();
  render();
}

async function signInWithGoogle() {
  try {
    const client = await loadSupabase();
    if (!client) throw new Error("Add Supabase settings first.");
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (error) throw error;
  } catch (error) {
    state.syncStatus = "Local only";
    state.message = error.message;
    saveState();
    render();
  }
}

async function loadCloud() {
  const client = await loadSupabase();
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user) return;
  const { data, error } = await client
    .from("quran_tracker_profiles")
    .select("data")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.data) {
    state = normalizeState({ ...data.data, syncStatus: "Signed in" });
  }
}

async function saveCloud() {
  try {
    const client = await loadSupabase();
    if (!client) return;
    const { data: auth } = await client.auth.getUser();
    if (!auth?.user) return;
    await client.from("quran_tracker_profiles").upsert({
      user_id: auth.user.id,
      data: { ...state, syncOpen: false },
      updated_at: new Date().toISOString(),
    });
  } catch {
    state.syncStatus = "Local saved";
  }
}

render();
