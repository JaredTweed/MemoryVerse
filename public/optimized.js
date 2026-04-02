import { parsePassageHtml } from "./passage-utils.js";
import { normalizeWord } from "./memorize-core.js";
import {
  beginOptimizedStage,
  createOptimizedFinalTestSession,
  createOptimizedPassage,
  createOptimizedSession,
  getActivePlanIndex,
  getOptimizedPrompt,
  jumpToPlanStudy,
  restartOptimizedFinalTest,
  submitOptimizedWord,
} from "./optimized-core.js";

const referenceInput = document.querySelector("#reference-input");
const translationSelect = document.querySelector("#translation-select");
const passageForm = document.querySelector("#passage-form");
const skipFinalButton = document.querySelector("#skip-final-button");
const answerForm = document.querySelector("#answer-form");
const answerField = document.querySelector("#answer-field");
const answerSubmitButton = document.querySelector("#answer-submit-button");
const guessInput = document.querySelector("#guess-input");
const restartButton = document.querySelector("#restart-button");
const practiceHeading = document.querySelector(".practice-heading");
const practiceActions = document.querySelector(".practice-actions");
const passageTitle = document.querySelector("#passage-title");
const statusMessage = document.querySelector("#status-message");
const chunkListTitle = document.querySelector("#chunk-list-title");
const chunkListSection = document.querySelector(".chunk-list-section");
const planNav = document.querySelector("#plan-nav");
const planPrevButton = document.querySelector("#plan-prev-button");
const planNextButton = document.querySelector("#plan-next-button");
const planPosition = document.querySelector("#plan-position");
const practiceCard = document.querySelector("#practice-card");
const chunkList = document.querySelector("#chunk-list");
const supportValue = document.querySelector("#support-value");
const supportSteps = {
  study: supportValue.querySelector('[data-support-step="study"]'),
  "first-letter": supportValue.querySelector('[data-support-step="first-letter"]'),
  blank: supportValue.querySelector('[data-support-step="blank"]'),
};
const LAST_REFERENCE_STORAGE_KEY = "memoryverse:last-reference";
const PASSAGE_CACHE_STORAGE_KEY = "memoryverse:passage-cache";
const PASSAGE_CACHE_LIMIT = 16;
const SUCCESSFUL_ATTEMPT_GRACE_MS = 1500;
const NON_PERSISTENT_TRANSLATIONS = new Set(["ESV", "NIV"]);
let headerLayoutFrame = 0;
let workspaceScrollFrame = 0;

const state = {
  loading: false,
  passage: null,
  activePassageKey: null,
  session: null,
  notice: "",
  leaderboardEntries: null,
  finalRunAttempt: null,
};

applySavedReferencePreference();
applyTheme();
render();

window.addEventListener("resize", syncPracticeHeaderLayout);

passageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const startInFinalTest = event.submitter?.id === "skip-final-button";
  await loadPassage({ startInFinalTest });
});

answerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAnswer();
});

answerSubmitButton.addEventListener("click", (event) => {
  if (!state.session || state.loading || state.session.stage.type === "study") {
    return;
  }

  event.preventDefault();
  revealCurrentWord();
});

guessInput.addEventListener("input", (event) => {
  if (
    event.isComposing ||
    !state.session ||
    state.loading ||
    state.session.stage.type === "study"
  ) {
    return;
  }

  const prompt = getOptimizedPrompt(state.session);
  if (!prompt?.word) {
    return;
  }

  if (normalizeWord(guessInput.value) !== prompt.word.normalized) {
    return;
  }

  submitAnswer();
});

guessInput.addEventListener("keydown", (event) => {
  if (event.key !== "Backspace") {
    return;
  }

  trackLateBackspace();
});

document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.key !== "Enter" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !state.session ||
    state.loading ||
    state.session.stage.type !== "study"
  ) {
    return;
  }

  const target = event.target;
  if (target instanceof HTMLElement && (passageForm.contains(target) || answerForm.contains(target))) {
    return;
  }

  event.preventDefault();
  beginRecall();
});

restartButton.addEventListener("click", () => {
  if (!state.passage) {
    return;
  }

  state.leaderboardEntries = null;
  state.finalRunAttempt = null;
  state.session = createSessionForMode(state.passage, { startInFinalTest: false });
  render();
});

planPrevButton.addEventListener("click", () => {
  jumpPlan(-1);
});

planNextButton.addEventListener("click", () => {
  jumpPlan(1);
});

async function loadPassage({ startInFinalTest = false } = {}) {
  const reference = normalizeReferenceInput(referenceInput.value);
  const translation = translationSelect.value;

  if (!reference) {
    state.notice = "Enter a Bible reference to begin.";
    render();
    referenceInput.focus();
    return;
  }

  const passageKey = createPassageCacheKey(reference, translation);
  const shouldPersistLocally = isPersistentPassageCacheAllowed(translation);

  if (hydrateCurrentPassage(passageKey, reference, { startInFinalTest })) {
    return;
  }

  const cachedPassage = shouldPersistLocally ? loadCachedPassage(passageKey) : null;
  if (cachedPassage) {
    activatePassage(cachedPassage, passageKey, reference, { startInFinalTest });
    render();

    if (startInFinalTest && state.session) {
      guessInput.focus({ preventScroll: true });
    }
    return;
  }

  state.loading = true;
  state.notice = "";
  render();

  try {
    const response = await fetch(
      `/api/passage?reference=${encodeURIComponent(reference)}&translation=${encodeURIComponent(
        translation,
      )}`,
      {
        cache: shouldPersistLocally ? "force-cache" : "no-store",
      },
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.details || payload.error || "Unable to load that passage.");
    }

    const parsedPassage = parsePassageHtml(payload.html, payload.requestedReference, payload.translation);
    const responseReference = normalizeReferenceInput(payload.requestedReference);
    const responsePassageKey = createPassageCacheKey(responseReference, payload.translation);
    if (shouldPersistLocally) {
      persistCachedPassage(responsePassageKey, parsedPassage);
    }
    activatePassage(parsedPassage, responsePassageKey, responseReference, { startInFinalTest });
    render();
  } catch (error) {
    state.passage = null;
    state.activePassageKey = null;
    state.session = null;
    state.notice = error instanceof Error ? error.message : "Unable to load that passage.";
    state.leaderboardEntries = null;
    state.finalRunAttempt = null;
    render();
  } finally {
    state.loading = false;
    if (isTrackedBlankFinalSession(state.session)) {
      startFinalRunAttempt(state.session);
    }
    render();
  }

  if (startInFinalTest && state.session && !state.loading) {
    guessInput.focus({ preventScroll: true });
  }
}

function render() {
  renderTitle();
  renderStatus();
  renderPractice();
  renderChunkList();
  renderStats();
  renderControls();
  syncPracticeHeaderLayout();
  syncWorkspaceVisibility();
}

function renderTitle() {
  if (!state.passage) {
    passageTitle.textContent = "Load a passage to begin.";
    return;
  }

  passageTitle.textContent = `${state.passage.referenceLabel} (${state.passage.translation})`;
}

function renderStatus() {
  if (state.loading) {
    statusMessage.textContent = "Loading passage...";
    return;
  }

  if (!state.session) {
    statusMessage.textContent = state.notice || "Choose a verse or range to begin.";
    return;
  }

  const prompt = getOptimizedPrompt(state.session);
  if (!prompt) {
    statusMessage.textContent =
      state.session.feedback.type === "completed"
        ? "Successful blank-only run. Leaderboard ready."
        : "The passage is ready.";
    return;
  }

  const statusPrefix = getStatusPrefix(state.session, prompt);
  switch (state.session.feedback.type) {
    case "help-word":
      statusMessage.textContent = `${statusPrefix}. The word was "${state.session.feedback.revealedWord}".`;
      return;
    case "mistake":
      statusMessage.textContent = `${statusPrefix}. The correct word was "${state.session.feedback.revealedWord}".`;
      return;
    case "empty-answer":
      statusMessage.textContent = `${statusPrefix}. Make a guess before getting help.`;
      return;
    default:
      statusMessage.textContent = `${statusPrefix}.`;
      return;
  }
}

function renderPractice() {
  practiceCard.innerHTML = "";

  if (!state.session) {
    practiceCard.classList.add("is-empty");
    practiceCard.innerHTML = `
      <div class="empty-state">
        <p class="empty-kicker">MemoryVerse</p>
        <p>Load a passage to begin.</p>
      </div>
    `;
    return;
  }

  practiceCard.classList.remove("is-empty");
  const prompt = getOptimizedPrompt(state.session);
  if (!prompt) {
    if (state.session.complete) {
      renderPassageText(
        practiceCard,
        state.session.passage,
        state.session.passage.hideableWordIndices.length,
        "blank",
      );
    }
    return;
  }

  if (prompt.type === "study") {
    renderStudyUnit(practiceCard, prompt.unit ?? prompt.chunk);
    return;
  }

  if (prompt.type === "chunk-recall") {
    renderRecallUnit(
      practiceCard,
      prompt.unit ?? prompt.chunk,
      state.session.promptPosition,
      prompt.cueStyle,
    );
    return;
  }

  renderPassageText(practiceCard, state.session.passage, state.session.promptPosition, prompt.cueStyle);
}

function renderStudyUnit(container, unit) {
  const displayChunks = getDisplayedUnitChunks(unit);
  const studyCard = document.createElement("div");
  studyCard.className = "study-card";
  studyCard.innerHTML = `<p class="eyebrow">Study ${escapeHtml(unit.label)}</p>`;

  displayChunks.forEach(({ chunk, isContext, showVerseNumber }) => {
    const block = document.createElement("section");
    block.className = "unit-chunk";
    if (isContext) {
      block.classList.add("is-context");
    }

    const text = document.createElement("p");
    text.className = "chunk-study-text";
    appendVerseMarker(text, showVerseNumber ? chunk.verseNumber : null);
    renderVisibleChunkText(text, chunk.segments);
    block.appendChild(text);
    studyCard.appendChild(block);
  });

  container.appendChild(studyCard);
}

function renderRecallUnit(container, unit, promptPosition, cueStyle) {
  const displayChunks = getDisplayedUnitChunks(unit);
  const recallCard = document.createElement("div");
  recallCard.className = "study-card";
  let wordCursor = 0;

  displayChunks.forEach(({ chunk, isContext, showVerseNumber }) => {
    const block = document.createElement("section");
    block.className = "unit-chunk";
    if (isContext) {
      block.classList.add("is-context");
    }

    const text = document.createElement("p");
    text.className = "chunk-study-text";
    appendVerseMarker(text, showVerseNumber ? chunk.verseNumber : null);

    if (isContext) {
      renderVisibleChunkText(text, chunk.segments);
    } else {
      wordCursor = renderChunkText(text, chunk.segments, promptPosition, cueStyle, wordCursor);
    }

    block.appendChild(text);
    recallCard.appendChild(block);
  });

  container.appendChild(recallCard);
}

function renderChunkText(container, segments, promptPosition, cueStyle, startingWordCursor = 0) {
  let wordCursor = startingWordCursor;

  for (const segment of segments) {
    if (segment.type === "text") {
      container.appendChild(document.createTextNode(segment.text));
      continue;
    }

    if (wordCursor < promptPosition) {
      const cleared = document.createElement("span");
      cleared.className = "word word-cleared";
      cleared.textContent = segment.text;
      container.appendChild(cleared);
      wordCursor += 1;
      continue;
    }

    const cue = buildCue(segment.text, cueStyle, wordCursor === promptPosition, wordCursor === 0);
    container.appendChild(cue);
    wordCursor += 1;
  }

  return wordCursor;
}

function renderPassageText(container, passage, promptPosition, cueStyle) {
  let wordCursor = 0;
  const hideableSet = new Set(passage.hideableWordIndices);

  for (let index = 0; index < passage.segments.length; index += 1) {
    const segment = passage.segments[index];

    if (segment.type === "verse-number") {
      const verseNumber = document.createElement("span");
      verseNumber.className = "verse-number";
      verseNumber.textContent = segment.text;
      container.appendChild(verseNumber);
      continue;
    }

    if (segment.type === "text") {
      container.appendChild(document.createTextNode(segment.text));
      continue;
    }

    if (!hideableSet.has(index)) {
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = segment.text;
      container.appendChild(word);
      continue;
    }

    if (wordCursor < promptPosition) {
      const cleared = document.createElement("span");
      cleared.className = "word word-cleared";
      cleared.textContent = segment.text;
      container.appendChild(cleared);
      wordCursor += 1;
      continue;
    }

    const cue = buildCue(segment.text, cueStyle, wordCursor === promptPosition, wordCursor === 0);
    container.appendChild(cue);
    wordCursor += 1;
  }
}

function buildCue(wordText, cueStyle, isCurrent, isLeadWord) {
  const cue = document.createElement("span");
  cue.className = "word-gap";
  cue.style.setProperty("--gap-width", String(Math.max(wordText.length, 3)));

  if (isCurrent) {
    cue.classList.add("is-current");
  }

  if (cueStyle === "first-letter") {
    cue.classList.add("has-cue");
    cue.textContent = `${wordText[0]}${".".repeat(Math.max(wordText.length - 1, 1))}`;
  } else if (cueStyle === "blank" && isLeadWord) {
    cue.classList.add("has-cue");
    cue.textContent = wordText[0];
  }

  return cue;
}

function renderVisibleChunkText(container, segments) {
  for (const segment of segments) {
    if (segment.type === "text") {
      container.appendChild(document.createTextNode(segment.text));
      continue;
    }

    const word = document.createElement("span");
    word.className = "word";
    word.textContent = segment.text;
    container.appendChild(word);
  }
}

function appendVerseMarker(container, verseNumber) {
  if (!verseNumber) {
    return;
  }

  const marker = document.createElement("sup");
  marker.className = "verse-number";
  marker.textContent = verseNumber;
  container.appendChild(marker);
}

function renderChunkList() {
  chunkListSection.hidden = !state.passage;
  chunkList.innerHTML = "";
  const hasLeaderboard = Boolean(state.leaderboardEntries?.length);
  chunkListTitle.textContent = hasLeaderboard ? "Section leaderboard" : "Chunk plan";
  renderPlanNavigation(hasLeaderboard);

  if (!state.passage) {
    return;
  }

  if (hasLeaderboard) {
    state.leaderboardEntries.forEach((entry, index) => {
      const item = document.createElement("article");
      item.className = "chunk-card";
      item.innerHTML = `
        <div class="chunk-card-header">
          <strong>#${index + 1} ${escapeHtml(entry.label)}</strong>
          <span class="chunk-badge">${formatDuration(entry.scoreMs)}</span>
        </div>
        <p>${escapeHtml(`Slowest word: ${entry.slowestWordLabel} ("${entry.slowestWordText}")`)}</p>
      `;
      chunkList.appendChild(item);
    });
    return;
  }

  if (!state.session) {
    return;
  }

  renderPlanOverview(chunkList, state.session);
}

function renderStats() {
  Object.values(supportSteps).forEach((step) => {
    step?.classList.remove("is-active");
  });

  if (!state.session) {
    return;
  }

  const activeSupportStep =
    state.session.stage.type === "study"
      ? "study"
      : state.session.stage.cueStyle === "first-letter"
        ? "first-letter"
        : "blank";

  supportSteps[activeSupportStep]?.classList.add("is-active");
}

function renderControls() {
  const isStudy = state.session?.stage.type === "study";
  const isDone = state.session?.complete;

  answerField.toggleAttribute("hidden", Boolean(isStudy));
  answerField.setAttribute("aria-hidden", isStudy ? "true" : "false");
  answerForm.classList.toggle("is-study-action", Boolean(isStudy));
  guessInput.disabled = !state.session || isStudy || Boolean(isDone) || state.loading;
  answerSubmitButton.textContent = isStudy ? "Begin Recall" : "Help";
  answerSubmitButton.disabled = !state.session || Boolean(isDone) || state.loading;
  guessInput.placeholder = isStudy
    ? "Click Begin Recall"
    : isDone
      ? "Session complete"
      : "Type the next word in order";
  skipFinalButton.disabled = state.loading;
  restartButton.disabled = !state.passage || state.loading;
}

function syncWorkspaceVisibility() {
  cancelAnimationFrame(workspaceScrollFrame);

  workspaceScrollFrame = requestAnimationFrame(() => {
    const currentPrompt = practiceCard.querySelector(".is-current");
    if (currentPrompt) {
      currentPrompt.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } else if (state.session?.stage.type === "study") {
      practiceCard.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      answerSubmitButton.focus({ preventScroll: true });
    }

    const activeChunk =
      chunkList.querySelector(".passage-overview .word-gap.is-current") ||
      chunkList.querySelector(".overview-chunk.is-active-unit, .chunk-card.is-active");
    if (!activeChunk) {
      return;
    }

    activeChunk.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });
}

function syncPracticeHeaderLayout() {
  cancelAnimationFrame(headerLayoutFrame);

  headerLayoutFrame = requestAnimationFrame(() => {
    const isNarrowViewport = window.matchMedia("(max-width: 900px)").matches;
    const headingBottom = practiceHeading.getBoundingClientRect().bottom;
    const actionsTop = practiceActions.getBoundingClientRect().top;
    const isStacked = isNarrowViewport && actionsTop > headingBottom;

    practiceActions.classList.toggle("is-stacked", isStacked);
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = "dark";
}

function applySavedReferencePreference() {
  const savedReference = loadLastReferencePreference();
  if (!savedReference) {
    return;
  }

  referenceInput.value = savedReference;
}

function loadLastReferencePreference() {
  try {
    return window.localStorage.getItem(LAST_REFERENCE_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function persistLastReferencePreference(reference) {
  try {
    window.localStorage.setItem(LAST_REFERENCE_STORAGE_KEY, reference);
  } catch {
    // Ignore storage failures and keep using the in-memory value.
  }
}

function normalizeReferenceInput(reference) {
  return reference.trim().replace(/\s+/g, " ");
}

function createPassageCacheKey(reference, translation) {
  return `${translation.toUpperCase()}:${reference.toLowerCase()}`;
}

function isPersistentPassageCacheAllowed(translation) {
  return !NON_PERSISTENT_TRANSLATIONS.has((translation || "").trim().toUpperCase());
}

function hydrateCurrentPassage(passageKey, reference, { startInFinalTest }) {
  if (!state.passage || state.activePassageKey !== passageKey) {
    return false;
  }

  activatePassage(state.passage, passageKey, reference, { startInFinalTest });
  render();

  if (startInFinalTest && state.session) {
    guessInput.focus({ preventScroll: true });
  }

  return true;
}

function activatePassage(passage, passageKey, reference, { startInFinalTest }) {
  state.passage = passage;
  state.activePassageKey = passageKey;
  state.leaderboardEntries = null;
  state.finalRunAttempt = null;
  state.session = createSessionForMode(passage, { startInFinalTest });
  state.notice = "";
  referenceInput.value = reference;
  persistLastReferencePreference(reference);
}

function createSessionForMode(passage, { startInFinalTest }) {
  const optimizedPassage = createOptimizedPassage(passage);
  return startInFinalTest
    ? createOptimizedFinalTestSession(optimizedPassage)
    : createOptimizedSession(optimizedPassage);
}

function loadCachedPassage(passageKey) {
  const cacheEntries = readCachedPassageEntries();
  const entry = cacheEntries.find((item) => item.key === passageKey);
  if (!entry?.passage) {
    return null;
  }

  persistCachedPassageEntries([
    { ...entry, updatedAt: Date.now() },
    ...cacheEntries.filter((item) => item.key !== passageKey),
  ]);

  return entry.passage;
}

function persistCachedPassage(passageKey, passage) {
  const cacheEntries = readCachedPassageEntries().filter((entry) => entry.key !== passageKey);
  persistCachedPassageEntries([
    {
      key: passageKey,
      passage,
      updatedAt: Date.now(),
    },
    ...cacheEntries,
  ]);
}

function readCachedPassageEntries() {
  try {
    const rawValue = window.localStorage.getItem(PASSAGE_CACHE_STORAGE_KEY);
    const parsedEntries = rawValue ? JSON.parse(rawValue) : [];
    return Array.isArray(parsedEntries)
      ? parsedEntries.filter((entry) => isPersistentPassageCacheEntry(entry))
      : [];
  } catch {
    return [];
  }
}

function persistCachedPassageEntries(entries) {
  try {
    window.localStorage.setItem(
      PASSAGE_CACHE_STORAGE_KEY,
      JSON.stringify(entries.slice(0, PASSAGE_CACHE_LIMIT)),
    );
  } catch {
    // Ignore cache write failures and fall back to the network next time.
  }
}

function isPersistentPassageCacheEntry(entry) {
  if (typeof entry?.key !== "string") {
    return false;
  }

  const [translation = ""] = entry.key.split(":", 1);
  return isPersistentPassageCacheAllowed(translation);
}

function beginRecall() {
  if (!state.session || state.loading || state.session.stage.type !== "study") {
    return;
  }

  state.session = beginOptimizedStage(state.session);
  render();
  guessInput.focus();
}

function jumpPlan(offset) {
  if (!state.session || state.loading || !state.session.plan?.length) {
    return;
  }

  const currentPlanIndex = getActivePlanIndex(state.session);
  const nextPlanIndex = currentPlanIndex + offset;

  if (nextPlanIndex < 0 || nextPlanIndex >= state.session.plan.length) {
    return;
  }

  state.finalRunAttempt = null;
  state.session = jumpToPlanStudy(state.session, nextPlanIndex);
  guessInput.value = "";
  render();
  answerSubmitButton.focus({ preventScroll: true });
}

function submitAnswer() {
  if (!state.session || state.loading) {
    return;
  }

  if (state.session.stage.type === "study") {
    beginRecall();
    return;
  }

  const previousSession = state.session;
  const prompt = getOptimizedPrompt(previousSession);
  const normalizedGuess = normalizeWord(guessInput.value);
  const wasTrackedBlankFinal = isTrackedBlankFinalPrompt(previousSession, prompt);
  const wasCorrect = Boolean(prompt?.word && normalizedGuess === prompt.word.normalized);

  if (wasTrackedBlankFinal && wasCorrect) {
    recordFinalRunWord(previousSession, prompt);
  }

  let nextSession = submitOptimizedWord(previousSession, guessInput.value);

  if (wasTrackedBlankFinal && nextSession.feedback.type === "mistake") {
    invalidateFinalRunAttempt();
  }

  nextSession = reconcileFinalRunState(previousSession, nextSession, wasTrackedBlankFinal, wasCorrect);
  state.session = nextSession;
  guessInput.value = "";
  render();

  if (state.session && !state.session.complete && state.session.stage.type !== "study") {
    guessInput.focus({ preventScroll: true });
  }
}

function revealCurrentWord() {
  if (!state.session || state.loading || state.session.stage.type === "study") {
    return;
  }

  const prompt = getOptimizedPrompt(state.session);
  if (!prompt?.word) {
    return;
  }

  state.session = {
    ...state.session,
    promptPosition: 0,
    feedback: {
      type: "help-word",
      revealedWord: prompt.word.text,
    },
  };
  guessInput.value = "";

  if (isTrackedBlankFinalSession(state.session)) {
    startFinalRunAttempt(state.session);
  }

  render();
  guessInput.focus({ preventScroll: true });
}

function trackLateBackspace() {
  if (!state.finalRunAttempt || !isTrackedBlankFinalSession(state.session)) {
    return;
  }

  if (performance.now() - state.finalRunAttempt.promptStartedAt < SUCCESSFUL_ATTEMPT_GRACE_MS) {
    return;
  }

  state.finalRunAttempt.promptUsedLateBackspace = true;
  state.finalRunAttempt.invalid = true;
}

function startFinalRunAttempt(session) {
  const prompt = getOptimizedPrompt(session);
  if (!isTrackedBlankFinalPrompt(session, prompt)) {
    state.finalRunAttempt = null;
    return;
  }

  state.finalRunAttempt = {
    promptStartedAt: performance.now(),
    promptUsedLateBackspace: false,
    wordResults: [],
    invalid: false,
  };
}

function prepareTrackedPrompt(session) {
  const prompt = getOptimizedPrompt(session);
  if (!isTrackedBlankFinalPrompt(session, prompt)) {
    return;
  }

  if (!state.finalRunAttempt) {
    startFinalRunAttempt(session);
    return;
  }

  state.finalRunAttempt.promptStartedAt = performance.now();
  state.finalRunAttempt.promptUsedLateBackspace = false;
}

function recordFinalRunWord(session, prompt) {
  if (!state.finalRunAttempt) {
    return;
  }

  const context = getStatusContext(session, prompt);
  state.finalRunAttempt.wordResults.push({
    label: context
      ? `${context.chunkReference}, Word ${context.wordNumber}/${context.wordTotal}`
      : `Word ${prompt.promptPosition + 1}/${prompt.totalPrompts}`,
    wordText: prompt.word.text,
    durationMs: performance.now() - state.finalRunAttempt.promptStartedAt,
    globalWordNumber: prompt.promptPosition + 1,
  });

  if (state.finalRunAttempt.promptUsedLateBackspace) {
    state.finalRunAttempt.invalid = true;
  }
}

function invalidateFinalRunAttempt() {
  if (!state.finalRunAttempt) {
    return;
  }

  state.finalRunAttempt.invalid = true;
}

function reconcileFinalRunState(
  previousSession,
  nextSession,
  wasTrackedBlankFinal,
  wasCorrect,
) {
  const failedTrackedBlankRun = wasTrackedBlankFinal && nextSession.feedback.type === "mistake";
  if (failedTrackedBlankRun) {
    invalidateFinalRunAttempt();
    const repeatedSession = restartOptimizedFinalTest(nextSession);
    startFinalRunAttempt(repeatedSession);
    return repeatedSession;
  }

  const completedTrackedBlankRun = wasTrackedBlankFinal && wasCorrect && nextSession.complete;

  if (completedTrackedBlankRun) {
    const wasSuccessfulRun = isSuccessfulFinalRun(previousSession);

    if (wasSuccessfulRun) {
      recordSuccessfulRun(state.finalRunAttempt.wordResults);
    }

    const repeatedSession = restartOptimizedFinalTest(
      nextSession,
      wasSuccessfulRun ? "final-test-success" : "final-test-retry",
    );
    startFinalRunAttempt(repeatedSession);
    return repeatedSession;
  }

  if (nextSession.complete) {
    const repeatedSession = restartOptimizedFinalTest(nextSession);
    startFinalRunAttempt(repeatedSession);
    return repeatedSession;
  }

  if (isTrackedBlankFinalSession(nextSession)) {
    if (!isTrackedBlankFinalSession(previousSession)) {
      startFinalRunAttempt(nextSession);
    } else if (wasTrackedBlankFinal && wasCorrect) {
      prepareTrackedPrompt(nextSession);
    }
  }

  return nextSession;
}

function isSuccessfulFinalRun(session) {
  return Boolean(
    state.finalRunAttempt &&
      !state.finalRunAttempt.invalid &&
      state.finalRunAttempt.wordResults.length === session.passage.hideableWordIndices.length,
  );
}

function recordSuccessfulRun(wordResults) {
  const nextRunNumber = (state.leaderboardEntries?.length ?? 0) + 1;
  const runEntry = buildRunLeaderboardEntry(wordResults, nextRunNumber);
  const entries = [...(state.leaderboardEntries ?? []), runEntry];

  state.leaderboardEntries = entries.sort(
    (left, right) => left.scoreMs - right.scoreMs || left.runNumber - right.runNumber,
  );
  state.finalRunAttempt = null;
}

function buildRunLeaderboardEntry(wordResults, runNumber) {
  const slowestWord = wordResults.reduce((slowest, current) =>
    current.durationMs > slowest.durationMs ? current : slowest,
  );

  return {
    label: `Run ${runNumber}`,
    runNumber,
    scoreMs: slowestWord.durationMs,
    slowestWordLabel: slowestWord.label,
    slowestWordText: slowestWord.wordText,
  };
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function isTrackedBlankFinalSession(session) {
  return Boolean(
    session &&
      !session.complete &&
      session.stage.type === "final-recall" &&
      session.stage.cueStyle === "blank",
  );
}

function isTrackedBlankFinalPrompt(session, prompt) {
  return Boolean(prompt && prompt.type === "final-recall" && isTrackedBlankFinalSession(session));
}

function getStatusPrefix(session, prompt) {
  const context = getStatusContext(session, prompt);
  if (!context) {
    return "The passage is ready";
  }

  let prefix = `${context.chunkReference}, ${context.chunkPositionLabel}`;
  if (context.wordNumber !== null && context.wordTotal !== null) {
    prefix += `, Word ${context.wordNumber}/${context.wordTotal}`;
  }

  return prefix;
}

function getStatusContext(session, prompt) {
  if (prompt.type === "study" || prompt.type === "chunk-recall") {
    return createUnitStatusContext(
      session,
      prompt.unit ?? prompt.chunk,
      prompt.type === "study" ? null : prompt.promptPosition + 1,
      prompt.type === "study" ? null : prompt.totalPrompts,
    );
  }

  if (prompt.type !== "final-recall") {
    return null;
  }

  let wordOffset = prompt.promptPosition;
  for (let chunkIndex = 0; chunkIndex < session.chunks.length; chunkIndex += 1) {
    const chunk = session.chunks[chunkIndex];
    if (wordOffset < chunk.words.length) {
      return createUnitStatusContext(
        session,
        chunk,
        wordOffset + 1,
        chunk.words.length,
      );
    }

    wordOffset -= chunk.words.length;
  }

  const finalChunkIndex = Math.max(session.chunks.length - 1, 0);
  const finalChunk = session.chunks[finalChunkIndex];
  if (!finalChunk) {
    return null;
  }

  return createUnitStatusContext(
    session,
    finalChunk,
    finalChunk.words.length,
    finalChunk.words.length,
  );
}

function createUnitStatusContext(session, chunk, wordNumber, wordTotal) {
  return {
    chunkReference: formatChunkReference(session.passage.referenceLabel, session.chunks, chunk),
    chunkPositionLabel: formatChunkPosition(chunk, session.chunks.length),
    wordNumber,
    wordTotal,
  };
}

function formatChunkReference(referenceLabel, chunks, chunk) {
  const chapterReference = referenceLabel.includes(":")
    ? referenceLabel.slice(0, referenceLabel.indexOf(":"))
    : referenceLabel;
  const startSuffix = chunks[chunk.startChunkIndex].label.replace(/^Verse\s+/u, "");
  const endSuffix = chunks[chunk.endChunkIndex].label.replace(/^Verse\s+/u, "");

  return startSuffix === endSuffix
    ? `${chapterReference}:${startSuffix}`
    : `${chapterReference}:${startSuffix}-${endSuffix}`;
}

function formatChunkPosition(chunk, totalChunks) {
  const startChunkNumber = chunk.startChunkIndex + 1;
  const endChunkNumber = chunk.endChunkIndex + 1;

  return startChunkNumber === endChunkNumber
    ? `Chunk ${startChunkNumber}/${totalChunks}`
    : `Chunks ${startChunkNumber}-${endChunkNumber}/${totalChunks}`;
}

function renderPlanNavigation(hasLeaderboard) {
  const hasPlan = Boolean(state.session?.plan?.length);
  const shouldShowNavigation = hasPlan && !hasLeaderboard;
  planNav.hidden = !shouldShowNavigation;

  if (!shouldShowNavigation) {
    planPosition.textContent = "-- / --";
    planPrevButton.disabled = true;
    planNextButton.disabled = true;
    return;
  }

  const activePlanIndex = getActivePlanIndex(state.session);
  planPosition.textContent = `${activePlanIndex + 1} / ${state.session.plan.length}`;
  planPrevButton.disabled = state.loading || activePlanIndex <= 0;
  planNextButton.disabled =
    state.loading || activePlanIndex >= state.session.plan.length - 1;
}

function renderPlanOverview(container, session) {
  const prompt = getOptimizedPrompt(session);
  if (!prompt) {
    return;
  }

  const overview = document.createElement("div");
  overview.className = "passage-overview";
  const activeRange = getOverviewActiveRange(session, prompt);
  const supportMode = getOverviewSupportMode(session, prompt);
  let activeWordCursor = 0;
  let lastVerseNumber = null;

  session.chunks.forEach((chunk, index) => {
    const chunkNode = document.createElement("span");
    chunkNode.className = "overview-chunk";
    const isActive =
      activeRange && index >= activeRange.startChunkIndex && index <= activeRange.endChunkIndex;

    if (isActive) {
      chunkNode.classList.add("is-active-unit");
    }

    if (chunk.complete) {
      chunkNode.classList.add("is-complete");
    }

    if (lastVerseNumber !== chunk.verseNumber) {
      appendVerseMarker(chunkNode, chunk.verseNumber);
      lastVerseNumber = chunk.verseNumber;
    }

    if (isActive && supportMode !== "study") {
      activeWordCursor = renderChunkText(
        chunkNode,
        chunk.segments,
        session.promptPosition,
        supportMode,
        activeWordCursor,
      );
    } else {
      renderVisibleChunkText(chunkNode, chunk.segments);
    }

    overview.appendChild(chunkNode);
    if (index < session.chunks.length - 1) {
      overview.appendChild(document.createTextNode(" "));
    }
  });

  container.appendChild(overview);
}

function getOverviewActiveRange(session, prompt) {
  if (prompt.type === "study" || prompt.type === "chunk-recall") {
    return prompt.unit ?? prompt.chunk;
  }

  if (prompt.type === "final-recall") {
    return {
      startChunkIndex: 0,
      endChunkIndex: session.chunks.length - 1,
    };
  }

  return null;
}

function getOverviewSupportMode(session, prompt) {
  if (prompt.type === "study") {
    return "study";
  }

  if (prompt.type === "chunk-recall" || prompt.type === "final-recall") {
    return prompt.cueStyle;
  }

  return "study";
}

function getDisplayedUnitChunks(unit) {
  if (!state.session || !unit) {
    return [];
  }

  const displayStart = Math.max(0, unit.startChunkIndex - 1);
  const displayEnd = Math.min(state.session.chunks.length - 1, unit.endChunkIndex + 1);
  const chunks = state.session.chunks.slice(displayStart, displayEnd + 1);

  return chunks.map((chunk, index) => {
    const absoluteChunkIndex = displayStart + index;
    const previousChunk = index > 0 ? chunks[index - 1] : null;
    return {
      chunk,
      isContext:
        absoluteChunkIndex < unit.startChunkIndex || absoluteChunkIndex > unit.endChunkIndex,
      showVerseNumber: !previousChunk || previousChunk.verseNumber !== chunk.verseNumber,
    };
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
