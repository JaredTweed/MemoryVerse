import { parsePassageHtml } from "./passage-utils.js";
import { normalizeWord } from "./memorize-core.js";
import {
  beginOptimizedStage,
  createOptimizedFinalTestSession,
  createOptimizedPassage,
  createOptimizedSession,
  getOptimizedPrompt,
  getOptimizedStats,
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
const practiceCard = document.querySelector("#practice-card");
const chunkList = document.querySelector("#chunk-list");
const progressValue = document.querySelector("#progress-value");
const supportValue = document.querySelector("#support-value");
const SUCCESSFUL_ATTEMPT_GRACE_MS = 1500;
let headerLayoutFrame = 0;
let workspaceScrollFrame = 0;

const state = {
  loading: false,
  passage: null,
  session: null,
  notice: "",
  leaderboardEntries: null,
  finalRunAttempt: null,
};

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
  state.session = createOptimizedSession(createOptimizedPassage(state.passage));
  render();
});

async function loadPassage({ startInFinalTest = false } = {}) {
  const reference = referenceInput.value.trim();
  const translation = translationSelect.value;

  if (!reference) {
    state.notice = "Enter a Bible reference to begin.";
    render();
    referenceInput.focus();
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
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to load that passage.");
    }

    const parsedPassage = parsePassageHtml(payload.html, payload.requestedReference, payload.translation);
    state.passage = parsedPassage;
    const optimizedPassage = createOptimizedPassage(parsedPassage);
    state.leaderboardEntries = null;
    state.finalRunAttempt = null;
    state.session = startInFinalTest
      ? createOptimizedFinalTestSession(optimizedPassage)
      : createOptimizedSession(optimizedPassage);
    state.notice = "";
    render();
  } catch (error) {
    state.passage = null;
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
    const studyCard = document.createElement("div");
    studyCard.className = "study-card";
    studyCard.innerHTML = `
      <p class="eyebrow">Study ${escapeHtml(prompt.chunk.label)}</p>
      <p class="chunk-study-text">${escapeHtml(prompt.chunk.text)}</p>
    `;
    practiceCard.appendChild(studyCard);
    return;
  }

  if (prompt.type === "chunk-recall") {
    renderChunkText(practiceCard, prompt.chunk.segments, state.session.promptPosition, prompt.cueStyle);
    return;
  }

  renderPassageText(practiceCard, state.session.passage, state.session.promptPosition, prompt.cueStyle);
}

function renderChunkText(container, segments, promptPosition, cueStyle) {
  let wordCursor = 0;

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

function renderChunkList() {
  chunkList.innerHTML = "";
  chunkListTitle.textContent = state.leaderboardEntries?.length ? "Section leaderboard" : "Chunk plan";

  if (state.leaderboardEntries?.length) {
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

  state.session.chunks.forEach((chunk, index) => {
    const item = document.createElement("article");
    item.className = "chunk-card";

    if (
      (state.session.stage.type === "study" || state.session.stage.type === "chunk-recall") &&
      state.session.stage.chunkIndex === index
    ) {
      item.classList.add("is-active");
    }

    if (chunk.complete) {
      item.classList.add("is-complete");
    }

    item.innerHTML = `
      <div class="chunk-card-header">
        <strong>${escapeHtml(chunk.label)}</strong>
        <span class="chunk-badge">${chunk.mastery} / 3</span>
      </div>
      <p>${escapeHtml(chunk.text)}</p>
    `;
    chunkList.appendChild(item);
  });
}

function renderStats() {
  if (!state.session) {
    progressValue.textContent = "--";
    supportValue.textContent = "--";
    return;
  }

  const stats = getOptimizedStats(state.session);
  progressValue.textContent = `${stats.completedChunks} / ${stats.totalChunks}`;

  if (state.session.stage.type === "study") {
    supportValue.textContent = "Study";
    return;
  }

  if (state.session.stage.type === "final-recall") {
    supportValue.textContent =
      state.session.stage.cueStyle === "first-letter"
        ? `Final ${state.session.finalRound + 1}: Letter cues`
        : `Final ${state.session.finalRound + 1}: Blank only`;
    return;
  }

  supportValue.textContent =
    state.session.stage.cueStyle === "first-letter" ? "First-letter cues" : "Blank only";
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

    const activeChunk = chunkList.querySelector(".is-active");
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

function beginRecall() {
  if (!state.session || state.loading || state.session.stage.type !== "study") {
    return;
  }

  state.session = beginOptimizedStage(state.session);
  render();
  guessInput.focus();
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

  let prefix = `${context.chunkReference}, Chunk ${context.chunkNumber}/${context.totalChunks}`;
  if (context.wordNumber !== null && context.wordTotal !== null) {
    prefix += `, Word ${context.wordNumber}/${context.wordTotal}`;
  }

  return prefix;
}

function getStatusContext(session, prompt) {
  if (prompt.type === "study" || prompt.type === "chunk-recall") {
    return createChunkStatusContext(
      session,
      prompt.chunkIndex,
      prompt.chunk,
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
      return createChunkStatusContext(
        session,
        chunkIndex,
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

  return createChunkStatusContext(
    session,
    finalChunkIndex,
    finalChunk,
    finalChunk.words.length,
    finalChunk.words.length,
  );
}

function createChunkStatusContext(session, chunkIndex, chunk, wordNumber, wordTotal) {
  return {
    chunkReference: formatChunkReference(session.passage.referenceLabel, chunk),
    chunkNumber: chunkIndex + 1,
    totalChunks: session.chunks.length,
    wordNumber,
    wordTotal,
  };
}

function formatChunkReference(referenceLabel, chunk) {
  const chunkSuffix = chunk.label.replace(/^Verse\s+/u, "");
  const chapterReference = referenceLabel.includes(":")
    ? referenceLabel.slice(0, referenceLabel.indexOf(":"))
    : referenceLabel;

  return `${chapterReference}:${chunkSuffix}`;
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
